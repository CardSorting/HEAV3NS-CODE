import AppKit

struct QueuedInstruction: Equatable {
    let id: String
    let text: String
    let revision: Int
}

/// Native, bounded queue inspection. Actions always address a stable run ID.
final class QueuedInstructions: NSViewController {
    var onEdit: ((QueuedInstruction) -> Void)?
    var onRemove: ((QueuedInstruction) -> Void)?
    private let content = NSStackView()
    private var entries = [QueuedInstruction]()
    private var enabled = false
    private var editing = false
    private var removing = false
    private var busy = Set<String>()
    override func loadView() {
        view = NSView()
        content.orientation = .vertical; content.alignment = .leading; content.spacing = 12
        content.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(content)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            content.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            content.topAnchor.constraint(equalTo: view.topAnchor, constant: 16),
            content.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -16),
            view.widthAnchor.constraint(equalToConstant: 400)
        ])
    }
    func update(_ entries: [QueuedInstruction], enabled: Bool, editing: Bool, removing: Bool, busy: Set<String>) {
        guard entries != self.entries || enabled != self.enabled || editing != self.editing || removing != self.removing || busy != self.busy || content.arrangedSubviews.isEmpty else { return }
        self.entries = entries; self.enabled = enabled; self.editing = editing; self.removing = removing; self.busy = busy
        _ = view
        for item in content.arrangedSubviews { content.removeArrangedSubview(item); item.removeFromSuperview() }
        let heading = NSTextField(labelWithString: "Up Next")
        heading.font = .systemFont(ofSize: 13, weight: .semibold); content.addArrangedSubview(heading)
        let detail = NSTextField(wrappingLabelWithString: entries.isEmpty ? "No instructions waiting. Send a follow-up while LUMI works to add it here." : "These instructions run in order after the current task.")
        detail.font = .systemFont(ofSize: 12); detail.textColor = .secondaryLabelColor
        detail.preferredMaxLayoutWidth = 368
        content.addArrangedSubview(detail)
        detail.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true
        for (index, entry) in entries.enumerated() {
            let label = NSTextField(wrappingLabelWithString: "\(index + 1). \(entry.text)")
            label.font = .systemFont(ofSize: 13); label.maximumNumberOfLines = 2; label.lineBreakMode = .byWordWrapping
            label.preferredMaxLayoutWidth = 368
            label.toolTip = entry.text; label.setAccessibilityLabel("Queued instruction \(index + 1): \(entry.text)")
            let edit = NSButton(title: "Edit…", target: self, action: #selector(editInstruction(_:)))
            let remove = NSButton(title: busy.contains(entry.id) ? "Removing…" : "Remove", target: self, action: #selector(removeInstruction(_:)))
            for button in [edit, remove] {
                button.identifier = NSUserInterfaceItemIdentifier(entry.id); button.bezelStyle = .rounded
                button.isEnabled = enabled && !busy.contains(entry.id)
            }
            edit.isHidden = !editing; remove.isHidden = !removing
            edit.setAccessibilityLabel("Edit queued instruction \(index + 1)"); remove.setAccessibilityLabel("Remove queued instruction \(index + 1)")
            let actions = NSStackView(views: [edit, remove]); actions.spacing = 6
            let row = NSStackView(views: [label, actions]); row.orientation = .vertical; row.alignment = .leading; row.spacing = 4
            content.addArrangedSubview(row); row.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true
            label.widthAnchor.constraint(equalTo: row.widthAnchor).isActive = true
        }
        preferredContentSize = NSSize(width: 400, height: max(112, content.fittingSize.height + 32))
    }
    @objc private func editInstruction(_ sender: NSButton) {
        if let entry = entries.first(where: { $0.id == sender.identifier?.rawValue }) { onEdit?(entry) }
    }
    @objc private func removeInstruction(_ sender: NSButton) {
        if let entry = entries.first(where: { $0.id == sender.identifier?.rawValue }) { onRemove?(entry) }
    }
}

/// Editing has its own draft so a failed or stale save cannot overwrite the composer.
final class QueuedInstructionEditor: NSWindowController, NSWindowDelegate, NSTextViewDelegate {
    private let text = NSTextView()
    private let message = NSTextField(wrappingLabelWithString: "Changes apply only while this instruction is waiting.")
    private let saveButton = NSButton(title: "Save Changes", target: nil, action: nil)
    private let cancelButton = NSButton(title: "Cancel", target: nil, action: nil)
    private let copyButton = NSButton(title: "Copy Edit", target: nil, action: nil)
    private let limit: Int
    private let save: (String, @escaping (Result<Void, Error>) -> Void) -> Void
    private var saving = false
    private var unavailableReason: String?
    private var saveFailure: String?
    init(text: String, limit: Int, save: @escaping (String, @escaping (Result<Void, Error>) -> Void) -> Void) {
        self.limit = limit; self.save = save
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 520, height: 320), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        panel.title = "Edit Queued Instruction"; panel.isReleasedWhenClosed = false
        super.init(window: panel); panel.delegate = self
        self.text.string = text; self.text.isRichText = false; self.text.font = .systemFont(ofSize: 14)
        self.text.delegate = self; self.text.isAutomaticQuoteSubstitutionEnabled = false; self.text.isAutomaticDashSubstitutionEnabled = false
        self.text.isVerticallyResizable = true; self.text.autoresizingMask = [.width]; self.text.textContainerInset = NSSize(width: 10, height: 10)
        self.text.setAccessibilityLabel("Queued instruction")
        let scroll = NSScrollView(); scroll.documentView = self.text; scroll.hasVerticalScroller = true; scroll.borderType = .bezelBorder
        message.font = .systemFont(ofSize: 12); message.textColor = .secondaryLabelColor; message.isSelectable = true
        saveButton.target = self; saveButton.action = #selector(saveChanges); saveButton.bezelStyle = .rounded; saveButton.keyEquivalent = "\r"; saveButton.keyEquivalentModifierMask = [.command]
        saveButton.toolTip = "Save Changes (⌘Return)"
        cancelButton.target = self; cancelButton.action = #selector(dismiss); cancelButton.bezelStyle = .rounded; cancelButton.keyEquivalent = "\u{1b}"
        copyButton.target = self; copyButton.action = #selector(copyEdit); copyButton.bezelStyle = .rounded
        copyButton.toolTip = "Copy your edited instruction to the clipboard"
        let actions = NSStackView(views: [copyButton, NSView(), cancelButton, saveButton]); actions.spacing = 8
        let title = NSTextField(labelWithString: "Edit Queued Instruction"); title.font = .systemFont(ofSize: 13, weight: .semibold)
        let root = NSStackView(views: [title, scroll, message, actions]); root.orientation = .vertical; root.alignment = .leading; root.spacing = 12
        root.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16); root.translatesAutoresizingMaskIntoConstraints = false
        panel.contentView?.addSubview(root)
        if let view = panel.contentView {
            NSLayoutConstraint.activate([root.leadingAnchor.constraint(equalTo: view.leadingAnchor), root.trailingAnchor.constraint(equalTo: view.trailingAnchor), root.topAnchor.constraint(equalTo: view.topAnchor), root.bottomAnchor.constraint(equalTo: view.bottomAnchor), scroll.widthAnchor.constraint(equalTo: root.widthAnchor, constant: -32), scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 160), message.widthAnchor.constraint(equalTo: scroll.widthAnchor), actions.widthAnchor.constraint(equalTo: scroll.widthAnchor)])
        }
        updateAvailability()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    func present(for parent: NSWindow) { parent.beginSheet(window!); window?.makeFirstResponder(text) }
    func textDidChange(_ notification: Notification) {
        saveFailure = nil; updateAvailability()
    }
    func setUnavailable(_ reason: String?) {
        guard unavailableReason != reason else { return }
        unavailableReason = reason; updateAvailability()
    }
    private func updateAvailability() {
        let count = text.string.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count
        saveButton.isEnabled = !saving && unavailableReason == nil && count > 0 && count <= limit
        cancelButton.title = unavailableReason == nil ? "Cancel" : "Close"
        copyButton.isEnabled = !text.string.isEmpty
        message.stringValue = unavailableReason ?? saveFailure ?? (count > limit ? "Keep this instruction under \(limit.formatted()) characters. Your edit is preserved." : "Changes apply only while this instruction is waiting.")
    }
    @objc private func copyEdit() {
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text.string, forType: .string)
    }
    @objc private func saveChanges() {
        let value = text.string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !saving, unavailableReason == nil, !text.hasMarkedText(), !value.isEmpty, value.utf16.count <= limit else { return }
        saving = true; text.isEditable = false; saveButton.isEnabled = false; cancelButton.isEnabled = false; saveButton.title = "Saving…"
        save(value) { [weak self] result in
            guard let self else { return }
            self.saving = false; self.text.isEditable = true; self.cancelButton.isEnabled = true; self.saveButton.title = "Save Changes"
            switch result {
            case .success: self.dismiss()
            case .failure(let error): self.saveFailure = error.localizedDescription + " Your edit is preserved here."; self.updateAvailability()
            }
        }
    }
    @objc private func dismiss() { guard !saving else { return }; if let window, let parent = window.sheetParent { parent.endSheet(window); window.orderOut(nil) } }
    func windowShouldClose(_ sender: NSWindow) -> Bool { dismiss(); return false }
}
