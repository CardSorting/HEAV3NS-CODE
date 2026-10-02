import AppKit

/// A native checked menu: each choice is a single, revision-checked workspace mutation.
final class ReasoningPicker: NSPopUpButton {
    var request: ((String, [String: Any], @escaping (Result<[String: Any], Error>) -> Void) -> Void)?
    var canApply: () -> Bool = { false }
    var onSelection: (([String: Any]) -> Void)?
    var onPending: (() -> Void)?
    var onError: ((String) -> Void)?
    private(set) var pending = false
    private var selection: WorkspaceModelSelection?
    private var blocked = false
    private var reconciled = false
    private var token = UUID()
    private var supported = false
    static func label(_ level: String) -> String {
        ["default": "Default", "none": "None", "minimal": "Minimal", "low": "Low", "medium": "Medium", "high": "High", "xhigh": "Extra High", "max": "Maximum"][level] ?? level
    }
    private static func detail(_ level: String) -> String {
        ["default": "Use the model’s default", "none": "No reasoning", "minimal": "Least reasoning", "low": "Faster responses", "medium": "Balance speed and depth", "high": "More thorough reasoning", "xhigh": "Deeper reasoning · more time", "max": "Most reasoning · more time and tokens"][level] ?? ""
    }
    init() {
        super.init(frame: .zero, pullsDown: true)
        bezelStyle = .rounded; target = self; action = #selector(choose)
        setContentHuggingPriority(.required, for: .horizontal)
        setContentCompressionResistancePriority(.required, for: .horizontal)
        setAccessibilityLabel("Reasoning level")
        refresh(supported: false)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    func receive(_ data: [String: Any]) {
        guard let incoming = WorkspaceModelSelection(data) else { return }; receive(incoming)
    }
    func receive(_ incoming: WorkspaceModelSelection) {
        guard selection == nil || incoming.revision >= selection!.revision else { return }
        selection = incoming; blocked = incoming.blocked != nil
        reconciled = true; refresh(supported: supported)
    }
    func connectionLost() {
        token = UUID(); pending = false; reconciled = false; selection = nil
        refresh(supported: false); onPending?()
    }
    func refresh(supported: Bool) {
        self.supported = supported
        isHidden = !supported
        removeAllItems()
        let value = reconciled ? Self.label(selection?.reasoningEffort ?? "default") : "Check Setting"
        addItem(withTitle: pending ? "Saving Reasoning…" : "Reasoning: \(value)")
        if reconciled, let selection {
            for level in ["default"] + selection.reasoningOptions {
                addItem(withTitle: "\(Self.label(level)) — \(Self.detail(level))")
                lastItem?.representedObject = level
                lastItem?.state = selection.reasoningEffort == level ? .on : .off
            }
        } else {
            addItem(withTitle: "Check Saved Setting"); lastItem?.representedObject = "refresh"
        }
        isEnabled = supported && !pending && !blocked && (!reconciled || (canApply() && selection?.reasoningOptions.isEmpty == false))
        toolTip = pending ? "Saving the reasoning level for future instructions…" : blocked ? "Reopen this workspace to recover its saved settings." : !reconciled ? "Check the saved reasoning level before changing it." : !canApply() ? "Finish or stop active and queued work before changing reasoning." : selection?.reasoningOptions.isEmpty == true ? "This model uses its default reasoning. Adjustable levels are not known for this model." : "Choose how much reasoning this model uses for future instructions. Higher levels can take longer and use more tokens."
        setAccessibilityValue(pending ? "Saving" : value)
    }
    @objc private func choose() {
        guard let level = selectedItem?.representedObject as? String else { return }
        select(level)
    }
    func select(_ level: String) {
        guard supported, !pending, !blocked else { return }
        if level == "refresh", !reconciled { checkSaved(); return }
        guard reconciled, canApply(), let selection,
              level == "default" || selection.reasoningOptions.contains(level), level != selection.reasoningEffort,
              let request else { refresh(supported: supported); return }
        pending = true; let operation = UUID(); token = operation
        refresh(supported: supported); onPending?()
        request("models.select", ["provider": selection.provider, "model": selection.model, "revision": selection.revision, "reasoningEffort": level]) { [weak self] result in
            guard let self, self.token == operation else { return }
            if case .success(let data) = result, let saved = WorkspaceModelSelection(data), saved.revision >= (self.selection?.revision ?? 0) {
                self.pending = false; self.receive(data); self.onSelection?(data); self.onPending?()
            } else {
                self.reconciled = false
                self.onError?("The reasoning change could not be confirmed. Checking the saved setting…")
                self.checkSaved()
            }
        }
    }
    private func checkSaved() {
        guard let request else { return }
        pending = true; let operation = UUID(); token = operation
        refresh(supported: supported); onPending?()
        request("models.list", [:]) { [weak self] result in
            guard let self, self.token == operation else { return }
            self.pending = false
            if case .success(let data) = result, let saved = WorkspaceModelSelection(data), saved.revision >= (self.selection?.revision ?? 0) {
                self.receive(data); self.onSelection?(data)
                self.onError?("Saved reasoning: \(Self.label(saved.reasoningEffort)). Choose a level to change it.")
            } else {
                self.reconciled = false
                self.onError?("Could not read the saved reasoning level. Use Reasoning → Check Saved Setting to try again.")
            }
            self.refresh(supported: self.supported); self.onPending?()
        }
    }
    var diagnostics: [String: Any] {
        ["value": selection?.reasoningEffort ?? "default", "options": selection?.reasoningOptions ?? [], "pending": pending, "reconciled": reconciled, "enabled": isEnabled, "title": title]
    }
}
