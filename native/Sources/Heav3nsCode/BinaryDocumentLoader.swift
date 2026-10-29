import Foundation
import CoreFoundation

/// Retrieves a single revision in bounded pages; abandoned loads cannot publish.
final class BinaryDocumentLoader {
    typealias Request = ([String: Any], @escaping (Result<[String: Any], Error>) -> Void) -> Void
    static let sizeLimit = 64 * 1024 * 1024
    private let path: String
    private let request: Request
    private var bytes = Data()
    private var revision: String?
    private var expectedSize: Int?
    private var cancelled = false
    private var finished = false
    var onProgress: ((Int, Int) -> Void)?
    var onComplete: ((Result<Data, Error>) -> Void)?

    init(path: String, request: @escaping Request) { self.path = path; self.request = request }
    func start() { guard !finished, !cancelled, revision == nil else { return }; readNext() }
    func cancel() { cancelled = true; bytes.removeAll(); onComplete = nil; onProgress = nil }
    private func fail(_ message: String) {
        guard !cancelled, !finished else { return }
        finished = true; bytes.removeAll(); onComplete?(.failure(BridgeError.message(message)))
    }
    private func readNext() {
        guard !cancelled, !finished else { return }
        let offset = bytes.count
        var params: [String: Any] = ["path": path, "offset": offset]
        if let revision { params["revision"] = revision }
        request(params) { [weak self] result in
            guard let self, !self.cancelled, !self.finished else { return }
            switch result {
            case .failure(let error): self.fail(error.localizedDescription)
            case .success(let page):
                func integer(_ key: String) -> Int? {
                    guard let number = page[key] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), let value = page[key] as? Int, value >= 0 else { return nil }
                    return value
                }
                guard let encoded = page["data"] as? String, encoded.utf8.count <= 90_000, let data = Data(base64Encoded: encoded), data.count <= 65_536,
                      let size = integer("size"), size <= Self.sizeLimit, let start = integer("offset"), start == offset,
                      let end = integer("nextOffset"), end == start + data.count, end <= size,
                      let more = page["more"] as? Bool, more == (end < size), !more || !data.isEmpty,
                      let token = page["revision"] as? String, token.count == 64, token.allSatisfy({ $0.isHexDigit && $0.isASCII }),
                      self.revision == nil || self.revision == token, self.expectedSize == nil || self.expectedSize == size else {
                    self.fail("The document page could not be verified. Reload to try again."); return
                }
                self.revision = token; self.expectedSize = size; self.bytes.append(data); self.onProgress?(end, size)
                if more { self.readNext() }
                else { self.finished = true; let result = self.bytes; self.bytes.removeAll(); self.onComplete?(.success(result)) }
            }
        }
    }
}
