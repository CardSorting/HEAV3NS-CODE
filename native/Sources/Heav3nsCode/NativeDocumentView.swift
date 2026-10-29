import AppKit
import PDFKit
import ImageIO

/// Native PDF and image preview; positions are presentation state only.
final class NativeDocumentView: NSView {
    var onChange: (() -> Void)?
    private let pdf = PDFView()
    private let imageScroll = NSScrollView()
    private let imageView = NSImageView()
    private let position = JourneyStyle.label("", size: 11, secondary: true)
    private let scale = JourneyStyle.label("", size: 11, secondary: true)
    private lazy var previous = JourneyButton("Previous") { [weak self] in self?.previousPage() }
    private lazy var next = JourneyButton("Next") { [weak self] in self?.nextPage() }
    private lazy var zoomOut = JourneyButton("−") { [weak self] in self?.changeZoom(1 / 1.2) }
    private lazy var zoomIn = JourneyButton("+") { [weak self] in self?.changeZoom(1.2) }
    private var observers = [NSObjectProtocol]()
    private var kind: WorkspaceViewport.Kind?
    private var restoring = false

    override init(frame: NSRect) {
        super.init(frame: frame)
        translatesAutoresizingMaskIntoConstraints = false
        [previous, next, zoomOut, zoomIn].forEach { $0.controlSize = .small }
        previous.setAccessibilityLabel("Previous PDF page"); next.setAccessibilityLabel("Next PDF page")
        zoomOut.setAccessibilityLabel("Zoom out"); zoomIn.setAccessibilityLabel("Zoom in")
        position.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let toolbar = JourneyStyle.stack([previous, position, next, NSView(), zoomOut, scale, zoomIn], vertical: false, spacing: 5)
        pdf.displayMode = .singlePageContinuous; pdf.displayDirection = .vertical
        pdf.autoScales = true; pdf.setAccessibilityLabel("PDF document")
        imageView.imageScaling = .scaleNone; imageView.setAccessibilityLabel("Image document")
        imageScroll.documentView = imageView; imageScroll.hasVerticalScroller = true; imageScroll.hasHorizontalScroller = true
        imageScroll.autohidesScrollers = true; imageScroll.allowsMagnification = true; imageScroll.minMagnification = 0.05; imageScroll.maxMagnification = 20
        imageScroll.contentView.postsBoundsChangedNotifications = true
        let root = JourneyStyle.stack([toolbar, pdf, imageScroll], spacing: 8)
        addSubview(root); JourneyStyle.pin(root, to: self)
        for view in root.arrangedSubviews { view.widthAnchor.constraint(equalTo: root.widthAnchor).isActive = true }
        for view in [pdf as NSView, imageScroll] { view.setContentHuggingPriority(.init(1), for: .vertical); view.setContentCompressionResistancePriority(.init(1), for: .vertical) }
        pdf.isHidden = true; imageScroll.isHidden = true
        let center = NotificationCenter.default
        for name in [Notification.Name.PDFViewPageChanged, .PDFViewScaleChanged] {
            observers.append(center.addObserver(forName: name, object: pdf, queue: .main) { [weak self] _ in self?.changed() })
        }
        observers.append(center.addObserver(forName: NSView.boundsDidChangeNotification, object: imageScroll.contentView, queue: .main) { [weak self] _ in self?.changed() })
        observers.append(center.addObserver(forName: NSScrollView.didEndLiveMagnifyNotification, object: imageScroll, queue: .main) { [weak self] _ in self?.changed() })
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) } }

    func open(_ data: Data, kind: WorkspaceViewport.Kind) throws {
        restoring = true
        defer { restoring = false }
        self.kind = kind
        switch kind {
        case .pdf:
            guard let document = PDFDocument(data: data), document.pageCount > 0 else { throw BridgeError.message("This PDF could not be opened.") }
            pdf.document = document; pdf.autoScales = true; pdf.isHidden = false; imageScroll.isHidden = true
            if let first = document.page(at: 0) { pdf.go(to: first) }
        case .image:
            guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                  let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                  let width = properties[kCGImagePropertyPixelWidth] as? Int, let height = properties[kCGImagePropertyPixelHeight] as? Int,
                  width > 0, height > 0, width <= 100_000, height <= 100_000, width <= 50_000_000 / height,
                  let image = NSImage(data: data), image.isValid, image.size.width.isFinite, image.size.height.isFinite,
                  image.size.width > 0, image.size.height > 0 else { throw BridgeError.message("This image could not be opened or is too large to preview.") }
            imageView.image = image; imageView.frame = NSRect(origin: .zero, size: image.size)
            imageScroll.magnification = 1; pdf.isHidden = true; imageScroll.isHidden = false
            imageScroll.contentView.scroll(to: .zero); imageScroll.reflectScrolledClipView(imageScroll.contentView)
        default: throw BridgeError.message("This document type cannot be previewed here.")
        }
        updateControls()
    }
    func restore(_ state: WorkspaceViewport?) {
        guard let state, state.kind == kind else { return }
        restoring = true
        defer { restoring = false; updateControls() }
        layoutSubtreeIfNeeded()
        if kind == .pdf, let document = pdf.document, let page = document.page(at: min(state.pdfPage, document.pageCount - 1)) {
            pdf.autoScales = false; pdf.scaleFactor = state.zoom; pdf.go(to: page)
        } else if kind == .image {
            imageScroll.magnification = state.zoom
            let clip = imageScroll.contentView
            let desired = NSRect(origin: NSPoint(x: state.scrollX, y: state.scrollY), size: clip.bounds.size)
            clip.scroll(to: clip.constrainBoundsRect(desired).origin); imageScroll.reflectScrolledClipView(clip)
        }
    }
    func capture(into state: inout WorkspaceViewport) {
        guard state.kind == kind else { return }
        if kind == .pdf, let document = pdf.document, let page = pdf.currentPage {
            state.pdfPage = document.index(for: page); state.zoom = min(20, max(0.05, pdf.scaleFactor))
        } else if kind == .image {
            state.zoom = min(20, max(0.05, imageScroll.magnification))
            state.scrollX = max(0, imageScroll.contentView.bounds.origin.x); state.scrollY = max(0, imageScroll.contentView.bounds.origin.y)
        }
    }
    private func changed() { guard !restoring else { return }; updateControls(); onChange?() }
    private func updateControls() {
        let isPDF = kind == .pdf
        previous.isHidden = !isPDF; next.isHidden = !isPDF; position.isHidden = !isPDF
        if isPDF, let document = pdf.document, let page = pdf.currentPage {
            let index = document.index(for: page)
            position.stringValue = "Page \(index + 1) of \(document.pageCount)"
            previous.isEnabled = index > 0; next.isEnabled = index + 1 < document.pageCount
        }
        let zoom = isPDF ? pdf.scaleFactor : imageScroll.magnification
        scale.stringValue = "\(Int((zoom * 100).rounded()))%"
    }
    private func previousPage() { if pdf.canGoToPreviousPage { pdf.goToPreviousPage(nil); changed() } }
    private func nextPage() { if pdf.canGoToNextPage { pdf.goToNextPage(nil); changed() } }
    private func changeZoom(_ factor: CGFloat) {
        if kind == .pdf { pdf.autoScales = false; pdf.scaleFactor = min(20, max(0.05, pdf.scaleFactor * factor)) }
        else if kind == .image { imageScroll.magnification = min(20, max(0.05, imageScroll.magnification * factor)) }
        changed()
    }
}
