// computer-control — macOS desktop control for agents
// 设计参考：OpenAI Codex Computer Use 的接口形态（一次取态 → 拿带编号的元素 → 按编号操作）
// 使用 Accessibility、CoreGraphics 和 screencapture；定向鼠标投递还使用 SkyLight 私有接口，来源见 VENDORED.md。
import Cocoa
import ApplicationServices
import IOKit.pwr_mgt

let VERSION = "0.2.0"

// ==================== AX 基础 ====================

func axCopy(_ el: AXUIElement, _ attr: String) -> CFTypeRef? {
    var v: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(el, attr as CFString, &v)
    recordWalkError(attr, error)
    return error == .success ? v : nil
}

func axStr(_ el: AXUIElement, _ attr: String) -> String? {
    guard let v = axCopy(el, attr) else { return nil }
    if let s = v as? String { return s.isEmpty ? nil : s }
    if let n = v as? NSNumber { return n.stringValue }
    return nil
}

func axChildren(_ el: AXUIElement) -> [AXUIElement] {
    (axCopy(el, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
}

/// 取元素的 AX 动作名。
/// 有些应用会把内部字段（`Name:拷贝` / `Target:0x0` / `Selector:(null)`）混进动作列表，
/// 这些不是可执行动作，传给 AXUIElementPerformAction 必然失败——在源头滤掉，
/// 免得它们出现在 snap 输出和 --json 的 actions 数组里误导调用方。
func axActions(_ el: AXUIElement) -> [String] {
    var arr: CFArray?
    let error = AXUIElementCopyActionNames(el, &arr)
    recordWalkError("AXActions:" + (axStr(el, "AXRole") ?? "unknown"), error)
    guard error == .success, let a = arr as? [String] else { return [] }
    return a.filter { name in
        guard !name.isEmpty else { return false }
        if name.contains(":") || name.contains("\n") { return false }
        return true
    }
}

func axFrame(_ el: AXUIElement) -> CGRect? {
    var p = CGPoint.zero, s = CGSize.zero
    var got = false
    if let pv = axCopy(el, kAXPositionAttribute as String), CFGetTypeID(pv) == AXValueGetTypeID() {
        AXValueGetValue((pv as! AXValue), .cgPoint, &p); got = true
    }
    if let sv = axCopy(el, kAXSizeAttribute as String), CFGetTypeID(sv) == AXValueGetTypeID() {
        AXValueGetValue((sv as! AXValue), .cgSize, &s)
    }
    return got ? CGRect(origin: p, size: s) : nil
}

func axSettable(_ el: AXUIElement, _ attr: String) -> Bool {
    var b = DarwinBoolean(false)
    let error = AXUIElementIsAttributeSettable(el, attr as CFString, &b)
    recordWalkError(attr + ":settable", error)
    return error == .success && b.boolValue
}

/// 去掉双向文本标记等不可见字符——它们会污染输出且让字符串比对失败
func clean(_ s: String) -> String {
    var t = s
    for junk in ["\u{200E}", "\u{200F}", "\u{202A}", "\u{202B}", "\u{202C}", "\u{202D}", "\u{202E}", "\u{FEFF}"] {
        t = t.replacingOccurrences(of: junk, with: "")
    }
    return t.replacingOccurrences(of: "\n", with: "⏎").trimmingCharacters(in: .whitespaces)
}

/// 标签提取：SwiftUI 应用常常 AXTitle 为空，按优先级回退多个属性
/// （这是关键——AppleScript 的 description 只会返回"按钮"这类角色名，拿不到真实标签）
let editableRoles: Set<String> = ["AXTextArea", "AXTextField", "AXComboBox", "AXSearchField"]

func labelOf(_ el: AXUIElement) -> String {
    let role = axStr(el, kAXRoleAttribute as String) ?? ""
    // 可编辑文本元素的 AXValue 是用户内容，会随输入变化，不能当身份标签
    // （否则 set 写入之后，同一个元素就认不出来了）
    let attrs = editableRoles.contains(role)
        ? ["AXTitle", "AXDescription", "AXPlaceholderValue", "AXHelp", "AXIdentifier"]
        : ["AXTitle", "AXDescription", "AXValue", "AXPlaceholderValue", "AXHelp", "AXIdentifier"]
    for a in attrs {
        if let s = axStr(el, a) {
            let t = clean(s)
            if !t.isEmpty { return t.count > 80 ? String(t.prefix(80)) + "…" : t }
        }
    }
    return ""
}

/// 可编辑元素的当前内容预览（只用于展示，不参与身份校验）
func valuePreview(_ el: AXUIElement, role: String) -> String? {
    guard editableRoles.contains(role), let v = axStr(el, kAXValueAttribute as String) else { return nil }
    let c = clean(v)
    if c.isEmpty { return nil }
    return c.count > 46 ? String(c.prefix(46)) + "…" : c
}

/// 当前状态：复选框/单选/开关勾没勾、标签页/行选没选中、折叠项展没展开。
/// 不读这些的话，界面上勾选前后的元素清单一模一样，调用方看不出一次点击到底生效没有。
let checkRoles: Set<String> = ["AXCheckBox", "AXRadioButton", "AXSwitch", "AXToggle"]
let expandableRoles: Set<String> = ["AXDisclosureTriangle", "AXPopUpButton", "AXMenuButton", "AXComboBox", "AXOutlineRow", "AXRow"]
func hasAttribute(_ el: AXUIElement, _ name: String) -> Bool {
    var names: CFArray?
    let error = AXUIElementCopyAttributeNames(el, &names)
    recordWalkError("AXAttributeNames", error)
    guard error == .success, let list = names as? [String] else { return false }
    return list.contains(name)
}

func stateOf(_ el: AXUIElement, role: String) -> String? {
    var parts: [String] = []
    if checkRoles.contains(role), let n = axCopy(el, kAXValueAttribute as String) as? NSNumber {
        parts.append(n.intValue == 1 ? "checked" : n.intValue == 2 ? "mixed" : "unchecked")
    }
    if let s = axCopy(el, kAXSelectedAttribute as String) as? NSNumber, s.boolValue { parts.append("selected") }
    // Chrome 对不支持展开的元素也回 AXExpanded=false，所以回「否」时再核对它的属性清单里真有这一项。
    if let e = axCopy(el, kAXExpandedAttribute as String) as? NSNumber,
       e.boolValue || expandableRoles.contains(role) || hasAttribute(el, kAXExpandedAttribute as String) {
        parts.append(e.boolValue ? "expanded" : "collapsed")
    }
    return parts.isEmpty ? nil : parts.joined(separator: ",")
}

/// 显示宽度：CJK 字符占两列，用于表格对齐
func dispWidth(_ s: String) -> Int {
    var w = 0
    for ch in s.unicodeScalars {
        switch ch.value {
        case 0x1100...0x115F, 0x2E80...0xA4CF, 0xAC00...0xD7A3,
             0xF900...0xFAFF, 0xFE30...0xFE4F, 0xFF00...0xFF60, 0xFFE0...0xFFE6,
             0x20000...0x3FFFD:
            w += 2
        default:
            w += 1
        }
    }
    return w
}

/// 按显示宽度补齐/截断
func pad(_ s: String, _ width: Int) -> String {
    var out = ""
    var w = 0
    for ch in s {
        let cw = dispWidth(String(ch))
        if w + cw > width { out += "…"; w += 1; break }
        out.append(ch); w += cw
    }
    return out + String(repeating: " ", count: max(0, width - w))
}

/// 创建应用级 AX 元素，并设置消息超时。
/// 不设的话，目标应用转圈（无响应）时 AXUIElementCopyAttributeValue 会长时间阻塞，
/// 而一次 walk 要调用几百次 AX API —— 足以让整个命令挂死。
func axApp(_ pid: pid_t, timeout: Float = 2.0) -> AXUIElement {
    let el = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(el, timeout)
    return el
}

// ==================== 应用解析 ====================

func pickApp(_ apps: [NSRunningApplication], _ ql: String) -> NSRunningApplication? {
    // 1) bundle id 精确
    if let a = apps.first(where: { $0.bundleIdentifier?.lowercased() == ql }) { return a }
    // 2) 名称精确（本地化名 / 可执行名）
    if let a = apps.first(where: { $0.localizedName?.lowercased() == ql }) { return a }
    if let a = apps.first(where: { $0.bundleURL?.deletingPathExtension().lastPathComponent.lowercased() == ql }) { return a }
    // 3) 路径
    if let a = apps.first(where: { $0.bundleURL?.path.lowercased() == ql }) { return a }
    // 4) 模糊包含
    if let a = apps.first(where: { ($0.localizedName?.lowercased().contains(ql) ?? false)
        || ($0.bundleIdentifier?.lowercased().contains(ql) ?? false)
        || ($0.bundleURL?.deletingPathExtension().lastPathComponent.lowercased().contains(ql) ?? false) }) { return a }
    return nil
}

func resolveApp(_ q: String) -> NSRunningApplication? {
    let all = NSWorkspace.shared.runningApplications
    let ql = q.lowercased()
    // 先在常规应用里找，避免误匹配到后台进程
    if let a = pickApp(all.filter { $0.activationPolicy == .regular }, ql) { return a }
    // 回退到全部：这样 Dock / ControlCenter / SystemUIServer 这类系统 UI 进程也能被显式操作
    return pickApp(all, ql)
}

func mustApp(_ q: String) -> NSRunningApplication {
    requireAXAccess()
    _ = requireTaskScope()
    if let a = resolveApp(q) { bindTaskOwnership(a); return a }
    if boundWindowRef != nil || installedAppURL(q).flatMap({ Bundle(url: $0)?.bundleIdentifier }).map(isBrowserBundle) == true { die("浏览器或绑定窗口的进程已退出，未自动重启", 4) }
    // 没在运行：能确定是哪个已安装应用时在后台拉起它（不抢前台）。
    // 只认 bundle id、.app 路径、或 Launch Services 能按名字找到的应用；拿不准就报错，不乱启动。
    // COMPUTER_CONTROL_NO_AUTOLAUNCH=1 关掉。
    let autolaunch = ProcessInfo.processInfo.environment["COMPUTER_CONTROL_NO_AUTOLAUNCH"] != "1"
    if autolaunch, let url = installedAppURL(q) {
        let bid = claimInstalledApp(url)
        if let a = launchApp(url, front: false) {
            // 等它有窗口或至少能回答辅助功能查询，最多 8 秒
            let t0 = Date()
            while Date().timeIntervalSince(t0) < 8 {
                if !appWindows(a.processIdentifier).isEmpty { break }
                usleep(200000)
            }
            usleep(300000)
            warn("'\(q)' 没在运行，已在后台启动（\(url.lastPathComponent)）")
            guard a.bundleIdentifier == bid else { die("启动后应用身份与归属不一致，未执行目标动作", 4) }
            return a
        }
    }
    appNotFound(q, installed: autolaunch)
}

func claimInstalledApp(_ url: URL) -> String {
    guard let bid = Bundle(url: url)?.bundleIdentifier else { die("无法确认待启动应用身份，拒绝启动", 3) }
    if isBrowserBundle(bid) { return bid }
    lockResource("app-" + bid)
    activeOwnership = updateOwnership(bid, scope: requireTaskScope(), action: "auto", lease: taskLease)
    return bid
}

/// 按 .app 位置启动或唤起应用；front 为 false 时不抢前台
func launchApp(_ url: URL, front: Bool) -> NSRunningApplication? {
    let cfg = NSWorkspace.OpenConfiguration()
    cfg.activates = front
    cfg.hides = false
    cfg.addsToRecentItems = false
    let sem = DispatchSemaphore(value: 0)
    var launched: NSRunningApplication?
    NSWorkspace.shared.openApplication(at: url, configuration: cfg) { app, _ in launched = app; sem.signal() }
    _ = sem.wait(timeout: .now() + 15)
    return launched
}

func appNotFound(_ q: String, installed: Bool) -> Never {
    let near = similarApps(q)
    let hint = near.isEmpty ? "用 `computer-control apps` 查看运行中的应用。" : "相近的有：" + near.joined(separator: "、") + "。"
    die((installed ? "找不到应用 '\(q)'，运行中和已安装的都没有。" : "找不到运行中的应用 '\(q)'（COMPUTER_CONTROL_NO_AUTOLAUNCH=1，不自动启动）。") + hint, 3)
}

func editDistance(_ a: [Character], _ b: [Character]) -> Int {
    if a.isEmpty { return b.count }
    var row = Array(0...b.count)
    for (i, ca) in a.enumerated() {
        var prev = row[0]
        row[0] = i + 1
        for (j, cb) in b.enumerated() {
            let cur = row[j + 1]
            row[j + 1] = min(row[j + 1] + 1, row[j] + 1, prev + (ca == cb ? 0 : 1))
            prev = cur
        }
    }
    return row[b.count]
}

func nameIsNear(_ ql: String, _ name: String) -> Bool {
    let n = name.lowercased()
    if n.isEmpty || ql.isEmpty { return false }
    if n.contains(ql) || (n.count >= 2 && ql.contains(n)) { return true }
    let a = Array(ql), b = Array(n)
    return editDistance(a, b) <= max(1, min(a.count, b.count) / 4)
}

/// 名字、bundle id 与查询相近的运行中和已安装应用，写成「名字（bundle id）」
func similarApps(_ q: String, limit: Int = 8) -> [String] {
    let ql = q.lowercased()
    var out: [String] = []
    var seen = Set<String>()
    func add(_ name: String, _ bid: String) {
        guard out.count < limit, seen.insert(bid).inserted else { return }
        out.append("\(name)（\(bid)）")
    }
    for a in NSWorkspace.shared.runningApplications where a.activationPolicy == .regular {
        guard let bid = a.bundleIdentifier else { continue }
        let names = [a.localizedName, a.bundleURL?.deletingPathExtension().lastPathComponent, bid].compactMap { $0 }
        if let hit = names.first(where: { nameIsNear(ql, $0) }) { add(a.localizedName ?? hit, bid) }
    }
    for d in appDirs() {
        guard let items = try? FileManager.default.contentsOfDirectory(atPath: d) else { continue }
        for it in items.sorted() where it.hasSuffix(".app") {
            let url = URL(fileURLWithPath: d).appendingPathComponent(it)
            guard let bid = Bundle(url: url)?.bundleIdentifier, !seen.contains(bid) else { continue }
            let names = [(it as NSString).deletingPathExtension, bid] + localizedAppNames(url)
            if let hit = names.first(where: { nameIsNear(ql, $0) }) { add(hit, bid) }
        }
    }
    return out
}

/// 应用各语言下的名字。系统应用的中文名（计算器、文本编辑）存在 InfoPlist.loctable 里，
/// 不在 Info.plist，也不在 displayName 里（本机语言是简体中文时 displayName 仍返回 Calculator.app）。
func localizedAppNames(_ url: URL) -> [String] {
    guard let b = Bundle(url: url) else { return [] }
    var names: [String] = []
    for key in ["CFBundleDisplayName", "CFBundleName"] {
        if let v = b.localizedInfoDictionary?[key] as? String { names.append(v) }
    }
    if let p = b.path(forResource: "InfoPlist", ofType: "loctable"),
       let d = NSDictionary(contentsOfFile: p) as? [String: Any] {
        for (_, table) in d {
            guard let t = table as? [String: Any] else { continue }
            for key in ["CFBundleDisplayName", "CFBundleName"] { if let v = t[key] as? String { names.append(v) } }
        }
    }
    for lang in b.localizations {
        if let p = b.path(forResource: "InfoPlist", ofType: "strings", inDirectory: nil, forLocalization: lang),
           let d = NSDictionary(contentsOfFile: p) as? [String: String] {
            for key in ["CFBundleDisplayName", "CFBundleName"] { if let v = d[key] { names.append(v) } }
        }
    }
    return names
}

func appDirs() -> [String] {
    ["/Applications", "/System/Applications", "/System/Applications/Utilities",
     "/Applications/Utilities", NSHomeDirectory() + "/Applications"]
}

/// 已安装应用的位置：bundle id、.app 路径、或应用名（本地化名、文件名都行）
func installedAppURL(_ q: String) -> URL? {
    if q.hasSuffix(".app"), FileManager.default.fileExists(atPath: q) { return URL(fileURLWithPath: q) }
    if q.contains("."), !q.contains("/"), let u = NSWorkspace.shared.urlForApplication(withBundleIdentifier: q) { return u }
    let ql = q.lowercased()
    var byLocalized: URL?
    for d in appDirs() {
        guard let items = try? FileManager.default.contentsOfDirectory(atPath: d) else { continue }
        for it in items where it.hasSuffix(".app") {
            let url = URL(fileURLWithPath: d).appendingPathComponent(it)
            if (it as NSString).deletingPathExtension.lowercased() == ql { return url }
            if byLocalized == nil, localizedAppNames(url).contains(where: { $0.lowercased() == ql }) { byLocalized = url }
        }
    }
    return byLocalized
}

// ==================== 窗口 ====================

func appWindows(_ pid: pid_t) -> [AXUIElement] {
    let a = axApp(pid)
    return (axCopy(a, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
}

/// 用公开 API CGWindowListCopyWindowInfo 按 pid + 位置匹配出 CGWindowID，
/// 供 `screencapture -l` 截图——即使窗口被遮挡也能截到（这是按屏幕坐标截图做不到的）。
func cgWindowID(pid: pid_t, frame: CGRect?) -> CGWindowID? {
    guard let frame = frame,
          let list = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
    let matches = list.filter { w in
        guard (w[kCGWindowOwnerPID as String] as? pid_t) == pid,
              let b = w[kCGWindowBounds as String] as? [String: Any],
              let r = CGRect(dictionaryRepresentation: b as CFDictionary) else { return false }
        return abs(r.minX-frame.minX) < 2 && abs(r.minY-frame.minY) < 2 && abs(r.width-frame.width) < 2 && abs(r.height-frame.height) < 2
    }
    guard matches.count == 1 else { return nil }
    return (matches[0][kCGWindowNumber as String] as? NSNumber)?.uint32Value
}

typealias AXWindowNumberFn = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
let axWindowLibrary = dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", RTLD_LAZY)
let axWindowNumberFn: AXWindowNumberFn? = axWindowLibrary.flatMap { dlsym($0, "_AXUIElementGetWindow") }.map { unsafeBitCast($0, to: AXWindowNumberFn.self) }

func nativeWindowID(_ window: AXUIElement) -> CGWindowID? {
    if let n = axCopy(window, "AXWindowNumber") as? NSNumber, n.uint32Value > 0 { return n.uint32Value }
    var wid: CGWindowID = 0
    if let f = axWindowNumberFn, f(window, &wid) == .success, wid > 0 { return wid }
    return nil
}

func isBrowserBundle(_ key: String) -> Bool {
    return ["com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.dev", "com.google.Chrome.canary", "company.thebrowser.Browser", "org.chromium.Chromium", "com.microsoft.edgemac", "com.brave.Browser", "com.apple.Safari"].contains(key)
}

var requestedWindowIndex: Int? = nil
var boundWindowRef: [String: Any]? = nil
var activeWindowRef: [String: Any]? = nil
var focusWindowRef: [String: Any]? = nil
var actionSent = false
var operationLocked = false
var inputCleanup: (() -> Void)? = nil
var requireFocus = false

func windowRef(_ app: NSRunningApplication, _ window: AXUIElement) -> [String: Any] {
    guard let id = nativeWindowID(window), let started = app.launchDate?.timeIntervalSince1970 else { die("不能可靠取得真实窗口号或进程代际，拒绝绑定", 5) }
    let matches = appWindows(app.processIdentifier).filter { nativeWindowID($0) == id }
    guard matches.count == 1 else { die("AX 窗口号不唯一，拒绝绑定", 4) }
    return ["id": Int(id), "pid": Int(app.processIdentifier), "startedAt": started, "bundleId": app.bundleIdentifier ?? ""]
}

func windowProcessMatches(_ ref: [String: Any], pid: pid_t, startedAt: Double?, bundle: String) -> Bool {
    guard let expected = ref["startedAt"] as? Double, let actual = startedAt else { return false }
    return ref["pid"] as? Int == Int(pid) && expected == actual && (ref["bundleId"] as? String).map { $0 == bundle } != false
}

func resolveWindowRef(_ app: NSRunningApplication, _ ref: [String: Any],
                      windows: (pid_t) -> [AXUIElement] = appWindows,
                      identify: (AXUIElement) -> CGWindowID? = nativeWindowID,
                      launched: (NSRunningApplication) -> Double? = { $0.launchDate?.timeIntervalSince1970 }) -> AXUIElement {
    guard windowProcessMatches(ref, pid: app.processIdentifier, startedAt: launched(app), bundle: app.bundleIdentifier ?? ""),
          let id = ref["id"] as? Int, id > 0 else { die("窗口引用的进程或代际不符", 4, outcome: actionSent ? "unknown" : "not_sent") }
    let matches = windows(app.processIdentifier).filter { identify($0).map(Int.init) == id }
    guard matches.count == 1 else { die("原窗口已消失或窗口号不唯一，未按标题或位置替代", 4, outcome: actionSent ? "unknown" : "not_sent") }
    return matches[0]
}

func checkBoundElement(_ element: AXUIElement) {
    guard let ref = activeWindowRef, let pid = ref["pid"] as? Int,
          let app = NSRunningApplication(processIdentifier: pid_t(pid)) else { return }
    let window = resolveWindowRef(app, ref)
    if CFEqual(window, element) { return }
    if let owner = axCopy(element, kAXWindowAttribute as String), CFGetTypeID(owner) == AXUIElementGetTypeID(), CFEqual(owner, window) { return }
    var current = element
    for _ in 0..<40 {
        guard let parent = axCopy(current, kAXParentAttribute as String), CFGetTypeID(parent) == AXUIElementGetTypeID() else { break }
        current = parent as! AXUIElement
        if CFEqual(current, window) { return }
    }
    die("元素已不属于绑定窗口，未执行动作", 4, outcome: actionSent ? "unknown" : "not_sent")
}

func beginFocusedOperation(_ app: NSRunningApplication) {
    if !operationLocked { lockResource("desktop-input"); operationLocked = true }
    if focusWindowRef == nil {
        if let ref = activeWindowRef { focusWindowRef = ref }
        else if isBrowserBundle(app.bundleIdentifier ?? ""), let (window, _) = pickWindow(app.processIdentifier, index: nil) { focusWindowRef = windowRef(app, window) }
    }
    checkOperationFocus()
}

func focusedWindowMatches(_ ref: [String: Any], frontPid: pid_t?, focusedID: CGWindowID?) -> Bool {
    return frontPid.map(Int.init) == ref["pid"] as? Int && focusedID.map(Int.init) == ref["id"] as? Int
}

func checkOperationFocus() {
    guard operationLocked, let ref = focusWindowRef else { return }
    guard let pid = ref["pid"] as? Int, let app = NSRunningApplication(processIdentifier: pid_t(pid)),
          NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier,
          windowProcessMatches(ref, pid: app.processIdentifier, startedAt: app.launchDate?.timeIntervalSince1970, bundle: app.bundleIdentifier ?? ""),
          let focused = axCopy(axApp(app.processIdentifier), kAXFocusedWindowAttribute as String), CFGetTypeID(focused) == AXUIElementGetTypeID(),
          focusedWindowMatches(ref, frontPid: NSWorkspace.shared.frontmostApplication?.processIdentifier, focusedID: nativeWindowID(focused as! AXUIElement)) else {
        die("前台焦点窗口已改变，已停止后续输入；不自动激活或重发", 4, outcome: actionSent ? "unknown" : "not_sent")
    }
    _ = resolveWindowRef(app, ref)
    if ["type", "paste", "key"].contains(currentCommand) {
        guard let focusedElement = axCopy(axApp(app.processIdentifier), kAXFocusedUIElementAttribute as String), CFGetTypeID(focusedElement) == AXUIElementGetTypeID() else { die("无法核对焦点输入元素", 4, outcome: actionSent ? "unknown" : "not_sent") }
        checkBoundElement(focusedElement as! AXUIElement)
    }
}

func pickWindow(_ pid: pid_t, index: Int?) -> (AXUIElement, String)? {
    let ws = appWindows(pid)
    if ws.isEmpty {
        if activeWindowRef != nil || index != nil { die("目标窗口已消失", 4, outcome: actionSent ? "unknown" : "not_sent") }
        return nil
    }
    if let ref = activeWindowRef {
        guard let app = NSRunningApplication(processIdentifier: pid) else { die("窗口进程已退出", 4, outcome: actionSent ? "unknown" : "not_sent") }
        let w = resolveWindowRef(app, ref)
        return (w, axStr(w, kAXTitleAttribute as String) ?? "(无标题)")
    }
    if let i = index {
        guard i >= 1 && i <= ws.count else { die("窗口下标越界，未回退当前窗", 4) }
        return (ws[i - 1], axStr(ws[i - 1], kAXTitleAttribute as String) ?? "(无标题)")
    }
    // 默认取 main/focused，回退第一个
    let a = axApp(pid)
    for attr in [kAXFocusedWindowAttribute as String, kAXMainWindowAttribute as String] {
        if let w = axCopy(a, attr), CFGetTypeID(w) == AXUIElementGetTypeID() {
            let el = w as! AXUIElement
            return (el, axStr(el, kAXTitleAttribute as String) ?? "(无标题)")
        }
    }
    return (ws[0], axStr(ws[0], kAXTitleAttribute as String) ?? "(无标题)")
}

/// 取遍历/定位的根元素：优先用窗口；没有窗口的（Dock、菜单栏图标、控制中心）回退到应用根。
/// snap 与后续 click/set 必须用同一个根，否则缓存里的路径对不上。
func uiRoot(_ pid: pid_t, _ winIdx: Int?) -> (AXUIElement, String) {
    if let (w, t) = pickWindow(pid, index: winIdx) { return (w, t) }
    return (axApp(pid), "(无窗口，已从应用根元素遍历)")
}

/// 取进程可执行文件名——用于提示「TCC 认哪个进程」，比只报 pid 有用
func processName(_ pid: pid_t) -> String {
    var buf = [CChar](repeating: 0, count: 4096)
    if proc_pidpath(pid, &buf, UInt32(buf.count)) > 0, let s = String(validatingUTF8: buf) {
        return (s as NSString).lastPathComponent
    }
    return "未知进程"
}

func frameTuple(_ f: CGRect?) -> (Double, Double, Double, Double)? {
    guard let f = f else { return nil }
    return (Double(f.origin.x), Double(f.origin.y), Double(f.size.width), Double(f.size.height))
}

/// 动作前校验目标窗口没被换掉。
/// 编号路径存在缓存里的是「相对窗口根」的 children 索引路径——窗口一换
/// （弹了对话框、切到同一应用的另一个文档窗、默认窗口变成别的一个），
/// 同一个路径会老老实实解析成**另一个窗口里的另一个元素**，
/// 于是命令成功返回、却点错了东西。这就是窗口层校验要解决的问题。
/// 使用进程与窗口 ID 唯一定位；缺乏稳定窗口身份时拒绝编号操作。
func verifiedWindow(_ app: NSRunningApplication, _ key: String, _ refWin: Int, _ q: String) -> AXUIElement {
    guard let meta = loadWinMeta(key), !key.isEmpty else { die("快照窗口身份缺失，请重新 snap", 4) }
    guard meta["pid"] as? Int == Int(app.processIdentifier) else { die("应用进程已变化，请重新 snap", 4) }
    if meta["id"] is Int { return resolveWindowRef(app, meta) }
    guard !isBrowserBundle(app.bundleIdentifier ?? ""), appWindows(app.processIdentifier).isEmpty,
          (meta["title"] as? String)?.hasPrefix("(无窗口") == true else { die("无法验证快照窗口稳定身份", 4) }
    return axApp(app.processIdentifier)
}

// ==================== 树遍历 ====================

/// 一次跨进程取回一个元素的全部常用属性。逐个取要来回十几次，网页这种上千元素的树会慢三倍
let batchAttrs = ["AXRole", "AXTitle", "AXDescription", "AXValue", "AXPlaceholderValue", "AXHelp",
                  "AXIdentifier", "AXEnabled", "AXPosition", "AXSize", "AXSelected", "AXExpanded",
                  "AXChildren", "AXURL", "AXFocused", "AXSubrole"]
struct AttrBag {
    var raw: [String: CFTypeRef] = [:]
    var readErrors: [String] = []
    var metadataErrors: [String] = []
    mutating func recordError(_ attribute: String, _ error: AXError) {
        if error == .success { return }
        if attribute != "AXRole" && (error == .attributeUnsupported || error == .noValue) { return }
        if error == .failure && ["AXURL", "AXSubrole", "AXFocused", "AXActions:AXSplitter", "AXActions:AXGroup"].contains(attribute) {
            metadataErrors.append("\(attribute):\(error.rawValue)")
        } else {
            readErrors.append("\(attribute):\(error.rawValue)")
        }
    }
    func str(_ k: String) -> String? {
        guard let v = raw[k] else { return nil }
        if let s = v as? String { return s.isEmpty ? nil : s }
        if let n = v as? NSNumber { return n.stringValue }
        if let u = v as? URL { return u.absoluteString }
        if CFGetTypeID(v) == CFURLGetTypeID() { return (v as! CFURL as URL).absoluteString }
        return nil
    }
    func bool(_ k: String) -> Bool? { (raw[k] as? NSNumber)?.boolValue }
    var children: [AXUIElement] { (raw["AXChildren"] as? [AXUIElement]) ?? [] }
    var frame: CGRect? {
        var p = CGPoint.zero, s = CGSize.zero
        guard let pv = raw["AXPosition"], CFGetTypeID(pv) == AXValueGetTypeID() else { return nil }
        AXValueGetValue((pv as! AXValue), .cgPoint, &p)
        if let sv = raw["AXSize"], CFGetTypeID(sv) == AXValueGetTypeID() { AXValueGetValue((sv as! AXValue), .cgSize, &s) }
        return CGRect(origin: p, size: s)
    }
}
func attrBag(_ el: AXUIElement) -> AttrBag {
    var vals: CFArray?
    var bag = AttrBag()
    if AXUIElementCopyMultipleAttributeValues(el, batchAttrs as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &vals) == .success,
       let arr = vals as? [AnyObject], arr.count == batchAttrs.count {
        for (i, k) in batchAttrs.enumerated() {
            let v = arr[i] as CFTypeRef
            // 取不到的属性在结果里是一个 AXValue 错误值，不是 nil
            if CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetType(v as! AXValue) == .axError {
                var error = AXError.success
                AXValueGetValue(v as! AXValue, .axError, &error)
                bag.recordError(k, error)
                continue
            }
            bag.raw[k] = v
        }
        return bag
    }
    for k in batchAttrs {
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(el, k as CFString, &value)
        bag.recordError(k, error)
        if error == .success, let value = value { bag.raw[k] = value }
    }
    return bag
}

func labelFrom(_ bag: AttrBag, role: String) -> String {
    let keys = editableRoles.contains(role)
        ? ["AXTitle", "AXDescription", "AXPlaceholderValue", "AXHelp", "AXIdentifier"]
        : ["AXTitle", "AXDescription", "AXValue", "AXPlaceholderValue", "AXHelp", "AXIdentifier"]
    for k in keys {
        if let s = bag.str(k) {
            let t = clean(s)
            if !t.isEmpty { return t.count > 80 ? String(t.prefix(80)) + "…" : t }
        }
    }
    return ""
}

/// 当前值：输入框内容、下拉框当前选项、滑块数值。名字已经就是这个值时不重复给。
let valueRoles: Set<String> = ["AXPopUpButton", "AXMenuButton", "AXSlider", "AXValueIndicator", "AXIncrementor",
                               "AXLevelIndicator", "AXProgressIndicator", "AXScrollBar", "AXColorWell", "AXDateField"]
func valueFrom(_ bag: AttrBag, role: String, label: String) -> String? {
    guard editableRoles.contains(role) || valueRoles.contains(role), let v = bag.str("AXValue") else { return nil }
    let c = clean(v)
    if c.isEmpty || c == label { return nil }
    return c.count > 80 ? String(c.prefix(80)) + "…" : c
}

func stateFrom(_ bag: AttrBag, _ el: AXUIElement, role: String) -> String? {
    var parts: [String] = []
    if checkRoles.contains(role), let n = bag.raw["AXValue"] as? NSNumber {
        parts.append(n.intValue == 1 ? "checked" : n.intValue == 2 ? "mixed" : "unchecked")
    }
    if bag.bool("AXSelected") == true { parts.append("selected") }
    // Chrome 对网页里每个元素都回 AXExpanded=false；只有展开箭头这类角色和按钮才可能真能展开，
    // 别的角色不再额外问属性清单（大网页上这一步要多跑上千次跨进程调用）。
    if let e = bag.bool("AXExpanded"),
       e || expandableRoles.contains(role) || (role == "AXButton" && hasAttribute(el, kAXExpandedAttribute as String)) {
        parts.append(e ? "expanded" : "collapsed")
    }
    if bag.bool("AXFocused") == true { parts.append("focused") }
    return parts.isEmpty ? nil : parts.joined(separator: ",")
}


struct Node {
    var idx: Int
    var role: String
    var label: String
    var frame: CGRect?
    var actions: [String]
    var depth: Int
    var path: [Int]          // 从窗口根出发的 children 索引路径，用于跨进程重新定位
    var settable: Bool
    var enabled: Bool
    var value: String?       // 可编辑元素的内容预览，仅展示，不参与校验
    var axid: String?        // AXIdentifier：开发者定义的稳定标识，语言无关，优先用它定位
    var help: String?        // AXHelp：补充说明
    var state: String? = nil // 勾选/选中/展开/焦点状态，见 stateFrom
    var url: String? = nil   // 链接、网页、文档窗口的网址
    var parent: Int? = nil   // 最近一个也被列出来的祖先的编号
    var hidden: Bool? = nil
}

/// 值得报告给模型的元素：可交互，或带有文本信息
func isInteresting(role: String, label: String, actions: [String], settable: Bool) -> Bool {
    if settable { return true }
    let acts = Set(actions)
    if acts.contains("AXPress") || acts.contains("AXIncrement") || acts.contains("AXDecrement")
        || acts.contains("AXConfirm") || acts.contains("AXPick") || acts.contains("AXShowMenu") { return true }
    let textish: Set<String> = ["AXStaticText", "AXTextField", "AXTextArea", "AXValueIndicator",
                                "AXHeading", "AXLink", "AXMenuItem", "AXCheckBox", "AXRadioButton",
                                "AXPopUpButton", "AXSlider", "AXTabGroup", "AXRow", "AXCell", "AXImage"]
    if textish.contains(role) && !label.isEmpty { return true }
    if role == "AXScrollArea" { return true }   // 滚动目标
    return false
}

let settableRoles: Set<String> = ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXSlider", "AXCheckBox",
                                  "AXRadioButton", "AXIncrementor", "AXColorWell", "AXDateField", "AXScrollBar", "AXSwitch",
                                  "AXToggle", "AXPopUpButton", "AXTab", "AXRulerMarker", "AXValueIndicator", "AXLevelIndicator"]

/// walk 是否因为超出时间预算而提前收尾（供 snap 提示用户）
var walkTimedOut = false
var walkDepthTruncated = false
var walkReadIncomplete = false
var walkReadErrors: [String] = []
var walkMetadataErrors: [String] = []
var walkRecordingErrors = false

func recordWalkError(_ attribute: String, _ error: AXError) {
    guard walkRecordingErrors else { return }
    var bag = AttrBag()
    bag.recordError(attribute, error)
    if !bag.readErrors.isEmpty {
        walkReadIncomplete = true
        if walkReadErrors.count < 8 { walkReadErrors.append(contentsOf: bag.readErrors.prefix(8 - walkReadErrors.count)) }
    }
    if walkMetadataErrors.count < 8 { walkMetadataErrors.append(contentsOf: bag.metadataErrors.prefix(8 - walkMetadataErrors.count)) }
}


func walk(root: AXUIElement, maxNodes: Int, maxDepth: Int, showAll: Bool,
          budget: TimeInterval = 8.0) -> [Node] {
    var out: [Node] = []
    var counter = 0
    walkRecordingErrors = true
    defer { walkRecordingErrors = false }
    walkTimedOut = false
    walkDepthTruncated = false
    walkReadIncomplete = false
    walkReadErrors = []
    walkMetadataErrors = []
    let deadline = Date().addingTimeInterval(budget)
    func rec(_ el: AXUIElement, _ depth: Int, _ path: [Int], _ listedAncestor: Int?) {
        if depth > maxDepth { walkDepthTruncated = true; return }
        if out.count >= maxNodes { return }
        // 单次 AX 调用已有 2s 超时，但几百次累加仍可能很久；这里卡总预算
        if Date() >= deadline { walkTimedOut = true; return }
        let bag = attrBag(el)
        if !bag.readErrors.isEmpty {
            walkReadIncomplete = true
            if walkReadErrors.count < 8 { walkReadErrors.append(contentsOf: bag.readErrors.prefix(8 - walkReadErrors.count)) }
        }
        if walkMetadataErrors.count < 8 { walkMetadataErrors.append(contentsOf: bag.metadataErrors.prefix(8 - walkMetadataErrors.count)) }
        let role = bag.str("AXRole") ?? "AXUnknown"
        let label = labelFrom(bag, role: role)
        let actions = axActions(el)
        // 「能不能写」要单独跨进程问一次；只有输入框、滑块、开关这类控件的值才可能可写，别的角色不问，
        // 大网页（上千个静态文字和分组）能省一半的往返。
        let settable = settableRoles.contains(role) ? axSettable(el, kAXValueAttribute as String) : false
        let enabled = bag.bool("AXEnabled") ?? true
        if showAll || isInteresting(role: role, label: label, actions: actions, settable: settable) {
            counter += 1
            let aid = bag.str("AXIdentifier").map(clean).flatMap { $0.isEmpty ? nil : $0 }
            let hlp = bag.str("AXHelp").map(clean).flatMap { $0.isEmpty || $0 == label ? nil : $0 }
            // 父元素：最近一个也被列出来的祖先（按路径前缀判断）。中间没列出的空容器跳过，
            // 但不同分组里的元素不会被误认成父子——光靠深度数字判断会把工具栏按钮挂到标尺下面。
            let parentIdx = listedAncestor
            out.append(Node(idx: counter, role: role, label: label, frame: bag.frame,
                            actions: actions, depth: depth, path: path, settable: settable,
                            enabled: enabled, value: valueFrom(bag, role: role, label: label),
                            axid: aid, help: hlp, state: stateFrom(bag, el, role: role),
                            url: bag.str("AXURL"), parent: parentIdx,
                             hidden: (axCopy(el, "AXHidden") as? NSNumber)?.boolValue))
        }
        // 往下传「最近一个被列出来的祖先」，不用每个元素回头扫一遍已列出的清单
        let childAncestor = out.last.map { $0.path == path ? $0.idx : listedAncestor } ?? listedAncestor
        if Date() >= deadline { walkTimedOut = true; return }
        let kids = bag.children
        for (i, k) in kids.enumerated() {
            if out.count >= maxNodes { return }
            rec(k, depth + 1, path + [i], childAncestor)
        }
    }
    rec(root, 0, [], nil)
    return out
}

/// 按缓存里的 path 重新定位元素
func resolvePath(root: AXUIElement, path: [Int]) -> AXUIElement? {
    var cur = root
    for i in path {
        let kids = axChildren(cur)
        guard i < kids.count else { return nil }
        cur = kids[i]
    }
    return cur
}

/// 截止或读取失败时不能证明唯一，不允许使用已搜到的部分结果。
func completeSearch<T>(root: T, children: (T) -> [T], match: (T) -> Bool,
                       maxDepth: Int = 30, maxNodes: Int = 10000, budget: TimeInterval = 8) -> [T] {
    var found: [T] = []
    var visited = 0
    let deadline = Date().addingTimeInterval(budget)
    func rec(_ node: T, _ depth: Int) {
        guard depth <= maxDepth, visited < maxNodes, Date() < deadline else {
            die("定位搜索不完整（深度、节点数或时间上限），不能确认唯一目标", 4)
        }
        visited += 1
        if match(node) { found.append(node) }
        let descendants = children(node)
        guard Date() < deadline else { die("定位搜索超时，不能确认唯一目标", 4) }
        for child in descendants { rec(child, depth + 1) }
    }
    rec(root, 0)
    return found
}

func searchString(_ el: AXUIElement, _ attribute: String) -> String? {
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(el, attribute as CFString, &value)
    if error == .attributeUnsupported || error == .noValue { return nil }
    guard error == .success else { die("定位时无法读取身份属性，不能确认唯一目标", 4) }
    if let string = value as? String { return string.isEmpty ? nil : string }
    if let number = value as? NSNumber { return number.stringValue }
    return nil
}

func searchLabel(_ el: AXUIElement) -> String {
    let role = searchString(el, "AXRole") ?? ""
    let attributes = editableRoles.contains(role)
        ? ["AXTitle", "AXDescription", "AXPlaceholderValue", "AXHelp", "AXIdentifier"]
        : ["AXTitle", "AXDescription", "AXValue", "AXPlaceholderValue", "AXHelp", "AXIdentifier"]
    for attribute in attributes {
        if let value = searchString(el, attribute) {
            let text = clean(value)
            if !text.isEmpty { return text.count > 80 ? String(text.prefix(80)) + "…" : text }
        }
    }
    return ""
}

func searchChildren(_ el: AXUIElement) -> [AXUIElement] {
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &value)
    if error == .attributeUnsupported || error == .noValue { return [] }
    guard error == .success, let children = value as? [AXUIElement] else {
        die("定位时无法完整读取子元素，停止操作", 4)
    }
    return children
}

/// 在整棵树里按 角色+标签 找元素（用于路径失效后的自愈重定位）
func findByRoleLabel(root: AXUIElement, role: String, label: String) -> [AXUIElement] {
    return completeSearch(root: root, children: searchChildren) { el in
        searchString(el, kAXRoleAttribute as String) == role && searchLabel(el) == label
    }
}

// ==================== 缓存 ====================

func cacheDir() -> URL {
    let base = ProcessInfo.processInfo.environment["XDG_CACHE_HOME"].map { URL(fileURLWithPath: $0, isDirectory: true) }
        ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".cache", isDirectory: true)
    let d = base.appendingPathComponent("computer-control", isDirectory: true)
    try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
    return d
}

func cacheURL(_ bundleKey: String) -> URL {
    let suffix = activeWindowRef.map { "-window-\($0["pid"]!)-\($0["startedAt"]!)-\($0["id"]!)-\(requireTaskScope())" } ?? ""
    let safe = (bundleKey + suffix).replacingOccurrences(of: "/", with: "_")
    return cacheDir().appendingPathComponent("\(safe).json")
}

/// 元素的内容签名：角色+标签+ID+内容。不含坐标——窗口一移动坐标全变，diff 会失去意义。
func sigOf(_ n: Node) -> String {
    "\(n.role)|\(n.label)|\(n.axid ?? "")|\(n.value ?? "")|\(n.state ?? "")"
}

func saveCache(_ key: String, _ nodes: [Node], winIndex: Int?, winTitle: String? = nil,
               winFrame: CGRect? = nil, token: String, pid: pid_t, windowID: CGWindowID?, complete: Bool = true) {
    var arr: [[String: Any]] = []
    for n in nodes {
        var e: [String: Any] = ["idx": n.idx, "role": n.role, "label": n.label, "path": n.path]
        if let a = n.axid { e["axid"] = a }
        arr.append(e)
    }
    // 窗口元数据：编号路径是「相对窗口根」的，窗口一换同一个路径会指到别的元素。
    // 记下 snap 时用的是哪个窗口（索引 + 标题 + 几何），动作前据此校验。
    var winMeta: [String: Any] = ["index": winIndex ?? 0, "title": winTitle ?? "", "pid": Int(pid)]
    if let wid = windowID { winMeta["id"] = Int(wid) }
    if let app = NSRunningApplication(processIdentifier: pid), let started = app.launchDate?.timeIntervalSince1970 { winMeta["startedAt"] = started; winMeta["bundleId"] = app.bundleIdentifier ?? "" }
    if let f = winFrame {
        winMeta["x"] = Int(f.origin.x.rounded())
        winMeta["y"] = Int(f.origin.y.rounded())
        winMeta["w"] = Int(f.size.width.rounded())
        winMeta["h"] = Int(f.size.height.rounded())
    }
    let obj: [String: Any] = ["win": winIndex ?? 0, "nodes": arr,
                              "sigs": nodes.map { sigOf($0) }, "winMeta": winMeta, "snapshot": token, "complete": complete,
                               "ownerLease": activeOwnership?.generation as Any? ?? NSNull()]
    if let d = try? JSONSerialization.data(withJSONObject: obj) {
        // 原子写入：避免写到一半被中断时留下半个 JSON，
        // 让下一次 click/set 读到损坏缓存（虽然会安全降级，但会白白丢掉一次定位机会）
        do { try d.write(to: cacheURL(key), options: .atomic) }
        catch { die("快照缓存写入失败: \(error)", 1) }
    }
}

func loadWinMeta(_ key: String) -> [String: Any]? {
    guard let d = try? Data(contentsOf: cacheURL(key)),
          let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return nil }
    return o["winMeta"] as? [String: Any]
}

func loadSigs(_ key: String) -> [String]? {
    guard let d = try? Data(contentsOf: cacheURL(key)),
          let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return nil }
    return o["sigs"] as? [String]
}

struct CachedRef { var path: [Int]; var role: String; var label: String; var win: Int; var axid: String? }

func loadCache(_ key: String, idx: Int) -> CachedRef? {
    guard let token = snapshotToken, !token.isEmpty else { die("编号操作必须带 snap 返回的 --snapshot 凭证，请重新 snap", 4) }
    guard let d = try? Data(contentsOf: cacheURL(key)),
          let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
          let arr = o["nodes"] as? [[String: Any]] else {
        if snapshotToken != nil { die("快照凭证不属于该应用或缓存缺失，请重新 snap", 4) }
        return nil
    }
    if o["snapshot"] as? String != token { die("快照凭证已过期，请重新 snap", 4) }
    guard o["complete"] as? Bool == true else { die("快照取态不完整，不能使用编号，请重新取得完整 snap", 4) }
    if let ownership = activeOwnership, o["ownerLease"] as? String != ownership.generation { die("快照来自交接前的归属，不能重新使用", 4) }
    let win = (o["win"] as? Int) ?? 0
    for e in arr where (e["idx"] as? Int) == idx {
        return CachedRef(path: (e["path"] as? [Int]) ?? [], role: (e["role"] as? String) ?? "",
                         label: (e["label"] as? String) ?? "", win: win, axid: e["axid"] as? String)
    }
    return nil
}

// ==================== 输出 ====================

func nodeJSON(_ n: Node) -> [String: Any] {
    var o: [String: Any] = [
        "idx": n.idx, "role": n.role, "label": n.label, "depth": n.depth,
        "enabled": n.enabled,
        "actions": n.actions.compactMap { a -> String? in
            let s = (a.components(separatedBy: .newlines).first ?? a)
                .replacingOccurrences(of: "AX", with: "").trimmingCharacters(in: .whitespaces)
            return s.isEmpty ? nil : s
        },
    ]
    if let a = n.axid { o["axid"] = a }
    if let v = n.value { o["value"] = v }
    if let s = n.state { o["state"] = s }
    if let h = n.help { o["help"] = h }
    if let u = n.url { o["url"] = u }
    if let p = n.parent { o["parent"] = p }
    o["settable"] = n.settable
    o["occluded"] = NSNull()
    o["scrollable"] = ["AXScrollArea", "AXWebArea", "AXList", "AXTable", "AXOutline"].contains(n.role)
    if let hidden = n.hidden { o["hidden"] = hidden; o["visible"] = !hidden }
    if let f = n.frame {
        o["x"] = Int(f.origin.x); o["y"] = Int(f.origin.y)
        o["w"] = Int(f.size.width); o["h"] = Int(f.size.height)
    }
    return o
}

/// removed 签名串 role|label|axid|value 拆回结构
func sigJSON(_ s: String) -> [String: Any] {
    let f = s.components(separatedBy: "|")
    var o: [String: Any] = ["role": f.count > 0 ? f[0] : ""]
    if f.count > 1 { o["label"] = f[1] }
    if f.count > 2, !f[2].isEmpty { o["axid"] = f[2] }
    if f.count > 3, !f[3].isEmpty { o["value"] = f[3] }
    if f.count > 4, !f[4].isEmpty { o["state"] = f[4] }
    return o
}

func fmtFrame(_ r: CGRect?) -> String {
    guard let r = r else { return "-" }
    return "\(Int(r.origin.x)),\(Int(r.origin.y)) \(Int(r.size.width))x\(Int(r.size.height))"
}

func shortActions(_ a: [String]) -> String {
    // 有些应用的 action 名里混着换行和内部字段（Name:/Target:/Selector:），只取首行首段
    let m = a.compactMap { s -> String? in
        var t = s.components(separatedBy: .newlines).first ?? s
        t = t.replacingOccurrences(of: "AX", with: "").trimmingCharacters(in: .whitespaces)
        if t.isEmpty { return nil }
        return t.count > 18 ? String(t.prefix(18)) : t
    }
    return m.isEmpty ? "-" : m.joined(separator: ",")
}

// ==================== 截图 ====================

/// 进程内截窗口：CGWindowListCreateImage 在新系统上已废弃，只能动态取符号，但比起动 screencapture + sips
/// 两个子进程快 3 倍（实测文本编辑窗口 0.16 秒对 0.5 秒）。拿不到符号或截图失败再退回 screencapture。
private enum WindowImage {
    typealias Fn = @convention(c) (CGRect, UInt32, CGWindowID, UInt32) -> Unmanaged<CGImage>?
    static let fn: Fn? = {
        guard let h = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_LAZY),
              let s = dlsym(h, "CGWindowListCreateImage") else { return nil }
        return unsafeBitCast(s, to: Fn.self)
    }()
}

/// 截窗口并按长边缩到 maxDim（0 = 不缩放）写成 PNG。成功返回 true。
///
/// 常驻进程里不直接截：新系统把这个接口转给系统截屏服务，进程会一直连着它。两个连过的进程同时活着，
/// 服务每秒在它们之间来回切几百次，三方各吃半个核（2026-10-13 实测两个闲置 computer-control 进程拖了 20 多小时）。
/// 所以交给一个只截这一张就退出的子进程。代价是新进程每次都要重新连截屏服务，实测每张图慢约 0.12 秒。
func captureWindowFast(_ wid: CGWindowID, to path: String, maxDim: Int) -> Bool {
    if serveMode {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
        p.arguments = ["capture-window", String(wid), path, String(maxDim)]
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return false }
        p.waitUntilExit()
        return p.terminationStatus == 0 && FileManager.default.fileExists(atPath: path)
    }
    return captureWindowInProcess(wid, to: path, maxDim: maxDim)
}

func captureWindowInProcess(_ wid: CGWindowID, to path: String, maxDim: Int) -> Bool {
    // kCGWindowListOptionIncludingWindow = 1<<3；kCGWindowImageBoundsIgnoreFraming = 1<<0，ShouldBeOpaque = 1<<1 不设，保留透明圆角
    guard let fn = WindowImage.fn, let img = fn(.null, 1 << 3, wid, 1 << 0)?.takeRetainedValue(),
          img.width > 1, img.height > 1 else { return false }
    var w = CGFloat(img.width), h = CGFloat(img.height)
    if maxDim > 0 {
        let s = min(1, CGFloat(maxDim) / max(w, h))
        w = (w * s).rounded(); h = (h * s).rounded()
    }
    guard let ctx = CGContext(data: nil, width: Int(w), height: Int(h), bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
    ctx.interpolationQuality = .high
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    guard let out = ctx.makeImage(),
          let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, "public.png" as CFString, 1, nil)
    else { return false }
    CGImageDestinationAddImage(dest, out, nil)
    return CGImageDestinationFinalize(dest)
}

@discardableResult
func captureWindow(_ wid: CGWindowID, to path: String) -> Bool {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    // -l <windowid>：按窗口 ID 截，遮挡也能截到；-x 静音；-o 去阴影
    p.arguments = ["-x", "-o", "-l", String(wid), path]
    try? p.run(); p.waitUntilExit()
    return p.terminationStatus == 0 && FileManager.default.fileExists(atPath: path)
}

/// 按屏幕矩形截图。仅作为拿不到 CGWindowID 时的回退——
/// 它截的是"屏幕上那块区域"，窗口被遮挡时会截到遮挡它的内容。
@discardableResult
func captureRect(_ r: CGRect, to path: String) -> Bool {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    p.arguments = ["-x", "-R", "\(Int(r.origin.x)),\(Int(r.origin.y)),\(Int(r.width)),\(Int(r.height))", path]
    try? p.run(); p.waitUntilExit()
    return p.terminationStatus == 0 && FileManager.default.fileExists(atPath: path)
}

func shrink(_ path: String, maxDim: Int) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/sips")
    p.arguments = ["-Z", String(maxDim), path]
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    try? p.run(); p.waitUntilExit()
}

// ==================== 键鼠 ====================

let keyMap: [String: CGKeyCode] = [
    "a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,"q":12,"w":13,"e":14,"r":15,
    "y":16,"t":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"=":24,"9":25,"7":26,"-":27,"8":28,"0":29,
    "]":30,"o":31,"u":32,"[":33,"i":34,"p":35,"return":36,"l":37,"j":38,"'":39,"k":40,";":41,
    "\\":42,",":43,"/":44,"n":45,"m":46,".":47,"tab":48,"space":49,"`":50,"delete":51,"escape":53,
    "esc":53,"enter":36,"backspace":51,
    "f1":122,"f2":120,"f3":99,"f4":118,"f5":96,"f6":97,"f7":98,"f8":100,"f9":101,"f10":109,"f11":103,"f12":111,
    "left":123,"right":124,"down":125,"up":126,
    "home":115,"end":119,"pageup":116,"pagedown":121,"forwarddelete":117,
]

/// 修饰键对应的真实键码；系统模式要补发 modifier 的按下和抬起，而不是只给主键设 flags。
let modifierKeyMap: [String: CGKeyCode] = [
    "cmd": 55, "command": 55, "super": 55, "meta": 55,
    "shift": 56,
    "alt": 58, "option": 58, "opt": 58,
    "ctrl": 59, "control": 59,
    "fn": 63,
]

func parseHotkey(_ spec: String) -> (code: CGKeyCode, flags: CGEventFlags, modifiers: [CGKeyCode])? {
    var flags: CGEventFlags = []
    var modifiers: [CGKeyCode] = []
    var parts = spec.lowercased().split(separator: "+").map(String.init)
    guard let last = parts.popLast() else { return nil }
    for m in parts {
        guard let modifier = modifierKeyMap[m] else { return nil }
        modifiers.append(modifier)
        switch m {
        case "cmd", "command", "super", "meta": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "alt", "option", "opt": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        case "fn": flags.insert(.maskSecondaryFn)
        default: return nil
        }
    }
    guard let code = keyMap[last] else { return nil }
    return (code, flags, modifiers)
}

func parseKey(_ spec: String) -> (CGKeyCode, CGEventFlags)? {
    guard let hotkey = parseHotkey(spec) else { return nil }
    return (hotkey.code, hotkey.flags)
}


// ==================== 系统唤醒 ====================

/// 当前屏幕是否锁定。读公开的 CGSession 会话字典；键不存在表示未锁。
func sessionScreenLocked() -> Bool? {
    guard let raw = CGSessionCopyCurrentDictionary() else { return nil }
    let dict = raw as NSDictionary
    guard let value = dict["CGSSessionScreenIsLocked"] else { return false }
    if let number = value as? NSNumber { return number.boolValue }
    if let flag = value as? Bool { return flag }
    return nil
}

/// 主显示器是否在睡眠；只读公开电源状态，不改变任何设置。
func mainDisplayAsleep() -> Bool {
    CGDisplayIsAsleep(CGMainDisplayID()) != 0
}

/// 当前前台应用的 bundle id；登录窗口中为 com.apple.loginwindow。
func frontmostBundleId() -> String? {
    NSWorkspace.shared.frontmostApplication?.bundleIdentifier
}

/// 把唤醒前后状态整理成命令返回；纯函数，测试不需要碰真实桌面。
func wakeReport(beforeLocked: Bool?, beforeAsleep: Bool,
                afterLocked: Bool?, afterAsleep: Bool, frontmost: String?,
                input: String?, hold: Double, assertions: [String: Bool]) -> [String: Any] {
    let state: String
    if afterAsleep { state = "asleep" }
    else if afterLocked == true || frontmost == "com.apple.loginwindow" { state = "loginwindow" }
    else if afterLocked == nil || frontmost == nil { state = "unknown" }
    else { state = "desktop" }
    var fields: [String: Any] = [
        "mode": "wake",
        "displayAsleepBefore": beforeAsleep,
        "displayAsleepAfter": afterAsleep,
        "screenLockedBefore": beforeLocked as Any? ?? NSNull(),
        "screenLockedAfter": afterLocked as Any? ?? NSNull(),
        "frontmost": frontmost ?? "",
        "wokeDisplay": beforeAsleep && !afterAsleep,
        "reachedDesktop": state == "desktop",
        "state": state,
        "holdSeconds": hold,
        "assertions": assertions,
    ]
    if let input = input {
        fields["input"] = input
        fields["delivery"] = "cghidEventTap"
    } else {
        fields["input"] = "none"
    }
    return fields
}

/// 发一个全局非文本按键。走公开 CGEvent 的 HID 事件流，不向密码框输入任何文本。
func postGlobalKey(_ spec: String) -> Bool {
    guard let (code, flags) = parseKey(spec) else { return false }
    requirePostEventAccess("系统唤醒按键")
    let source = CGEventSource(stateID: .hidSystemState)
    var posted = false
    if let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true) {
        down.flags = flags
        down.post(tap: .cghidEventTap)
        posted = true
    }
    usleep(30_000)
    if let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) {
        up.flags = flags
        up.post(tap: .cghidEventTap)
    }
    return posted
}

/// 用公开电源管理 API 声明用户活动并短暂阻止显示器睡眠；只做正常唤醒，不碰锁屏和密码策略。
func performWake(holdSeconds: Double, input: String?) -> [String: Any] {
    let beforeLocked = sessionScreenLocked()
    let beforeAsleep = mainDisplayAsleep()
    var activity: IOPMAssertionID = 0
    var displayHold: IOPMAssertionID = 0
    let activityResult = IOPMAssertionDeclareUserActivity("computer-control wake" as CFString,
                                                          kIOPMUserActiveLocal, &activity)
    let holdResult = IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleDisplaySleep as CFString,
                                                 IOPMAssertionLevel(kIOPMAssertionLevelOn),
                                                 "computer-control wake hold" as CFString, &displayHold)
    defer {
        if activity != 0 { IOPMAssertionRelease(activity) }
        if displayHold != 0 { IOPMAssertionRelease(displayHold) }
    }
    let deadline = Date().addingTimeInterval(max(0.3, holdSeconds))
    while Date() < deadline && mainDisplayAsleep() { usleep(100_000) }
    var sentInput: String? = nil
    if let input = input, input != "none",
       (sessionScreenLocked() == true || frontmostBundleId() == "com.apple.loginwindow") {
        if postGlobalKey(input) { sentInput = input }
        let inputDeadline = Date().addingTimeInterval(1.5)
        while Date() < inputDeadline && sessionScreenLocked() == true { usleep(100_000) }
    }
    let remaining = deadline.timeIntervalSinceNow
    if remaining > 0 { usleep(useconds_t(remaining * 1_000_000)) }
    let assertions: [String: Bool] = [
        "userActivity": activityResult == kIOReturnSuccess,
        "displaySleep": holdResult == kIOReturnSuccess,
    ]
    return wakeReport(beforeLocked: beforeLocked, beforeAsleep: beforeAsleep,
                      afterLocked: sessionScreenLocked(), afterAsleep: mainDisplayAsleep(),
                      frontmost: frontmostBundleId(), input: sentInput, hold: holdSeconds,
                      assertions: assertions)
}

// ==================== 定向投递 ====================
//
// 后台键盘/滚轮只有一条路：把事件投进目标进程的事件流，不经过全局光标与焦点。两条通道：
//   1) 私有 SkyLight 的 SLEventPostToPid —— 更直接，Peekaboo 等成熟实现优先用它；
//   2) 公开的 CGEvent.postToPid（即 CGEventPostToPid，macOS 10.11+）—— 稳定兜底。
// 两者都**不回报目标是否处理了事件**（无回执），所以动作后必须重新取态验证，
// 不能只看命令返回值——见 SKILL.md 的三条铁律。

private enum SkyLightPost {
    typealias PostToPidFn = @convention(c) (pid_t, CGEvent) -> Void
    static let fn: PostToPidFn? = {
        guard let h = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY),
              let sym = dlsym(h, "SLEventPostToPid") else { return nil }
        return unsafeBitCast(sym, to: PostToPidFn.self)
    }()
}

/// 强制走公开 API（怀疑私有通道有问题时用）
let forcePublicPost = ProcessInfo.processInfo.environment["COMPUTER_CONTROL_PUBLIC_POST"] == "1"

/// 投递事件到指定进程，返回实际使用的通道名
@discardableResult
func postToPid(_ ev: CGEvent, _ pid: pid_t) -> String {
    if !forcePublicPost, let f = SkyLightPost.fn {
        f(pid, ev)
        return "skylight"
    }
    ev.postToPid(pid)
    return "cgpost"
}

/// 投递通道自述（供 perms 与错误信息展示）
func postChannelName() -> String {
    if forcePublicPost { return "公开 API（COMPUTER_CONTROL_PUBLIC_POST=1）" }
    return SkyLightPost.fn != nil ? "SkyLight 优先，回落公开 API" : "仅公开 API（SkyLight 不可用）"
}

/// macOS 14+ 向其他进程投递事件需要 Event Synthesizing 授权（TCC 服务 kTCCServicePostEvent）。
/// 没有它时事件被系统**静默丢弃**：命令返回成功、界面毫无变化——这是最难查的一类失败，
/// 所以投递前先自检，宁可当场明确报错。
/// 授权对象是运行 computer-control 的宿主进程（pa daemon / 终端 / Zed），不是这个二进制。
/// COMPUTER_CONTROL_ALLOW_POST_DENIED=1 可降级为警告后继续（自检误报时的逃生口）。
func requirePostEventAccess(_ what: String) {
    if CGPreflightPostEventAccess() { return }
    let msg = """
    缺少 Event Synthesizing（事件合成）授权：\(what) 会被系统静默丢弃，界面不会变化。
      授权对象是运行 computer-control 的宿主进程，不是这个二进制；换宿主（终端/Zed/daemon）要重新授权。
      系统设置 → 隐私与安全性 → 辅助功能（或输入监控），打开该宿主的开关后重试。
      自检：computer-control perms
    """
    if ProcessInfo.processInfo.environment["COMPUTER_CONTROL_ALLOW_POST_DENIED"] == "1" {
        warn(msg + "\n（COMPUTER_CONTROL_ALLOW_POST_DENIED=1，仍继续投递）")
        return
    }
    die(msg, 5)
}

/// 定向发给指定进程：用 postToPid，不需要目标应用在前台。返回实际通道名。
func sendKey(pid: pid_t, code: CGKeyCode, flags: CGEventFlags) -> String {
    checkOperationFocus()
    let src = CGEventSource(stateID: .hidSystemState)
    var channel = "cgpost"
    if let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true) {
        down.flags = flags
        actionSent = true; channel = postToPid(down, pid)
    }
    inputCleanup = {
        if let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false) { up.flags = []; _ = postToPid(up, pid) }
    }
    usleep(12000)
    checkOperationFocus()
    if let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false) {
        up.flags = flags
        channel = postToPid(up, pid)
    }
    inputCleanup = nil
    checkOperationFocus()
    return channel
}

/// 判断系统按键的目标是否就是当前前台应用；纯函数，返回错误文本或 nil。
func frontmostTargetError(frontPid: pid_t?, frontName: String?, targetPid: pid_t, targetName: String) -> String? {
    guard let frontPid = frontPid else {
        return "需要目标应用在前台，但读不到当前前台应用"
    }
    guard frontPid == targetPid else {
        return "只发给当前前台应用；当前前台是「\(frontName ?? "?")」，不是「\(targetName)」。不抢焦点，请先把目标切到前台"
    }
    return nil
}

/// 系统模式前置条件：目标应用必须是当前前台应用，避免把真实全局事件发给别的程序。
func requireFrontmost(_ app: NSRunningApplication, _ what: String) {
    let front = NSWorkspace.shared.frontmostApplication
    if let error = frontmostTargetError(frontPid: front?.processIdentifier,
                                        frontName: front?.localizedName,
                                        targetPid: app.processIdentifier,
                                        targetName: app.localizedName ?? "?") {
        die("\(what)\(error)", 4)
    }
}

struct HotkeyEventPlan {
    let keyCode: CGKeyCode
    let keyDown: Bool
    let flags: CGEventFlags
    let modifier: Bool
}

func modifierFlag(_ keyCode: CGKeyCode) -> CGEventFlags {
    switch keyCode {
    case 55: return .maskCommand
    case 56: return .maskShift
    case 58: return .maskAlternate
    case 59: return .maskControl
    case 63: return .maskSecondaryFn
    default: return []
    }
}

/// 组合键事件顺序：修饰键按给定顺序按下 → 主键按下/抬起 → 修饰键逆序抬起；flags 随剩余按键递减。
func hotkeyEventPlan(code: CGKeyCode, flags: CGEventFlags, modifiers: [CGKeyCode]) -> [HotkeyEventPlan] {
    var plan: [HotkeyEventPlan] = []
    var active: CGEventFlags = []
    for modifier in modifiers {
        active.insert(modifierFlag(modifier))
        plan.append(HotkeyEventPlan(keyCode: modifier, keyDown: true, flags: active, modifier: true))
    }
    plan.append(HotkeyEventPlan(keyCode: code, keyDown: true, flags: flags, modifier: false))
    plan.append(HotkeyEventPlan(keyCode: code, keyDown: false, flags: flags, modifier: false))
    for modifier in modifiers.reversed() {
        active.remove(modifierFlag(modifier))
        plan.append(HotkeyEventPlan(keyCode: modifier, keyDown: false, flags: active, modifier: true))
    }
    return plan
}

/// 系统模式：按计划把真实公开事件发到全局 HID 事件流；无回执，调用方必须自己核对界面。
func sendSystemHotkey(code: CGKeyCode, flags: CGEventFlags, modifiers: [CGKeyCode]) -> String {
    let src = CGEventSource(stateID: .hidSystemState)
    var held: [CGKeyCode] = []
    inputCleanup = {
        for code in held.reversed() {
            let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false)
            up?.flags = []
            up?.post(tap: .cghidEventTap)
        }
    }
    for step in hotkeyEventPlan(code: code, flags: flags, modifiers: modifiers) {
        checkOperationFocus()
        if let event = CGEvent(keyboardEventSource: src, virtualKey: step.keyCode, keyDown: step.keyDown) {
            actionSent = true
            if step.keyDown { held.append(step.keyCode) } else { held.removeAll { $0 == step.keyCode } }
            event.flags = step.flags
            event.post(tap: .cghidEventTap)
        }
        usleep(step.modifier ? 10_000 : 25_000)
    }
    inputCleanup = nil
    checkOperationFocus()
    return "cghidEventTap"
}

func sendText(pid: pid_t, text: String) -> String {
    let src = CGEventSource(stateID: .hidSystemState)
    var channel = "cgpost"
    for ch in text.unicodeScalars {
        checkOperationFocus()
        if pasteCancelled { die("输入被取消，动作结果未知；请重新观察，不要自动重发", 1) }
        var u = Array(String(ch).utf16)
        if let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true) {
            down.keyboardSetUnicodeString(stringLength: u.count, unicodeString: &u)
            actionSent = true; channel = postToPid(down, pid)
        }
        if let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false) {
            up.keyboardSetUnicodeString(stringLength: u.count, unicodeString: &u)
            channel = postToPid(up, pid)
        }
        checkOperationFocus()
        usleep(6000)
    }
    if pasteCancelled { die("输入被取消，动作结果未知；请重新观察，不要自动重发", 1) }
    return channel
}

func requireExplicitCoordinate(_ enabled: Bool) {
    guard enabled else { die("后台鼠标投递不可用，未移动真实鼠标；需要全局操作请显式 --coord", 1) }
}

func requireGlobalHit(_ app: NSRunningApplication, _ p: CGPoint) {
    guard CGPreflightPostEventAccess() else { die("真实鼠标操作缺事件投递权限", 5) }
    var hit: AXUIElement?
    let error = AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(p.x), Float(p.y), &hit)
    guard error == .success, let hit = hit else { die("无法验证真实鼠标命中的应用", 4) }
    var pid: pid_t = 0
    guard AXUIElementGetPid(hit, &pid) == .success, pid == app.processIdentifier,
          let owner = NSRunningApplication(processIdentifier: pid) else { die("坐标实际命中其他应用，拒绝投递", 4) }
    if let ref = activeWindowRef {
        beginFocusedOperation(app)
        guard let window = axCopy(hit, kAXWindowAttribute as String), CFGetTypeID(window) == AXUIElementGetTypeID(), nativeWindowID(window as! AXUIElement).map(Int.init) == ref["id"] as? Int else { die("坐标命中其他窗口", 4) }
    }
    requireNotSensitive(owner, "真实鼠标操作")
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
          let top = list.first(where: { item in
              guard let bounds = item[kCGWindowBounds as String] as? [String: Any], let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return false }
              return rect.contains(p) && (item[kCGWindowAlpha as String] as? Double ?? 1) > 0
          }), (top[kCGWindowOwnerPID as String] as? pid_t) == pid else { die("坐标被其他窗口遮挡或无法确认顶层窗口", 4) }
}

func clickAt(_ p: CGPoint, button: String, count: Int) {
    let src = CGEventSource(stateID: .hidSystemState)
    let (dn, up, btn): (CGEventType, CGEventType, CGMouseButton) =
        button == "right" ? (.rightMouseDown, .rightMouseUp, .right) : (.leftMouseDown, .leftMouseUp, .left)
    for i in 1...max(1, count) {
        checkOperationFocus()
        actionSent = true
        if let d = CGEvent(mouseEventSource: src, mouseType: dn, mouseCursorPosition: p, mouseButton: btn) {
            d.setIntegerValueField(.mouseEventClickState, value: Int64(i))
            d.post(tap: .cghidEventTap)
        }
        inputCleanup = { CGEvent(mouseEventSource: src, mouseType: up, mouseCursorPosition: p, mouseButton: btn)?.post(tap: .cghidEventTap) }
        checkOperationFocus()
        if let u = CGEvent(mouseEventSource: src, mouseType: up, mouseCursorPosition: p, mouseButton: btn) {
            u.setIntegerValueField(.mouseEventClickState, value: Int64(i))
            u.post(tap: .cghidEventTap)
        }
        inputCleanup = nil
        checkOperationFocus()
        usleep(60000)
        checkOperationFocus()
    }
}

/// 全树按标签模糊找（不限角色），供 wait 轮询用
func findLabelLoose(root: AXUIElement, label: String) -> Bool {
    var hit = false
    func rec(_ el: AXUIElement, _ d: Int) {
        if hit || d > 28 { return }
        if labelOf(el).localizedCaseInsensitiveContains(label) { hit = true; return }
        for k in axChildren(el) { if hit { return }; rec(k, d + 1) }
    }
    rec(root, 0)
    return hit
}

/// 完整快照剪贴板（所有 item 的所有类型）。
/// 只存 .string 会丢掉图片/文件/富文本——那等于替用户销毁数据。
func snapshotPasteboard(_ pb: NSPasteboard) -> [[NSPasteboard.PasteboardType: Data]] {
    var out: [[NSPasteboard.PasteboardType: Data]] = []
    for item in pb.pasteboardItems ?? [] {
        var d: [NSPasteboard.PasteboardType: Data] = [:]
        for type in item.types {
            guard let data = item.data(forType: type) else { die("剪贴板包含无法完整读取的类型，未改写", 1) }
            d[type] = data
        }
        if !d.isEmpty { out.append(d) }
    }
    return out
}

/// 还原快照；返回是否真的还原了
@discardableResult
func restorePasteboard(_ pb: NSPasteboard, _ snapshot: [[NSPasteboard.PasteboardType: Data]]) -> Bool {
    if snapshot.isEmpty { pb.clearContents(); return true }
    let items = snapshot.map { dict -> NSPasteboardItem in
        let it = NSPasteboardItem()
        for (ty, da) in dict { it.setData(da, forType: ty) }
        return it
    }
    pb.clearContents()
    return pb.writeObjects(items)
}

var clipboardSaved: [[NSPasteboard.PasteboardType: Data]]? = nil
var clipboardOwnerCount: Int? = nil
var clipboardRestored = false
var pasteCancelled = false

func ownsClipboard(current: Int, expected: Int?) -> Bool { current == expected }

func cleanupClipboard(_ pasteboard: () -> NSPasteboard = { .general }) {
    guard let saved = clipboardSaved else { return }
    let pb = pasteboard()
    if ownsClipboard(current: pb.changeCount, expected: clipboardOwnerCount) { clipboardRestored = restorePasteboard(pb, saved) }
    clipboardSaved = nil
    clipboardOwnerCount = nil
}

/// 拖拽：按下 → 分步移动（一步到位很多应用识别不了）→ 松开
func dragFrom(_ a: CGPoint, to b: CGPoint, steps: Int = 24) {
    checkOperationFocus()
    actionSent = true
    let src = CGEventSource(stateID: .hidSystemState)
    CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: a, mouseButton: .left)?
        .post(tap: .cghidEventTap)
    usleep(60000)
    checkOperationFocus()
    CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: a, mouseButton: .left)?
        .post(tap: .cghidEventTap)
    usleep(60000)
    inputCleanup = { CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: a, mouseButton: .left)?.post(tap: .cghidEventTap) }
    for i in 1...steps {
        checkOperationFocus()
        actionSent = true
        let t = Double(i) / Double(steps)
        let p = CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
        CGEvent(mouseEventSource: src, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left)?
            .post(tap: .cghidEventTap)
        usleep(14000)
    }
    usleep(60000)
    checkOperationFocus()
    CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: b, mouseButton: .left)?
        .post(tap: .cghidEventTap)
    inputCleanup = nil
    checkOperationFocus()
}

func parsePoint(_ s: String) -> CGPoint {
    let xy = s.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
    guard xy.count == 2 else { die("坐标格式应为 X,Y，收到 '\(s)'") }
    return CGPoint(x: xy[0], y: xy[1])
}


// ==================== 精确定向投递（鼠标） ====================
// 只靠 postToPid 发的鼠标事件，AppKit 不知道点在哪个窗口里，双击选词、网页里的滚轮都不生效。
// 下面给事件补上窗口号、窗口内坐标、目标进程，并在点击前后让目标进程「以为自己在前台」，
// 真实前台应用和真鼠标都不动。做法和字段编号来自 iFurySt/open-codex-computer-use
// （MIT，SkyLightSPI.swift / SkyClickSimulation.swift，其注明源自 MIT 的 Cua Driver 与 yabai）。
// 全部是私有接口：拿不到任何一个符号就整体退回旧路径，不崩。
private enum SkyMouse {
    typealias PostFn = @convention(c) (pid_t, UnsafeMutableRawPointer?) -> Void
    typealias SetFieldFn = @convention(c) (UnsafeMutableRawPointer?, UInt32, Int64) -> Void
    typealias SetWinLocFn = @convention(c) (UnsafeMutableRawPointer?, Double, Double) -> Void
    typealias PostRecordFn = @convention(c) (UnsafeRawPointer?, UnsafePointer<UInt8>?) -> Int32
    typealias GetPSNFn = @convention(c) (pid_t, UnsafeMutableRawPointer?) -> Int32
    static let sl = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY | RTLD_GLOBAL)
    static let asv = dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", RTLD_LAZY | RTLD_GLOBAL)
    static func sym<T>(_ h: UnsafeMutableRawPointer?, _ n: String) -> T? { h.flatMap { dlsym($0, n) }.map { unsafeBitCast($0, to: T.self) } }
    static let post: PostFn? = sym(sl, "SLEventPostToPid")
    static let setField: SetFieldFn? = sym(sl, "SLEventSetIntegerValueField")
    static let setWinLoc: SetWinLocFn? = sym(sl, "CGEventSetWindowLocation")
    static let postRecord: PostRecordFn? = sym(sl, "SLPSPostEventRecordTo")
    static let getPSN: GetPSNFn? = sym(asv, "GetProcessForPID")
    static var available: Bool { post != nil && setField != nil && setWinLoc != nil && postRecord != nil && getPSN != nil && !forcePublicPost }
}

/// 找到 pid 名下、包含屏幕点 p 的普通窗口：返回窗口号和窗口在屏幕上的范围
func windowAt(_ pid: pid_t, _ p: CGPoint) -> (CGWindowID, CGRect)? {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
    for w in list where (w[kCGWindowOwnerPID as String] as? pid_t) == pid && (w[kCGWindowLayer as String] as? Int) == 0 {
        guard let b = w[kCGWindowBounds as String] as? [String: CGFloat],
              let n = w[kCGWindowNumber as String] as? NSNumber else { continue }
        let r = CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
        if r.contains(p) { return (n.uint32Value, r) }
    }
    return nil
}

struct MouseTarget {
    let pid: pid_t
    let point: CGPoint      // 屏幕坐标
    let windowID: CGWindowID
    let local: CGPoint      // 窗口内坐标
}

func mouseTarget(_ pid: pid_t, _ p: CGPoint) -> MouseTarget? {
    guard SkyMouse.available, let (wid, r) = windowAt(pid, p) else { return nil }
    if let ref = activeWindowRef, ref["id"] as? Int != Int(wid) { die("坐标命中同应用其他窗口，拒绝投递", 4) }
    if activeWindowRef != nil, let app = NSRunningApplication(processIdentifier: pid) { beginFocusedOperation(app) }
    return MouseTarget(pid: pid, point: p, windowID: wid, local: CGPoint(x: p.x - r.minX, y: p.y - r.minY))
}

private func stamp(_ e: CGEvent, _ t: MouseTarget, state: Int64? = nil, phase: Int64? = nil, button: Int64? = nil, group: Int64? = nil) {
    guard let set = SkyMouse.setField, let loc = SkyMouse.setWinLoc else { return }
    let raw = Unmanaged.passUnretained(e).toOpaque()
    if let phase = phase { set(raw, 0, phase) }
    if let state = state { set(raw, 1, state) }
    if let button = button { set(raw, 3, button) }
    if phase != nil { set(raw, 7, 3) }
    set(raw, 40, Int64(t.pid)); set(raw, 51, Int64(t.windowID))
    if let group = group { set(raw, 58, group) }
    set(raw, 91, Int64(t.windowID)); set(raw, 92, Int64(t.windowID))
    loc(raw, t.local.x, t.local.y)
}

private func postBoth(_ e: CGEvent, _ pid: pid_t) {
    checkOperationFocus()
    actionSent = true
    if e.type == .leftMouseDown || e.type == .rightMouseDown {
        let up = e.copy()
        up?.type = e.type == .leftMouseDown ? .leftMouseUp : .rightMouseUp
        inputCleanup = { if let up = up { SkyMouse.post?(pid, Unmanaged.passUnretained(up).toOpaque()); up.postToPid(pid) } }
    }
    SkyMouse.post?(pid, Unmanaged.passUnretained(e).toOpaque())
    e.postToPid(pid)
    if e.type == .leftMouseUp || e.type == .rightMouseUp { inputCleanup = nil }
}

/// 让目标进程短暂「以为自己在前台」：AppKit 只把点击当成对前台窗口的操作。结束时只撤销目标，不碰真实前台。
private func withSyntheticFocus(_ t: MouseTarget, _ body: () -> Void) {
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier != t.pid,
          let getPSN = SkyMouse.getPSN, let postRecord = SkyMouse.postRecord else { body(); return }
    var psn = [UInt8](repeating: 0, count: 8)
    guard psn.withUnsafeMutableBytes({ getPSN(t.pid, $0.baseAddress) }) == 0 else { body(); return }
    func record(_ focused: Bool) {
        var r = [UInt8](repeating: 0, count: 0xF8)
        r[0x04] = 0xF8; r[0x08] = 0x0D
        for i in 0..<4 { r[0x3C + i] = UInt8(truncatingIfNeeded: t.windowID >> (8 * UInt32(i))) }
        r[0x8A] = focused ? 0x01 : 0x02
        _ = psn.withUnsafeBytes { p in r.withUnsafeBufferPointer { postRecord(p.baseAddress, $0.baseAddress) } }
        usleep(40000)
    }
    record(true)
    body()
    usleep(100000)   // 投递是异步的，等最后一个抬起被消费掉再撤销
    record(false)
}

/// 后台左键单击/双击：先在 (-1,-1) 点一下「预热」，再点目标。Chromium 系应用没有预热会吞掉第一下。
func skyLeftClick(_ t: MouseTarget, count: Int) {
    let src = CGEventSource(stateID: .hidSystemState)
    let group = Int64(DispatchTime.now().uptimeNanoseconds % 1_000_000_000)
    let primer = CGPoint(x: -1, y: -1)
    let primerTarget = MouseTarget(pid: t.pid, point: primer, windowID: t.windowID, local: primer)
    func send(_ type: CGEventType, _ tt: MouseTarget, state: Int64, phase: Int64) {
        guard let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: tt.point, mouseButton: .left) else { return }
        stamp(e, tt, state: state, phase: phase, button: 0, group: group)
        postBoth(e, t.pid)
    }
    withSyntheticFocus(t) {
        send(.mouseMoved, t, state: 0, phase: 2); usleep(15000)
        send(.leftMouseDown, primerTarget, state: 1, phase: 1); usleep(1000)
        send(.leftMouseUp, primerTarget, state: 1, phase: 2); usleep(100000)
        for i in 1...max(1, min(count, 3)) {
            checkOperationFocus()
            send(.leftMouseDown, t, state: Int64(i), phase: 3); usleep(1000)
            send(.leftMouseUp, t, state: Int64(i), phase: 3)
            if i < count { usleep(80000) }
        }
    }
}

/// 后台右键：和左键同一套窗口定位，按下前先让目标「以为自己在前台」。给没有 ShowMenu 动作的元素用（访达边栏、网页画布）。
func skyRightClick(_ t: MouseTarget) {
    let src = CGEventSource(stateID: .hidSystemState)
    let group = Int64(DispatchTime.now().uptimeNanoseconds % 1_000_000_000)
    func send(_ type: CGEventType, state: Int64, phase: Int64) {
        guard let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: t.point, mouseButton: .right) else { return }
        stamp(e, t, state: state, phase: phase, button: 1, group: group)
        postBoth(e, t.pid)
    }
    withSyntheticFocus(t) {
        send(.mouseMoved, state: 0, phase: 2); usleep(15000)
        send(.rightMouseDown, state: 1, phase: 3); usleep(30000)
        send(.rightMouseUp, state: 1, phase: 3)
    }
}

/// 后台拖拽：按下、一串拖动、抬起，全部带窗口号和窗口内坐标定向投递，真鼠标不动。
/// 同一次拖拽的事件共用一个手势编号，窗口服务器才认得出这是一次连续拖动（拖窗口、拖选文字、拖滑块都靠这个）。
func skyDrag(_ a: MouseTarget, to bPoint: CGPoint, steps: Int = 24) -> Bool {
    guard let (wid, r) = windowAt(a.pid, a.point), wid == a.windowID else { return false }
    let src = CGEventSource(stateID: .hidSystemState)
    let group = Int64(DispatchTime.now().uptimeNanoseconds % 1_000_000_000)
    func target(_ p: CGPoint) -> MouseTarget { MouseTarget(pid: a.pid, point: p, windowID: wid, local: CGPoint(x: p.x - r.minX, y: p.y - r.minY)) }
    func send(_ type: CGEventType, _ p: CGPoint, state: Int64) {
        guard let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: .left) else { return }
        stamp(e, target(p), state: state, phase: nil, button: 0, group: group)
        postBoth(e, a.pid)
    }
    withSyntheticFocus(a) {
        send(.mouseMoved, a.point, state: 0); usleep(20000)
        send(.leftMouseDown, a.point, state: 1); usleep(60000)
        for i in 1...steps {
        checkOperationFocus()
            let t = Double(i) / Double(steps)
            send(.leftMouseDragged, CGPoint(x: a.point.x + (bPoint.x - a.point.x) * t, y: a.point.y + (bPoint.y - a.point.y) * t), state: 1)
            usleep(14000)
        }
        usleep(40000)
        send(.leftMouseUp, bPoint, state: 1)
    }
    return true
}

/// 后台滚轮：带上窗口号和窗口内坐标，网页里的小列表才会跟着滚（只用 postToPid 时网页收不到）。
func skyScroll(_ t: MouseTarget, dx: Int32, dy: Int32) -> Bool {
    guard let e = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) else { return false }
    e.location = t.point
    stamp(e, t)
    postBoth(e, t.pid)
    return true
}

/// 让 Chrome/Arc/Electron 把网页内容交给辅助功能，等到网页元素出现或超时。返回是否已读得到网页。
/// Chrome 默认只暴露浏览器外壳；给应用根元素设 AXEnhancedUserInterface（VoiceOver 的做法）后约 1~2 秒网页元素才出现。
/// Chrome 对这次写入返回 -25208 但实际已生效，所以不看返回码，按树里有没有带内容的 AXWebArea 判断。
/// AXManualAccessibility 是 Electron 的专用开关，对 Chrome 返回 -25205；两个都写，互不影响。
func hasWebContent(_ pid: pid_t) -> Bool {
    let (win, _) = uiRoot(pid, nil)
    var found = false
    func rec(_ el: AXUIElement, _ d: Int) {
        if d > 12 || found { return }
        if axStr(el, kAXRoleAttribute as String) == "AXWebArea", !axChildren(el).isEmpty { found = true; return }
        for k in axChildren(el) { rec(k, d + 1) }
    }
    rec(win, 0)
    return found
}

@discardableResult
func enableWebContent(_ pid: pid_t, timeout: Double) -> (ok: Bool, seconds: Double, manual: Int32, enhanced: Int32) {
    let root = axApp(pid)
    let manual = AXUIElementSetAttributeValue(root, "AXManualAccessibility" as CFString, kCFBooleanTrue).rawValue
    let enhanced = AXUIElementSetAttributeValue(root, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue).rawValue
    let t0 = Date()
    var ok = hasWebContent(pid)
    while !ok && Date().timeIntervalSince(t0) < timeout { usleep(250000); ok = hasWebContent(pid) }
    return (ok, (Date().timeIntervalSince(t0) * 10).rounded() / 10, manual, enhanced)
}

/// 已知会把网页内容藏起来的应用：Chromium 系浏览器和 Electron 应用。不在名单里的应用 snap 时不会被改设置。
let webHosts: Set<String> = ["com.google.Chrome", "com.google.Chrome.canary", "com.google.chrome.for.testing",
                             "company.thebrowser.Browser",
                             "com.microsoft.edgemac", "com.brave.Browser", "org.chromium.Chromium",
                             "com.vivaldi.Vivaldi", "com.operasoftware.Opera", "com.electron.lark",
                             "com.tinyspeck.slackmacgap", "com.microsoft.VSCode", "com.hnc.Discord",
                             "notion.id", "com.figma.Desktop", "com.tencent.xinWeChat"]
func isElectron(_ app: NSRunningApplication) -> Bool {
    guard let url = app.bundleURL else { return false }
    return FileManager.default.fileExists(atPath: url.appendingPathComponent("Contents/Frameworks/Electron Framework.framework").path)
}

/// 敏感应用：终端、密码管理器、钥匙串、系统授权框。默认只允许读、不允许操作——在这些窗口里点一下、敲一行，
/// 后果收不回来。确实要操作时设 COMPUTER_CONTROL_ALLOW_SENSITIVE=1，或
/// COMPUTER_CONTROL_ALLOW_APPS=com.apple.Terminal,… 单独放行。
let sensitiveApps: Set<String> = [
    "com.apple.Terminal", "com.googlecode.iterm2", "com.mitchellh.ghostty", "com.github.wez.wezterm",
    "net.kovidgoyal.kitty", "io.alacritty", "dev.warp.Warp-Stable", "co.zeit.hyper", "com.raphaelamorim.rio",
    "com.apple.keychainaccess", "com.apple.Passwords", "com.1password.1password", "com.agilebits.onepassword7",
    "com.bitwarden.desktop", "com.lastpass.LastPass", "com.dashlane.dashlanephonefinal", "in.sinew.Enpass-Desktop",
    "com.apple.SecurityAgent", "com.apple.LocalAuthentication.UIAgent", "com.apple.ScriptEditor2", "com.apple.Automator",
]
func requireNotSensitive(_ app: NSRunningApplication, _ what: String) {
    guard let bid = app.bundleIdentifier, sensitiveApps.contains(bid) else { return }
    let env = ProcessInfo.processInfo.environment
    if env["COMPUTER_CONTROL_ALLOW_SENSITIVE"] == "1" { return }
    let allowed = Set((env["COMPUTER_CONTROL_ALLOW_APPS"] ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) })
    if allowed.contains(bid) { return }
    die("『\(app.localizedName ?? bid)』属于敏感应用（终端、密码管理器、系统授权框），默认只能读、不能\(what)。" +
        "确认要操作时设 COMPUTER_CONTROL_ALLOW_APPS=\(bid) 或 COMPUTER_CONTROL_ALLOW_SENSITIVE=1", 6)
}

// ==================== 任务归属 ====================

struct AppOwnership: Codable {
    var schema = 1
    var owner: String?
    var generation: String
    var retired: [String]
}

func ownershipURL(_ key: String) -> URL {
    cacheDir().appendingPathComponent("owner-" + key.replacingOccurrences(of: "/", with: "_") + ".json")
}

func loadOwnership(_ key: String) -> AppOwnership? {
    let url = ownershipURL(key)
    if !FileManager.default.fileExists(atPath: url.path) { return nil }
    guard let data = try? Data(contentsOf: url),
          let state = try? JSONDecoder().decode(AppOwnership.self, from: data), state.schema == 1 else {
        die("应用任务归属记录损坏，拒绝接管；需核对后恢复", 4)
    }
    return state
}

func saveOwnership(_ key: String, _ state: AppOwnership) {
    do { try JSONEncoder().encode(state).write(to: ownershipURL(key), options: .atomic) }
    catch { die("应用任务归属写入失败，未执行应用动作：\(error)", 4) }
}

func validTaskScope(_ scope: String) -> Bool {
    !scope.isEmpty && scope.utf8.count <= 256 && !scope.contains(where: { $0.isNewline || $0 == "\0" })
}

func ownershipTransition(_ previous: AppOwnership?, scope: String, action: String,
                         lease: String? = nil, next: String? = nil, expectedOwner: String? = nil,
                         authorized: Bool = false) -> AppOwnership {
    guard validTaskScope(scope) else { die("任务归属需要非空 scope（最多256字节，不能含换行）", 2) }
    var state = previous ?? AppOwnership(owner: nil, generation: UUID().uuidString, retired: [])
    if action == "auto" || action == "claim" {
        if let owner = state.owner {
            guard owner == scope else { die("应用正由任务『\(owner)』持有，当前任务不得接管", 6) }
            if action == "auto" && state.retired.contains(scope) && lease == nil { die("曾释放的任务须传当前持有凭证，旧无凭证请求不得复活", 4) }
            if let lease = lease, lease != state.generation { die("应用持有凭证已失效，不能重新解释旧请求", 4) }
            return state
        }
        if action == "auto" && state.retired.contains(scope) { die("本任务已释放应用；再次操作须显式 claim，旧请求不自动接管", 4) }
        guard lease == nil else { die("已释放的持有凭证不能重新接管应用", 4) }
        state.owner = scope
        state.generation = UUID().uuidString
        return state
    }
    if action == "recover" {
        guard authorized, let owner = state.owner, owner == expectedOwner,
              lease == state.generation else { die("恢复必须明确授权并核对旧 owner 和 lease；不按时间或进程猜死", 6) }
        if !state.retired.contains(owner) { state.retired.append(owner) }
        state.owner = scope
        state.generation = UUID().uuidString
        return state
    }
    guard state.owner == scope else { die("应用不属于当前任务，不能操作或释放", 6) }
    guard let lease = lease, lease == state.generation else { die("应用持有凭证缺失或过期，未执行动作", 4) }
    if action == "check" { return state }
    guard action == "release" || action == "handoff" else { die("未知归属动作", 2) }
    if !state.retired.contains(scope) { state.retired.append(scope) }
    if action == "handoff" {
        guard let next = next, validTaskScope(next), next != scope else { die("交接需要不同的有效目标 scope", 2) }
        state.owner = next
    } else {
        state.owner = nil
    }
    state.generation = UUID().uuidString
    return state
}

func updateOwnership(_ key: String, scope: String, action: String,
                     lease: String? = nil, next: String? = nil, expectedOwner: String? = nil,
                     authorized: Bool = false) -> AppOwnership {
    let previous = loadOwnership(key)
    let state = ownershipTransition(previous, scope: scope, action: action, lease: lease,
                                    next: next, expectedOwner: expectedOwner, authorized: authorized)
    saveOwnership(key, state)
    return state
}

var taskScope: String? = nil
var taskLease: String? = nil
var activeOwnership: AppOwnership? = nil

func requireTaskScope() -> String {
    guard let scope = taskScope, validTaskScope(scope) else {
        die("应用操作需要任务 scope：传 --scope 或设置 COMPUTER_CONTROL_CONTEXT_ID / DSH_SESSION_ID", 2)
    }
    return scope
}

func bindTaskOwnership(_ app: NSRunningApplication) {
    let key = app.bundleIdentifier ?? String(app.processIdentifier)
    if isBrowserBundle(key) {
        if currentCommand == "windows" || currentCommand == "owner" { return }
        if let ref = boundWindowRef { _ = resolveWindowRef(app, ref); activeWindowRef = ref }
        else if currentCommand == "snap" {
            guard let (window, _) = pickWindow(app.processIdentifier, index: requestedWindowIndex) else { die("浏览器没有可绑定窗口", 4) }
            activeWindowRef = windowRef(app, window)
        } else if currentCommand == "menu" && args.count <= 1 { return }
        else { die("共享浏览器动作必须带稳定 --window-ref；先 windows 或 snap", 4) }
        if let ref = activeWindowRef { lockResource("window-\(ref["pid"]!)-\(ref["startedAt"]!)-\(ref["id"]!)") }
        if requireFocus { beginFocusedOperation(app) }
        return
    }
    if let ref = boundWindowRef { _ = resolveWindowRef(app, ref); activeWindowRef = ref }
    lockResource("app-" + key)
    if currentCommand == "owner" { return }
    activeOwnership = updateOwnership(key, scope: requireTaskScope(), action: "auto", lease: taskLease)
}

// ==================== 参数 ====================

var args = Array(CommandLine.arguments.dropFirst())
var optionBoundary: Int? = nil
var snapshotToken: String? = nil
var commandLocks: [Int32] = []

func lockResource(_ key: String) {
    let path = cacheDir().appendingPathComponent("lock-" + key.replacingOccurrences(of: "/", with: "_")).path
    let fd = Darwin.open(path, O_CREAT | O_RDWR, 0o600)
    guard fd >= 0 else { die("无法取得命令锁", 4) }
    let flags = (key.hasPrefix("app-") || key.hasPrefix("window-") || key == "desktop-input" || key == "clipboard") ? LOCK_EX | LOCK_NB : LOCK_EX
    guard flock(fd, flags) == 0 else { Darwin.close(fd); die("应用正在执行其他命令，未等待或执行当前请求", 6) }
    commandLocks.append(fd)
}

func requireAXAccess(trusted: Bool = AXIsProcessTrusted()) {
    guard trusted else { die("缺辅助功能权限，未读取或覆盖快照缓存", 5) }
}


func removeFirstArg() {
    args.removeFirst()
    if let boundary = optionBoundary { optionBoundary = max(0, boundary - 1) }
}

let valueFlags: Set<String> = ["--window-ref", "--scope", "--lease", "--to", "--expected-owner", "--snapshot", "--max", "--depth", "--window", "--out", "--shrink", "--id", "--label", "--at", "--count", "--button", "--pages", "--timeout", "--settle", "--hold", "--input"]

func optionIndex(_ name: String) -> Int? {
    let end = optionBoundary ?? args.firstIndex(of: "--") ?? args.count
    var i = 0
    while i < end {
        if args[i] == name { return i }
        i += valueFlags.contains(args[i]) ? 2 : 1
    }
    return nil
}

func flagValue(_ name: String) -> String? {
    if let i = optionIndex(name), i + 1 < (optionBoundary ?? args.firstIndex(of: "--") ?? args.count) {
        let v = args[i + 1]; args.removeSubrange(i...(i + 1)); if optionBoundary != nil { optionBoundary! -= 2 }; return v
    }
    return nil
}
func hasFlag(_ name: String) -> Bool {
    if let i = optionIndex(name) { args.remove(at: i); if optionBoundary != nil { optionBoundary! -= 1 }; return true }
    return false
}
/// --json：输出单行 JSON 供程序消费。stdout 只有 JSON，诊断信息一律走 stderr。
var jsonMode = false

func emitJSON(_ obj: [String: Any]) {
    var obj = obj
    if obj["ok"] as? Bool == true, obj["ownership"] == nil, let state = activeOwnership {
        obj["ownership"] = ["owner": state.owner as Any? ?? NSNull(), "lease": state.generation]
    }
    let opts: JSONSerialization.WritingOptions = [.withoutEscapingSlashes, .sortedKeys]
    let s: String
    if let d = try? JSONSerialization.data(withJSONObject: obj, options: opts), let t = String(data: d, encoding: .utf8) {
        s = t
    } else {
        s = "{\"ok\":false,\"error\":\"JSON 序列化失败\"}"
    }
    if serveMode { serveOutput.append(s) } else { print(s) }
}

/// 动作类命令的成功输出：先等界面稳定，把等了多久一起返回
func emitAction(_ pid: pid_t, _ human: String, _ fields: [String: Any]) {
    var f = fields
    actionSent = true
    checkOperationFocus()
    let waited = settleAfterAction(pid)
    checkOperationFocus()
    if waited > 0 { f["settled"] = waited }
    emitOK(human, f)
}

/// 成功输出：非 JSON 模式打印人类可读文本，JSON 模式输出结构化对象
func emitOK(_ human: String, _ fields: [String: Any] = [:]) {
    if jsonMode {
        var o: [String: Any] = ["ok": true]
        for (k, v) in fields { o[k] = v }
        if let state = activeOwnership { o["ownership"] = ["owner": state.owner as Any? ?? NSNull(), "lease": state.generation] }
        emitJSON(o)
    } else if !human.isEmpty {
        print(human)
    }
}

var currentCommand = ""

func die(_ msg: String, _ code: Int32 = 2, outcome: String? = nil) -> Never {
    if jsonMode {
        emitJSON(["ok": false, "error": msg, "code": Int(code), "command": currentCommand,
                  "host": "local", "outcome": outcome ?? (code == 1 ? "unknown" : "not_sent")])
    } else {
        FileHandle.standardError.write("computer-control: \(msg)\n".data(using: .utf8)!)
    }
    finish(code)
}

func warn(_ msg: String) {
    if serveMode { serveWarnings.append(msg); return }
    FileHandle.standardError.write("computer-control: \(msg)\n".data(using: .utf8)!)
}

/// 按 AXIdentifier 定位——最稳的方式：开发者定义、语言无关、不随内容变化
func locateById(_ app: NSRunningApplication, _ wantId: String, _ q: String, winIdx: Int?) -> (AXUIElement, String, String) {
    let (win, _) = uiRoot(app.processIdentifier, winIdx)
    let hits = completeSearch(root: win, children: searchChildren) { el in
        searchString(el, "AXIdentifier").map(clean) == wantId
    }.map { ($0, axStr($0, kAXRoleAttribute as String) ?? "", labelOf($0)) }
    if hits.count == 1 { return hits[0] }
    if hits.count > 1 {
        die("有 \(hits.count) 个元素的 ID 是「\(wantId)」，无法确定", 4)
    }
    die("在 '\(q)' 里找不到 ID 为「\(wantId)」的元素。先 `computer-control snap \(q)` 看看有哪些 ID", 3)
}

/// 按标签直接定位（不依赖编号，界面变化后依然有效——推荐的用法）
func locateByLabel(_ app: NSRunningApplication, _ label: String, _ q: String, winIdx: Int?) -> (AXUIElement, String, String) {
    let (win, _) = uiRoot(app.processIdentifier, winIdx)
    var exact: [(AXUIElement, String, String)] = []
    var fuzzy: [(AXUIElement, String, String)] = []
    _ = completeSearch(root: win, children: searchChildren) { el in
        let r = searchString(el, kAXRoleAttribute as String) ?? ""
        let l = searchLabel(el)
        if !l.isEmpty {
            if l == label { exact.append((el, r, l)) }
            else if l.lowercased().contains(label.lowercased()) { fuzzy.append((el, r, l)) }
        }
        return false
    }
    if exact.count == 1 { return exact[0] }
    if exact.count > 1 {
        die("有 \(exact.count) 个元素叫「\(label)」，无法确定。用 snap 看编号后按编号操作", 4)
    }
    if fuzzy.count == 1 {
        warn("没有精确匹配「\(label)」，用了模糊匹配到的「\(fuzzy[0].2)」")
        return fuzzy[0]
    }
    if fuzzy.count > 1 {
        let names = fuzzy.map { "「\($0.2)」" }.joined(separator: " ")
        die("找不到「\(label)」；相近的有: \(names)", 3)
    }
    die("在 '\(q)' 里找不到标签为「\(label)」的元素。先跑 `computer-control snap \(q)` 看看有什么", 3)
}

/// 统一定位：缓存路径 → 角色/标签校验 → 路径失效则按 角色+标签 全树自愈
/// 这是本工具的核心保障：界面变化时宁可报错或自愈，也绝不点错元素。
func locate(_ app: NSRunningApplication, _ key: String, _ idx: Int, _ q: String) -> (AXUIElement, String, String) {
    guard let ref = loadCache(key, idx: idx) else {
        die("编号 \(idx) 不在缓存里，先跑 `computer-control snap \(q)`", 3)
    }
    let win = verifiedWindow(app, key, ref.win, q)
    if let el = resolvePath(root: win, path: ref.path) {
        let nowRole = axStr(el, kAXRoleAttribute as String) ?? ""
        let nowLabel = labelOf(el)
        let nowId = axStr(el, "AXIdentifier").map(clean)
        // AXIdentifier 优先：它语言无关、不随内容变化，比标签可靠
        if let want = ref.axid {
            if want == nowId && nowRole == ref.role { return (el, nowRole, nowLabel) }
        } else if nowRole == ref.role && (ref.label.isEmpty || nowLabel == ref.label) {
            return (el, nowRole, nowLabel)
        }
    }
    // 路径失效 → 先按 AXIdentifier 找（最稳），再退回按标签找
    if let want = ref.axid {
        let found = completeSearch(root: win, children: searchChildren) { el in
            searchString(el, "AXIdentifier").map(clean) == want && searchString(el, kAXRoleAttribute as String) == ref.role
        }
        if found.count > 1 { die("元素 ID 不唯一，请重新 snap", 4) }
        if let el = found.first {
            warn("#\(idx) 位置已变，按 ID「\(want)」自动重定位成功")
            return (el, axStr(el, kAXRoleAttribute as String) ?? "", labelOf(el))
        }
    }
    if ref.axid == nil && !ref.label.isEmpty {
        let hits = findByRoleLabel(root: win, role: ref.role, label: ref.label)
        if hits.count == 1 {
            warn("#\(idx) 位置已变，按标签「\(ref.label)」自动重定位成功")
            return (hits[0], ref.role, ref.label)
        }
        if hits.count > 1 {
            die("界面已变，且有 \(hits.count) 个同名的「\(ref.label)」，无法确定是哪个。请重新 snap", 4)
        }
    }
    die("元素 #\(idx)（\(ref.role) \"\(ref.label)\"）已不存在，请重新 snap", 4)
}

let usage = """
computer-control \(VERSION) — macOS 桌面控制（给 agent 用）

机器选择（由 computer-control 启动器处理，选项放在命令前）：
  computer-control -H <host> <命令>                     临时指定机器，如 computer-control -H beta snap Finder
  computer-control --host <host> <命令>                 与 -H 相同；local 表示本机
  computer-control use <host>                           设置 computer-control 自己的默认机器
  computer-control pin                                  查看 computer-control 当前默认目标
  computer-control hosts                                查看可用机器
  computer-control use --clear                          清除默认目标，回到本机
  未指定机器时读取 computer-control 的默认目标，不沿用 remote-host 或 dsh-control 的默认机器。
  远程截图由共享传输层取回本机；JSON 的 shot/path 是本机路径，remotePath 是原路径。

  apps [--all]                            列出运行中的应用（--all 含 Dock/控制中心等系统 UI）
  menu <app> [菜单名] [菜单项]              读/点应用菜单栏，如 menu Zed "File" "Save"
  drag <app> X1,Y1 X2,Y2 [--coord]        拖拽（默认后台，失败直接报错；--coord 用真鼠标，路径必须属于指定应用）
  snap <app> [选项]                        ★ 取态：带编号的元素清单，默认不截图
      --shot           同时截图
      --diff           只输出与上次 snap 的差异（无变化就一行带过，极省 token）
      --all            不过滤，输出全部元素
      --max N          最多输出 N 个元素（默认 120）
      --depth N        最大遍历深度（默认 25）
      --window N       第 N 个窗口（默认主窗口）
      --out PATH       截图保存路径（默认缓存中的 UUID 图片）
      --snapshot TOKEN 编号操作必填；绑定 snap 返回的凭证，缺失或过期退出4
      --scope TASK 任务标识；默认 COMPUTER_CONTROL_CONTEXT_ID / DSH_SESSION_ID
      --lease TOKEN 持有凭证；交接/释放后的旧凭证拒绝
      owner APP status|claim|release|handoff|recover 管理归属，不关窗口
      handoff 需 --to TASK，恢复需 --expected-owner TASK --lease TOKEN --authorized
      --               后面所有参数都是原样文本，不解析成选项
      --shrink N       截图缩放长边到 N 像素（默认 1400，0 = 不缩放）
  click <app> --id "Seven"     ★最稳：按 AXIdentifier 点，语言无关、内容无关
  click <app> --label "文本"   按标签点，界面变了也有效（中文系统标签是中文）
  click <app> <idx>           按 snap 给的编号点（编号会随界面变化失效）
  click <app> --at X,Y        按像素坐标后台点（--coord 才移动真实鼠标）
        公共选项: [--count N] [--button left|right] [--coord]
  type  <app> <文本>
  key   <app> <键> [--system]              如 Return / Tab / cmd+c / shift+Left；--system 发真实系统热键，只限当前前台应用
  scroll <app> <idx> <up|down|left|right> [--pages N]
  set   <app> <idx> <值>                   直接给可写元素赋值（后台、不抢焦点）
  act   <app> <idx> <动作名>                执行 AX 动作，如 Press / ShowMenu
  wait  <app> --label "文本" [--gone] [--timeout 秒]
                                          等元素出现（或 --gone 等它消失），默认等 10 秒
  selecttext <app> <idx> <文本>            选中文本元素里的一段文字
  paste <app> <文本> [--settle 毫秒]       走剪贴板粘贴（比 type 快）；用完还原剪贴板。
                                          --settle 默认 400，慢应用调大；粘完请用 read 验证
  clip  [文本]                             读剪贴板（无参）/ 写剪贴板（带参）
  screens                                 列出显示器（多屏时坐标是全局的）
  winmove <app> X,Y                       移动窗口（后台生效）
  winsize <app> 宽,高                       调整窗口大小（后台生效）
  read  <app> <idx> [--selected]           读元素全文；--selected 只读当前选中的部分
  shot  <app> [--out PATH] [--shrink N]    只截图
  open  <名称或路径> [--front]              启动应用，默认后台不抢焦点
  webmode <app> [--off] [--timeout 秒]     让 Chrome/Electron 把网页内容暴露给辅助功能（默认只暴露浏览器外壳）
  perms [--request]                        查三项权限；--request 触发系统授权申请，需用户亲手允许
  wake [--hold 秒] [--input none|space|return|escape]
                                           正常唤醒显示器并核对桌面状态；仍锁在登录窗口时只发一个非文本按键，不输密码
  serve                                    常驻模式：标准输入逐行读 {"id":1,"args":["snap","计算器"]}，逐行回结果

全局选项：
  --json    输出单行 JSON（stdout 只有 JSON，诊断走 stderr），失败时为
            {"ok":false,"error":"...","code":N}；配合退出码判断更稳。
  --no-settle  动作后不等界面稳定就返回（默认会等，网页加载中最多 5 秒）

要点：
  · click/set/act 默认走辅助功能动作 → 后台生效、不抢鼠标不抢焦点
  · key --system 走真实系统输入（公开 CGEvent → cghidEventTap），只发给当前前台应用；与 --coord 一样先告知用户，失败不重试
  · --coord 强制用像素坐标点击（会移动真实鼠标），仅在 AX 动作无效时用
  · type/key/paste/scroll 走定向事件投递（SkyLight 优先，回落公开 API），
    需要 Event Synthesizing 授权，否则事件被系统静默丢弃；这条在投递前自检，
    缺权限直接报错（退出码 5），不让调用方误以为成功
  · 编号是「相对 snap 时那个窗口」的路径：动作前会校验窗口没被换掉，
    用进程和窗口 ID 校验，无法确定就报错（退出码 4），不按标题猜测

退出码：
  0 成功 / 1 动作执行失败 / 2 用法错 / 3 找不到应用或元素 / 4 界面或窗口已变、定位失败 / 5 缺系统权限 / 6 敏感应用拒绝操作
"""

// ==================== 动作后等界面稳定 ====================

/// 点完、按完、输完之后等界面稳定再返回，调用方紧接着读界面就是新样子，不用自己猜要等多久。
/// 判断「稳定」：每 60 毫秒取一次窗口的轻量指纹（前三层的角色、标题、值、元素数），连续两次相同就算稳了；
/// 看到进度条、转圈、「正在载入」这类繁忙标记就继续等。最短 0.12 秒，最长默认 1.5 秒；
/// 页面在加载时最多等 5 秒。--no-settle 或 COMPUTER_CONTROL_NO_SETTLE=1 关掉。
let busyRoles: Set<String> = ["AXProgressIndicator", "AXBusyIndicator"]
func windowFingerprint(_ pid: pid_t) -> (String, Bool) {
    let (win, title) = uiRoot(pid, nil)
    var parts: [String] = [title]
    var busy = false
    var budget = 1500
    // 繁忙标记可能在网页很深处（Chrome 里一个转圈在第 10 层），所以找繁忙标记要走得深；
    // 但指纹只取前 8 层，免得页面动画、时钟这类无关变化让它永远「不稳」。
    func rec(_ el: AXUIElement, _ d: Int) {
        if budget <= 0 || d > 30 { return }
        budget -= 1
        let bag = attrBag(el)
        let role = bag.str("AXRole") ?? ""
        if busyRoles.contains(role) { busy = true }
        if role == "AXWebArea" {
            if let loaded = axCopy(el, "AXLoaded") as? NSNumber, !loaded.boolValue { busy = true }
            if let b = axCopy(el, "AXElementBusy") as? NSNumber, b.boolValue { busy = true }
        }
        if d <= 8 {
            parts.append("\(d)|\(role)|\(bag.str("AXTitle") ?? "")|\(bag.str("AXValue")?.prefix(40) ?? "")|\(bag.children.count)")
        }
        for k in bag.children { rec(k, d + 1) }
    }
    rec(win, 0)
    return (parts.joined(separator: "\n"), busy)
}

var settleDisabled = false
@discardableResult
func settleAfterAction(_ pid: pid_t, maxWait: Double = 1.5) -> Double {
    if settleDisabled || ProcessInfo.processInfo.environment["COMPUTER_CONTROL_NO_SETTLE"] == "1" { return 0 }
    let t0 = Date()
    // 先等一小下让应用处理完事件，再比两次指纹：相同且不忙就返回。
    // 实测计算器、文本编辑按一下后 50 毫秒内就重画完；网页加载时靠繁忙标记继续等。
    usleep(50000)
    var (last, busy) = windowFingerprint(pid)
    while true {
        let elapsed = Date().timeIntervalSince(t0)
        if elapsed >= (busy ? 5.0 : maxWait) { break }
        usleep(40000)
        let (cur, b) = windowFingerprint(pid)
        let same = cur == last
        busy = b
        last = cur
        if same && !busy { break }
    }
    return (Date().timeIntervalSince(t0) * 100).rounded() / 100
}

/// 只发送 macOS 正常退出请求；调用方可用替身测试等待与超时，真实动作永不强杀。
func requestApplicationQuit(_ app: NSRunningApplication, timeout: TimeInterval,
                            request: (NSRunningApplication) -> Bool = { $0.terminate() },
                            isTerminated: (NSRunningApplication) -> Bool = { $0.isTerminated })
    -> (requested: Bool, terminated: Bool, waitedSeconds: Double) {
    let started = Date()
    guard request(app) else { return (false, isTerminated(app), 0) }
    while true {
        if isTerminated(app) { return (true, true, Date().timeIntervalSince(started)) }
        let waited = Date().timeIntervalSince(started)
        if waited >= timeout { return (true, false, waited) }
        usleep(50000)
    }
}

func requestWindowClose(target: CGWindowID, initial: Set<CGWindowID>, timeout: TimeInterval,
                        request: () -> AXError, current: () -> Set<CGWindowID>?,
                        now: () -> TimeInterval = { Date().timeIntervalSince1970 },
                        pause: () -> Void = { usleep(50000) })
    -> (requested: Bool, closed: Bool, error: String?) {
    guard initial.contains(target) else { return (false, false, "原窗口已消失，未发送关闭") }
    let start = now()
    guard request() == .success else { return (true, false, "关闭请求未获得成功回执，结果未知") }
    while true {
        guard let ids = current() else { return (true, false, "关闭后无法确认窗口列表，结果未知") }
        if !initial.subtracting([target]).isSubset(of: ids) { return (true, false, "关闭期间其他窗口也消失，不能确认单窗关闭") }
        if !ids.contains(target) { return (true, true, nil) }
        if now() - start >= timeout { return (true, false, "窗口仍存在，可能有未保存确认；未重发关闭") }
        pause()
    }
}

func currentWindowIDs(_ pid: pid_t) -> Set<CGWindowID>? {
    guard let info = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
    return Set(info.filter { ($0[kCGWindowOwnerPID as String] as? pid_t) == pid }.compactMap { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value })
}

func observedWindowIDs(_ pid: pid_t) -> Set<CGWindowID>? {
    let windows = appWindows(pid)
    let ids = windows.compactMap(nativeWindowID)
    guard ids.count == windows.count, Set(ids).count == ids.count,
          let current = currentWindowIDs(pid), Set(ids).isSubset(of: current) else { return nil }
    return current
}

// ==================== 命令 ====================

/// 一条命令跑完。单次调用时就是退出进程；常驻模式（serve）下每条命令跑在自己的线程上，
/// 这里只结束那个线程，进程和它已经连上的系统服务留着给下一条用。
/// 结束线程不会执行 defer，所以命令里需要收尾的地方（粘贴还原剪贴板）都在报错前显式收尾。
var serveMode = false
var serveOutput: [String] = []
var serveWarnings: [String] = []
var serveCode: Int32 = 0
var serveBusy = false
var serveLastActive = Date().timeIntervalSince1970
let serveDone = DispatchSemaphore(value: 0)
func finish(_ code: Int32) -> Never {
    inputCleanup?(); inputCleanup = nil
    cleanupClipboard()
    for fd in commandLocks { flock(fd, LOCK_UN); Darwin.close(fd) }
    commandLocks = []
    if serveMode && !Thread.isMainThread && Thread.current.name != "computer-control-reader" {
        serveCode = code
        serveDone.signal()
        pthread_exit(nil)
    }
    fflush(stdout)
    exit(code)
}

func print(_ items: Any..., separator: String = " ", terminator: String = "\n") {
    if serveMode && Thread.current.name != "computer-control-reader" && !Thread.isMainThread { return }
    Swift.print(items.map { "\($0)" }.joined(separator: separator), terminator: terminator)
}

func runCommand(_ cmd: String) {
currentCommand = cmd
optionBoundary = nil
snapshotToken = flagValue("--snapshot")
activeOwnership = nil
activeWindowRef = nil
focusWindowRef = nil
actionSent = false
operationLocked = false
inputCleanup = nil
requireFocus = hasFlag("--require-focus")
boundWindowRef = nil
if let raw = flagValue("--window-ref") {
    guard let data = raw.data(using: .utf8), let ref = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          ref["id"] is Int, ref["pid"] is Int, ref["startedAt"] is Double else { die("window-ref 需要 id/pid/startedAt", 2) }
    boundWindowRef = ref
}
requestedWindowIndex = optionIndex("--window").flatMap { $0 + 1 < args.count ? Int(args[$0 + 1]) : nil }
taskScope = flagValue("--scope") ?? ProcessInfo.processInfo.environment["COMPUTER_CONTROL_CONTEXT_ID"] ?? ProcessInfo.processInfo.environment["DSH_SESSION_ID"]
taskLease = flagValue("--lease")
settleDisabled = hasFlag("--no-settle")
if let divider = args.firstIndex(of: "--") { optionBoundary = divider; args.remove(at: divider) }
switch cmd {

case "-h", "--help", "help":
    if jsonMode { emitJSON(["ok": true, "mode": "help", "version": VERSION, "usage": usage]) }
    else { print(usage) }

case "-v", "--version":
    emitOK(VERSION, ["mode": "version", "version": VERSION])

case "owner":
    guard args.count >= 2 else { die("用法: computer-control owner APP status|claim|release|handoff|recover --scope TASK [--lease TOKEN]", 2) }
    let query = args[0], action = args[1]
    let next = flagValue("--to")
    let expectedOwner = flagValue("--expected-owner")
    let authorized = hasFlag("--authorized")
    let running = resolveApp(query)
    let key: String
    if let app = running {
        key = app.bundleIdentifier ?? String(app.processIdentifier)
    } else {
        guard action == "status" || action == "release" else {
            die("取得或交接控制需要应用正在运行；未启动应用", 3)
        }
        key = installedAppURL(query).flatMap { Bundle(url: $0)?.bundleIdentifier } ?? query
    }
    if isBrowserBundle(key) {
        guard action == "status" else { die("共享浏览器不再登记长期 owner/lease；请绑定任务窗口", 6) }
        emitJSON(["ok": true, "mode": "owner", "appKey": key, "resourceMode": "window", "ownership": ["owner": NSNull(), "lease": NSNull()]])
        finish(0)
    }
    lockResource("app-" + key)
    if running == nil && loadOwnership(key) == nil {
        die("找不到应用的现有归属记录；未启动应用", 3)
    }
    if action == "status" {
        let state = loadOwnership(key)
        emitJSON(["ok": true, "mode": "owner", "appKey": key,
                  "ownership": ["owner": state?.owner as Any? ?? NSNull(), "lease": state?.generation as Any? ?? NSNull()]])
    } else {
        let state = updateOwnership(key, scope: requireTaskScope(), action: action, lease: taskLease,
                                    next: next, expectedOwner: expectedOwner, authorized: authorized)
        activeOwnership = state
        emitJSON(["ok": true, "mode": "owner", "action": action, "appKey": key,
                  "targets_closed": false])
    }

case "perms":
    if hasFlag("--request") {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
        if !CGPreflightPostEventAccess() { _ = CGRequestPostEventAccess() }
        if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
    }
    let ax = AXIsProcessTrusted()
    let post = CGPreflightPostEventAccess()
    let shot = CGPreflightScreenCaptureAccess()
    let parent = getppid()
    let hostName = NSRunningApplication(processIdentifier: parent)?.localizedName
        ?? "\(processName(parent)) (pid \(parent))"
    if jsonMode {
        emitJSON(["ok": true, "mode": "perms",
                  "accessibility": ax, "postEvent": post,
                  "screenCapturePreflight": shot,
                  "postEventDelivery": forcePublicPost ? "cgpost" : (SkyLightPost.fn != nil ? "skylight" : "cgpost"),
                  "hostProcess": hostName])
        finish(0)
    }
    print("Accessibility（辅助功能）   \(ax ? "✅ 已授权" : "❌ 未授权：读不到元素、点不了")")
    print("Event Synthesizing（事件合成）\(post ? "✅ 已授权" : "❌ 未授权：后台键盘/滚轮会被静默丢弃（退出码 5）")")
    print("Screen Recording（屏幕录制）  \(shot ? "✅ 已授权" : "⚠️ 自检报 false；此自检在部分宿主下会误报，以 `computer-control shot <app>` 能否出图为准")")
    print("投递通道                    \(postChannelName())")
    print("权限归属进程                \(hostName)（TCC 认这个进程，换宿主需重新授权）")

case "wake":
    let hold = Double(flagValue("--hold") ?? "") ?? 3.0
    guard hold >= 0.3 && hold <= 30 else { die("--hold 需要 0.3 到 30 秒", 2) }
    let rawInput = (flagValue("--input") ?? "none").lowercased()
    let input = rawInput == "none" ? nil : rawInput
    guard input == nil || ["space", "return", "escape"].contains(input!) else {
        die("--input 支持 none/space/return/escape", 2)
    }
    let fields = performWake(holdSeconds: hold, input: input)
    let state = fields["state"] as? String ?? "unknown"
    let human: String
    switch state {
    case "desktop": human = "已回到桌面（显示器已唤醒，锁屏已解除）"
    case "loginwindow": human = "显示器已唤醒，但仍停留在登录窗口；需要身份验证时立即停止"
    case "asleep": human = "显示器仍在睡眠"
    default: human = "无法确认桌面状态"
    }
    emitOK(human, fields)

case "apps":
    let includeBg = hasFlag("--all")
    let apps = NSWorkspace.shared.runningApplications
        .filter { includeBg ? ($0.bundleIdentifier != nil) : ($0.activationPolicy == .regular) }
        .sorted { ($0.localizedName ?? "") < ($1.localizedName ?? "") }
    if includeBg && !jsonMode { print("(含后台/系统 UI 进程；Dock、ControlCenter 等可直接 snap 和 click)") }
    if jsonMode {
        emitJSON(["ok": true, "mode": "apps", "apps": apps.map { a in
            ["name": a.localizedName ?? "?", "bundleId": a.bundleIdentifier ?? "",
             "pid": Int(a.processIdentifier), "windows": appWindows(a.processIdentifier).count,
             "frontmost": a.isActive]
        }])
        finish(0)
    }
    print("\(pad("NAME", 24)) \(pad("BUNDLE ID", 36)) \(pad("PID", 7)) WINDOWS")
    for a in apps {
        let n = a.localizedName ?? "?"
        let b = a.bundleIdentifier ?? "-"
        let w = appWindows(a.processIdentifier).count
        let front = a.isActive ? "  ←前台" : ""
        print("\(pad(n, 24)) \(pad(b, 36)) \(pad(String(a.processIdentifier), 7)) \(w)\(front)")
    }

case "windows":
    guard let name = args.first, let app = resolveApp(name) else { die("找不到运行中的应用；未启动", 3) }
    requireAXAccess()
    _ = requireTaskScope()
    let refs = appWindows(app.processIdentifier).map { window -> [String: Any] in
        var ref = windowRef(app, window)
        ref["title"] = axStr(window, kAXTitleAttribute as String) ?? ""
        if let f = axFrame(window) { ref["x"] = f.minX; ref["y"] = f.minY; ref["w"] = f.width; ref["h"] = f.height }
        let focused = axCopy(axApp(app.processIdentifier), kAXFocusedWindowAttribute as String)
        ref["isFocused"] = focused.map { CFGetTypeID($0) == AXUIElementGetTypeID() && CFEqual($0, window) } ?? false
        ref["isFrontmost"] = app.isActive
        ref["minimized"] = (axCopy(window, kAXMinimizedAttribute as String) as? NSNumber)?.boolValue ?? false
        return ref
    }
    emitJSON(["ok": true, "mode": "windows", "windows": refs])

case "window-close":
    guard let name = args.first, hasFlag("--authorized"), boundWindowRef != nil else { die("关闭窗口需要明确授权和稳定窗口引用", 6) }
    let app = mustApp(name)
    requireNotSensitive(app, "关闭窗口")
    let window = resolveWindowRef(app, boundWindowRef!)
    guard let close = axCopy(window, kAXCloseButtonAttribute as String), CFGetTypeID(close) == AXUIElementGetTypeID() else { die("窗口没有可用关闭按钮", 5) }
    checkBoundElement(close as! AXUIElement)
    let timeout = Double(flagValue("--timeout") ?? "10") ?? 10
    guard timeout.isFinite && timeout > 0 && timeout <= 120 else { die("timeout 必须在0至120秒之间", 2) }
    guard let initial = observedWindowIDs(app.processIdentifier), let id = boundWindowRef!["id"] as? Int else { die("不能完整确认关闭前窗口列表", 4) }
    let result = requestWindowClose(target: CGWindowID(id), initial: initial, timeout: timeout,
        request: { actionSent = true; return AXUIElementPerformAction(close as! AXUIElement, kAXPressAction as CFString) },
        current: { currentWindowIDs(app.processIdentifier) })
    guard result.closed else { die(result.error ?? "关闭结果未知", 4, outcome: result.requested ? "unknown" : "not_sent") }
    emitJSON(["ok": true, "mode": "window.close", "closed": true, "window": boundWindowRef!])

case "snap":
    guard let q = args.first else { die("用法: computer-control snap <app>") }
    removeFirstArg()
    if optionIndex("--no-shot") != nil { die("snap 默认不截图，--no-shot 已移除；要截图用 --shot", 2) }
    let wantShot = hasFlag("--shot")
    let wantDiff = hasFlag("--diff")
    let showAll = hasFlag("--all")
    let maxN = Int(flagValue("--max") ?? "") ?? 120
    let maxD = Int(flagValue("--depth") ?? "") ?? 25
    let winIdx = Int(flagValue("--window") ?? "")
    let shrinkTo = Int(flagValue("--shrink") ?? "") ?? 1400
    let app = mustApp(q)
    let pid = app.processIdentifier
    let key = app.bundleIdentifier ?? (app.localizedName ?? q)
    // 浏览器和 Electron 应用：第一次读时网页内容还没交给辅助功能，自动打开并等一下。
    // --no-webmode 或 COMPUTER_CONTROL_NO_WEBMODE=1 关掉。
    var webmodeNote: String? = nil
    if !hasFlag("--no-webmode"), ProcessInfo.processInfo.environment["COMPUTER_CONTROL_NO_WEBMODE"] != "1",
       webHosts.contains(key) || isElectron(app), !hasWebContent(pid) {
        let r = enableWebContent(pid, timeout: 3)
        webmodeNote = r.ok ? "已自动打开网页辅助功能（等了 \(r.seconds)s）" : "已请求打开网页辅助功能，但 3 秒内没看到网页内容"
        warn(webmodeNote!)
    }
    let (win, title) = uiRoot(pid, winIdx)
    var rootRole: CFTypeRef?
    let rootError = AXUIElementCopyAttributeValue(win, kAXRoleAttribute as CFString, &rootRole)
    guard rootError == .success else { die("无法读取界面 (AXError \(rootError.rawValue))，未覆盖缓存", rootError == .apiDisabled ? 5 : 1) }
    let frame = axFrame(win)
    let nodes = walk(root: win, maxNodes: maxN, maxDepth: maxD, showAll: showAll)
    if walkReadIncomplete { warn("界面部分属性读取失败，取态不完整；已禁用本次编号操作：" + walkReadErrors.joined(separator: ", ")) }
    if !walkMetadataErrors.isEmpty { warn("附加展示属性读取失败（不影响目标身份判断）：" + walkMetadataErrors.joined(separator: ", ")) }
    if let ref = activeWindowRef { _ = resolveWindowRef(app, ref) }
    let prevSigs = wantDiff ? loadSigs(key) : nil
    let token = UUID().uuidString
    let windowID = nativeWindowID(win)
    saveCache(key, nodes, winIndex: winIdx, winTitle: title, winFrame: frame, token: token, pid: pid, windowID: windowID,
              complete: nodes.count < maxN && !walkDepthTruncated && !walkReadIncomplete && !walkTimedOut)

    if wantDiff {
        if prevSigs == nil {
            if jsonMode { warn("没有上次的 snap 记录，本次输出完整清单") }
            else { print("（没有上次的 snap 记录，本次输出完整清单）") }
        }
        if let prev = prevSigs {
            let prevSet = Set(prev)
            let cur = nodes.map { sigOf($0) }
            let curSet = Set(cur)
            let added = nodes.filter { !prevSet.contains(sigOf($0)) }
            let removed = prev.filter { !curSet.contains($0) }
            if jsonMode {
                emitJSON([
                    "ok": true, "mode": "diff", "snapshot": token,
                    "window": activeWindowRef ?? [:],
                    "screenshot": ["requested": wantShot, "ok": false, "via": "none", "error": "diff 不截图；需要图片请取完整 snap"],
                    "app": ["name": app.localizedName ?? q, "bundleId": app.bundleIdentifier ?? "", "pid": Int(pid)],
                    "changed": !(added.isEmpty && removed.isEmpty),
                    "truncated": nodes.count >= maxN || walkDepthTruncated || walkReadIncomplete,
                    "timedOut": walkTimedOut,
                    "added": added.map { nodeJSON($0) },
                    "removed": removed.map { sigJSON($0) },
                ])
                finish(0)
            }
            print("APP  \(app.localizedName ?? q)  pid=\(pid)")
            if walkDepthTruncated || walkReadIncomplete || walkTimedOut || nodes.count >= maxN { print("⚠️ 当前取态不完整，差异不代表整屏变化") }
            if added.isEmpty && removed.isEmpty {
                print("DIFF 与上次 snap 相比：无变化")
            } else {
                print("DIFF +\(added.count) 新增 / -\(removed.count) 消失")
                for n in added {
                    let idPart = n.axid.map { " #\($0)" } ?? ""
                    let v = n.value.map { "  = \"\($0)\"" } ?? ""
                    print("  + [\(n.idx)] \(n.role.replacingOccurrences(of: "AX", with: "")) \(n.label.isEmpty ? "·" : n.label)\(idPart)\(v)")
                }
                for s in removed {
                    let f = s.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
                    let role = f.count > 0 ? f[0].replacingOccurrences(of: "AX", with: "") : "?"
                    let lab = f.count > 1 && !f[1].isEmpty ? f[1] : "·"
                    let aid = f.count > 2 && !f[2].isEmpty ? " #\(f[2])" : ""
                    print("  - \(role) \(lab)\(aid)")
                }
            }
            finish(0)
        }
    }

    var shotPath: String? = nil
    var shotViaRect = false
    if !jsonMode {
        print("APP  \(app.localizedName ?? q)  [\(app.bundleIdentifier ?? "-")]  pid=\(pid)\(app.isActive ? "  ←前台" : "")")
        print("WIN  \"\(title)\"  \(fmtFrame(frame))  窗口数=\(appWindows(pid).count)")
    }

    if wantShot {
        let outPath = flagValue("--out") ?? cacheDir().appendingPathComponent("\((key).replacingOccurrences(of: "/", with: "_"))-\(UUID().uuidString).png").path
        var shotOK = false
        var fast = false
        if let wid = nativeWindowID(win) {
            fast = captureWindowFast(wid, to: outPath, maxDim: shrinkTo)
            shotOK = fast || captureWindow(wid, to: outPath)
        }
        var viaRect = false
        if !shotOK, activeWindowRef == nil, let f = frame, f.width > 1, f.height > 1 {
            shotOK = captureRect(f, to: outPath); viaRect = shotOK
        }
        if shotOK {
            if shrinkTo > 0 && !fast { shrink(outPath, maxDim: shrinkTo) }
            shotPath = outPath; shotViaRect = viaRect
            if !jsonMode {
                print("SHOT \(outPath)\(viaRect ? "   ⚠️ 按坐标截取（无标准窗口），被遮挡时会截到别的内容" : "")")
            }
        } else if !jsonMode {
            print("SHOT (失败：拿不到窗口 ID 且无可用坐标；检查屏幕录制权限)")
        }
    }

    if jsonMode {
        var o: [String: Any] = [
            "ok": true, "mode": "snap", "snapshot": token,
            "screenshot": ["requested": wantShot, "ok": shotPath != nil, "via": shotPath == nil ? "none" : (shotViaRect ? "rect" : "window"), "error": (wantShot && shotPath == nil) ? "截图失败；检查屏幕录制权限和窗口可用性" : ""],
            "app": ["name": app.localizedName ?? q, "bundleId": app.bundleIdentifier ?? "",
                    "pid": Int(pid), "frontmost": app.isActive],
            "window": ["title": title, "count": appWindows(pid).count],
            "truncated": nodes.count >= maxN || walkDepthTruncated || walkReadIncomplete,
            "timedOut": walkTimedOut,
            "elements": nodes.map { node -> [String: Any] in
                var item = nodeJSON(node)
                if let bounds = node.frame, let windowFrame = frame {
                    item["offscreen"] = !bounds.intersects(windowFrame)
                }
                return item
            },
        ]
        if let f = frame {
            o["window"] = ["title": title, "count": appWindows(pid).count,
                           "x": Int(f.origin.x), "y": Int(f.origin.y),
                           "w": Int(f.size.width), "h": Int(f.size.height)]
        }
        var windowInfo = o["window"] as! [String: Any]
        windowInfo["id"] = windowID.map { $0 as Any } ?? NSNull()
        windowInfo["pid"] = Int(pid)
        windowInfo["startedAt"] = app.launchDate?.timeIntervalSince1970
        windowInfo["bundleId"] = app.bundleIdentifier ?? ""
        o["window"] = windowInfo
        if let s = shotPath { o["shot"] = s; o["shotViaRect"] = shotViaRect }
        emitJSON(o)
        finish(0)
    }
    print("")
    print("\(pad("IDX", 4)) \(pad("ROLE", 16)) \(pad("LABEL  #AXIdentifier", 46)) \(pad("FRAME", 21)) ACTIONS")
    for n in nodes {
        let role = n.role.replacingOccurrences(of: "AX", with: "")
        let indent = String(repeating: " ", count: min(n.depth, 6))
        let idPart = n.axid.map { " #\($0)" } ?? ""
        let lab = indent + (n.label.isEmpty ? "·" : n.label) + idPart
        let dis = n.enabled ? "" : " (禁用)"
        let valStr = n.value.map { "  = \"\($0)\"" } ?? ""
        let stateStr = n.state.map { "  [\($0)]" } ?? ""
        print("\(pad(String(n.idx), 4)) \(pad(role, 16)) \(pad(lab, 46)) \(pad(fmtFrame(n.frame), 21)) \(shortActions(n.actions))\(dis)\(valStr)\(stateStr)")
    }
    if nodes.count >= maxN { print("\n(已截断到 \(maxN) 个元素，用 --max 调大)") }
    if walkReadIncomplete { print("\n⚠️ 界面部分属性读取失败，取态不完整。") }
    if walkDepthTruncated { print("\n(深度达到 \(maxD) 层，元素清单不完整，用 --depth 调大)") }
    if walkTimedOut {
        print("\n⚠️ 遍历超时（8 秒预算），元素清单不完整。")
        print("   目标应用可能无响应，或界面过于复杂——可先确认应用是否卡住，或用 --max 限制范围。")
    }

case "click":
    guard let q = args.first else { die("用法: computer-control click <app> <idx>  或  --at X,Y") }
    removeFirstArg()
    let count = Int(flagValue("--count") ?? "") ?? 1
    let button = flagValue("--button") ?? "left"
    guard ["left", "right"].contains(button), count > 0 else { die("button 仅支持 left/right，count 必须大于0") }
    let at = flagValue("--at")
    let label = flagValue("--label")
    let wantId = flagValue("--id")
    let forceCoord = hasFlag("--coord")
    let app = mustApp(q)
    requireNotSensitive(app, "点击")
    let key = app.bundleIdentifier ?? (app.localizedName ?? q)

    if let at = at {
        let xy = at.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        guard xy.count == 2 else { die("--at 需要 X,Y") }
        let p = CGPoint(x: xy[0], y: xy[1])
        // 左键坐标点击优先走后台鼠标事件；要真的移动鼠标（拖放、悬停菜单）加 --coord
        if !forceCoord, let t = mouseTarget(app.processIdentifier, p) {
            requirePostEventAccess("后台鼠标点击")
            if button == "right" { die("后台坐标右键没有可靠回执；请用元素 AXShowMenu 或显式 --coord", 1) }
            skyLeftClick(t, count: count)
            emitAction(app.processIdentifier, "clicked at \(Int(p.x)),\(Int(p.y))  (后台鼠标事件，未动真鼠标)",
                   ["mode": "click", "via": "sky", "x": Int(p.x), "y": Int(p.y), "count": count])
            finish(0)
        }
        requireExplicitCoordinate(forceCoord)
        requireGlobalHit(app, p)
        clickAt(p, button: button, count: count)
        emitAction(app.processIdentifier, "clicked at \(Int(xy[0])),\(Int(xy[1]))  (坐标模式，已移动鼠标)",
               ["mode": "click", "via": "coord", "x": Int(xy[0]), "y": Int(xy[1])])
        finish(0)
    }
    let el: AXUIElement, nowRole: String, nowLabel: String, refDesc: String
    if let wantId = wantId {
        (el, nowRole, nowLabel) = locateById(app, wantId, q, winIdx: nil)
        refDesc = "#\(wantId)"
    } else if let label = label {
        (el, nowRole, nowLabel) = locateByLabel(app, label, q, winIdx: nil)
        refDesc = "「\(label)」"
    } else {
        guard let idxs = args.first, let idx = Int(idxs) else {
            die("用法: computer-control click <app> <idx>  |  --label \"标签\"  |  --at X,Y")
        }
        (el, nowRole, nowLabel) = locate(app, key, idx, q)
        refDesc = "#\(idx)"
    }
    let acts = axActions(el)
    // 右键：先用元素自己的「弹出菜单」动作（后台、不动鼠标）。元素自己没有这个动作时往上找：
    // 表格、大纲、列表（访达边栏、文件列表）的右键菜单挂在容器上、作用于选中的行，所以先把所在行设为选中，
    // 再让容器弹菜单——弹出的就是这一行的菜单。都没有才走后台鼠标事件。
    var menuHost: AXUIElement? = acts.contains("AXShowMenu") ? el : nil
    if button == "right" && !forceCoord && menuHost == nil {
        var cur: AXUIElement? = el
        var row: AXUIElement? = nil
        for _ in 0..<8 {
            guard let c = cur, let pr = axCopy(c, kAXParentAttribute as String), CFGetTypeID(pr) == AXUIElementGetTypeID() else { break }
            let parent = pr as! AXUIElement
            let prole = axStr(parent, kAXRoleAttribute as String) ?? ""
            if row == nil, ["AXRow", "AXOutlineRow"].contains(prole) || (axStr(c, kAXRoleAttribute as String) ?? "") == "AXRow" {
                row = (axStr(c, kAXRoleAttribute as String) ?? "") == "AXRow" ? c : parent
            }
            if axActions(parent).contains("AXShowMenu") {
                if let r = row, axSettable(r, kAXSelectedAttribute as String) {
                    _ = AXUIElementSetAttributeValue(r, kAXSelectedAttribute as CFString, kCFBooleanTrue)
                    usleep(80000)
                    menuHost = parent
                } else if row == nil {
                    menuHost = nil
                }
                break
            }
            cur = parent
        }
    }
    if button == "right" && !forceCoord, let host = menuHost {
        checkBoundElement(host)
        let e = AXUIElementPerformAction(host, "AXShowMenu" as CFString)
        if e != .success { die("AXShowMenu 失败 (AXError \(e.rawValue))", 1) }
        emitAction(app.processIdentifier, "right-clicked \(refDesc) \(nowRole) \"\(nowLabel)\"  (后台，弹出菜单)",
               ["mode": "click", "via": "ax-menu", "target": refDesc, "role": nowRole, "label": nowLabel])
        finish(0)
    }
    // 双击、没有按下动作的元素、右键但元素没有菜单动作：走后台鼠标事件（不移动真鼠标、不抢前台）
    if forceCoord || count > 1 || button != "left" || !acts.contains("AXPress") {
        guard let f = axFrame(el) else { die("元素没有坐标，无法点击", 4) }
        let p = CGPoint(x: f.midX, y: f.midY)
        if button == "right", !forceCoord {
            die("元素不支持可靠的后台右键；请用 AXShowMenu 或显式 --coord", 1)
        }
        if button == "left", !forceCoord, let t = mouseTarget(app.processIdentifier, p) {
            requirePostEventAccess("后台鼠标点击")
            skyLeftClick(t, count: count)
            emitAction(app.processIdentifier, "clicked \(refDesc) \(nowRole) \"\(nowLabel)\" ×\(count)  (后台鼠标事件，未动真鼠标)",
                   ["mode": "click", "via": "sky", "target": refDesc, "role": nowRole, "label": nowLabel,
                    "x": Int(p.x), "y": Int(p.y), "count": count])
            finish(0)
        }
        requireExplicitCoordinate(forceCoord)
        requireGlobalHit(app, p)
        clickAt(p, button: button, count: count)
        emitAction(app.processIdentifier, "clicked \(refDesc) \(nowRole) \"\(nowLabel)\" @\(Int(f.midX)),\(Int(f.midY))  (坐标模式，已移动真鼠标)",
               ["mode": "click", "via": "coord", "target": refDesc, "role": nowRole, "label": nowLabel,
                "x": Int(f.midX), "y": Int(f.midY)])
    } else {
        for _ in 0..<max(1, count) {
            checkBoundElement(el)
            let e = AXUIElementPerformAction(el, kAXPressAction as CFString)
            if e != .success { die("AXPress 失败 (AXError \(e.rawValue))", 1) }
            usleep(80000)
        }
        emitAction(app.processIdentifier, "pressed \(refDesc) \(nowRole) \"\(nowLabel)\"  (后台，未抢焦点)",
               ["mode": "click", "via": "ax", "target": refDesc, "role": nowRole, "label": nowLabel])
    }

case "type":
    let allowNL = hasFlag("--allow-newline")
    guard args.count >= 2 else { die("用法: computer-control type <app> <文本> [--allow-newline]") }
    let app = mustApp(args[0])
    beginFocusedOperation(app)
    requireNotSensitive(app, "输入")
    let text = args.dropFirst().joined(separator: " ")
    // 换行符在聊天类应用里等同于「发送」——默认拦住，避免误发消息
    if text.contains("\n") && !allowNL {
        die("文本含换行符：在聊天/搜索类应用里会直接触发发送或提交。\n  改用 `computer-control paste <app> <文本>`（走剪贴板，不产生按键），\n  或确认安全后加 --allow-newline", 2)
    }
    requirePostEventAccess("后台键盘输入")
    let channel = sendText(pid: app.processIdentifier, text: text)
    emitAction(app.processIdentifier, "typed \(text.count) 字符 → \(app.localizedName ?? "?")",
           ["mode": "type", "chars": text.count, "app": app.localizedName ?? "", "delivery": channel])

case "key":
    let useSystem = hasFlag("--system")
    guard args.count >= 2 else { die("用法: computer-control key <app> <键> [--system]") }
    let app = mustApp(args[0])
    beginFocusedOperation(app)
    requireNotSensitive(app, "按键")
    if isBrowserBundle(app.bundleIdentifier ?? ""), args[1].lowercased().split(separator: "+").contains("q") { die("窗口模式不能发送退出浏览器的快捷键", 6) }
    guard let hotkey = parseHotkey(args[1]) else { die("看不懂的按键 '\(args[1])'（支持 cmd/shift/alt/ctrl + 键名）") }
    if useSystem {
        requireFrontmost(app, "系统按键")
        requirePostEventAccess("系统按键")
        let channel = sendSystemHotkey(code: hotkey.code, flags: hotkey.flags, modifiers: hotkey.modifiers)
        emitAction(app.processIdentifier, "key \(args[1]) → \(app.localizedName ?? "?")  (系统全局输入)",
               ["mode": "key", "key": args[1], "app": app.localizedName ?? "", "delivery": channel, "global": true])
    } else {
        requirePostEventAccess("后台按键")
        let channel = sendKey(pid: app.processIdentifier, code: hotkey.code, flags: hotkey.flags)
        emitAction(app.processIdentifier, "key \(args[1]) → \(app.localizedName ?? "?")",
               ["mode": "key", "key": args[1], "app": app.localizedName ?? "", "delivery": channel, "global": false])
    }

case "scroll":
    guard args.count >= 3, let idx = Int(args[1]) else { die("用法: computer-control scroll <app> <idx> <up|down|left|right>") }
    let dir = args[2].lowercased()
    guard ["up", "down", "left", "right"].contains(dir) else { die("滚动方向只能是 up/down/left/right，收到 '\(args[2])'") }
    let pages = Double(flagValue("--pages") ?? "") ?? 1
    let app = mustApp(args[0])
    requireNotSensitive(app, "滚动")
    let key = app.bundleIdentifier ?? (app.localizedName ?? args[0])
    let (el, _, _) = locate(app, key, idx, args[0])
    guard let f = axFrame(el) else { die("元素没有坐标，无法滚动", 4) }
    let amount = Int32(pages * 10)
    let (dx, dy): (Int32, Int32) = dir == "up" ? (0, amount) : dir == "down" ? (0, -amount)
        : dir == "left" ? (amount, 0) : (-amount, 0)
    requirePostEventAccess("后台滚轮")
    // 滚轮落在元素可见部分的中心：长列表的元素本身可能远超出屏幕，取它的中心会落到窗口外。
    // 网页里滚出视野的行会被报成高 1 像素、挤在列表底边，落在那里滚轮打在边框上不生效；
    // 这种太小的元素往上找第一个够大的祖先（通常就是那个可滚动的列表）来落点。
    let win = uiRoot(app.processIdentifier, nil).0
    var target = f
    if f.width < 8 || f.height < 8 {
        var cur: AXUIElement? = el
        for _ in 0..<8 {
            guard let c = cur, let parentRef = axCopy(c, kAXParentAttribute as String),
                  CFGetTypeID(parentRef) == AXUIElementGetTypeID() else { break }
            let parent = parentRef as! AXUIElement
            if let pf = axFrame(parent), pf.width >= 20, pf.height >= 20 { target = pf; break }
            cur = parent
        }
    }
    let visible = axFrame(win).map { target.intersection($0) }.flatMap { $0.isNull || $0.isEmpty ? nil : $0 } ?? target
    let p = CGPoint(x: visible.midX, y: visible.midY)
    var channel = "cgpost"
    if let t = mouseTarget(app.processIdentifier, p), skyScroll(t, dx: dx, dy: dy) {
        channel = "sky"
    } else if activeWindowRef != nil {
        die("窗口定向滚轮不可用，未退回仅按进程投递", 5)
    } else if let ev = CGEvent(scrollWheelEvent2Source: CGEventSource(stateID: .hidSystemState), units: .line,
                               wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) {
        ev.location = p
        channel = postToPid(ev, app.processIdentifier)
    }
    emitAction(app.processIdentifier, "scrolled #\(idx) \(dir) \(pages) 页  (\(channel == "sky" ? "后台滚轮，带窗口定位" : channel == "skylight" ? "SkyLight" : "定向事件"))",
           ["mode": "scroll", "idx": idx, "direction": dir, "pages": pages, "delivery": channel])

case "set":
    guard args.count >= 3, let idx = Int(args[1]) else { die("用法: computer-control set <app> <idx> <值>") }
    let value = args.dropFirst(2).joined(separator: " ")
    let app = mustApp(args[0])
    requireNotSensitive(app, "赋值")
    let key = app.bundleIdentifier ?? (app.localizedName ?? args[0])
    let (el, _, _) = locate(app, key, idx, args[0])
    checkBoundElement(el)
    let e = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, value as CFTypeRef)
    if e != .success { die("赋值失败 (AXError \(e.rawValue))；该元素可能不可写，试试 type", 1) }
    emitAction(app.processIdentifier, "set #\(idx) = \"\(value)\"  (后台，未抢焦点)",
           ["mode": "set", "idx": idx, "value": value])

case "act":
    guard args.count >= 3, let idx = Int(args[1]) else { die("用法: computer-control act <app> <idx> <动作名>") }
    var action = args[2]
    if !action.hasPrefix("AX") { action = "AX" + action }
    let app = mustApp(args[0])
    requireNotSensitive(app, "执行动作")
    let key = app.bundleIdentifier ?? (app.localizedName ?? args[0])
    let (el, _, _) = locate(app, key, idx, args[0])
    checkBoundElement(el)
    let e = AXUIElementPerformAction(el, action as CFString)
    if e != .success { die("动作 \(action) 失败 (AXError \(e.rawValue))。可用: \(shortActions(axActions(el)))", 1) }
    emitAction(app.processIdentifier, "did \(action) on #\(idx)", ["mode": "act", "idx": idx, "action": action])

case "drag":
    guard args.count >= 3 else { die("用法: computer-control drag <app> X1,Y1 X2,Y2 [--coord]") }
    let forceRealMouse = hasFlag("--coord")
    let app = mustApp(args[0])
    requireNotSensitive(app, "拖拽")
    let from = parsePoint(args[1]), to = parsePoint(args[2])
    // 默认后台拖拽：不动真鼠标、不抢前台。拖到别的应用里（跨应用拖放）只能用真鼠标，加 --coord。
    requirePostEventAccess("拖拽")
    if !forceRealMouse, let t = mouseTarget(app.processIdentifier, from), windowAt(app.processIdentifier, to)?.0 == t.windowID,
       skyDrag(t, to: to) {
        emitAction(app.processIdentifier, "dragged \(Int(from.x)),\(Int(from.y)) → \(Int(to.x)),\(Int(to.y))  (后台，未动真鼠标)",
               ["mode": "drag", "via": "sky", "fromX": Int(from.x), "fromY": Int(from.y), "toX": Int(to.x), "toY": Int(to.y)])
        finish(0)
    }
    requireExplicitCoordinate(forceRealMouse)
    for i in 0...24 {
        let t = Double(i) / 24
        requireGlobalHit(app, CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t))
    }
    dragFrom(from, to: to)
    emitAction(app.processIdentifier, "dragged \(Int(from.x)),\(Int(from.y)) → \(Int(to.x)),\(Int(to.y))  (已移动真实鼠标)",
           ["mode": "drag", "via": "coord", "fromX": Int(from.x), "fromY": Int(from.y),
            "toX": Int(to.x), "toY": Int(to.y)])

case "menu":
    guard let q = args.first else { die("用法: computer-control menu <app> [菜单名] [菜单项]") }
    removeFirstArg()
    let app = mustApp(q)
    let axAppEl = axApp(app.processIdentifier)
    guard let mbRef = axCopy(axAppEl, kAXMenuBarAttribute as String), CFGetTypeID(mbRef) == AXUIElementGetTypeID() else {
        die("拿不到 '\(q)' 的菜单栏（该应用可能没有菜单栏）", 3)
    }
    let menuBar = mbRef as! AXUIElement
    let topItems = axChildren(menuBar)

    if args.isEmpty {
        if jsonMode {
            emitJSON(["ok": true, "mode": "menu", "level": "bar",
                      "app": app.localizedName ?? q,
                      "menus": topItems.map { labelOf($0) }.filter { !$0.isEmpty }])
            finish(0)
        }
        print("APP  \(app.localizedName ?? q)  菜单栏共 \(topItems.count) 项")
        for m in topItems {
            let l = labelOf(m)
            if !l.isEmpty { print("  \(l)") }
        }
        print("\n用 `computer-control menu \(q) \"<菜单名>\"` 看它下面有什么")
        finish(0)
    }

    let wantMenu = args[0]
    guard let top = topItems.first(where: { labelOf($0) == wantMenu })
            ?? topItems.first(where: { labelOf($0).lowercased().contains(wantMenu.lowercased()) }) else {
        let names = topItems.map { labelOf($0) }.filter { !$0.isEmpty }.joined(separator: " / ")
        die("菜单栏里没有「\(wantMenu)」。现有: \(names)", 3)
    }
    // 菜单项挂在 AXMenuBarItem 的第一个子元素（AXMenu）下
    guard let submenu = axChildren(top).first else { die("菜单「\(wantMenu)」是空的", 3) }
    let entries = axChildren(submenu)

    if args.count == 1 {
        if jsonMode {
            emitJSON(["ok": true, "mode": "menu", "level": "items",
                      "app": app.localizedName ?? q, "menu": labelOf(top),
                      "items": entries.compactMap { e -> [String: Any]? in
                          let l = labelOf(e)
                          if l.isEmpty { return nil }
                          return ["label": l,
                                  "enabled": (axCopy(e, kAXEnabledAttribute as String) as? NSNumber)?.boolValue ?? true,
                                  "hasSubmenu": !axChildren(e).isEmpty,
                                  "shortcut": axStr(e, "AXMenuItemCmdChar") ?? ""]
                      }])
            finish(0)
        }
        print("MENU \(app.localizedName ?? q) → \(labelOf(top))  共 \(entries.count) 项")
        for e in entries {
            let l = labelOf(e)
            if l.isEmpty { continue }
            let enabled = (axCopy(e, kAXEnabledAttribute as String) as? NSNumber)?.boolValue ?? true
            let hasSub = !axChildren(e).isEmpty
            let cmd = axStr(e, "AXMenuItemCmdChar") ?? ""
            var marks = ""
            if hasSub { marks += " ▸" }
            if !cmd.isEmpty { marks += "  ⌘\(cmd)" }
            print("  \(l)\(marks)\(enabled ? "" : "  (禁用)")")
        }
        print("\n用 `computer-control menu \(q) \"\(wantMenu)\" \"<菜单项>\"` 点它")
        finish(0)
    }

    let wantItem = args[1]
    guard let item = entries.first(where: { labelOf($0) == wantItem })
            ?? entries.first(where: { labelOf($0).lowercased().contains(wantItem.lowercased()) }) else {
        let names = entries.map { labelOf($0) }.filter { !$0.isEmpty }.prefix(12).joined(separator: " / ")
        die("菜单「\(wantMenu)」里没有「\(wantItem)」。前几项: \(names)", 3)
    }
    let enabled = (axCopy(item, kAXEnabledAttribute as String) as? NSNumber)?.boolValue ?? true
    if !enabled { die("菜单项「\(labelOf(item))」当前是禁用状态，点不了", 4) }
    beginFocusedOperation(app)
    requireNotSensitive(app, "点菜单")
    if isBrowserBundle(app.bundleIdentifier ?? ""), axStr(item, "AXMenuItemCmdChar")?.lowercased() == "q" { die("窗口授权不能退出整个浏览器", 6) }
    checkOperationFocus()
    actionSent = true
    let me = AXUIElementPerformAction(item, kAXPressAction as CFString)
    if me != .success { die("点击菜单项失败 (AXError \(me.rawValue))", 1) }
    emitAction(app.processIdentifier, "menu \(labelOf(top)) → \(labelOf(item))  已点击",
           ["mode": "menu", "menu": labelOf(top), "item": labelOf(item)])

case "wait":
    guard let q = args.first else { die("用法: computer-control wait <app> --label \"文本\" [--gone] [--timeout 秒]") }
    removeFirstArg()
    let wantGone = hasFlag("--gone")
    let timeout = Double(flagValue("--timeout") ?? "") ?? 10
    guard let label = flagValue("--label") else { die("需要 --label \"要等的文本\"") }
    let app = mustApp(q)
    let t0 = Date()
    while Date().timeIntervalSince(t0) < timeout {
        let (root, _) = uiRoot(app.processIdentifier, nil)
        let present = findLabelLoose(root: root, label: label)
        if present != wantGone {
            let secs = Date().timeIntervalSince(t0)
            let ss = String(format: "%.1f", secs)
            emitOK(wantGone ? "「\(label)」已消失（等了 \(ss)s）" : "「\(label)」已出现（等了 \(ss)s）",
                   ["mode": "wait", "label": label, "waitedFor": wantGone ? "gone" : "present",
                    "seconds": Double(ss) ?? secs])
            finish(0)
        }
        usleep(300000)
    }
    die("等了 \(Int(timeout))s 超时：「\(label)」\(wantGone ? "仍然在" : "始终没出现")", 4)

case "selecttext":
    guard args.count >= 3, let idx = Int(args[1]) else {
        die("用法: computer-control selecttext <app> <idx> <要选中的文本>")
    }
    let target = args.dropFirst(2).joined(separator: " ")
    let app = mustApp(args[0])
    requireNotSensitive(app, "选中文字")
    let key = app.bundleIdentifier ?? (app.localizedName ?? args[0])
    let (el, _, _) = locate(app, key, idx, args[0])
    guard let full = axStr(el, kAXValueAttribute as String) else { die("元素 #\(idx) 没有可读文本", 4) }
    guard let r = full.range(of: target) else {
        die("元素里找不到「\(target)」。它的内容开头是: \(String(full.prefix(60)))", 3)
    }
    // AX 的范围用 UTF-16 偏移，不能用 Character 计数
    let u16 = full.utf16
    guard let lo = r.lowerBound.samePosition(in: u16) else { die("文本定位失败", 1) }
    var cfr = CFRange(location: u16.distance(from: u16.startIndex, to: lo), length: target.utf16.count)
    guard let rv = AXValueCreate(.cfRange, &cfr) else { die("构造选择范围失败", 1) }
    checkBoundElement(el)
    let se = AXUIElementSetAttributeValue(el, kAXSelectedTextRangeAttribute as CFString, rv)
    if se != .success { die("选中失败 (AXError \(se.rawValue))；该元素可能不支持文本选择", 1) }
    emitAction(app.processIdentifier, "selected 「\(target)」 in #\(idx)",
           ["mode": "selecttext", "idx": idx, "selected": target])

case "clip":
    lockResource("clipboard")
    let pb = NSPasteboard.general
    if args.isEmpty {
        let s = pb.string(forType: .string) ?? ""
        emitOK(s, ["mode": "clip", "action": "get", "text": s])
    } else {
        let text = args.joined(separator: " ")
        pb.clearContents(); pb.setString(text, forType: .string)
        emitOK("剪贴板已写入 \(text.count) 字符",
               ["mode": "clip", "action": "set", "chars": text.count])
    }

case "paste":
    // 必须先摘掉选项，再拼位置参数——否则 --settle 600 会被当成要粘贴的文本
    let settleMs = Int(flagValue("--settle") ?? "") ?? 400
    guard settleMs >= 0 && settleMs <= 30000 else { die("settle 必须在0至30000毫秒之间") }
    guard args.count >= 2 else { die("用法: computer-control paste <app> <文本> [--settle 毫秒]") }
    let app = mustApp(args[0])
    beginFocusedOperation(app)
    requireNotSensitive(app, "粘贴")
    let text = args.dropFirst().joined(separator: " ")
    let pb = NSPasteboard.general
    lockResource("clipboard")
    checkOperationFocus()
    let saved = snapshotPasteboard(pb)
    var restored = false
    // 先把会失败的检查做完再动剪贴板：命令结束（常驻模式下是结束线程）不会执行 defer，
    // 从这里往后直到还原剪贴板为止，中间没有任何提前退出的路径。
    guard let (vc, vf) = parseKey("cmd+v") else { die("内部错误：cmd+v 解析失败", 1) }
    requirePostEventAccess("后台粘贴（投递 cmd+v）")
    clipboardSaved = saved
    clipboardRestored = false
    pasteCancelled = false
    pb.clearContents()
    clipboardOwnerCount = pb.changeCount
    guard pb.setString(text, forType: .string) else { cleanupClipboard(); die("临时剪贴板写入失败", 1) }
    clipboardOwnerCount = pb.changeCount
    // 投递后只能观察，不自动重放：AX 值未变化也可能是更新延迟。
    // 读不到焦点框（网页画布、终端这类）就只能照旧投递、交给调用方核对。
    let focusedEl: AXUIElement? = axCopy(axApp(app.processIdentifier), kAXFocusedUIElementAttribute as String)
        .flatMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil }
    let beforeValue = focusedEl.flatMap { axStr($0, kAXValueAttribute as String) }
    let channel = sendKey(pid: app.processIdentifier, code: vc, flags: vf)
    // 固定等待：目标应用读剪贴板需要时间。慢应用可能还没读完就被还原 →
    // 会"报告成功但实际没粘上"。慢应用请用 --settle 调大。
    for _ in 0..<max(1, settleMs / 10) { usleep(10000); checkOperationFocus() }
    var verified: Bool? = nil
    let retried = false
    if let el = focusedEl, beforeValue != nil {
        func landed() -> Bool { (axStr(el, kAXValueAttribute as String) ?? "") != (beforeValue ?? "") }
        verified = landed()

    }
    let ownershipLost = pb.changeCount != clipboardOwnerCount
    cleanupClipboard()
    restored = clipboardRestored
    if pasteCancelled { die("粘贴被取消，动作结果未知；剪贴板仅在仍属于本命令时恢复", 1) }
    let note = ownershipLost ? "（期间有新复制，已保留新内容）" : (restored ? "（原剪贴板已完整还原）" : "⚠️ 原剪贴板还原失败")
    if verified == false {
        die("粘贴未能验证：焦点输入框的内容没变；未自动重试。先 click 目标输入框，或改用 set\(note)", 1)
    }
    emitAction(app.processIdentifier, "pasted \(text.count) 字符 → \(app.localizedName ?? "?")\(note)",
           ["mode": "paste", "chars": text.count, "clipboardRestored": restored,
            "clipboardWasEmpty": saved.isEmpty, "clipboardOwnershipLost": ownershipLost, "delivery": channel,
            "verified": verified.map { $0 as Any } ?? NSNull(), "retried": retried])

case "screens":
    if jsonMode {
        emitJSON(["ok": true, "mode": "screens", "screens": NSScreen.screens.enumerated().map { (i, s) in
            ["index": i + 1, "w": Int(s.frame.width), "h": Int(s.frame.height),
             "x": Int(s.frame.origin.x), "y": Int(s.frame.origin.y),
             "scale": Double(s.backingScaleFactor), "main": NSScreen.main?.frame == s.frame]
        }])
        finish(0)
    }
    for (i, s) in NSScreen.screens.enumerated() {
        let f = s.frame
        let isMain = (NSScreen.main?.frame == f)
        print("\(i + 1). \(Int(f.width))x\(Int(f.height)) @ \(Int(f.origin.x)),\(Int(f.origin.y))  \(s.backingScaleFactor)x\(isMain ? "  ←主屏" : "")")
    }
    if NSScreen.screens.count > 1 {
        print("\n注意：多屏下坐标是全局的，副屏的 x/y 可能为负或超出主屏范围。")
    }

case "winmove", "winsize":
    guard args.count >= 2 else { die("用法: computer-control \(cmd) <app> \(cmd == "winmove" ? "X,Y" : "宽,高")") }
    let app = mustApp(args[0])
    requireNotSensitive(app, "调整窗口")
    guard let (win, _) = pickWindow(app.processIdentifier, index: Int(flagValue("--window") ?? "")) else {
        die("'\(args[0])' 没有可操作的窗口", 3)
    }
    let nums = args[1].split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
    guard nums.count == 2 else { die("格式应为 数字,数字") }
    checkBoundElement(win)
    let we: AXError
    if cmd == "winmove" {
        var p = CGPoint(x: nums[0], y: nums[1])
        guard let v = AXValueCreate(.cgPoint, &p) else { die("构造坐标失败", 1) }
        we = AXUIElementSetAttributeValue(win, kAXPositionAttribute as CFString, v)
    } else {
        var sz = CGSize(width: nums[0], height: nums[1])
        guard let v = AXValueCreate(.cgSize, &sz) else { die("构造尺寸失败", 1) }
        we = AXUIElementSetAttributeValue(win, kAXSizeAttribute as CFString, v)
    }
    if we != .success { die("窗口操作失败 (AXError \(we.rawValue))；该窗口可能不可调整", 1) }
    emitOK("\(cmd) \(app.localizedName ?? args[0]) → \(Int(nums[0])),\(Int(nums[1]))  (后台生效)",
           ["mode": cmd, "a": Int(nums[0]), "b": Int(nums[1])])

case "read":
    let wantSel = hasFlag("--selected")
    guard args.count >= 2, let idx = Int(args[1]) else {
        die("用法: computer-control read <app> <idx> [--selected]   （读元素全文 / 只读选中部分）")
    }
    let app = mustApp(args[0])
    let key = app.bundleIdentifier ?? (app.localizedName ?? args[0])
    let (el, _, _) = locate(app, key, idx, args[0])
    let content: String?
    if wantSel {
        // 后台窗口不画选中高亮，截图看不出来，只能从 AX 层读——这是验证选中是否生效的唯一可靠方式
        content = axStr(el, kAXSelectedTextAttribute as String)
        if content == nil { die("元素 #\(idx) 当前没有选中的文本", 3) }
    } else {
        content = axStr(el, kAXValueAttribute as String) ?? axStr(el, kAXTitleAttribute as String)
        if content == nil { die("元素 #\(idx) 没有可读内容", 3) }
    }
    emitOK(content!, ["mode": "read", "idx": idx, "selected": wantSel, "text": content!])

case "capture-window":
    // 内部命令，只给常驻进程截图用，见 captureWindowFast
    guard args.count >= 3, let wid = UInt32(args[0]) else { finish(2) }
    finish(captureWindowInProcess(CGWindowID(wid), to: args[1], maxDim: Int(args[2]) ?? 0) ? 0 : 1)

case "shot":
    guard let q = args.first else { die("用法: computer-control shot <app>") }
    removeFirstArg()
    let shrinkTo = Int(flagValue("--shrink") ?? "") ?? 1400
    let app = mustApp(q)
    let key = app.bundleIdentifier ?? (app.localizedName ?? q)
    let outPath = flagValue("--out") ?? cacheDir().appendingPathComponent("\(key.replacingOccurrences(of: "/", with: "_"))-\(UUID().uuidString).png").path
    let frame = pickWindow(app.processIdentifier, index: nil).flatMap { axFrame($0.0) }
    var ok = false
    var fast = false
    if let wid = activeWindowRef?["id"] as? Int ?? pickWindow(app.processIdentifier, index: nil).flatMap({ nativeWindowID($0.0).map(Int.init) }) {
        let wid = CGWindowID(wid)
        fast = captureWindowFast(wid, to: outPath, maxDim: shrinkTo)
        ok = fast || captureWindow(wid, to: outPath)
    }
    if !ok, activeWindowRef == nil, let f = frame, f.width > 1, f.height > 1 {
        // 访达的「桌面」这类不是标准 CGWindow，拿不到窗口 ID，只能按坐标截
        warn("拿不到窗口 ID（该应用可能没有标准窗口，例如访达的桌面），已回退为按屏幕坐标截图；窗口若被遮挡会截到遮挡它的内容")
        ok = captureRect(f, to: outPath)
    }
    if !ok { die("截图失败：既拿不到窗口 ID，也没有可用坐标。检查屏幕录制权限是否已授予宿主应用", 1) }
    if shrinkTo > 0 && !fast { shrink(outPath, maxDim: shrinkTo) }
    emitOK(outPath, ["mode": "shot", "path": outPath])

case "webmode":
    // Chrome/Electron 默认不向辅助功能暴露网页内容，只暴露浏览器外壳。
    // 给应用根元素设 AXEnhancedUserInterface（VoiceOver 就是这么做的）会让它构建网页的无障碍树；
    // Chrome 对这次写入返回 -25208，但实际已生效，约 1~2 秒后网页元素出现。所以不看返回码，按树里有没有网页判断。
    // AXManualAccessibility 是 Electron 的专用开关，对 Chrome 返回 -25205；两个都写，互不影响。
    guard let q = args.first else { die("用法: computer-control webmode <app> [--off] [--timeout 秒]") }
    removeFirstArg()
    let turnOff = hasFlag("--off")
    let timeout = Double(flagValue("--timeout") ?? "") ?? 4
    let app = mustApp(q)
    if turnOff {
        let root = axApp(app.processIdentifier)
        let manual = AXUIElementSetAttributeValue(root, "AXManualAccessibility" as CFString, kCFBooleanFalse).rawValue
        let enhanced = AXUIElementSetAttributeValue(root, "AXEnhancedUserInterface" as CFString, kCFBooleanFalse).rawValue
        emitOK("已关闭 \(app.localizedName ?? q) 的网页辅助功能",
               ["mode": "webmode", "enabled": false, "manualError": Int(manual), "enhancedError": Int(enhanced)])
        finish(0)
    }
    let r = enableWebContent(app.processIdentifier, timeout: timeout)
    emitOK(r.ok ? "\(app.localizedName ?? q) 的网页内容已可读（等了 \(r.seconds)s）"
                : "已请求开启，但 \(Int(timeout))s 内没看到网页内容（可能不是浏览器，或页面还没加载）",
           ["mode": "webmode", "enabled": true, "webContent": r.ok, "seconds": r.seconds,
            "manualError": Int(r.manual), "enhancedError": Int(r.enhanced)])

case "quit":
    guard let name = args.first else { die("用法: computer-control quit <应用名> --authorized [--timeout 秒]", 2) }
    removeFirstArg()
    guard hasFlag("--authorized") else { die("关闭目标需要明确授权", 6) }
    let timeout = Double(flagValue("--timeout") ?? "") ?? 10
    guard timeout > 0 else { die("timeout 必须大于 0", 2) }
    _ = requireTaskScope()
    // 退出绝不能像 snap 那样把未运行的应用先启动起来。
    guard let app = resolveApp(name) else { die("找不到运行中的应用 '\(name)'，未启动或退出其他进程", 3) }
    requireNotSensitive(app, "退出")
    if isBrowserBundle(app.bundleIdentifier ?? "") { die("共享浏览器不接受整应用退出；绑定窗口后仅关闭该窗口", 6) }
    bindTaskOwnership(app)
    let pid = app.processIdentifier
    let result = requestApplicationQuit(app, timeout: timeout)
    guard result.requested else { die("应用未接受正常退出请求，未强杀", 1) }
    guard result.terminated else {
        die("已请求应用正常退出，但 \(String(format: "%.1f", timeout)) 秒内进程尚未退出；可能有确认框或未保存内容，未强杀", 4, outcome: "unknown")
    }
    emitOK("已正常退出 \(app.localizedName ?? name) pid=\(pid)（已核对进程退出）",
           ["mode": "target.close", "app": app.localizedName ?? name, "appKey": app.bundleIdentifier ?? String(pid), "pid": Int(pid),
            "requested": true, "terminated": true,
            "waitedSeconds": (result.waitedSeconds * 100).rounded() / 100])

case "open":
    guard let name = args.first else { die("用法: computer-control open <应用名或路径>") }
    removeFirstArg()
    let front = hasFlag("--front")
    _ = requireTaskScope()
    if let running = resolveApp(name), isBrowserBundle(running.bundleIdentifier ?? ""), boundWindowRef == nil {
        guard !front else { die("共享浏览器不会激活整个应用，请置前明确任务窗口", 6) }
        emitOK("浏览器实例已运行", ["mode": "open", "running": true, "pid": Int(running.processIdentifier)])
        finish(0)
    }
    let url: URL
    let bid: String
    if let running = resolveApp(name), let u = running.bundleURL, let b = running.bundleIdentifier {
        bindTaskOwnership(running)
        url = u; bid = b
    } else if let u = installedAppURL(name) {
        bid = claimInstalledApp(u)
        url = u
    } else { appNotFound(name, installed: true) }
    if boundWindowRef != nil {
        guard !front else { die("绑定窗口不会自动激活应用，请手动置前目标窗", 6) }
        emitOK("目标窗口已运行", ["mode": "open", "window": boundWindowRef!])
        finish(0)
    }
    guard let launched = launchApp(url, front: front) else { die("启动失败: \(url.path)", 1) }
    guard launched.bundleIdentifier == bid else { die("启动后应用身份与归属不一致", 4) }
    // 等窗口就绪（冷启动可能要 3 秒以上）
    var waited = 0.0
    while waited < 12.0 {
        if let a = NSRunningApplication(processIdentifier: launched.processIdentifier), !appWindows(a.processIdentifier).isEmpty {
            emitOK("opened \(a.localizedName ?? name) pid=\(a.processIdentifier)\(front ? "" : "  (后台，未抢焦点)")",
                   ["mode": "open", "app": a.localizedName ?? name,
                    "pid": Int(a.processIdentifier), "front": front])
            finish(0)
        }
        usleep(300000); waited += 0.3
    }
    emitOK("已启动 \(name)，但 \(Int(waited))s 内没等到窗口（可能是无窗口应用）",
           ["mode": "open", "app": name, "windowAppeared": false,
            "waitedSeconds": Int(waited), "front": front])

default:
    die("未知命令 '\(cmd)'。跑 `computer-control --help` 看用法")
}
finish(0)
}

// ==================== 常驻模式 ====================

/// `computer-control serve`：从标准输入逐行读 JSON 请求 {"id":1,"args":["snap","计算器"]}，
/// 每行回一行 {"id":1,"code":0,"result":{…},"warnings":[…]}。一个进程连续跑命令，
/// 省掉每条命令的进程启动、系统框架加载和权限初始化（截图从 0.2 秒降到几十毫秒）。
/// 每条命令在自己的线程上跑、跑完就结束那个线程；命令之间共享的只有全局设置，按请求重置。
/// 标准输入关闭就退出。
func runServe() {
    serveMode = true
    jsonMode = true
    _ = NSApplication.shared          // 截图、窗口列表要先连上窗口服务器
    setvbuf(stdout, nil, _IOLBF, 0)
    FileHandle.standardError.write("computer-control serve ready\n".data(using: .utf8)!)
    // 主线程必须一直转运行循环：正在运行的应用列表、窗口列表这类系统状态只在运行循环转动时更新，
    // 主线程卡在读输入上的话，应用重开之后常驻进程还看到旧进程。所以读输入放到后台线程，
    // 每条命令再派到它自己的线程上跑（命令结束用 pthread_exit 收掉那个线程）。
    let reader = Thread {
        while let line = readLine(strippingNewline: true) {
            if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
            serveBusy = true
            serveOne(line)
            serveLastActive = Date().timeIntervalSince1970
            serveBusy = false
        }
        exit(0)
    }
    reader.name = "computer-control-reader"
    reader.stackSize = 16 << 20
    reader.start()
    // 空闲太久就自己退出：会话停了但 Python 环境还开着时，常驻进程会跟着一直待命，
    // 2026-10-13 有两个这样待了 20 多小时、还卡在系统录屏组件里反复连截屏服务。
    // 调用方按同一个时长提前重开，所以这里退出不会撞上正在发来的请求。
    let idle = Double(ProcessInfo.processInfo.environment["COMPUTER_CONTROL_SERVE_IDLE"] ?? "") ?? 600
    while true {
        if pasteCancelled && clipboardSaved == nil { exit(143) }
        if idle > 0 && !serveBusy && clipboardSaved == nil
            && Date().timeIntervalSince1970 - serveLastActive > idle { exit(0) }
        RunLoop.main.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
    }
}

/// 处理一行请求：在主线程上刷新一下应用列表，再把命令派到新线程上跑，等它结束，写一行结果。
func serveOne(_ line: String) {
    guard let d = line.data(using: .utf8),
          let req = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
          let list = req["args"] as? [Any], let first = list.first as? String else {
        print("{\"code\":2,\"result\":{\"ok\":false,\"error\":\"请求格式应为 {\\\"id\\\":…,\\\"args\\\":[\\\"命令\\\",…]}\",\"code\":2}}")
        return
    }
    let id = req["id"] ?? NSNull()
    args = list.dropFirst().map { "\($0)" }
    optionBoundary = nil
    _ = hasFlag("--json")
    serveOutput = []
    serveWarnings = []
    serveCode = 0
    walkTimedOut = false
    let env = req["env"] as? [String: String] ?? [:]
    for (k, v) in env { setenv(k, v, 1) }
    _ = DispatchQueue.main.sync { RunLoop.main.run(mode: .default, before: Date(timeIntervalSinceNow: 0.01)) }
    let worker = Thread { runCommand(first) }
    worker.stackSize = 16 << 20
    worker.start()
    serveDone.wait()
    for (k, _) in env { unsetenv(k) }
    var result: Any = NSNull()
    if let last = serveOutput.last, let od = last.data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: od) {
        result = o
    }
    var reply: [String: Any] = ["id": id, "code": Int(serveCode), "result": result]
    if !serveWarnings.isEmpty { reply["warnings"] = serveWarnings }
    if let rd = try? JSONSerialization.data(withJSONObject: reply, options: [.withoutEscapingSlashes]),
       let s = String(data: rd, encoding: .utf8) {
        print(s)
    }
}

signal(SIGTERM) { _ in pasteCancelled = true }
signal(SIGINT) { _ in pasteCancelled = true }
jsonMode = hasFlag("--json")
guard let cmd = args.first else { print(usage); exit(0) }
removeFirstArg()
if cmd == "serve" { runServe() } else { runCommand(cmd) }