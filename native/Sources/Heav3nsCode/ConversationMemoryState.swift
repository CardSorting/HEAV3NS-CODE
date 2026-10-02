import Foundation

struct ConversationMemoryEntry: Equatable {
    let id: String
    let revision: String
    let key: String
    let category: String
    let preview: String
    let value: String
    let editable: Bool
    let updatedAt: Date?
    init?(_ data: [String: Any]) {
        guard let id = data["id"] as? String, id.count == 64,
              let revision = data["revision"] as? String, revision.count == 64,
              let key = data["key"] as? String, let category = data["category"] as? String else { return nil }
        self.id = id; self.revision = revision; self.key = String(key.prefix(160)); self.category = category
        preview = String((data["preview"] as? String ?? "").prefix(120))
        value = String((data["value"] as? String ?? "").prefix(8000)); editable = data["editable"] as? Bool == true
        if let time = data["updatedAt"] as? Double, time.isFinite, time >= 0, time <= 253402300799000 { updatedAt = Date(timeIntervalSince1970: time / 1000) }
        else { updatedAt = nil }
    }
}

/// A draft never becomes a write merely because a read, retry or reconnect completes.
final class ConversationMemoryState {
    typealias Request = (String, [String: Any], @escaping (Result<[String: Any], Error>) -> Void) -> Void
    let conversation: String
    private let request: Request
    private let available: () -> Bool
    private let writable: () -> Bool
    var onChange: (() -> Void)?
    private(set) var entries = [ConversationMemoryEntry]()
    private(set) var selected: ConversationMemoryEntry?
    private(set) var savedVersion: ConversationMemoryEntry?
    private(set) var conflict = false
    private(set) var key = "", value = "", category = "fact", query = ""
    private(set) var offset = 0, total = 0
    private(set) var more = false, limited = false, loading = false, saving = false, creating = false, uncertain = false
    private(set) var message = "Loading conversation memory…"
    private var generation = 0
    private var closed = false
    private var reading = false
    private var queuedRead: (String, [String: Any], (Result<[String: Any], Error>) -> Void)?
    var dirty: Bool { creating ? !key.isEmpty || !value.isEmpty : selected.map { key != $0.key || value != $0.value || category != $0.category } ?? false }
    var canNavigate: Bool { !closed && available() && !loading && !saving && !dirty && !uncertain }
    var canEdit: Bool { !closed && available() && writable() && !loading && !saving && !uncertain && (creating || selected?.editable == true) }
    var canSave: Bool { canEdit && dirty && !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && key.utf16.count <= 160 && value.utf16.count <= 8000 }
    var canRemove: Bool { canNavigate && writable() && selected != nil }
    var canReview: Bool { !closed && available() && !loading && !saving && conflict && selected != nil }
    var canUseSaved: Bool { !closed && available() && !loading && !saving && savedVersion != nil }
    var canKeepDraft: Bool { canUseSaved && writable() && uncertain && savedVersion?.editable == true && savedVersion?.key == key }
    init(conversation: String, request: @escaping Request, available: @escaping () -> Bool, writable: @escaping () -> Bool) {
        self.conversation = conversation; self.request = request; self.available = available; self.writable = writable
    }
    func syncAvailability() { onChange?() }
    func close() {
        closed = true; generation += 1; queuedRead = nil
        selected = nil; creating = false; uncertain = false; saving = false; key = ""; value = ""
        savedVersion = nil; conflict = false
    }
    private func read(_ method: String, _ params: [String: Any], _ completion: @escaping (Result<[String: Any], Error>) -> Void) {
        queuedRead = (method, params, completion); drainRead()
    }
    private func drainRead() {
        guard !closed, !reading, let (method, params, completion) = queuedRead else { return }
        queuedRead = nil; reading = true
        request(method, params) { [weak self] result in
            guard let self else { return }; self.reading = false
            completion(result); self.drainRead()
        }
    }
    func load(query: String? = nil, offset: Int = 0, selecting: String? = nil) {
        guard !closed, available(), !saving, !dirty, !uncertain else { return }
        if let query { self.query = query }
        generation += 1; let ticket = generation
        queuedRead = nil
        loading = true; selected = nil; creating = false; key = ""; value = ""; entries = []
        savedVersion = nil; conflict = false
        total = 0; self.offset = 0; more = false; limited = false
        guard self.query.utf16.count <= 200 else { loading = false; message = "Keep the search under 200 characters."; onChange?(); return }
        message = "Loading conversation memory…"; onChange?()
        var params: [String: Any] = ["conversation": conversation, "query": self.query, "offset": offset]
        if let selecting { params["anchor"] = selecting }
        read("memory.list", params) { [weak self] result in
            guard let self, !self.closed, ticket == self.generation else { return }
            self.loading = false
            switch result {
            case .success(let data):
                guard data["conversation"] as? String == self.conversation, self.available() else { self.message = "Conversation changed. Reopen memory from the selected conversation."; self.onChange?(); return }
                self.entries = (data["entries"] as? [[String: Any]] ?? []).prefix(50).compactMap(ConversationMemoryEntry.init)
                self.offset = data["offset"] as? Int ?? 0; self.total = data["total"] as? Int ?? 0
                self.more = data["more"] as? Bool == true; self.limited = data["limited"] as? Bool == true
                self.message = self.entries.isEmpty ? (self.query.isEmpty ? "No saved memory. Add a preference or fact for future instructions in this conversation." : "No matching memories. Try another search.") : "Select a memory to read or edit it."
                if let entry = self.entries.first(where: { $0.id == selecting }) ?? self.entries.first { self.select(entry.id) }
            case .failure(let error): self.message = error.localizedDescription
            }
            self.onChange?()
        }
    }
    func select(_ id: String) {
        guard canNavigate else { return }
        generation += 1; let ticket = generation
        loading = true; creating = false; selected = nil; key = ""; value = ""; message = "Loading memory…"; onChange?()
        savedVersion = nil; conflict = false
        read("memory.read", ["conversation": conversation, "id": id]) { [weak self] result in
            guard let self, !self.closed, ticket == self.generation else { return }
            self.loading = false
            switch result {
            case .success(let data):
                guard self.available(), data["conversation"] as? String == self.conversation,
                      let raw = data["entry"] as? [String: Any], raw["value"] is String, let entry = ConversationMemoryEntry(raw), entry.id == id else {
                    self.message = "Memory changed or became unavailable. Refresh to try again."; self.onChange?(); return
                }
                self.setEntry(entry)
                self.message = entry.editable ? "Changes apply to future instructions in this conversation." : "This entry can only be viewed here. Its format or size is outside the editor limits."
            case .failure(let error): self.message = error.localizedDescription
            }
            self.onChange?()
        }
    }
    private func setEntry(_ entry: ConversationMemoryEntry) {
        selected = entry; creating = false; key = entry.key; value = entry.value; category = entry.category
    }
    func newEntry() {
        guard canNavigate, writable() else { return }
        generation += 1; selected = nil; creating = true; key = ""; value = ""; category = "fact"
        savedVersion = nil; conflict = false
        message = "Give this memory a name and write what LUMI should remember."; onChange?()
    }
    func edit(key: String, value: String, category: String) {
        guard canEdit else { return }
        if creating { self.key = key }; self.value = value; self.category = category
        message = key.utf16.count > 160 || value.utf16.count > 8000 ? "Use up to 160 characters for the name and 8,000 for the memory." : "Save or discard changes before selecting another memory."
        onChange?()
    }
    func discard() {
        guard !saving else { return }
        let selecting = selected?.id
        uncertain = false; creating = false; selected = nil; key = ""; value = ""
        savedVersion = nil; conflict = false
        generation += 1; queuedRead = nil; loading = false
        load(query: query, offset: offset, selecting: selecting)
    }
    func refresh() { load(query: query, offset: offset, selecting: selected?.id) }
    /// Read the current saved record without throwing away or writing the local draft.
    func reviewSaved() {
        guard canReview, let selected else { return }
        generation += 1; let ticket = generation
        savedVersion = nil; loading = true; message = "Loading the saved version. Your draft stays here."; onChange?()
        read("memory.read", ["conversation": conversation, "id": selected.id]) { [weak self] result in
            guard let self, !self.closed, ticket == self.generation else { return }
            self.loading = false
            switch result {
            case .success(let data):
                guard self.available(), data["conversation"] as? String == self.conversation,
                      let raw = data["entry"] as? [String: Any], raw["value"] is String,
                      let latest = ConversationMemoryEntry(raw), latest.id == selected.id else {
                    self.message = "Could not verify the saved version. Your draft is preserved."; self.onChange?(); return
                }
                self.savedVersion = latest
                self.message = "Compare the saved version with your draft, then choose which version to keep. Nothing has been written."
            case .failure(let error): self.message = error.localizedDescription + " Your draft is preserved."
            }
            self.onChange?()
        }
    }
    func useSavedVersion() {
        guard canUseSaved, let latest = savedVersion else { return }
        entries = entries.map { $0.id == latest.id ? latest : $0 }
        setEntry(latest); uncertain = false; conflict = false; savedVersion = nil
        message = "Showing the saved version. No changes were written."; onChange?()
    }
    func keepDraft() {
        guard canKeepDraft, let latest = savedVersion else { return }
        entries = entries.map { $0.id == latest.id ? latest : $0 }
        selected = latest; uncertain = false; conflict = false
        message = "Your draft is ready to edit. Save Memory replaces the saved version shown below."; onChange?()
    }
    func save() {
        guard canSave else { return }
        var params: [String: Any] = ["conversation": conversation, "key": key, "value": value, "category": category]
        if let selected { params["id"] = selected.id; params["revision"] = selected.revision }
        mutate("memory.write", params)
    }
    func remove() {
        guard canRemove, let selected else { return }
        mutate("memory.remove", ["conversation": conversation, "id": selected.id, "revision": selected.revision])
    }
    private func mutate(_ method: String, _ params: [String: Any]) {
        generation += 1; let ticket = generation
        savedVersion = nil; conflict = false
        saving = true; message = method == "memory.remove" ? "Removing memory…" : "Saving memory…"; onChange?()
        request(method, params) { [weak self] result in
            guard let self, !self.closed, ticket == self.generation else { return }
            self.saving = false
            switch result {
            case .success(let data) where data["saved"] as? Bool == true && data["conversation"] as? String == self.conversation:
                let raw = data["entry"] as? [String: Any]
                let entry = raw.flatMap(ConversationMemoryEntry.init)
                let expectedKey = (params["key"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
                guard method == "memory.remove" || (raw?["value"] is String && entry != nil && entry?.key == expectedKey) else {
                    self.uncertain = true; self.message = "The saved entry could not be verified. Keep your draft, then discard and refresh to inspect it."; self.onChange?(); return
                }
                self.creating = false; self.selected = nil; self.key = ""; self.value = ""
                self.savedVersion = nil; self.conflict = false
                self.load(query: method == "memory.write" ? "" : self.query, selecting: entry?.id)
            case .success: self.uncertain = true; self.message = "The save was not confirmed. Keep your draft, then discard and refresh to inspect the saved state."
            case .failure(let error):
                let description = error.localizedDescription
                let editableFailure = ["MEMORY_EXISTS:", "MEMORY_LIMIT:", "WORK_PENDING:"].contains(where: description.contains)
                self.uncertain = !editableFailure
                self.conflict = description.contains("MEMORY_CHANGED:") && self.selected != nil
                self.savedVersion = nil
                self.message = self.conflict ? "This memory changed after you opened it. Your draft is preserved. Choose Compare Saved Version to review both versions." : description + (editableFailure ? " Your draft is preserved." : " Your draft is preserved. Discard and refresh before trying again.")
            }
            self.onChange?()
        }
    }
}
