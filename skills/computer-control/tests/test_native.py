"""Compile actual Swift implementation and exercise only isolated non-GUI paths."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
HARNESS = r"""
jsonMode = true
let mode = CommandLine.arguments[1]
if mode == "flags" {
    args = ["app", "--settle", "400", "--json", "--", "--json", "--settle", "--"]
    optionBoundary = nil
    assert(hasFlag("--json"))
    assert(flagValue("--settle") == "400")
    let divider = args.firstIndex(of: "--")!
    optionBoundary = divider
    args.remove(at: divider)
    assert(!hasFlag("--json"))
    assert(flagValue("--settle") == nil)
    removeFirstArg()
    assert(args == ["--json", "--settle", "--"])
    args = ["--out", "--json", "--json"]
    optionBoundary = nil
    assert(hasFlag("--json"))
    assert(flagValue("--out") == "--json")
    emitJSON(["ok": true])
} else if mode == "owner" {
    let action = CommandLine.arguments[2]
    let scope = CommandLine.arguments[3]
    let lease = CommandLine.arguments.count > 4 && CommandLine.arguments[4] != "-" ? CommandLine.arguments[4] : nil
    let next = CommandLine.arguments.count > 5 ? CommandLine.arguments[5] : nil
    lockResource("app-owner-fixture")
    let result = updateOwnership("owner-fixture", scope: scope, action: action, lease: lease,
                                 next: next, expectedOwner: next,
                                 authorized: CommandLine.arguments.contains("--authorized"))
    emitJSON(["ok": true, "owner": result.owner as Any? ?? NSNull(), "lease": result.generation])
} else if mode == "cache" {
    let token = CommandLine.arguments[2]
    let key = CommandLine.arguments[3]
    let node = Node(idx: 10, role: "AXButton", label: "Save", frame: nil, actions: [], depth: 0, path: [0], settable: false, enabled: true, value: nil, axid: "save", help: nil)
    saveCache("fixture", [node], winIndex: 1, winTitle: "fixture", token: "latest", pid: 123, windowID: 42, complete: token != "partial")
    snapshotToken = token == "missing" ? nil : token == "partial" ? "latest" : token
    _ = loadCache(key, idx: 10)
    emitJSON(["ok": true, "found": loadCache(key, idx: 10) != nil])
} else if mode == "permission" {
    requireAXAccess(trusted: false)
} else if mode == "background-failure" {
    requireExplicitCoordinate(false)
} else if mode == "clipboard" {
    let pb = NSPasteboard(name: NSPasteboard.Name("computer-control-test-" + UUID().uuidString))
    pb.clearContents()
    let saved = snapshotPasteboard(pb)
    assert(saved.isEmpty)
    pb.setString("temporary", forType: .string)
    clipboardSaved = saved
    clipboardOwnerCount = pb.changeCount
    cleanupClipboard { pb }
    assert(clipboardRestored && pb.string(forType: .string) == nil)
    pb.setString("original", forType: .string)
    clipboardSaved = snapshotPasteboard(pb)
    pb.setString("temporary", forType: .string)
    clipboardOwnerCount = pb.changeCount
    pb.setString("new-user-copy", forType: .string)
    cleanupClipboard { pb }
    assert(pb.string(forType: .string) == "new-user-copy")
    pb.releaseGlobally()
    emitJSON(["ok": true])
} else if mode == "inactive-cleanup" {
    clipboardSaved = nil
    cleanupClipboard { fatalError("inactive cleanup must not connect to pasteboard") }
    emitJSON(["ok": true])
} else if mode == "ownership" {
    assert(ownsClipboard(current: 7, expected: 7))
    assert(!ownsClipboard(current: 8, expected: 7))
    assert(!ownsClipboard(current: 7, expected: nil))
    emitJSON(["ok": true])
} else if mode == "attributes" {
    var bag = AttrBag()
    bag.recordError("AXHelp", .attributeUnsupported)
    bag.recordError("AXChildren", .noValue)
    assert(bag.readErrors.isEmpty)
    bag.recordError("AXChildren", .cannotComplete)
    bag.recordError("AXIdentifier", .invalidUIElement)
    bag.recordError("AXRole", .noValue)
    assert(bag.readErrors.count == 3)
    bag.recordError("AXURL", .failure)
    bag.recordError("AXSubrole", .failure)
    assert(bag.readErrors.count == 3 && bag.metadataErrors.count == 2)
    bag.recordError("AXActions:AXSplitter", .failure)
    assert(bag.readErrors.count == 3 && bag.metadataErrors.count == 3)
    bag.recordError("AXActions:AXGroup", .failure)
    assert(bag.readErrors.count == 3 && bag.metadataErrors.count == 4)
    bag.recordError("AXActions:AXGroup", .cannotComplete)
    bag.recordError("AXActions:AXSplitter", .cannotComplete)
    bag.recordError("AXActions:AXButton", .failure)
    assert(bag.readErrors.count == 6)
    walkRecordingErrors = true
    for attribute in ["AXActions", "AXValue:settable", "AXHidden", "AXAttributeNames"] {
        recordWalkError(attribute, .cannotComplete)
    }
    assert(walkReadIncomplete && walkReadErrors.count == 4)
    walkRecordingErrors = false
    let before = walkReadErrors.count
    recordWalkError("AXActions", .cannotComplete)
    assert(walkReadErrors.count == before)
    emitJSON(["ok": true, "errors": bag.readErrors])
} else if mode == "search" {
    let caseName = CommandLine.arguments[2]
    let limit = caseName == "depth" ? 1 : 30
    let nodes = caseName == "nodes" ? 1 : 100
    let budget: TimeInterval = caseName == "time" ? 0 : caseName == "slow-leaf" ? 0.01 : 8
    let hits = completeSearch(root: 0, children: { node in
        if caseName == "slow-leaf" { usleep(30000); return [] }
        return node < 2 ? [node + 1] : []
    },
                              match: { $0 == 0 || $0 == 2 }, maxDepth: limit, maxNodes: nodes, budget: budget)
    emitJSON(["ok": true, "hits": hits])
} else if mode == "removed-no-shot" {
    args = ["computer-control-fixture-app-that-does-not-exist", "--no-shot"]
    optionBoundary = nil
    runCommand("snap")
} else if mode == "scroll-direction" {
    args = ["computer-control-fixture-app-that-does-not-exist", "1", "sideways"]
    optionBoundary = nil
    runCommand("scroll")
} else if mode == "installed" {
    let found = CommandLine.arguments.dropFirst(2).map { installedAppURL($0)?.path ?? "" }
    emitJSON(["ok": true, "paths": found])
} else if mode == "open-missing" {
    taskScope = "fixture"
    args = [CommandLine.arguments[2]]
    optionBoundary = nil
    runCommand("open")
} else if mode == "quit" {
    let scenario = CommandLine.arguments[2]
    var requests = 0
    var checks = 0
    let result = requestApplicationQuit(NSRunningApplication.current, timeout: 0.12,
        request: { _ in requests += 1; return scenario != "refused" },
        isTerminated: { _ in
            checks += 1
            return scenario == "immediate" || (scenario == "eventual" && checks >= 2)
        })
    emitJSON(["ok": true, "requested": result.requested, "terminated": result.terminated,
              "requests": requests, "checks": checks])
} else if mode == "wake" {
    let beforeLocked = CommandLine.arguments[2] == "1"
    let afterArg = CommandLine.arguments[3]
    let afterLocked: Bool? = afterArg == "true" ? true : (afterArg == "false" ? false : nil)
    let beforeAsleep = CommandLine.arguments[4] == "1"
    let afterAsleep = CommandLine.arguments[5] == "1"
    let fields = wakeReport(beforeLocked: beforeLocked, beforeAsleep: beforeAsleep,
                            afterLocked: afterLocked, afterAsleep: afterAsleep,
                            frontmost: afterLocked == true ? "com.apple.loginwindow" : "company.thebrowser.Browser",
                            input: CommandLine.arguments.count > 6 ? CommandLine.arguments[6] : nil,
                            hold: 3, assertions: ["userActivity": true, "displaySleep": true])
    var out: [String: Any] = ["ok": true]
    for (key, value) in fields { out[key] = value }
    emitJSON(out)
} else if mode == "hotkey" {
    let spec = CommandLine.arguments[2]
    guard let parsed = parseHotkey(spec) else { emitJSON(["ok": false]); finish(2) }
    let plan = hotkeyEventPlan(code: parsed.code, flags: parsed.flags, modifiers: parsed.modifiers)
    emitJSON(["ok": true, "code": Int(parsed.code), "modifiers": parsed.modifiers.map { Int($0) },
              "flags": Int(parsed.flags.rawValue),
              "plan": plan.map { ["code": Int($0.keyCode), "down": $0.keyDown, "modifier": $0.modifier,
                                  "flags": Int($0.flags.rawValue)] }])
} else if mode == "window-ref" {
    let scenario = CommandLine.arguments[2]
    let app = NSRunningApplication.current
    var ref: [String: Any] = ["id": 42, "pid": Int(app.processIdentifier), "startedAt": 123.5, "bundleId": app.bundleIdentifier ?? ""]
    if scenario == "pid" { ref["pid"] = Int(app.processIdentifier) + 1 }
    if scenario == "generation" { ref["startedAt"] = 124.5 }
    let original = AXUIElementCreateApplication(123)
    let replacement = AXUIElementCreateApplication(124)
    let offered = scenario == "gone" ? [replacement] : scenario == "duplicate" ? [original, original] : [original]
    _ = resolveWindowRef(app, ref, windows: { _ in offered }, identify: { CFEqual($0, original) ? 42 : 99 }, launched: { _ in 123.5 })
    emitJSON(["ok": true])
} else if mode == "window-focus" {
    let ref: [String: Any] = ["id": 42, "pid": 123]
    assert(focusedWindowMatches(ref, frontPid: 123, focusedID: 42))
    assert(!focusedWindowMatches(ref, frontPid: 123, focusedID: 99))
    assert(!focusedWindowMatches(ref, frontPid: 124, focusedID: 42))
    assert(!focusedWindowMatches(ref, frontPid: nil, focusedID: nil))
    emitJSON(["ok": true])
} else if mode == "window-lock" {
    lockResource("window-" + CommandLine.arguments[2])
    emitJSON(["ok": true])
    fflush(stdout)
    usleep(250000)
} else if mode == "window-cache" {
    taskScope = "task-a"
    activeWindowRef = ["pid": 123, "startedAt": 100.0, "id": 42]
    let a = cacheURL("com.google.Chrome")
    activeWindowRef = ["pid": 123, "startedAt": 100.0, "id": 99]
    let b = cacheURL("com.google.Chrome")
    assert(a != b)
    activeWindowRef = nil
    assert(cacheURL("com.google.Chrome").lastPathComponent == "com.google.Chrome.json")
    emitJSON(["ok": true])
} else if mode == "window-close-result" {
    let scenario = CommandLine.arguments[2]
    var calls = 0
    var polls = 0
    var clock = 0.0
    let result = requestWindowClose(target: 42, initial: scenario == "missing" ? [99] : [42, 99], timeout: 1,
        request: { calls += 1; return scenario == "failed" ? .cannotComplete : .success },
        current: {
            polls += 1
            if scenario == "unreadable" { return nil }
            if scenario == "collateral" { return [] }
            if scenario == "timeout" || scenario == "hidden" { return [42, 99] }
            if scenario == "eventual" && polls < 3 { return [42, 99] }
            return [99]
        }, now: { clock }, pause: { clock += 0.5 })
    emitJSON(["ok": true, "requested": result.requested, "closed": result.closed, "calls": calls, "polls": polls, "error": result.error as Any? ?? NSNull()])
} else if mode == "frontmost" {
    let rawFront = CommandLine.arguments[2]
    let frontPid: pid_t? = rawFront == "-" ? nil : pid_t(rawFront)
    let targetPid = pid_t(CommandLine.arguments[3]) ?? 0
    let error = frontmostTargetError(frontPid: frontPid, frontName: frontPid == nil ? nil : "Front",
                                     targetPid: targetPid, targetName: "Target")
    emitJSON(["ok": true, "refused": error != nil, "error": error as Any? ?? NSNull()])
} else if mode == "lock" {
    lockResource("fixture")
    print("locked")
    fflush(stdout)
    usleep(250000)
}
finish(0)
"""

@unittest.skipUnless(sys.platform == "darwin", "needs macOS toolchain")
class Native(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="computer-control-native-tests-")
        cls.addClassCleanup(cls.temp.cleanup)
        cls.directory = Path(cls.temp.name)
        source = (ROOT / "bin/computer-control.swift").read_text()
        prefix = source.split('signal(SIGTERM)', 1)[0]
        harness = cls.directory / "probe.swift"
        harness.write_text(prefix + HARNESS)
        cls.binary = cls.directory / "probe"
        built = subprocess.run(["xcrun", "swiftc", "-O", str(harness), "-o", str(cls.binary)], capture_output=True, text=True)
        if built.returncode:
            raise AssertionError(built.stderr)
        cls.env = {**os.environ, "XDG_CACHE_HOME": str(cls.directory / "cache")}

    def invoke(self, *args):
        return subprocess.run([str(self.binary), *args], env=self.env, capture_output=True, text=True)

    def test_stable_window_ref_rejects_pid_generation_disappearance_and_duplicate(self):
        good = self.invoke("window-ref", "valid")
        self.assertEqual(good.returncode, 0, good.stdout + good.stderr)
        for scenario in ("pid", "generation", "gone", "duplicate"):
            with self.subTest(scenario=scenario):
                result = self.invoke("window-ref", scenario)
                self.assertEqual(result.returncode, 4, result.stdout + result.stderr)
                self.assertEqual(json.loads(result.stdout)["outcome"], "not_sent")

    def test_same_pid_other_focused_window_is_rejected(self):
        result = self.invoke("window-focus")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_window_caches_are_separate_and_nonbrowser_cache_remains_compatible(self):
        result = self.invoke("window-cache")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_window_locks_allow_different_windows_refuse_same_window(self):
        first = subprocess.Popen([str(self.binary), "window-lock", "fixture-a"], env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertTrue(json.loads(first.stdout.readline())["ok"])
            same = self.invoke("window-lock", "fixture-a")
            other = self.invoke("window-lock", "fixture-b")
            self.assertEqual(same.returncode, 6, same.stdout + same.stderr)
            self.assertEqual(other.returncode, 0, other.stdout + other.stderr)
        finally:
            first.communicate(timeout=5)

    def test_window_close_result_never_re_resolves_or_resends_after_disappearance(self):
        for scenario in ("immediate", "eventual"):
            result = self.invoke("window-close-result", scenario)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            data = json.loads(result.stdout)
            self.assertTrue(data["closed"])
            self.assertEqual(data["calls"], 1)

    def test_window_close_missing_is_not_sent_and_uncertain_results_are_not_success(self):
        for scenario in ("missing", "failed", "unreadable", "collateral", "timeout", "hidden"):
            result = self.invoke("window-close-result", scenario)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            data = json.loads(result.stdout)
            self.assertFalse(data["closed"])
            self.assertEqual(data["requested"], scenario != "missing")
            self.assertEqual(data["calls"], 0 if scenario == "missing" else 1)
            self.assertTrue(data["error"])

    def test_quit_requests_normal_termination_and_checks_actual_state(self):
        for scenario, expected in (("immediate", (True, True, 1)), ("eventual", (True, True, 1)),
                                   ("refused", (False, False, 1)), ("timeout", (True, False, 1))):
            with self.subTest(scenario=scenario):
                result = self.invoke("quit", scenario)
                self.assertEqual(result.returncode, 0, result.stderr)
                data = json.loads(result.stdout)
                self.assertEqual((data["requested"], data["terminated"], data["requests"]), expected)
                if scenario == "eventual": self.assertGreaterEqual(data["checks"], 2)
                if scenario == "timeout": self.assertGreaterEqual(data["checks"], 2)

    def test_quit_implementation_has_no_force_termination(self):
        self.assertNotIn("forceTerminate(", (ROOT / "bin/computer-control.swift").read_text())

    def owner_probe(self, action, scope, lease="-", next_scope=None, authorized=False, cache=None):
        argv = [str(self.binary), "owner", action, scope, lease]
        if next_scope is not None:
            argv.append(next_scope)
        if authorized:
            argv.append("--authorized")
        env = {**self.env, "XDG_CACHE_HOME": str(cache or self.owner_cache)}
        result = subprocess.run(argv, env=env, capture_output=True, text=True)
        return result, json.loads(result.stdout)

    def test_task_owner_handoff_fences_old_requests(self):
        self.owner_cache = self.directory / "handoff-cache"
        result, first = self.owner_probe("auto", "task-a")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.owner_probe("auto", "task-b")[0].returncode, 6)
        _, handed = self.owner_probe("handoff", "task-a", first["lease"], "task-b")
        self.assertEqual(handed["owner"], "task-b")
        self.assertNotEqual(first["lease"], handed["lease"])
        self.assertEqual(self.owner_probe("auto", "task-a", first["lease"])[0].returncode, 6)
        self.assertEqual(self.owner_probe("check", "task-b", handed["lease"])[0].returncode, 0)
        self.assertEqual(self.owner_probe("check", "task-b", first["lease"])[0].returncode, 4)
        self.assertEqual(self.owner_probe("release", "task-a", first["lease"])[0].returncode, 6)

    def test_task_release_requires_explicit_reclaim(self):
        self.owner_cache = self.directory / "release-cache"
        _, owned = self.owner_probe("auto", "task-a")
        _, released = self.owner_probe("release", "task-a", owned["lease"])
        self.assertIsNone(released["owner"])
        self.assertEqual(self.owner_probe("auto", "task-a")[0].returncode, 4)
        self.assertEqual(self.owner_probe("claim", "task-a", owned["lease"])[0].returncode, 4)
        result, reclaimed = self.owner_probe("claim", "task-a")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotEqual(reclaimed["lease"], owned["lease"])
        self.assertEqual(self.owner_probe("check", "task-a", owned["lease"])[0].returncode, 4)
        self.assertEqual(self.owner_probe("auto", "task-a")[0].returncode, 4)
        self.assertEqual(self.owner_probe("auto", "task-a", reclaimed["lease"])[0].returncode, 0)

    def test_recovery_never_guesses_expiration_or_dead_process(self):
        self.owner_cache = self.directory / "recover-cache"
        _, owned = self.owner_probe("auto", "dead-task")
        self.assertEqual(self.owner_probe("auto", "new-task")[0].returncode, 6)
        self.assertEqual(self.owner_probe("recover", "new-task", owned["lease"], "dead-task")[0].returncode, 6)
        self.assertEqual(self.owner_probe("recover", "new-task", "wrong", "dead-task", True)[0].returncode, 6)
        self.assertEqual(self.owner_probe("recover", "new-task", owned["lease"], "wrong-task", True)[0].returncode, 6)
        result, recovered = self.owner_probe("recover", "new-task", owned["lease"], "dead-task", True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(recovered["owner"], "new-task")
        self.assertNotEqual(recovered["lease"], owned["lease"])

    def test_concurrent_claims_have_exactly_one_winner(self):
        cache = self.directory / "race-cache"
        env = {**self.env, "XDG_CACHE_HOME": str(cache)}
        processes = [subprocess.Popen([str(self.binary), "owner", "auto", scope, "-"], env=env,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                     for scope in ("task-a", "task-b")]
        results = []
        for proc in processes:
            output, error = proc.communicate(timeout=10)
            results.append((proc.returncode, json.loads(output), error))
        self.assertEqual(sorted(r[0] for r in results), [0, 6], results)
        winner = next(r[1]["owner"] for r in results if r[0] == 0)
        self.owner_cache = cache
        self.assertEqual(self.owner_probe("auto", winner)[0].returncode, 0)

    def test_corrupt_persisted_ownership_refuses_without_overwrite(self):
        self.owner_cache = self.directory / "corrupt-cache"
        state_dir = self.owner_cache / "computer-control"
        state_dir.mkdir(parents=True)
        state_file = state_dir / "owner-owner-fixture.json"
        state_file.write_text("not-json")
        result, data = self.owner_probe("auto", "task-a")
        self.assertEqual(result.returncode, 4, result.stderr)
        self.assertEqual(state_file.read_text(), "not-json")

    def test_actual_parser_keeps_flags_as_text(self):
        result = self.invoke("flags")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)["ok"])

    def test_actual_cache_rejects_old_token_and_wrong_app(self):
        good = self.invoke("cache", "latest", "fixture")
        self.assertEqual(good.returncode, 0, good.stderr)
        stale = self.invoke("cache", "old", "fixture")
        self.assertEqual(stale.returncode, 4, stale.stderr)
        self.assertEqual(json.loads(stale.stdout)["code"], 4)
        wrong = self.invoke("cache", "latest", "other-app")
        self.assertEqual(wrong.returncode, 4)
        self.assertEqual(json.loads(wrong.stdout)["code"], 4)

    def test_actual_cache_requires_snapshot_token(self):
        for token in ("missing", ""):
            result = self.invoke("cache", token, "fixture")
            self.assertEqual(result.returncode, 4, result.stderr)
            self.assertIn("--snapshot", json.loads(result.stdout)["error"])

    def test_actual_search_refuses_partial_results(self):
        for reason in ("depth", "nodes", "time", "slow-leaf"):
            result = self.invoke("search", reason)
            self.assertEqual(result.returncode, 4, result.stderr)
            self.assertIn("不能确认唯一", json.loads(result.stdout)["error"])
        complete = self.invoke("search", "complete")
        self.assertEqual(complete.returncode, 0, complete.stderr)
        self.assertEqual(json.loads(complete.stdout)["hits"], [0, 2])

    def test_actual_cache_rejects_incomplete_observation(self):
        result = self.invoke("cache", "partial", "fixture")
        self.assertEqual(result.returncode, 4, result.stderr)
        self.assertIn("不完整", json.loads(result.stdout)["error"])

    def test_attribute_errors_distinguish_missing_optional_from_failed_read(self):
        result = self.invoke("attributes")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(json.loads(result.stdout)["errors"]), 6)

    def test_snap_rejects_removed_no_shot_before_touching_app(self):
        result = self.invoke("removed-no-shot")
        self.assertEqual(result.returncode, 2, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual(data["code"], 2)
        self.assertIn("--shot", data["error"])

    def test_scroll_rejects_unknown_direction_before_touching_app(self):
        result = self.invoke("scroll-direction")
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("sideways", json.loads(result.stdout)["error"])

    def test_open_and_snap_find_installed_app_by_chinese_english_or_bundle_id(self):
        result = self.invoke("installed", "计算器", "Calculator", "com.apple.calculator", "calculator")
        self.assertEqual(result.returncode, 0, result.stderr)
        paths = json.loads(result.stdout)["paths"]
        self.assertEqual(len(set(paths)), 1, paths)
        self.assertTrue(paths[0].endswith("/Calculator.app"), paths)

    def test_open_unknown_app_lists_similar_without_launching(self):
        result = self.invoke("open-missing", "Calculater")
        self.assertEqual(result.returncode, 3, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual(data["outcome"], "not_sent")
        self.assertIn("com.apple.calculator", data["error"])
        self.assertFalse((self.directory / "cache/computer-control/owner-com.apple.calculator.json").exists())

    def test_actual_ownership_guard(self):
        self.assertEqual(self.invoke("ownership").returncode, 0)

    def test_actual_permission_and_background_failure_codes(self):
        permission = self.invoke("permission")
        self.assertEqual(permission.returncode, 5)
        self.assertEqual(json.loads(permission.stdout)["code"], 5)
        background = self.invoke("background-failure")
        self.assertEqual(background.returncode, 1)
        self.assertEqual(json.loads(background.stdout)["code"], 1)

    def test_system_hotkey_plan_has_modifier_press_and_release(self):
        cases = [
            ("ctrl+space", [(59, True, True), (49, True, False), (49, False, False), (59, False, True)]),
            ("cmd+shift+space", [(55, True, True), (56, True, True), (49, True, False),
                                  (49, False, False), (56, False, True), (55, False, True)]),
        ]
        for spec, expected in cases:
            with self.subTest(spec=spec):
                result = self.invoke("hotkey", spec)
                self.assertEqual(result.returncode, 0, result.stderr)
                data = json.loads(result.stdout)
                self.assertEqual(data["code"], 49)
                self.assertEqual([(step["code"], step["down"], step["modifier"]) for step in data["plan"]], expected)
                self.assertNotEqual(data["plan"][0]["flags"], 0)
                self.assertEqual(data["plan"][-1]["flags"], 0)
        invalid = self.invoke("hotkey", "ctrl+")
        self.assertEqual(invalid.returncode, 2)

    def test_system_mode_refuses_non_frontmost_target(self):
        same = json.loads(self.invoke("frontmost", "41", "41").stdout)
        self.assertFalse(same["refused"])
        different = json.loads(self.invoke("frontmost", "41", "42").stdout)
        self.assertTrue(different["refused"])
        missing = json.loads(self.invoke("frontmost", "-", "42").stdout)
        self.assertTrue(missing["refused"])

    def test_wake_report_only_claims_desktop_when_really_unlocked(self):
        cases = [
            (("1", "false", "1", "0"), "desktop", True, True),
            (("1", "true", "1", "0"), "loginwindow", False, True),
            (("1", "false", "1", "1"), "asleep", False, False),
            (("0", "false", "0", "0"), "desktop", True, False),
        ]
        for args, state, reached, woke in cases:
            with self.subTest(args=args):
                result = self.invoke("wake", *args)
                self.assertEqual(result.returncode, 0, result.stderr)
                data = json.loads(result.stdout)
                self.assertEqual(data["state"], state)
                self.assertEqual(data["reachedDesktop"], reached)
                self.assertEqual(data["wokeDisplay"], woke)

    def test_inactive_cleanup_never_connects_to_pasteboard(self):
        result = self.invoke("inactive-cleanup")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)["ok"])

    def test_actual_private_pasteboard_empty_and_ownership(self):
        result = self.invoke("clipboard")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_actual_cross_process_lock(self):
        first = subprocess.Popen([str(self.binary), "lock"], env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(first.stdout.readline().strip(), "locked")
            start = time.monotonic()
            second = self.invoke("lock")
            elapsed = time.monotonic() - start
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertGreater(elapsed, 0.4)
            _, error = first.communicate(timeout=5)
            self.assertEqual(first.returncode, 0, error)
        finally:
            if first.poll() is None:
                first.kill()
                first.communicate()


@unittest.skipUnless(sys.platform == "darwin", "needs macOS toolchain")
class NativeSafety(unittest.TestCase):
    """Actual native control flow, with AX and posting boundaries isolated."""
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="computer-control-safety-tests-")
        cls.addClassCleanup(cls.temp.cleanup)
        directory = Path(cls.temp.name)
        source = (ROOT / "bin/computer-control.swift").read_text()
        def function(name):
            start = source.index("func " + name + ("<" if name == "completeSearch" else "("))
            end = source.index("\n}\n", start) + 3
            return source[start:end]
        harness = r"""
import AppKit
var jsonMode = true
var pasteCancelled = false
var actionSent = false
func checkOperationFocus() {
    if scenario == "focus-before" { die("focus changed", 4) }
    if scenario == "focus-during" && posted.count >= 2 { die("focus changed", 1) }
}
let mode = CommandLine.arguments[1]
let scenario = CommandLine.arguments[2]
let root = AXUIElementCreateApplication(111111)
let replacement = AXUIElementCreateApplication(111112)
let original = AXUIElementCreateApplication(111113)
struct CachedRef { var path: [Int]; var role: String; var label: String; var win: Int; var axid: String? }
func loadCache(_ key: String, idx: Int) -> CachedRef? {
    CachedRef(path: [0], role: "AXButton", label: "Save", win: 1, axid: scenario == "no-cached-id" ? nil : "save")
}
func verifiedWindow(_ app: NSRunningApplication, _ key: String, _ win: Int, _ q: String) -> AXUIElement { root }
func resolvePath(root: AXUIElement, path: [Int]) -> AXUIElement? { replacement }
func clean(_ s: String) -> String { s }
func axStr(_ el: AXUIElement, _ attribute: String) -> String? {
    if attribute == "AXRole" { return "AXButton" }
    if attribute == "AXIdentifier" {
        if CFEqual(el, original) { return "save" }
        if CFEqual(el, replacement) {
            if scenario == "unchanged" || scenario == "duplicate" { return "save" }
            if scenario == "changed-id" { return "other" }
        }
    }
    return nil
}
func labelOf(_ el: AXUIElement) -> String { "Save" }
func searchString(_ el: AXUIElement, _ attribute: String) -> String? { axStr(el, attribute) }
func searchChildren(_ el: AXUIElement) -> [AXUIElement] {
    guard CFEqual(el, root) else { return [] }
    return scenario == "moved" ? [replacement, original] : [replacement]
}
func findByRoleLabel(root: AXUIElement, role: String, label: String) -> [AXUIElement] { [replacement] }
func warn(_ message: String) {}
var posted: [String] = []
func emit(_ fields: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
}
func die(_ message: String, _ code: Int32 = 2) -> Never {
    emit(["ok": false, "code": Int(code), "outcome": code == 1 ? "unknown" : "not_sent", "posted": posted])
    exit(code)
}
func postToPid(_ event: CGEvent, _ pid: pid_t) -> String {
    posted.append(event.type == .keyDown ? "down" : "up")
    if scenario == "during" && posted.count == 1 { raise(SIGTERM) }
    if scenario == "last" && posted.count == 6 { raise(SIGTERM) }
    return "fixture"
}
"""
        harness += "\n" + "\n".join(function(name) for name in ("completeSearch", "locate", "sendText"))
        handler = next(line for line in source.splitlines() if line.startswith("signal(SIGTERM)"))
        harness += "\n" + handler + r"""
if mode == "locate" {
    let (found, _, _) = locate(NSRunningApplication.current, "fixture", 10, "fixture")
    emit(["ok": true, "target": CFEqual(found, original) ? "original" : "replacement"])
} else {
    if scenario == "before" { raise(SIGTERM) }
    let channel = sendText(pid: 111111, text: "A中😀")
    emit(["ok": true, "channel": channel, "posted": posted])
}
"""
        probe = directory / "probe.swift"
        probe.write_text(harness)
        cls.binary = directory / "probe"
        built = subprocess.run(["xcrun", "swiftc", str(probe), "-o", str(cls.binary)], capture_output=True, text=True)
        if built.returncode:
            raise AssertionError(built.stderr)

    def invoke(self, mode, scenario):
        result = subprocess.run([str(self.binary), mode, scenario], capture_output=True, text=True, timeout=10)
        return result, json.loads(result.stdout)

    def test_numbered_target_missing_original_id_is_rejected(self):
        for scenario in ("missing-id", "changed-id"):
            with self.subTest(scenario=scenario):
                result, data = self.invoke("locate", scenario)
                self.assertEqual(result.returncode, 4, data)
                self.assertEqual(data["outcome"], "not_sent")

    def test_numbered_target_relocates_original_id_not_same_label(self):
        result, data = self.invoke("locate", "moved")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(data["target"], "original")

    def test_numbered_target_keeps_valid_id_and_idless_label_behavior(self):
        for scenario in ("unchanged", "no-cached-id"):
            result, data = self.invoke("locate", scenario)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(data["target"], "replacement")

    def test_text_sigterm_stops_after_balanced_current_character(self):
        for scenario, expected in (("before", []), ("during", ["down", "up"]), ("last", ["down", "up"] * 3)):
            with self.subTest(scenario=scenario):
                result, data = self.invoke("text", scenario)
                self.assertEqual(result.returncode, 1, data)
                self.assertEqual(data["outcome"], "unknown")
                self.assertEqual(data["posted"], expected)

    def test_text_focus_change_stops_after_balanced_character(self):
        for scenario, code, count in (("focus-before", 4, 0), ("focus-during", 1, 2)):
            result = subprocess.run([str(self.binary), "text", scenario], capture_output=True, text=True)
            self.assertEqual(result.returncode, code, result.stdout + result.stderr)
            data = json.loads(result.stdout)
            self.assertEqual(len(data["posted"]), count)
            self.assertEqual(data["outcome"], "unknown" if count else "not_sent")

    def test_text_without_cancellation_delivers_all_characters(self):
        result, data = self.invoke("text", "normal")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(data["posted"], ["down", "up"] * 3)


class LauncherProtocol(unittest.TestCase):
    def test_capabilities_do_not_import_routing(self):
        probe = ("import runpy, sys\nsys.argv = sys.argv[1:]\ntry:\n runpy.run_path(sys.argv[0], run_name='__main__')\n"
                 "except SystemExit as exc:\n code = exc.code\nprint(sorted(m for m in sys.modules if m.startswith('agentkit.remote')), file=sys.stderr)\nsys.exit(code)\n")
        for args in (["--capabilities", "--json"], ["--local", "--capabilities", "--json"]):
            result = subprocess.run([sys.executable, "-c", probe, str(ROOT / "scripts/computer-control"), *args], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stderr.strip().splitlines()[-1], "[]")
            data = json.loads(result.stdout)
            self.assertEqual((data["tool"], data["protocol"]), ("computer-control", 1))
            self.assertTrue({"local-routing", "snapshot-token", "snapshot-status"} <= set(data["features"]))
