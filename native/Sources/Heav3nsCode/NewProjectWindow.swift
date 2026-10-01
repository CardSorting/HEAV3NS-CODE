import AppKit
import Darwin

enum ProjectCreation {
    static func suggestedName(in parent: URL) -> String {
        for index in 1...100 {
            let candidate = index == 1 ? "Untitled Project" : "Untitled Project \(index)"
            let path = parent.appendingPathComponent(candidate).path
            if !FileManager.default.fileExists(atPath: path), (try? FileManager.default.destinationOfSymbolicLink(atPath: path)) == nil { return candidate }
        }
        return "Untitled Project \(UUID().uuidString.prefix(8))"
    }
    static func validName(_ name: String) -> Bool {
        !name.isEmpty && name == name.trimmingCharacters(in: .whitespacesAndNewlines)
            && name != "." && name != ".." && !name.contains(where: { "/:\0\n\r".contains($0) })
    }
    static func create(name: String, in parent: URL) throws -> URL {
        guard validName(name), parent.isFileURL else { throw CocoaError(.fileWriteInvalidFileName) }
        let folder = parent.resolvingSymlinksInPath().standardizedFileURL.appendingPathComponent(name, isDirectory: true)
        // mkdir is exclusive: an existing file, directory, or symlink is never reused.
        let failure = folder.withUnsafeFileSystemRepresentation { path -> Int32 in
            guard let path else { return EINVAL }
            return mkdir(path, 0o755) == 0 ? 0 : errno
        }
        guard failure == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(failure), userInfo: [NSFilePathErrorKey: folder.path]) }
        return folder
    }
}

final class NewProjectWindow: NSWindowController, NSTextFieldDelegate {
    private let name = NSTextField(string: "Untitled Project")
    private let locationLabel = JourneyStyle.label("", size: 12, secondary: true)
    private let errorLabel = JourneyStyle.label("", size: 12)
    private var location: URL
    private let defaults: UserDefaults?
    private var createButton: NSButton!
    private let onCreate: (URL) -> Void
    var onClose: (() -> Void)?

    init(location requestedLocation: URL? = nil, defaults: UserDefaults? = nil,
         onCreate: @escaping (URL) -> Void) {
        let fallback = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first ?? FileManager.default.homeDirectoryForCurrentUser
        let saved = defaults?.string(forKey: "projectCreation.location").map { URL(fileURLWithPath: $0) }
        let remembered = saved.flatMap { (try? $0.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true ? $0 : nil }
        let location = requestedLocation ?? remembered ?? fallback
        self.location = location; self.onCreate = onCreate; self.defaults = defaults
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 340), styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "New Project"; window.isReleasedWhenClosed = false
        super.init(window: window)
        name.delegate = self; name.placeholderString = "Project name"; name.setAccessibilityLabel("Project name")
        name.stringValue = ProjectCreation.suggestedName(in: location)
        locationLabel.maximumNumberOfLines = 1; locationLabel.lineBreakMode = .byTruncatingMiddle
        locationLabel.stringValue = location.path; locationLabel.toolTip = location.path
        locationLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let choose = JourneyButton("Choose…") { [weak self] in self?.chooseLocation() }
        let locationRow = JourneyStyle.stack([locationLabel, choose], vertical: false)
        locationLabel.setContentHuggingPriority(.init(1), for: .horizontal)
        createButton = JourneyButton("Create Project") { [weak self] in self?.create() }
        createButton.keyEquivalent = "\r"; createButton.bezelColor = .controlAccentColor
        let cancel = JourneyButton("Cancel") { [weak self] in self?.dismiss() }; cancel.keyEquivalent = "\u{1b}"
        let buttons = JourneyStyle.stack([NSView(), cancel, createButton], vertical: false)
        errorLabel.textColor = .systemRed; errorLabel.isHidden = true
        errorLabel.setAccessibilityLabel("Project creation error")
        let stack = JourneyStyle.stack([JourneyStyle.label("Create a project", size: 22, weight: .semibold),
            JourneyStyle.label("Choose a name and location. Your new folder opens ready for your first instruction.", size: 13, secondary: true),
            JourneyStyle.label("Project name", size: 12, weight: .medium), name,
            JourneyStyle.label("Location", size: 12, weight: .medium), locationRow, errorLabel, buttons], spacing: 10)
        let root = NSView(); root.addSubview(stack); JourneyStyle.pin(stack, to: root, inset: 24)
        for view in stack.arrangedSubviews { view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true }
        window.contentView = root
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    func present(on parent: NSWindow) {
        guard let window else { return }; parent.beginSheet(window)
        window.makeFirstResponder(name); name.selectText(nil)
    }
    func controlTextDidChange(_ obj: Notification) {
        let valid = ProjectCreation.validName(name.stringValue)
        createButton.isEnabled = valid
        errorLabel.stringValue = "Use a name other than . or .., without /, :, surrounding spaces, or line breaks."
        errorLabel.isHidden = valid || name.stringValue.isEmpty
    }
    private func chooseLocation() {
        guard let window else { return }
        let chooser = NSOpenPanel(); chooser.title = "Choose Project Location"; chooser.prompt = "Choose Location"
        chooser.canChooseFiles = false; chooser.canChooseDirectories = true; chooser.canCreateDirectories = true
        chooser.directoryURL = location
        chooser.beginSheetModal(for: window) { [weak self] response in
            guard let self, response == .OK, let url = chooser.url else { return }
            self.location = url; self.locationLabel.stringValue = url.path; self.locationLabel.toolTip = url.path
            self.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: self.name))
        }
    }
    private func create() {
        do {
            let url = try ProjectCreation.create(name: name.stringValue, in: location)
            defaults?.set(location.path, forKey: "projectCreation.location")
            dismiss(); onCreate(url)
        } catch {
            let error = error as NSError
            switch (error.domain, Int32(error.code)) {
            case (NSPOSIXErrorDomain, EEXIST): errorLabel.stringValue = "That name already exists here. Choose another name or location."
            case (NSPOSIXErrorDomain, EACCES), (NSPOSIXErrorDomain, EPERM), (NSPOSIXErrorDomain, EROFS): errorLabel.stringValue = "This location isn’t writable. Choose another location or update its permissions in Finder."
            case (NSPOSIXErrorDomain, ENOENT), (NSPOSIXErrorDomain, ENOTDIR): errorLabel.stringValue = "This location is no longer available. Choose another location."
            case (NSPOSIXErrorDomain, ENAMETOOLONG): errorLabel.stringValue = "This folder name or path is too long. Use a shorter name or another location."
            case (NSPOSIXErrorDomain, ENOSPC): errorLabel.stringValue = "This disk is full. Free some space or choose another disk."
            default: errorLabel.stringValue = "Couldn’t create the folder. Check its name and choose a writable location."
            }
            errorLabel.isHidden = false
            NSAccessibility.post(element: errorLabel, notification: .announcementRequested, userInfo: [.announcement: errorLabel.stringValue, .priority: NSAccessibilityPriorityLevel.high.rawValue])
        }
    }
    private func dismiss() { if let window { window.sheetParent?.endSheet(window); window.orderOut(nil) }; onClose?() }
}
