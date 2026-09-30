import AppKit

struct ApprovalRequest: Equatable {
    let run: String
    let operation: String
    let tool: String
    let scope: String
    let reason: String
    let arguments: String
    var identity: String { "\(run):\(operation)" }
    var details: String { "Workspace\n\(scope)\n\nReason\n\(reason.isEmpty ? "Review this operation before it runs." : reason)\n\nArguments\n\(arguments)" }
}

/// The sheet always describes one immutable operation. It never follows a newer
/// request under the user's pointer or turns Return into permission to execute.
final class ApprovalReview: NSWindowController, NSWindowDelegate {
    let request: ApprovalRequest
    private let message = NSTextField(wrappingLabelWithString: "")
    private let allowButton = NSButton(title: "Allow Once", target: nil, action: nil)
    private let denyButton = NSButton(title: "Deny", target: nil, action: nil)
    private let closeButton = NSButton(title: "Close", target: nil, action: nil)
    private let decide: (ApprovalRequest, String) -> Void
    private let didClose: () -> Void
    private var submitting = false
    private var canDecide = false

    init(request: ApprovalRequest, decide: @escaping (ApprovalRequest, String) -> Void, didClose: @escaping () -> Void) {
        self.request = request; self.decide = decide; self.didClose = didClose
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 620, height: 340), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Review Request"; window.isReleasedWhenClosed = false
        super.init(window: window); window.delegate = self
        let root = NSStackView(); root.orientation = .vertical; root.alignment = .leading; root.spacing = 12
        root.translatesAutoresizingMaskIntoConstraints = false
        let title = NSTextField(labelWithString: request.tool)
        title.font = .systemFont(ofSize: 16, weight: .semibold); title.lineBreakMode = .byTruncatingMiddle; title.toolTip = request.tool
        let text = NSTextView(); text.isEditable = false; text.isSelectable = true; text.isRichText = false
        text.font = .monospacedSystemFont(ofSize: 12, weight: .regular); text.string = request.details
        text.textContainerInset = NSSize(width: 10, height: 10)
        text.isVerticallyResizable = true; text.autoresizingMask = [.width]
        text.setAccessibilityLabel("Full operation details for \(request.tool)")
        let scroll = NSScrollView(); scroll.documentView = text; scroll.hasVerticalScroller = true; scroll.borderType = .bezelBorder
        message.font = .systemFont(ofSize: 12); message.textColor = .secondaryLabelColor; message.maximumNumberOfLines = 3
        let buttons = NSStackView(views: [closeButton, NSView(), denyButton, allowButton]); buttons.spacing = 8
        for button in [closeButton, denyButton, allowButton] { button.bezelStyle = .rounded; button.target = self; button.setContentHuggingPriority(.required, for: .horizontal) }
        closeButton.action = #selector(dismiss); closeButton.keyEquivalent = "\u{1b}"
        denyButton.action = #selector(deny); allowButton.action = #selector(allow)
        [title, scroll, message, buttons].forEach(root.addArrangedSubview)
        let content = NSView(); content.addSubview(root); window.contentView = content
        NSLayoutConstraint.activate([
            root.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20), root.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            root.topAnchor.constraint(equalTo: content.topAnchor, constant: 18), root.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -18),
            title.widthAnchor.constraint(equalTo: root.widthAnchor), scroll.widthAnchor.constraint(equalTo: root.widthAnchor),
            message.widthAnchor.constraint(equalTo: root.widthAnchor), buttons.widthAnchor.constraint(equalTo: root.widthAnchor), scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 120)
        ])
        window.initialFirstResponder = text
        text.nextKeyView = closeButton; closeButton.nextKeyView = denyButton; denyButton.nextKeyView = allowButton; allowButton.nextKeyView = text
        update(isCurrent: true, connected: false, submitting: false, stopping: false)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    func present(for parent: NSWindow) { if let window { parent.beginSheet(window) } }
    func update(isCurrent: Bool, connected: Bool, submitting: Bool, stopping: Bool, error: String? = nil) {
        self.submitting = submitting
        canDecide = isCurrent && connected && !submitting && !stopping
        allowButton.isEnabled = canDecide; denyButton.isEnabled = canDecide
        message.stringValue = !isCurrent ? "This request is no longer waiting. Close this review to see the current task." :
            !connected ? "Disconnected. Reconnect in the workspace to check this request's status." :
            stopping ? "Stopping this task. This operation cannot be approved." :
            submitting ? "Saving your decision…" : error ?? "Allow Once applies only to this operation. Close leaves the request waiting."
    }
    private func resolve(_ decision: String) {
        guard canDecide, !submitting else { return }
        submitting = true; canDecide = false; allowButton.isEnabled = false; denyButton.isEnabled = false
        message.stringValue = "Saving your decision…"; decide(request, decision)
    }
    @objc private func allow() { resolve("allow") }
    @objc private func deny() { resolve("deny") }
    @objc private func dismiss() {
        if let window, let parent = window.sheetParent { parent.endSheet(window); window.orderOut(nil) }
        didClose()
    }
    override func cancelOperation(_ sender: Any?) { dismiss() }
    func windowShouldClose(_ sender: NSWindow) -> Bool { dismiss(); return false }
}
