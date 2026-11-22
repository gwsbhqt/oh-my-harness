"""Cra-shaped inputs backed by page-scoped Chrome DevTools MCP tools."""
from __future__ import annotations

import asyncio
import json
import re
import stat
from pathlib import Path
from urllib.parse import unquote, urlsplit, urlunsplit
from uuid import uuid4

from .protocol import BrowserError, checked_reply


INPUT_TOOLS = frozenset({
    "page_click", "page_fill", "page_type", "page_press", "page_hover",
    "page_select", "page_drag", "page_scroll", "page_upload",
})
_KEYS = {"Enter", "Tab", "Backspace", "Delete", "Escape", "Space", "Home", "End",
         "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
         *(f"F{i}" for i in range(1, 13))}
_WRITES = {"POST", "PUT", "PATCH", "DELETE"}


def _arguments(name, a):
    if name not in INPUT_TOOLS:
        raise BrowserError("unsupported", f"Unknown input tool {name}")
    if a.get("humanize") or name == "page_scroll":
        raise BrowserError("unsupported", "Chrome DevTools MCP has no paced input or wheel tool.")
    point = "x" in a or "y" in a
    if point and ("x" not in a or "y" not in a or min(a["x"], a["y"]) < 0):
        raise BrowserError("invalid_arguments", "Supply both nonnegative screenshot coordinates.")
    targets = sum((point, "ref" in a, "selector" in a))
    if targets > 1 or (not targets and name not in {"page_type", "page_press"}):
        raise BrowserError("invalid_arguments", "Supply exactly one input target, or use current focus for type/press.")
    for k in ("ref", "selector", "targetSelector"):
        if k in a and (not a[k] or len(a[k].encode("utf-8")) > (2048 if k != "ref" else 100)):
            raise BrowserError("invalid_arguments", f"Invalid {k}.")
    if point and name not in {"page_click", "page_upload"}:
        raise BrowserError("unsupported", "This Chrome tool needs an element reference or selector.")
    if name == "page_click" and (a.get("button", "left") != "left" or a.get("clickCount", 1) > 2 or "modifiers" in a):
        raise BrowserError("unsupported", "Chrome supports single and double left clicks without modifiers.")
    if "text" in a and any((ord(ch) < 32 and ch != "\n") or ord(ch) == 127 for ch in a["text"]):
        raise BrowserError("invalid_arguments", "Text may contain newlines but no other control characters.")
    if name == "page_press":
        key = a["key"]
        if key not in _KEYS and not (len(key) == 1 and " " <= key <= "~"):
            raise BrowserError("invalid_arguments", "Use a named Cra key or a single printable ASCII key.")
        mods = a["modifiers"].split("+") if "modifiers" in a else []
        if set(mods) - {"Shift", "Control", "Alt", "Meta"} or len(set(mods)) != len(mods):
            raise BrowserError("invalid_arguments", "Modifiers must be distinct Shift, Control, Alt or Meta keys.")
    if name == "page_select" and (("value" in a) == ("label" in a)):
        raise BrowserError("invalid_arguments", "Choose one option by value or label.")
    for k in ("label", "value"):
        if k in a and len(a[k].encode("utf-8")) > 2048:
            raise BrowserError("invalid_arguments", f"{k} exceeds 2048 bytes.")


def _files(control, paths):
    if not control.local_files:
        raise BrowserError("unsupported", "Upload requires an explicitly selected browser on the same filesystem.")
    files = []
    for path in paths:
        p = Path(path)
        if not p.is_absolute() or "\0" in path or len(path.encode("utf-8")) > 4096:
            raise BrowserError("invalid_arguments", "Each file must have an absolute local path.")
        try:
            info = p.lstat()
        except OSError as exc:
            raise BrowserError("invalid_arguments", "An upload file is inaccessible.") from exc
        if not stat.S_ISREG(info.st_mode) or info.st_size > 16 * 1024**2:
            raise BrowserError("invalid_arguments", "Choose regular, non-symlink files of at most 16 MiB each.")
        files.append({"name": p.name, "size": info.st_size})
    if sum(f["size"] for f in files) > 64 * 1024**2:
        raise BrowserError("invalid_arguments", "The files exceed 64 MiB in total.")
    return files


def redacted_url(raw):
    """Format a URL for a page report without user info, credentials or fragments."""
    try:
        u = urlsplit(raw)
        host = u.hostname
        if u.scheme not in {"http", "https"} or not host:
            return f"{u.scheme}:…" if u.scheme else "…"
        host = f"[{host}]" if ":" in host else host
        if u.port is not None:
            host += f":{u.port}"
    except ValueError:
        return "…"

    def token_like(value):
        decoded = unquote(value)
        return ":" in decoded or (len(decoded) >= 20 and re.search(r"[A-Za-z]", decoded) and re.search(r"[0-9]", decoded))

    path = "/".join("…" if token_like(p) else p for p in u.path.split("/"))
    sensitive = ("code", "token", "pass", "secret", "key", "sig", "auth", "session", "state", "nonce", "jwt", "otp", "ticket", "credential", "sid")
    pairs = []
    for pair in u.query.split("&") if u.query else ():
        key, separator, value = pair.partition("=")
        if not re.fullmatch(r"[\w.\[\]-]+", key):
            pairs.append("…=…")
        elif separator and (any(marker in key.lower() for marker in sensitive) or token_like(value)):
            pairs.append(key + "=…")
        else:
            pairs.append(pair)
    return urlunsplit((u.scheme, host, path, "&".join(pairs), ""))[:500]


def _text(reply):
    return "\n".join(b.get("text", "") for b in reply["content"] if b.get("type") == "text")


async def _requests(control, page_id):
    name = "list_network_requests"
    reply = checked_reply(name, await control.google(name, {"pageId": page_id, "includePreservedRequests": True}))
    data = reply.get("structuredContent") or {}
    if not isinstance(data, dict):
        raise BrowserError("observation_incomplete", "Chrome returned an invalid network observation.")
    rows = data.get("networkRequests")
    text = _text(reply)
    if data.get("reconnected"):
        raise BrowserError("observation_incomplete", "The Chrome connection changed.")
    if rows is None:
        if "## Network requests\nNo requests found." in text:
            return {}
        count = re.search(r"(?m)^Showing 1-(\d+) of (\d+) \(Page 1 of 1\)\.$", text)
        matches = re.findall(r"(?m)^reqid=(\d+) (\S+) (.+?) \[([^\]]+)\](?: \[selected in the DevTools Network panel\])?$", text)
        if not count or int(count[1]) != int(count[2]) or len(matches) != int(count[1]):
            raise BrowserError("observation_incomplete", "The network response was incomplete.")
        rows = [dict(requestId=int(i), method=m, url=u, status=s) for i, m, u, s in matches]
    pagination = data.get("pagination") or {}
    if not isinstance(pagination, dict) or any(pagination.get(k) for k in ("hasNextPage", "hasPreviousPage", "invalidPage")):
        raise BrowserError("observation_incomplete", "The network list was paginated.")
    if not isinstance(rows, list):
        raise BrowserError("observation_incomplete", "Chrome returned an invalid request list.")
    requests = {}
    for row in rows:
        if not isinstance(row, dict) or type(row.get("requestId")) not in (int, str) or not all(isinstance(row.get(k), str) for k in ("method", "url", "status")):
            raise BrowserError("observation_incomplete", "The network list contained an unreadable entry.")
        rid = str(row["requestId"])
        if rid in requests:
            raise BrowserError("observation_incomplete", "The network list repeated a request identifier.")
        requests[rid] = {"method": row["method"], "url": redacted_url(row["url"]), "status": row["status"]}
    return requests


async def _observe(control, page_id, errors, name):
    try:
        if name == "network":
            return await _requests(control, page_id)
        result = await control.snapshot(page_id, interactive=True)
        if isinstance(result.get("elements"), list):
            return result
    except BrowserError:
        pass
    errors.append(f"The {name} observation was unavailable or incomplete.")
    return None


def _element_line(e):
    state = ", ".join(f"{k}={json.dumps(e[k], ensure_ascii=False)}" for k in
                      ("checked", "selected", "expanded", "disabled", "focused", "required", "level") if k in e)
    label = json.dumps(e.get("name", ""), ensure_ascii=False)
    return f'{e.get("role", "")} {label}' + (f" [{state}]" if state else "") + f' {e["ref"]}'


def _diff(before, after, changes, errors):
    for key in ("url", "title"):
        if key in before and key in after and before[key] != after[key]:
            values = [before[key], after[key]]
            if key == "url":
                values = [redacted_url(v) for v in values]
            changes[key] = dict(zip(("from", "to"), values))
    new_doc = "document" in before and "document" in after and before["document"] != after["document"]
    if new_doc:
        changes["document"] = "new"
    old = {} if new_doc else {e["ref"]: _element_line(e) for e in before["elements"] if e.get("ref")}
    new = {e["ref"]: _element_line(e) for e in after["elements"] if e.get("ref")}
    if before.get("truncated") or after.get("truncated"):
        errors.append("The interactive snapshot was truncated.")
    additions = [v for k, v in new.items() if k not in old] if new_doc or not before.get("truncated") else []
    updates = [f"{v} (was {old[k]})" for k, v in new.items() if k in old and old[k] != v]
    removals = [v for k, v in old.items() if k not in new] if not after.get("truncated") else []
    for key, rows in (("added", additions), ("changed", updates), ("removed", removals)):
        if rows:
            changes[key] = rows[:40]
            if len(rows) > 40:
                errors.append(f"{len(rows) - 40} more {key} elements were omitted.")


async def _changes(control, page_id, before, previous, errors):
    changes = {}
    # Allow the page's handlers a turn; only wait further for observed in-flight requests.
    clock = asyncio.get_running_loop()
    deadline = clock.time() + 1.5
    await asyncio.sleep(0.06)
    latest = await _observe(control, page_id, errors, "network")
    if latest is not None and previous is not None:
        while any(r["status"] == "pending" for k, r in latest.items() if k not in previous):
            if clock.time() >= deadline:
                changes["unsettled"] = "Requests observed during the action were still pending."
                break
            await asyncio.sleep(0.1)
            update = await _observe(control, page_id, errors, "network")
            if update is None:
                break
            latest = update
        if previous.keys() - latest.keys():
            errors.append("Chrome no longer retains all requests from before the action.")
        writes = [r for k, r in latest.items() if k not in previous and r["method"] in _WRITES]
        if writes:
            changes["network"] = writes[:20]
            if len(writes) > 20:
                errors.append(f"{len(writes) - 20} more writes were omitted.")
    after = await _observe(control, page_id, errors, "snapshot")
    if before is not None and after is not None:
        _diff(before, after, changes, errors)
    if errors:
        changes["incomplete"] = list(dict.fromkeys(errors))
    # Request IDs identify newly observed writes on this page, not which script caused them.
    changes["networkScope"] = "Page requests observed between samples; concurrent activity can be included and later requests missed."
    return changes


async def _match_uid(evaluate, page_id, uids, expression):
    """Match a DOM node to an upstream handle by identity, never by its text or index."""
    function = f"(...nodes) => {{ const wanted = {expression}; return wanted?.isConnected ? nodes.indexOf(wanted) : -1; }}"

    async def check(uids):
        try:
            index = await evaluate(page_id, function, uid=uids)
        except BrowserError as exc:
            # Google evaluates handles from one frame at a time. Split only documented node/frame failures.
            message = str(exc)
            if exc.code != "tool_error" or not any(s in message for s in (
                "different frames", "no longer exists", "not found on page", "Cannot find context",
            )):
                raise
            if len(uids) == 1:
                return None
            middle = len(uids) // 2
            return await check(uids[:middle]) or await check(uids[middle:])
        if type(index) is not int or not -1 <= index < len(uids):
            raise BrowserError("protocol_error", "Google returned an invalid node identity comparison.")
        return None if index == -1 else uids[index]

    for start in range(0, len(uids), 40):
        found = await check(uids[start:start + 40])
        if found is not None:
            return found
    raise BrowserError("unsupported_target", "The node is detached or has no matching handle in this Google snapshot.")


async def _selector_uid(evaluate, page_id, uids, selector):
    selector = json.dumps(selector)
    query = f"document.querySelectorAll({selector})"
    count = await evaluate(page_id, f"() => {{ try {{ return {query}.length; }} catch {{ return -1; }} }}")
    if type(count) is not int or count != 1:
        raise BrowserError("invalid_target", "The selector must be valid and match exactly one element in the main document.")
    return await _match_uid(evaluate, page_id, uids,
                            f"window === window.top && {query}.length === 1 ? {query}[0] : null")


# Google dispatches all input. This probe verifies its target and guards keyboard focus during delivery.
_PROBE = r"""(bound, destination) => {
  const cfg = SETTINGS;
  const failure = (message, code = 'unsupported_target') => ({error: message, code});
  let topWindow;
  try { topWindow = window.top; void topWindow.document; }
  catch { return failure('The target is in a frame whose input landing cannot be verified.'); }
  const active = () => {
    let n = topWindow.document.activeElement;
    while (n) {
      const child = n.shadowRoot?.activeElement || (n.tagName === 'IFRAME' && n.contentDocument?.activeElement);
      if (!child || child === n) break;
      n = child;
    }
    return n;
  };
  const hit = (doc, x, y) => {
    let n = doc.elementFromPoint(x, y);
    while (n?.shadowRoot) {
      const next = n.shadowRoot.elementFromPoint(x, y);
      if (!next || next === n) break;
      n = next;
    }
    return n;
  };
  const target = bound || (cfg.point ? hit(document, ...cfg.point) : active());
  if (!target || target.nodeType !== 1 || !target.isConnected) return failure('The input target is gone. Take a new snapshot.', 'stale_ref');
  const doc = target.ownerDocument;
  const tag = target.tagName;
  const field = tag === 'TEXTAREA' || (tag === 'INPUT' && ['text','search','url','tel','email','password'].includes(target.type));
  const rich = target.isContentEditable;
  const editable = field || rich;
  const text = cfg.text || '';
  const focused = () => {
    const n = active();
    return n === target || (rich && target.contains(n));
  };
  const readText = () => field ? target.value : target.innerText;
  const atEnd = () => {
    if (field) return target.selectionStart === target.value.length && target.selectionEnd === target.value.length;
    const sel = doc.getSelection();
    if (!sel?.isCollapsed || !sel.rangeCount || !target.contains(sel.anchorNode)) return false;
    const tail = doc.createRange();
    tail.selectNodeContents(target);
    tail.setStart(sel.anchorNode, sel.anchorOffset);
    return !tail.toString();
  };
  const singleLine = tag === 'INPUT';
  if (!bound && !cfg.point && tag === 'IFRAME') return failure('Focus is inside a frame that Chrome cannot verify.');
  if (target.matches(':disabled') || target.closest('[inert]')) return failure('The target is disabled or inert.');
  if (!cfg.point && cfg.name === 'page_click' && tag === 'OPTION') return failure('Use page_select for native options.');
  if (cfg.name !== 'page_upload') {
    for (const n of [target, destination].filter(Boolean)) {
      const win = n.ownerDocument.defaultView;
      const rect = n.getBoundingClientRect();
      if (!rect.width || !rect.height || win.getComputedStyle(n).visibility !== 'visible') return failure('The target is not visible.');
      const left = Math.max(0, rect.left), right = Math.min(win.innerWidth, rect.right);
      const top = Math.max(0, rect.top), bottom = Math.min(win.innerHeight, rect.bottom);
      const needsPointer = cfg.point || ['page_click','page_drag','page_hover'].includes(cfg.name) || (!focused() && cfg.targeted);
      if (needsPointer && !cfg.point && left < right && top < bottom) {
        const under = n.getRootNode().elementFromPoint?.((left + right) / 2, (top + bottom) / 2);
        if (under && !n.contains(under)) return failure('Another element covers the target.');
      }
    }
  }
  if (['page_type','page_fill'].includes(cfg.name)) {
    if (!editable || target.readOnly) return failure('Choose a writable text field, textarea or editable element.');
    if (singleLine && text.includes('\n') && !(cfg.name === 'page_type' && text.indexOf('\n') === text.length - 1)) {
      return failure('Use a separate Enter press to submit a single-line field.');
    }
    if (cfg.name === 'page_type' && field && target.selectionStart === null && target.value.length) {
      return failure('Chrome does not expose a caret for this field; use page_fill.');
    }
  }
  if (cfg.name === 'page_press' && cfg.targeted && !focused() && !editable) {
    return failure('The non-editable target is not focused; clicking it could activate it.');
  }
  if (cfg.name === 'page_upload') {
    if (tag !== 'INPUT' || target.type !== 'file' || target.webkitdirectory) return failure('Choose a directly addressable file input.');
    if (cfg.fileCount > 1 && !target.multiple) return failure('This file input accepts only one file.');
  }
  let option = null;
  if (cfg.name === 'page_select') {
    if (tag !== 'SELECT' || target.multiple) return failure('Choose a single native HTML select.');
    const norm = s => s.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
    const options = Array.from(target.options);
    const matches = options.filter(o => !o.matches(':disabled') &&
      (cfg.value !== undefined ? o.value === cfg.value : norm(o.label) === norm(cfg.label)));
    if (matches.length !== 1) return failure('The requested value or label must match exactly one enabled option.');
    option = matches[0];
    if (options.some(o => o !== option && o.value === option.value)) return failure('Chrome cannot safely distinguish options that share a value.');
  }
  const counts = {};
  let keyboardArmed = false, focusLost = false;
  let releasedAtDestination = false;
  const events = ['pointerdown','pointerup','mousemove','mousedown','mouseup','click','dblclick','keydown','beforeinput','keypress','keyup','input','change','dragstart','drop'];
  const observe = e => {
    if (!e.isTrusted) return;
    const path = e.composedPath();
    if (keyboardArmed && ['keydown','beforeinput','keypress','keyup'].includes(e.type) &&
        (focusLost || !focused() || !path.includes(target))) {
      focusLost = true;
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (path.includes(target)) counts[e.type] = (counts[e.type] || 0) + 1;
    if (destination && ['pointerup','mouseup','drop'].includes(e.type)) {
      releasedAtDestination ||= path.includes(destination) || destination.contains(hit(destination.ownerDocument, e.clientX, e.clientY));
    }
  };
  const win = doc.defaultView;
  let expected;
  const close = () => {
    for (const type of events) win.removeEventListener(type, observe, true);
    topWindow.clearTimeout(timer);
    delete topWindow[cfg.token];
  };
  const inspect = op => {
    if (op === 'close') { close(); return true; }
    if (op === 'option') return option;
    if (op === 'prepare') {
      if (!target.isConnected || !focused()) return failure('Keyboard focus moved away from the original target.', 'input_landing');
      keyboardArmed = cfg.name === 'page_type' || cfg.name === 'page_fill';
      if (field && cfg.name === 'page_type') {
        const start = target.selectionStart ?? 0, end = target.selectionEnd ?? 0;
        expected = target.value.slice(0, start) + text + target.value.slice(end);
      }
    }
    keyboardArmed &&= op !== 'finish';
    const state = {focusLost, connected: target.isConnected, focused: focused(), atEnd: editable && atEnd(),
      counts, target: {tag}, framed: cfg.point && tag === 'IFRAME', singleLine, releasedAtDestination,
      timeOrigin: topWindow.performance.timeOrigin};
    if (cfg.name === 'page_hover') state.hovered = target.matches(':hover');
    if (option) { state.picked = option.label; state.selected = option.isConnected && target.options[target.selectedIndex] === option; }
    if (op === 'finish' && editable && ['page_type','page_fill'].includes(cfg.name)) {
      state.textMatches = cfg.name === 'page_fill' ? readText() === text : field ? readText() === expected : readText().includes(text);
    }
    if (op === 'finish' && cfg.name === 'page_upload') state.files = Array.from(target.files, f => ({name: f.name, size: f.size}));
    return state;
  };
  for (const type of events) win.addEventListener(type, observe, {capture: true});
  const timer = topWindow.setTimeout(close, 120000);
  Object.defineProperty(topWindow, cfg.token, {value: inspect, configurable: true});
  return inspect('start');
}"""


class _Input:
    def __init__(self, control, page_id):
        self.control = control
        self.page_id = page_id
        self.token = json.dumps('browser-input-' + uuid4().hex)
        self.sent = False
        self.terminal = None
        self.time_origin = None

    async def send(self, tool, **arguments):
        reply = checked_reply(tool, await self.control.google(tool, {"pageId": self.page_id, **arguments}))
        self.sent = True
        data = reply.get("structuredContent") or {}
        text = _text(reply)
        if data.get("dialog") or ("structuredContent" not in reply and "# Open dialog\n" in text):
            self.terminal = {"status": "dialog_opened", "input": "chromium", "next": "Answer the dialog with page_dialog."}
            if data.get("dialog"):
                self.terminal["dialog"] = data["dialog"]
        elif data.get("navigatedToUrl") or ("structuredContent" not in reply and re.search(r"(?m)^Page navigated to .+\.$", text)):
            self.terminal = {"status": "navigation_observed", "input": "chromium"}

    async def inspect(self, step):
        fn = f"() => window[{self.token}]?.({json.dumps(step)}) ?? null"
        result = await self.control.evaluate(self.page_id, fn)
        if result is None:
            now = await self.control.evaluate(self.page_id, "() => performance.timeOrigin")
            if self.sent and now != self.time_origin:
                self.terminal = {"status": "navigation_observed", "input": "chromium"}
                return {}
            raise BrowserError("input_landing", "The input observer expired. Inspect the page before continuing.")
        return _verified(result)

    async def act(self, name, a, uid, destination, point, files):
        cfg = {k: a[k] for k in ("text", "label", "value") if k in a}
        cfg.update(name=name, token=json.loads(self.token), targeted=uid is not None,
                   point=point, fileCount=len(files))
        handles = [uid, destination] if destination is not None else uid
        state = _verified(await self.control.evaluate(self.page_id, _PROBE.replace("SETTINGS", json.dumps(cfg)), uid=handles))
        self.time_origin = state["timeOrigin"]
        if name in {"page_fill", "page_type", "page_press"}:
            if uid is not None and not state["focused"]:
                await self.send("click", uid=uid)
                if self.terminal:
                    return self.terminal
                state = await self.inspect("prepare")
                if self.terminal:
                    return self.terminal
                if name == "page_type" and not state["atEnd"]:
                    await self.send("press_key", key="End" if state["singleLine"] else "Control+End")
                    if self.terminal:
                        return self.terminal
                    state = await self.inspect("prepare")
                    if self.terminal:
                        return self.terminal
                    if not state["atEnd"]:
                        raise BrowserError("input_landing", "Chrome could not verify the caret at the end; no text was typed.")
            elif name != "page_press" or uid is not None:
                state = await self.inspect("prepare")
            if name == "page_press":
                key = "+".join(filter(None, (a.get("modifiers"), a["key"])))
                await self.send("press_key", key=key)
            elif name == "page_fill":
                await self.send("fill", uid=uid, value=a["text"])
            else:
                text = a["text"]
                if state["singleLine"] and text.endswith("\n"):
                    await self.send("type_text", text=text[:-1], submitKey="Enter")
                else:
                    await self.send("type_text", text=text)
        elif name == "page_select":
            if not state["selected"]:
                # Public snapshots suppress combobox children. Use Google's actual option handles internally.
                reply = await self.control.google("take_snapshot", {"pageId": self.page_id})
                root = (checked_reply("take_snapshot", reply).get("structuredContent") or {}).get("snapshot")
                if not isinstance(root, dict):
                    raise BrowserError("protocol_error", "Chrome did not return the structured accessibility tree.")
                pending, options = [root], []
                while pending:
                    node = pending.pop()
                    if node.get("role") == "option" and node.get("id"):
                        options.append(node["id"])
                    pending.extend(node.get("children", ()))
                option = await _match_uid(
                    self.control.evaluate, self.page_id, options,
                    f"(() => {{ try {{ return window.top[{self.token}]?.('option'); }} catch {{ return null; }} }})()",
                )
                await self.send("click", uid=option)
        elif name == "page_click":
            double = a.get("clickCount", 1) == 2
            if point is None:
                await self.send("click", uid=uid, dblClick=double)
            else:
                await self.send("click_at", x=point[0], y=point[1], dblClick=double)
        elif name == "page_hover":
            await self.send("hover", uid=uid)
        elif name == "page_drag":
            await self.send("drag", from_uid=uid, to_uid=destination)
        else:
            await self.send("upload_file", uid=uid, filePaths=a["paths"])
        if self.terminal:
            return self.terminal
        final = await self.inspect("finish")
        if self.terminal:
            return self.terminal
        counts = final["counts"]
        result = {"status": "completed", "input": "chromium", "target": final["target"], "trustedEvents": counts}
        failure = None
        if name == "page_click":
            result["focusInTarget"] = final["focused"]
            if point:
                result["at"] = {"x": a["x"], "y": a["y"]}
            if final["framed"]:
                result["eventVerification"] = "The click was sent into a frame; check its contents."
            elif counts.get("click", 0) < a.get("clickCount", 1):
                failure = "The original target did not receive the requested clicks."
        elif name == "page_hover" and not (final["hovered"] or counts.get("mousemove")):
            failure = "The pointer did not land on the requested element."
        elif name == "page_press" and not counts.get("keydown"):
            failure = "The focused element did not observe a trusted key press."
        elif name in ("page_type", "page_fill"):
            submitting = name == "page_type" and state["singleLine"] and a["text"].endswith("\n")
            if final["focusLost"]:
                failure = "Focus moved during input. Further keyboard events to the wrong element were blocked."
            elif submitting:
                if not counts.get("keydown"):
                    failure = "The field did not observe keyboard input."
                result["eventVerification"] = "A submit key was sent; inspect the page for the result."
            elif not final["connected"] or not final["textMatches"]:
                failure = "The original editable element does not contain the expected text."
            else:
                result["textVerified"] = True
        elif name == "page_select":
            if not final["selected"]:
                failure = "The requested option was not selected."
            result["picked"] = final["picked"]
        elif name == "page_upload":
            if not final["connected"] or final["files"] != files:
                failure = "The file input does not contain the requested names and sizes."
            result["files"] = final["files"]
        elif name == "page_drag":
            if not (counts.get("pointerdown") or counts.get("dragstart")) or not final["releasedAtDestination"]:
                failure = "The page did not confirm a drag from the source to the destination."
            result["kind"] = "html" if counts.get("dragstart") else "pointer"
        if failure:
            raise BrowserError("input_landing", failure, data={"trustedEvents": counts})
        return result


def _verified(state):
    if not isinstance(state, dict):
        raise BrowserError("protocol_error", "Chrome returned no input observation.")
    if state.get("error"):
        raise BrowserError(state["code"], state["error"])
    return state


async def perform(control, name, arguments):
    """Perform one input on its bound page. The caller validates the public tool schema."""
    _arguments(name, arguments)
    a = arguments
    files = _files(control, a["paths"]) if name == "page_upload" else []
    page_id = await control.page_id(a["tabId"])
    action = _Input(control, page_id)
    report = name != "page_hover" and a.get("changes", True)
    before = previous = destination = point = None
    errors = []
    try:
        uid = await control.uid_for(page_id, a["ref"]) if "ref" in a else None
        if report:
            before = await _observe(control, page_id, errors, "snapshot")
        uids = []
        if "selector" in a or "targetSelector" in a or (name == "page_upload" and "x" in a):
            elements = (await control.snapshot(page_id))["elements"]
            uids = [await control.uid_for(page_id, e["ref"]) for e in elements if e.get("ref")]
        if "ref" in a and (report or "targetSelector" in a):
            uid = await control.uid_for(page_id, a["ref"])
        if "selector" in a:
            uid = await _selector_uid(control.evaluate, page_id, uids, a["selector"])
        if "targetSelector" in a:
            destination = await _selector_uid(control.evaluate, page_id, uids, a["targetSelector"])
        if "x" in a:
            point = await control.screenshot_point(page_id, a["x"], a["y"])
            if name == "page_upload":
                uid = await _match_uid(control.evaluate, page_id, uids,
                                      f"window === window.top ? document.elementFromPoint(...{json.dumps(point)}) : null")
        if report:
            previous = await _observe(control, page_id, errors, "network")
        result = await action.act(name, a, uid, destination, point, files)
    except BrowserError as exc:
        if not action.sent and action.time_origin is None and "ref" in a and exc.code == "tool_error":
            if re.search(r"Element (?:with uid .+ no longer exists on the page|uid .+ not found on page)", str(exc)):
                raise BrowserError("stale_ref", "The referenced element is gone. Take a fresh snapshot.") from exc
        if action.sent and exc.outcome != "unknown":
            raise BrowserError(exc.code, str(exc), outcome="unknown", data=exc.data) from exc
        raise
    finally:
        if action.time_origin is not None and (action.terminal or {}).get("status") != "dialog_opened":
            try:
                await control.evaluate(page_id, f"() => window[{action.token}]?.('close') ?? false")
            except BrowserError:
                pass  # Navigation destroys the observer; a live observer also has its own expiry.
    if report and result["status"] != "dialog_opened":
        result["changes"] = await _changes(control, page_id, before, previous, errors)

    return result
