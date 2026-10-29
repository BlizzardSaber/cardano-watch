import AppKit
import CoreGraphics
import Foundation

// 从桌面端 Cardano Sparrow 的 icns（或仓库内置的 1024px 快照）生成 iOS 图标三变体：
//   AppIcon-1024.png        亮色（原图，去 alpha）
//   AppIcon-Dark-1024.png   暗色（浅背景 → 深灰蓝，蓝色图案 → 亮蓝）
//   AppIcon-Tinted-1024.png 色调（灰度，iOS 18 系统上色）
//
// 用法：
//   swift scripts/generate-ios-icons.swift                    # 用内置 scripts/cardano-icon-1024.png
//   swift scripts/generate-ios-icons.swift /path/to/cardano.icns  # 从桌面端 icns 重新提取

let scriptDir = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
let outputDir = scriptDir.deletingLastPathComponent()
    .appendingPathComponent("ios/CardanoWatch/Assets.xcassets/AppIcon.appiconset", isDirectory: true)

func loadSource() throws -> CGImage {
    let input: URL
    if CommandLine.arguments.count > 1 {
        input = URL(fileURLWithPath: CommandLine.arguments[1])
    } else {
        input = scriptDir.appendingPathComponent("cardano-icon-1024.png")
    }
    if input.pathExtension.lowercased() == "icns" {
        // iconutil 提取 iconset，取最大尺寸 icon_512x512@2x.png（1024px）
        let temp = FileManager.default.temporaryDirectory
            .appendingPathComponent("cardano-icon-\(UUID().uuidString).iconset", isDirectory: true)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
        process.arguments = ["-c", "iconset", input.path, "-o", temp.path]
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0,
              let largest = try FileManager.default.contentsOfDirectory(at: temp, includingPropertiesForKeys: nil)
                .filter({ $0.pathExtension == "png" })
                .max(by: { lhs, rhs in
                    let l = (try? Data(contentsOf: lhs)).flatMap { NSBitmapImageRep(data: $0)?.pixelsWide } ?? 0
                    let r = (try? Data(contentsOf: rhs)).flatMap { NSBitmapImageRep(data: $0)?.pixelsWide } ?? 0
                    return l < r
                }) else {
            throw NSError(domain: "icons", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "icns 提取失败：\(input.path)"])
        }
        defer { try? FileManager.default.removeItem(at: temp) }
        return try loadImage(largest)
    }
    return try loadImage(input)
}

func loadImage(_ url: URL) throws -> CGImage {
    guard let data = try? Data(contentsOf: url),
          let image = NSBitmapImageRep(data: data)?.cgImage else {
        throw NSError(domain: "icons", code: 2,
                      userInfo: [NSLocalizedDescriptionKey: "无法读取图片：\(url.path)"])
    }
    return image
}

let source = try loadSource()
let width = 1024, height = 1024
let space = CGColorSpace(name: CGColorSpace.sRGB)!

// 统一缩放到 1024，读入像素缓冲
var pixels = [UInt8](repeating: 0, count: width * height * 4)
let ctx = CGContext(data: &pixels, width: width, height: height,
                    bitsPerComponent: 8, bytesPerRow: width * 4, space: space,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
ctx.interpolationQuality = .high
ctx.draw(source, in: CGRect(x: 0, y: 0, width: width, height: height))
// CGContext 坐标系原点在左下，写回时翻转让方向与原图一致
func flip(_ buffer: [UInt8]) -> [UInt8] {
    var out = buffer
    for row in 0..<height {
        let src = row * width * 4
        let dst = (height - 1 - row) * width * 4
        out.replaceSubrange(dst..<(dst + width * 4), with: buffer[src..<(src + width * 4)])
    }
    return out
}
pixels = flip(pixels)

let luma = { (r: Double, g: Double, b: Double) in 0.299 * r + 0.587 * g + 0.114 * b }

func writePng(_ name: String, transform: (Double, Double, Double) -> (Double, Double, Double)) throws {
    var out = [UInt8](repeating: 255, count: width * height * 4)
    for i in 0..<(width * height) {
        let r = Double(pixels[i * 4]), g = Double(pixels[i * 4 + 1]), b = Double(pixels[i * 4 + 2])
        let (tr, tg, tb) = transform(r, g, b)
        out[i * 4] = UInt8(max(0, min(255, tr.rounded())))
        out[i * 4 + 1] = UInt8(max(0, min(255, tg.rounded())))
        out[i * 4 + 2] = UInt8(max(0, min(255, tb.rounded())))
        out[i * 4 + 3] = 255  // iOS App 图标不允许透明通道
    }
    out = flip(out)
    let provider = CGDataProvider(data: Data(out) as CFData)!
    let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
                        bytesPerRow: width * 4, space: space,
                        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
                        provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
    let rep = NSBitmapImageRep(cgImage: image)
    let target = outputDir.appendingPathComponent(name)
    try rep.representation(using: .png, properties: [:])!.write(to: target)
    print("已生成 \(target.path)")
}

// 亮色：原图
try writePng("AppIcon-1024.png") { r, g, b in (r, g, b) }
// 暗色：浅背景 → 深灰蓝；蓝色图案 → 亮蓝；其余保留
try writePng("AppIcon-Dark-1024.png") { r, g, b in
    if luma(r, g, b) > 200 { return (22, 26, 38) }
    if b > r + 40 && b > 90 { return (96, 142, 255) }
    return (r, g, b)
}
// 色调：灰度
try writePng("AppIcon-Tinted-1024.png") { r, g, b in
    let l = luma(r, g, b)
    return (l, l, l)
}
