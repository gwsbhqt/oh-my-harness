import AppKit
final class Delegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var identityButton: NSButton!
    var pressCount: NSTextField!
    var count = 0
    var input: NSTextField!
    var inputMonitor: Any?
    var reportedInput = false
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        CommandLine.arguments.contains("--refuse-quit") ? .terminateCancel : .terminateNow
    }
    @objc func removeIdentity() { identityButton.setAccessibilityIdentifier(nil) }
    @objc func pressIdentity() { count += 1; pressCount.stringValue = String(count) }
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 120, y: 180, width: 380, height: 200), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "computer-control 任务交接验收"
        for (i, label) in ["城市", "尺寸"].enumerated() {
            let popup = NSPopUpButton(frame: NSRect(x: 30, y: 120 - i * 65, width: 240, height: 30), pullsDown: false)
            popup.addItems(withTitles: i == 0 ? ["巴黎", "里斯本"] : ["小", "大"])
            popup.setAccessibilityLabel(label)
            popup.setAccessibilityIdentifier(i == 0 ? "city" : "size")
            window.contentView!.addSubview(popup)
        }
        identityButton = NSButton(title: "保存测试", target: self, action: #selector(pressIdentity))
        identityButton.frame = NSRect(x: 280, y: 120, width: 90, height: 30)
        identityButton.setAccessibilityIdentifier("identity-save")
        window.contentView!.addSubview(identityButton)
        let mutation = NSButton(title: "移除标识", target: self, action: #selector(removeIdentity))
        mutation.frame = NSRect(x: 280, y: 70, width: 90, height: 30)
        mutation.setAccessibilityIdentifier("remove-identity")
        window.contentView!.addSubview(mutation)
        pressCount = NSTextField(labelWithString: "0")
        pressCount.frame = NSRect(x: 300, y: 30, width: 50, height: 25)
        pressCount.setAccessibilityIdentifier("press-count")
        window.contentView!.addSubview(pressCount)
        input = NSTextField(string: "")
        input.frame = NSRect(x: 30, y: 15, width: 240, height: 25)
        input.setAccessibilityIdentifier("cancel-input")
        window.contentView!.addSubview(input)
        inputMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            if let text = event.characters, !text.isEmpty {
                self.input.stringValue += text
                if !self.reportedInput {
                    self.reportedInput = true
                    print("input-started"); fflush(stdout)
                }
            }
            return nil
        }
        window.orderFront(nil)
        print("ready"); fflush(stdout)
    }
}
let app = NSApplication.shared
let delegate = Delegate()
app.setActivationPolicy(.accessory); app.delegate = delegate; app.run()
