// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "OrkestrMobileCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "OrkestrMobileCore", targets: ["OrkestrMobileCore"])],
    targets: [
        .target(name: "OrkestrMobileCore"),
        .testTarget(name: "OrkestrMobileCoreTests", dependencies: ["OrkestrMobileCore"]),
    ]
)
