import AppKit

// The generated master owns the dimensional icon. The companion geometry is
// deliberately flat for vector/template use. Run from the repository root.
let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let assets = root.appendingPathComponent("native/Assets")
let brand = root.appendingPathComponent("native/Sources/Heav3nsCode/Resources/Brand")
let iconset = assets.appendingPathComponent("AppIcon.iconset")
for directory in [assets, brand, iconset] {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
}
guard let master = NSImage(contentsOf: assets.appendingPathComponent("AppIcon-Master.png")), master.isValid else {
    fatalError("Missing or invalid native/Assets/AppIcon-Master.png")
}

// A three-lobed cloud with paired code apertures. SVG and AppKit share commands.
let commands: [(String, [CGFloat])] = [
    ("M", [31, 73]), ("L", [69, 73]), ("C", [81, 73, 86, 66, 86, 56]),
    ("C", [86, 45, 77, 37, 68, 40]), ("C", [66, 30, 59, 24, 50, 24]),
    ("C", [40, 24, 34, 30, 32, 40]), ("C", [22, 37, 14, 45, 14, 56]),
    ("C", [14, 66, 19, 73, 31, 73]), ("Z", []),
    ("M", [42, 45]), ("C", [43, 45, 44, 46, 44, 47]),
    ("C", [44, 48, 44, 48, 43, 49]), ("L", [35, 56]), ("L", [43, 63]),
    ("C", [45, 65, 42, 68, 40, 66]), ("L", [29, 58]),
    ("C", [28, 57, 28, 55, 29, 54]), ("L", [40, 46]),
    ("C", [41, 45, 41, 45, 42, 45]), ("Z", []),
    ("M", [58, 45]), ("C", [57, 45, 56, 46, 56, 47]),
    ("C", [56, 48, 56, 48, 57, 49]), ("L", [65, 56]), ("L", [57, 63]),
    ("C", [55, 65, 58, 68, 60, 66]), ("L", [71, 58]),
    ("C", [72, 57, 72, 55, 71, 54]), ("L", [60, 46]),
    ("C", [59, 45, 59, 45, 58, 45]), ("Z", [])
]
func markPath() -> NSBezierPath {
    let path = NSBezierPath(); path.windingRule = .evenOdd
    for (command, p) in commands {
        switch command {
        case "M": path.move(to: CGPoint(x: p[0], y: p[1]))
        case "L": path.line(to: CGPoint(x: p[0], y: p[1]))
        case "C": path.curve(to: CGPoint(x: p[4], y: p[5]),
                            controlPoint1: CGPoint(x: p[0], y: p[1]),
                            controlPoint2: CGPoint(x: p[2], y: p[3]))
        default: path.close()
        }
    }
    return path
}
func drawMark(in rect: CGRect, monochrome: Bool = false) {
    NSGraphicsContext.saveGraphicsState()
    let transform = NSAffineTransform()
    transform.translateX(by: rect.minX, yBy: rect.maxY)
    transform.scaleX(by: rect.width / 100, yBy: -rect.height / 100); transform.concat()
    (monochrome ? NSColor.black : NSColor(srgbRed: 40/255, green: 73/255, blue: 188/255, alpha: 1)).setFill()
    markPath().fill()
    NSGraphicsContext.restoreGraphicsState()
}
func drawIcon(size: CGFloat) {
    master.draw(in: CGRect(x: 0, y: 0, width: size, height: size), from: .zero, operation: .copy, fraction: 1)
}

// Preserve origin on every export, including subsequent regeneration.
func withOrigin(_ data: Data, _ origin: String) -> Data {
    let payload = Data(("impeccable:prompt\0" + origin).utf8)
    let type = Data("tEXt".utf8)
    var crc: UInt32 = 0xffffffff
    for byte in type + payload {
        crc ^= UInt32(byte)
        for _ in 0..<8 { crc = (crc >> 1) ^ (crc & 1 == 1 ? 0xedb88320 : 0) }
    }
    func bytes(_ value: UInt32) -> Data { var big = value.bigEndian; return Data(bytes: &big, count: 4) }
    let chunk = bytes(UInt32(payload.count)) + type + payload + bytes(crc ^ 0xffffffff)
    return data.dropLast(12) + chunk + data.suffix(12)
}
func png(size: Int, to url: URL, origin: String, draw: (CGFloat) -> Void) throws {
    guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
        let context = NSGraphicsContext(bitmapImageRep: bitmap) else { fatalError("Cannot create bitmap") }
    bitmap.size = NSSize(width: size, height: size)
    NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = context
    context.imageInterpolation = .high; context.shouldAntialias = true
    draw(CGFloat(size)); context.flushGraphics(); NSGraphicsContext.restoreGraphicsState()
    guard let data = bitmap.representation(using: .png, properties: [:]) else { fatalError("Cannot encode PNG") }
    try withOrigin(data, origin).write(to: url, options: .atomic)
}
let iconOrigin = "Origin: resized from native/Assets/AppIcon-Master.png, created with built-in image_gen. Exact prompt: native/Assets/provenance.json and the master's embedded impeccable:prompt. Exported with scripts/build-native-assets.swift; alpha preserved."
let vectorOrigin = "Origin: original flat cloud/code companion drawn by scripts/build-native-assets.swift from shared vector commands. Ultramarine #2849bc; no generative model used for this vector export."
for points in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let name = "icon_\(points)x\(points)\(scale == 2 ? "@2x" : "").png"
        try png(size: points * scale, to: iconset.appendingPathComponent(name), origin: iconOrigin, draw: drawIcon)
    }
}
try png(size: 1024, to: brand.appendingPathComponent("AppIcon.png"), origin: iconOrigin, draw: drawIcon)
try png(size: 512, to: assets.appendingPathComponent("BrandMark.png"), origin: vectorOrigin) { size in
    drawMark(in: CGRect(x: 0, y: 0, width: size, height: size))
}
final class TemplateView: NSView {
    override func draw(_ dirtyRect: NSRect) { drawMark(in: bounds, monochrome: true) }
}
let template = TemplateView(frame: CGRect(x: 0, y: 0, width: 100, height: 100))
try template.dataWithPDF(inside: template.bounds).write(to: brand.appendingPathComponent("BrandMarkTemplate.pdf"), options: .atomic)
let path = commands.map { command, values in command + values.map { String(Double($0)) }.joined(separator: " ") }.joined(separator: " ")
let markSVG = """
<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
  <title>HEAV3NS-CODE cloud and code mark</title>
  <path fill="#2849bc" fill-rule="evenodd" d="\(path)"/>
</svg>

"""
try markSVG.write(to: assets.appendingPathComponent("BrandMark.svg"), atomically: true, encoding: .utf8)
let iconSVG = """
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 100 100">
  <title>HEAV3NS-CODE flat app icon companion</title>
  <rect x="6" y="6" width="88" height="88" rx="20" fill="#2849bc"/>
  <path fill="#f7faff" fill-rule="evenodd" d="\(path)"/>
</svg>

"""
try iconSVG.write(to: assets.appendingPathComponent("AppIcon.svg"), atomically: true, encoding: .utf8)
let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
process.arguments = ["-c", "icns", iconset.path, "-o", assets.appendingPathComponent("AppIcon.icns").path]
try process.run(); process.waitUntilExit()
guard process.terminationStatus == 0 else {
    FileHandle.standardError.write(Data("iconutil failed; PNG, SVG, and PDF exports are complete. Check sandbox access for Apple's icon converter.\n".utf8))
    exit(1)
}
print("Built HEAV3NS-CODE cloud/code icon, ten native sizes, flat brand mark, and vector template.")
