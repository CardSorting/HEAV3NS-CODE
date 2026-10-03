import Foundation
import CoreFoundation
import Darwin

struct FrameParser {
    static let limit = 256 * 1024
    private var pending = Data()
    var bufferedBytes: Int { pending.count }

    /// Extract one encoded frame without expanding the rest of a burst into objects.
    mutating func nextFrame(in chunk: Data, offset: inout Data.Index) throws -> Data? {
        while offset < chunk.endIndex {
            let end = chunk[offset...].firstIndex(of: 10) ?? chunk.endIndex
            guard pending.count + end - offset <= Self.limit else { throw BridgeError.message("Runtime frame exceeds 256 KiB.") }
            pending.append(contentsOf: chunk[offset..<end])
            offset = end == chunk.endIndex ? end : end + 1
            if end < chunk.endIndex, !pending.isEmpty {
                let frame = pending; pending = Data()
                return frame
            }
        }
        return nil
    }
    static func decode(_ frame: Data) throws -> [String: Any] {
        guard String(data: frame, encoding: .utf8) != nil,
              let value = try JSONSerialization.jsonObject(with: frame) as? [String: Any],
              let version = value["v"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version == 1 else {
            throw BridgeError.message("Incompatible runtime protocol. Rebuild the app and CLI together.")
        }
        return value
    }
    mutating func append(_ chunk: Data) throws -> [[String: Any]] {
        var messages = [[String: Any]](), offset = chunk.startIndex
        while let frame = try nextFrame(in: chunk, offset: &offset) { messages.append(try Self.decode(frame)) }
        return messages
    }
    func finish() throws {
        if !pending.isEmpty { throw BridgeError.message("Runtime control channel ended with an incomplete frame. Last outcome unknown.") }
    }
}

/// A bounded mailbox of encoded bytes. Only one decoded batch may await the UI.
/// The lock covers framing and ownership, never JSON decoding or user callbacks.
final class ControlFrameInbox {
    static let byteLimit = 4 * 1024 * 1024
    static let chunkLimit = 1024
    static let batchLimit = 32
    static let batchBytes = 256 * 1024
    struct Batch { let frames: [Data]; let ended: Bool }
    private let lock = NSLock()
    private var chunks = [Data]()
    private var head = 0, offset = 0, queuedBytes = 0
    private var parser = FrameParser()
    private var draining = false, ended = false, stopped = false

    var pendingBytes: Int { lock.lock(); defer { lock.unlock() }; return queuedBytes + parser.bufferedBytes }
    var pendingChunks: Int { lock.lock(); defer { lock.unlock() }; return chunks.count - head }
    var isStopped: Bool { lock.lock(); defer { lock.unlock() }; return stopped }

    /// True transfers responsibility for starting the sole drain to the caller.
    func append(_ data: Data) throws -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard !stopped, !ended else { return false }
        if data.isEmpty { ended = true }
        else {
            guard queuedBytes + parser.bufferedBytes + data.count <= Self.byteLimit, chunks.count - head < Self.chunkLimit else {
                throw BridgeError.message("Output exceeded the display queue. LUMI is stopping; reconnect to inspect its recorded state.")
            }
            if chunks.count == head { offset = data.startIndex }
            chunks.append(data); queuedBytes += data.count
        }
        guard !draining else { return false }
        draining = true; return true
    }
    func takeBatch() throws -> Batch? {
        lock.lock(); defer { lock.unlock() }
        guard !stopped else { return nil }
        var frames = [Data](), consumed = 0, frameBytes = 0
        while head < chunks.count, frames.count < Self.batchLimit, consumed < Self.batchBytes, frameBytes < Self.batchBytes {
            let chunk = chunks[head], start = offset
            let frame = try parser.nextFrame(in: chunk, offset: &offset)
            let count = offset - start; queuedBytes -= count; consumed += count
            if let frame { frames.append(frame); frameBytes += frame.count }
            if offset == chunk.endIndex {
                chunks[head] = Data() // Release consumed storage before compacting the array.
                head += 1; offset = head < chunks.count ? chunks[head].startIndex : 0
            }
        }
        if head > 0 { chunks.removeFirst(head); head = 0 }
        let finished = ended && chunks.isEmpty
        if finished { try parser.finish() }
        if frames.isEmpty, chunks.isEmpty, !finished { draining = false; return nil }
        return Batch(frames: frames, ended: finished)
    }
    @discardableResult func stop() -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard !stopped else { return false }
        stopped = true; draining = false; chunks.removeAll(); parser = FrameParser()
        head = 0; offset = 0; queuedBytes = 0
        return true
    }
}

/// Background decoding yields after each small batch, so main-thread stalls cannot
/// multiply object graphs, dispatch closures, or autoreleased Foundation objects.
final class ControlFrameReader {
    let inbox = ControlFrameInbox()
    private let io = DispatchQueue(label: "io.heav3ns.desktop.frames", autoreleaseFrequency: .workItem)
    private let readLock = NSLock(), deliveryLock = NSLock()
    private var delivery: (messages: [[String: Any]], ended: Bool)?
    private let receive: ([[String: Any]]) -> Void
    private let failure: (String) -> Void
    init(receive: @escaping ([[String: Any]]) -> Void, failure: @escaping (String) -> Void) {
        self.receive = receive; self.failure = failure
    }
    func read(_ handle: FileHandle) {
        do {
            guard let data = try availableData(handle) else { return }
            if data.isEmpty { handle.readabilityHandler = nil }
            if try inbox.append(data) { scheduleDrain() }
        } catch {
            handle.readabilityHandler = nil
            fail(error.localizedDescription)
        }
    }
    private func availableData(_ handle: FileHandle) throws -> Data? {
        readLock.lock(); defer { readLock.unlock() }
        guard !inbox.isStopped else { return nil }
        // Foundation's read(upToCount:) waits to fill the requested length on a
        // pipe. One bounded read returns the bytes currently available instead.
        var data = Data(count: 64 * 1024), count: Int
        repeat { count = data.withUnsafeMutableBytes { Darwin.read(handle.fileDescriptor, $0.baseAddress, $0.count) } } while count < 0 && errno == EINTR
        guard count >= 0 else { throw BridgeError.message("Could not read LUMI's control channel. Reconnect to inspect its recorded state.") }
        // Copy only the bytes read; a small slice must not retain a 64 KiB buffer.
        return data.withUnsafeBytes { Data(bytes: $0.baseAddress!, count: count) }
    }
    private func scheduleDrain() { io.async { [weak self] in self?.drain() } }
    private func drain() {
        do {
            guard let batch = try inbox.takeBatch() else { return }
            let messages = try batch.frames.map(FrameParser.decode)
            deliveryLock.lock()
            if !inbox.isStopped { delivery = (messages, batch.ended) }
            deliveryLock.unlock()
            DispatchQueue.main.async { [weak self] in
                guard let self, !self.inbox.isStopped else { return }
                self.deliveryLock.lock()
                let delivery = self.delivery; self.delivery = nil
                self.deliveryLock.unlock()
                guard let delivery else { return }
                self.receive(delivery.messages)
                guard !self.inbox.isStopped else { return }
                if delivery.ended { self.fail("Disconnected · control channel closed. Last confirmed state is preserved.") }
                else { self.scheduleDrain() }
            }
        } catch { fail(error.localizedDescription) }
    }
    private func fail(_ message: String) {
        guard inbox.stop() else { return }
        deliveryLock.lock(); delivery = nil; deliveryLock.unlock()
        DispatchQueue.main.async { [weak self] in self?.failure(message) }
    }
    func stop() {
        readLock.lock(); inbox.stop(); readLock.unlock()
        deliveryLock.lock(); delivery = nil; deliveryLock.unlock()
    }
}
