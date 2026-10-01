import AppKit

struct TranscriptRow: Equatable {
    let id: String
    let title: String
    let text: String
    let activity: Bool
    var user = false
    var checkpoint: String?
    var evidence: String?
    var automatic = false
}

/// Row height and rendered text share the actual cell width, including AppKit's
/// table-style insets. Explicit native text frames keep wrapping and measurement
/// together without reloading the conversation or disturbing selection on resize.
struct TranscriptMessageLayout {
    let width: CGFloat
    let height: CGFloat
    let title: NSRect
    let evidence: NSRect?
    let body: NSRect?
    let checkpoint: NSRect?

    init(_ row: TranscriptRow, availableWidth: CGFloat) {
        width = max(120, min(760, availableWidth - 24, row.user ? availableWidth * 0.86 : availableWidth))
        let textWidth = width - 24
        func measured(_ text: String, width: CGFloat, font: NSFont) -> CGFloat {
            ceil((text as NSString).boundingRect(with: NSSize(width: max(1, width), height: .greatestFiniteMagnitude),
                options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: [.font: font]).height) + 2
        }
        let titleHeight = max(20, measured(row.title, width: textWidth - 22, font: .systemFont(ofSize: 12, weight: .semibold)))
        title = NSRect(x: 34, y: 12, width: textWidth - 22, height: titleHeight)
        var y = title.maxY
        if let text = row.evidence {
            let frame = NSRect(x: 12, y: y + 5, width: textWidth, height: measured(text, width: textWidth, font: .systemFont(ofSize: 12)))
            evidence = frame; y = frame.maxY
        } else { evidence = nil }
        if !row.text.isEmpty {
            let frame = NSRect(x: 12, y: y + 5, width: textWidth, height: measured(row.text, width: textWidth, font: .systemFont(ofSize: row.activity ? 12 : 14)))
            body = frame; y = frame.maxY
        } else { body = nil }
        if row.checkpoint != nil {
            let frame = NSRect(x: 12, y: y + 5, width: textWidth, height: 24)
            checkpoint = frame; y = frame.maxY
        } else { checkpoint = nil }
        height = ceil(y + 16) // 12pt bottom inset and 2pt outside each end of the surface.
    }
}

private final class TranscriptMessageSurface: NSView {
    var user = false
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        if user {
            NSColor.controlAccentColor.withAlphaComponent(0.10).setFill()
            NSBezierPath(roundedRect: bounds, xRadius: 12, yRadius: 12).fill()
        }
    }
}

final class TranscriptMessageCell: NSTableCellView {
    override var isFlipped: Bool { true }
    let row: TranscriptRow
    private let surface = TranscriptMessageSurface()
    private let title = NSTextField(wrappingLabelWithString: "")
    private let body = NSTextField(wrappingLabelWithString: "")
    private let evidence = NSTextField(wrappingLabelWithString: "")
    private let icon = NSImageView()
    private var disclosure: JourneyButton?
    private var checkpoint: JourneyButton?

    init(_ row: TranscriptRow, expanded: Bool, toggle: @escaping () -> Void, openCheckpoint: @escaping () -> Void) {
        self.row = row
        super.init(frame: .zero)
        surface.user = row.user; addSubview(surface)
        title.stringValue = row.title; title.font = .systemFont(ofSize: 12, weight: .semibold)
        title.textColor = row.activity ? .secondaryLabelColor : .labelColor
        body.stringValue = row.text; body.font = .systemFont(ofSize: row.activity ? 12 : 14)
        body.textColor = row.activity ? .secondaryLabelColor : .labelColor; body.isSelectable = true
        evidence.stringValue = row.evidence ?? ""; evidence.font = .systemFont(ofSize: 12); evidence.textColor = .secondaryLabelColor
        [title, body, evidence].forEach { surface.addSubview($0) }
        body.isHidden = row.text.isEmpty; evidence.isHidden = row.evidence == nil
        if row.activity {
            let button = JourneyButton("", symbol: expanded ? "chevron.down" : "chevron.right", action: toggle)
            button.isBordered = false; button.bezelStyle = .inline; button.imagePosition = .imageOnly
            button.setAccessibilityLabel("\(expanded ? "Collapse" : "Expand") \(row.title)")
            disclosure = button; surface.addSubview(button)
        } else {
            icon.image = NSImage(systemSymbolName: row.user ? "person.crop.circle.fill" : "sparkles", accessibilityDescription: nil)
            icon.contentTintColor = row.user ? .controlAccentColor : .secondaryLabelColor; surface.addSubview(icon)
        }
        if row.checkpoint != nil {
            let button = JourneyButton(row.automatic ? "Checkpoint before repair" : row.user ? "Checkpoint before message" : "Checkpoint after reply", symbol: "clock.arrow.circlepath", action: openCheckpoint)
            button.bezelStyle = .inline; button.controlSize = .small; button.toolTip = "Review and restore project files at this point"
            checkpoint = button; surface.addSubview(button)
        }
        setAccessibilityLabel(row.automatic ? "Automatic app repair" : row.user ? "Your message" : row.activity ? "LUMI activity" : "LUMI response")
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    override func setFrameSize(_ newSize: NSSize) { super.setFrameSize(newSize); needsLayout = true }
    override func layout() {
        super.layout()
        let geometry = TranscriptMessageLayout(row, availableWidth: bounds.width)
        surface.frame = NSRect(x: row.user ? bounds.width - 12 - geometry.width : 12, y: 2, width: geometry.width, height: geometry.height - 4)
        title.frame = geometry.title
        body.frame = geometry.body ?? .zero
        evidence.frame = geometry.evidence ?? .zero
        for field in [title, body, evidence] where !field.isHidden { field.preferredMaxLayoutWidth = field.frame.width }
        icon.frame = NSRect(x: 12, y: 14, width: 16, height: 16)
        disclosure?.frame = NSRect(x: 10, y: 12, width: 20, height: 20)
        if var frame = geometry.checkpoint, let checkpoint {
            frame.size.width = min(frame.width, checkpoint.intrinsicContentSize.width)
            checkpoint.frame = frame
        }
    }
    var contentFits: Bool {
        let fields = [title, body, evidence].filter { !$0.isHidden }
        return bounds.insetBy(dx: -1, dy: -1).contains(surface.frame) && fields.allSatisfy { surface.bounds.contains($0.frame) }
    }
    var layoutIssue: [String: Any]? {
        guard !contentFits else { return nil }
        return ["row": row.id, "cell": NSStringFromRect(bounds), "surface": NSStringFromRect(surface.frame),
            "labels": [title, body, evidence].filter { !$0.isHidden }.map { ["frame": NSStringFromRect($0.frame), "text": String($0.stringValue.prefix(80))] }]
    }
}
