// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "HEAV3NS-CODE",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "HEAV3NS-CODE", targets: ["Heav3nsCode"])],
    targets: [
        .executableTarget(name: "Heav3nsCode", resources: [.copy("Resources/Brand")]),
        .testTarget(name: "Heav3nsCodeTests", dependencies: ["Heav3nsCode"])
    ]
)
