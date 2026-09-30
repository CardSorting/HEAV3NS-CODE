import AppKit

/// Selection is not activation. Arrow keys browse; Return deliberately opens.
final class KeyboardListView: NSTableView {
    var onActivate: (() -> Void)?
    var onEnterFolder: (() -> Void)?
    var onParent: (() -> Void)?
    var onCancel: (() -> Void)?
    override func keyDown(with event: NSEvent) {
        guard isEnabled, event.modifierFlags.intersection([.command, .control, .option]).isEmpty else { super.keyDown(with: event); return }
        switch event.keyCode {
        case 36, 76: if let onActivate { onActivate(); return }
        case 124: if let onEnterFolder { onEnterFolder(); return }
        case 123: if let onParent { onParent(); return }
        case 53: if let onCancel { onCancel(); return }
        default: break
        }
        super.keyDown(with: event)
    }
}
