import AppKit

/// Native bindings for the approved journey. AppKit retains focus, selection and appearance behavior.
enum JourneyStyle {
    static func label(_ text: String, size: CGFloat = 13, weight: NSFont.Weight = .regular, secondary: Bool = false) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: text)
        label.font = .systemFont(ofSize: size, weight: weight)
        label.textColor = secondary ? .secondaryLabelColor : .labelColor
        return label
    }
    static func stack(_ views: [NSView], vertical: Bool = true, spacing: CGFloat = 12) -> NSStackView {
        let stack = NSStackView(views: views)
        stack.orientation = vertical ? .vertical : .horizontal
        stack.alignment = vertical ? .leading : .centerY
        stack.spacing = spacing; stack.translatesAutoresizingMaskIntoConstraints = false
        return stack
    }
    static func rule() -> NSBox { let line = NSBox(); line.boxType = .separator; return line }
    static func pin(_ view: NSView, to parent: NSView, inset: CGFloat = 0) {
        view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: parent.leadingAnchor, constant: inset),
            view.trailingAnchor.constraint(equalTo: parent.trailingAnchor, constant: -inset),
            view.topAnchor.constraint(equalTo: parent.topAnchor, constant: inset),
            view.bottomAnchor.constraint(equalTo: parent.bottomAnchor, constant: -inset),
        ])
    }
}

final class JourneyButton: NSButton {
    private let handler: () -> Void
    init(_ title: String, symbol: String? = nil, action: @escaping () -> Void) {
        handler = action
        super.init(frame: .zero)
        self.title = title; target = self; self.action = #selector(activate)
        bezelStyle = .rounded; controlSize = .regular
        if let symbol { image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil); imagePosition = .imageLeading }
        setAccessibilityLabel(title)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    @objc private func activate() { handler() }
}
