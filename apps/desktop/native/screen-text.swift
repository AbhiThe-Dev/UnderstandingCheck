// Reads text in screenshots with Apple's Vision framework, on this Mac. Used by the desktop app to
// find code names on a shared screen; images are passed in memory and never written to disk.
//
// Protocol: one JSON request per stdin line, {"id": "...", "png": "<base64>"}; one JSON reply per
// stdout line, {"id": "...", "lines": [{"text": "...", "confidence": 0.98}]} or {"id": "...", "error": "..."}.
// `--self-test` draws known code text into an image, reads it back, and exits 0 if both lines are found.

import CoreGraphics
import CoreText
import Foundation
import ImageIO
import Vision

struct Request: Decodable {
  let id: String
  let png: String
}

func recognize(_ image: CGImage) throws -> [[String: Any]] {
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  // Language correction "fixes" identifiers like approveApplication( into words; keep text as shown.
  request.usesLanguageCorrection = false
  try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
  return (request.results ?? []).compactMap { observation in
    guard let best = observation.topCandidates(1).first else { return nil }
    return ["text": best.string, "confidence": Double(best.confidence)]
  }
}

func decodeImage(_ data: Data) -> CGImage? {
  guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
  return CGImageSourceCreateImageAtIndex(source, 0, nil)
}

func emit(_ reply: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: reply) else { return }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0A]))
}

func selfTest() -> Int32 {
  let expected = ["approveApplication(", "src/applications/approve.ts:22"]
  let width = 1400, height = 260
  guard
    let ctx = CGContext(
      data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
  else { return 2 }
  ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
  ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
  let font = CTFontCreateWithName("Menlo" as CFString, 40, nil)
  for (i, text) in expected.enumerated() {
    let attributed = NSAttributedString(
      string: text,
      attributes: [
        NSAttributedString.Key(kCTFontAttributeName as String): font,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(red: 0, green: 0, blue: 0, alpha: 1),
      ])
    ctx.textPosition = CGPoint(x: 40, y: CGFloat(height - 90 - i * 100))
    CTLineDraw(CTLineCreateWithAttributedString(attributed), ctx)
  }
  guard let image = ctx.makeImage(), let lines = try? recognize(image) else { return 2 }
  let text = lines.compactMap { $0["text"] as? String }.joined(separator: "\n")
  print(text)
  return expected.allSatisfy { text.contains($0) } ? 0 : 1
}

if CommandLine.arguments.contains("--self-test") {
  exit(selfTest())
}

while let line = readLine(strippingNewline: true) {
  autoreleasepool {
    guard let data = line.data(using: .utf8), let request = try? JSONDecoder().decode(Request.self, from: data) else {
      emit(["id": "", "error": "bad request"])
      return
    }
    guard let png = Data(base64Encoded: request.png), let image = decodeImage(png) else {
      emit(["id": request.id, "error": "not an image"])
      return
    }
    do {
      emit(["id": request.id, "lines": try recognize(image)])
    } catch {
      emit(["id": request.id, "error": String(describing: error)])
    }
  }
}
