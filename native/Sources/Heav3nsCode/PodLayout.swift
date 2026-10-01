import AppKit

/// Tile geometry follows the usable board, including the user's scroller preference.
struct PodLayout {
    static let gap: CGFloat = 12
    static let minimumWidth: CGFloat = 360
    let columns: Int
    let height: CGFloat
    var compact: Bool { height < 380 }

    init(width: CGFloat, height: CGFloat) {
        columns = max(1, min(3, Int((max(0, width) + Self.gap) / (Self.minimumWidth + Self.gap))))
        self.height = min(400, max(300, height))
    }
}

/// Text grows vertically inside its own viewport, never into a neighboring tile.
enum PodTextViewport {
    static func configure(_ text: NSTextView, in scroll: NSScrollView) {
        text.isEditable = false; text.isSelectable = true; text.isRichText = false
        text.minSize = .zero
        text.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        text.isHorizontallyResizable = false; text.isVerticallyResizable = true
        text.autoresizingMask = [.width]
        text.textContainerInset = NSSize(width: 8, height: 6)
        text.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        text.textContainer?.widthTracksTextView = true
        text.textContainer?.heightTracksTextView = false
        let paragraph = NSMutableParagraphStyle(); paragraph.lineBreakMode = .byWordWrapping
        text.defaultParagraphStyle = paragraph
        scroll.documentView = text; scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = false; scroll.autohidesScrollers = true
        scroll.borderType = .bezelBorder; scroll.contentView.clipsToBounds = true
        scroll.setContentCompressionResistancePriority(.init(1), for: .horizontal)
    }
}
