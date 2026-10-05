// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "HEAV3NS-CODE",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "HEAV3NS-CODE", targets: ["Heav3nsCode"])],
    dependencies: [
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.6.0")
    ],
    targets: [
        .executableTarget(
            name: "Heav3nsCode",
            dependencies: [
                .product(name: "Sparkle", package: "Sparkle")
            ],
            resources: [.copy("Resources/Brand")]
        ),
        .testTarget(name: "Heav3nsCodeTests", dependencies: ["Heav3nsCode"])
    ]
)

