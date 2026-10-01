import AppKit

/// Assets resolve identically in SwiftPM runs, tests, and the packaged application.
enum BrandAssets {
    static let appIcon: NSImage? = image("AppIcon", extension: "png")

    static let brandMarkTemplate: NSImage? = {
        let image = Self.image("BrandMarkTemplate", extension: "pdf")
        image?.isTemplate = true
        return image
    }()

    private static func image(_ name: String, extension suffix: String) -> NSImage? {
        // SwiftPM's generated accessor looks beside the executable or in the build
        // directory. Installed .app bundles keep nested resources in Contents/Resources.
        let resources: Bundle?
        if Bundle.main.bundleURL.pathExtension == "app" {
            resources = Bundle.main.url(forResource: "HEAV3NS-CODE_Heav3nsCode", withExtension: "bundle")
                .flatMap { Bundle(url: $0) }
        } else {
            resources = Bundle.module
        }
        guard let url = resources?.url(forResource: name, withExtension: suffix, subdirectory: "Brand") else { return nil }
        return NSImage(contentsOf: url)
    }
}
