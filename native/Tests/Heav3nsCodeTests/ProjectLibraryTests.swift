import AppKit
import XCTest
@testable import Heav3nsCode

final class ProjectLibraryTests: XCTestCase {
    private func directory() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }
    private func defaults() -> UserDefaults {
        let suite = "ProjectLibraryTests.\(UUID().uuidString)"
        addTeardownBlock { UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite) }
        return UserDefaults(suiteName: suite)!
    }
    private func views(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(views) }

    func testCreationIsExclusiveAndNeverChangesExistingContent() throws {
        let root = try directory()
        let created = try ProjectCreation.create(name: "My Project 🌤", in: root)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: created.path), [])
        let file = created.appendingPathComponent("keep.txt")
        try "Keep me".write(to: file, atomically: true, encoding: .utf8)
        XCTAssertThrowsError(try ProjectCreation.create(name: created.lastPathComponent, in: root))
        XCTAssertEqual(try String(contentsOf: file), "Keep me")
        let link = root.appendingPathComponent("alias")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: created)
        XCTAssertThrowsError(try ProjectCreation.create(name: "alias", in: root))
        for name in ["", ".", "..", "../escape", "/absolute", "with:colon", " trailing ", "line\nbreak", "nul\0byte"] {
            XCTAssertThrowsError(try ProjectCreation.create(name: name, in: root), name)
        }
        XCTAssertThrowsError(try ProjectCreation.create(name: "New", in: root.appendingPathComponent("missing")))
    }

    func testNestedEditsAreDetectedWithoutDependencyOrSymlinkChurn() throws {
        let root = try directory(), outside = try directory()
        let source = root.appendingPathComponent("src"), dependencies = root.appendingPathComponent("node_modules")
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: dependencies, withIntermediateDirectories: true)
        let edited = source.appendingPathComponent("main.swift"), noise = dependencies.appendingPathComponent("noise.js")
        try "source".write(to: edited, atomically: true, encoding: .utf8)
        try "noise".write(to: noise, atomically: true, encoding: .utf8)
        let runtime = root.appendingPathComponent(".broccolidb")
        try FileManager.default.createDirectory(at: runtime, withIntermediateDirectories: true)
        try "runtime churn".write(to: runtime.appendingPathComponent("state.db"), atomically: true, encoding: .utf8)
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("external"), withDestinationURL: outside)
        let old = Date(timeIntervalSince1970: 1_000), recent = Date(timeIntervalSince1970: 2_000)
        for url in [root, source] { try FileManager.default.setAttributes([.modificationDate: old], ofItemAtPath: url.path) }
        try FileManager.default.setAttributes([.modificationDate: recent], ofItemAtPath: edited.path)
        let activity = ProjectActivityReader.read(root)
        XCTAssertEqual(activity.modified?.timeIntervalSince1970, recent.timeIntervalSince1970)
        XCTAssertNotNil(activity.created); XCTAssertFalse(activity.incomplete)
        XCTAssertTrue(ProjectActivityReader.read(root, limit: 0).incomplete)
        XCTAssertTrue(ProjectActivityReader.read(root, cancelled: { true }).incomplete)
        XCTAssertNil(ProjectActivityReader.read(root.appendingPathComponent("missing")).modified)
    }

    func testSortsDuplicateNamesByActualDatesWithStableUnknownLastOrdering() throws {
        let defaults = defaults(), old = Date(timeIntervalSince1970: 1_000), recent = Date(timeIntervalSince1970: 2_000)
        let a = WorkspaceProject(path: "/one/Same", lastOpened: old, pinned: true)
        let b = WorkspaceProject(path: "/two/Same", lastOpened: recent, pinned: false)
        let missing = WorkspaceProject(path: "/three/Missing", lastOpened: old, pinned: false)
        defaults.set(try JSONEncoder().encode([a, missing, b]), forKey: "workspaceProjects.v1")
        let library = ProjectLibrary(defaults: defaults)
        let activity = [a.path: ProjectActivity(created: recent, modified: recent), b.path: ProjectActivity(created: old, modified: old)]
        XCTAssertEqual(library.matching("Same").map(\.path), [b.path, a.path])
        XCTAssertEqual(library.matching("", sort: .recentlyModified, activity: activity).map(\.path), [a.path, b.path, missing.path])
        XCTAssertEqual(library.matching("", sort: .newestCreated, activity: activity).map(\.path), [a.path, b.path, missing.path])
        XCTAssertEqual(library.matching("", sort: .oldestCreated, activity: activity).map(\.path), [b.path, a.path, missing.path])
        XCTAssertEqual(library.matching("Same", sort: .name).map(\.path), [a.path, b.path])
        XCTAssertEqual(library.matching("", pinnedOnly: true, sort: .recentlyModified, activity: activity), [a])
        XCTAssertEqual(library.matching("/two/", sort: .name), [b])
    }

    func testLibraryExposesCreationAndRemembersSortChoice() throws {
        _ = NSApplication.shared
        let defaults = defaults(); defaults.set(true, forKey: "journeyWelcomeCompleted")
        let launcher = LauncherWindow(library: ProjectLibrary(defaults: defaults), defaults: defaults)
        defer { launcher.window?.close() }
        var creates = 0; launcher.onCreateProject = { creates += 1 }
        let descendants = views(try XCTUnwrap(launcher.window?.contentView))
        let create = try XCTUnwrap(descendants.compactMap { $0 as? NSButton }.first { $0.title == "New Project…" })
        create.performClick(nil); XCTAssertEqual(creates, 1)
        let sort = try XCTUnwrap(descendants.compactMap { $0 as? NSPopUpButton }.first)
        sort.selectItem(withTitle: "Last modified"); sort.sendAction(sort.action, to: sort.target)
        XCTAssertEqual(defaults.string(forKey: "projectLibrary.sort"), ProjectSort.recentlyModified.rawValue)
        launcher.refresh()
        let restored = try XCTUnwrap(views(try XCTUnwrap(launcher.window?.contentView)).compactMap { $0 as? NSPopUpButton }.first)
        XCTAssertEqual(restored.titleOfSelectedItem, "Last modified")
    }

    func testCreationFormCreatesAndCancelDoesNotTouchDisk() throws {
        _ = NSApplication.shared
        let root = try directory()
        var created: URL?
        let form = NewProjectWindow(location: root) { created = $0 }
        let descendants = views(try XCTUnwrap(form.window?.contentView))
        let create = try XCTUnwrap(descendants.compactMap { $0 as? NSButton }.first { $0.title == "Create Project" })
        create.performClick(nil)
        XCTAssertEqual(created?.lastPathComponent, "Untitled Project")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), ["Untitled Project"])
        let cancelForm = NewProjectWindow(location: root) { _ in XCTFail("Cancelled creation must not open a project") }
        let cancel = try XCTUnwrap(views(try XCTUnwrap(cancelForm.window?.contentView)).compactMap { $0 as? NSButton }.first { $0.title == "Cancel" })
        cancel.performClick(nil)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), ["Untitled Project"])
    }

    func testClearingSearchRefreshesResultsThroughTheNativeSearchAction() throws {
        _ = NSApplication.shared
        let defaults = defaults(), library = ProjectLibrary(defaults: defaults)
        library.opened(try directory())
        let launcher = LauncherWindow(library: library, defaults: defaults)
        defer { launcher.window?.close() }
        let descendants = views(try XCTUnwrap(launcher.window?.contentView))
        let search = try XCTUnwrap(descendants.compactMap { $0 as? NSSearchField }.first)
        let table = try XCTUnwrap(descendants.compactMap { $0 as? NSTableView }.first)
        search.stringValue = "does-not-match-any-project"
        launcher.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: search))
        XCTAssertEqual(table.numberOfRows, 0)
        search.stringValue = ""
        XCTAssertNotNil(search.action)
        search.sendAction(search.action, to: search.target)
        XCTAssertEqual(table.numberOfRows, 1)
    }

    func testCancelledScanCannotPublishStaleDates() throws {
        let root = try directory()
        let callback = expectation(description: "cancelled scan is silent"); callback.isInverted = true
        let token = ProjectActivityReader.scan([WorkspaceProject(path: root.path, lastOpened: Date(), pinned: false)]) { _ in callback.fulfill() }
        token.cancel()
        wait(for: [callback], timeout: 0.1)
    }

    func testProjectPathUsesAvailableRowWidth() throws {
        _ = NSApplication.shared
        let defaults = defaults(), library = ProjectLibrary(defaults: defaults)
        library.opened(try directory())
        let launcher = LauncherWindow(library: library, defaults: defaults)
        defer { launcher.window?.close() }
        let table = try XCTUnwrap(views(try XCTUnwrap(launcher.window?.contentView)).compactMap { $0 as? NSTableView }.first)
        let row = try XCTUnwrap(launcher.tableView(table, viewFor: table.tableColumns.first, row: 0))
        row.frame = NSRect(x: 0, y: 0, width: 824, height: 96)
        row.layoutSubtreeIfNeeded()
        let labels = views(row).compactMap { $0 as? NSTextField }
        let path = try XCTUnwrap(labels.first { $0.stringValue == library.projects.first?.path })
        XCTAssertGreaterThan(path.frame.width, 700, "Folder paths should use the available row width before truncating")
    }

    func testRelocatingPreservesPinAndHistoryAndMergesAnExistingDestination() throws {
        let root = try directory(), moved = try directory(), defaults = defaults()
        let original = WorkspaceProject(path: root.path, lastOpened: Date(timeIntervalSince1970: 2_000), pinned: true)
        let destination = WorkspaceProject(path: moved.path, lastOpened: Date(timeIntervalSince1970: 3_000), pinned: false)
        defaults.set(try JSONEncoder().encode([original, destination]), forKey: "workspaceProjects.v1")
        let library = ProjectLibrary(defaults: defaults)
        let file = moved.appendingPathComponent("keep.txt"); try "unchanged".write(to: file, atomically: true, encoding: .utf8)
        XCTAssertThrowsError(try library.relocate(root.path, to: file))
        XCTAssertEqual(library.projects, [original, destination])
        let relocated = try library.relocate(root.path, to: moved)
        let saved = ProjectLibrary(defaults: defaults).projects
        XCTAssertEqual(saved.count, 1); XCTAssertEqual(saved.first?.path, relocated)
        XCTAssertEqual(saved.first?.lastOpened, destination.lastOpened); XCTAssertEqual(saved.first?.pinned, true)
        XCTAssertEqual(try String(contentsOf: file), "unchanged")
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.path))
    }

    func testSearchMatchesUnorderedPathTermsAndAccents() throws {
        let defaults = defaults()
        let projects = [WorkspaceProject(path: "/clients/Café/Website", lastOpened: Date(), pinned: false),
                        WorkspaceProject(path: "/personal/Website", lastOpened: Date(), pinned: false)]
        defaults.set(try JSONEncoder().encode(projects), forKey: "workspaceProjects.v1")
        let library = ProjectLibrary(defaults: defaults)
        XCTAssertEqual(library.matching("  website CAFE  "), [projects[0]])
        XCTAssertEqual(library.matching(" \n\t ").count, 2)
        XCTAssertTrue(library.matching("website missing").isEmpty)
    }

    func testReturnOpensFirstSearchMatchAndEscapeClearsSearch() throws {
        _ = NSApplication.shared
        let defaults = defaults(), library = ProjectLibrary(defaults: defaults), folder = try directory()
        library.opened(folder)
        let launcher = LauncherWindow(library: library, defaults: defaults)
        defer { launcher.window?.close() }
        let search = try XCTUnwrap(views(try XCTUnwrap(launcher.window?.contentView)).compactMap { $0 as? NSSearchField }.first)
        var opened: URL?; launcher.onOpenProject = { opened = $0 }
        search.stringValue = folder.lastPathComponent
        launcher.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: search))
        XCTAssertTrue(launcher.control(search, textView: NSTextView(), doCommandBy: #selector(NSResponder.insertNewline(_:))))
        XCTAssertEqual(opened?.path, folder.resolvingSymlinksInPath().path)
        XCTAssertTrue(launcher.control(search, textView: NSTextView(), doCommandBy: #selector(NSResponder.cancelOperation(_:))))
        XCTAssertEqual(search.stringValue, "")
    }

    func testProjectMenuKeepsItsTargetWhenSelectionChangesAndRemovalKeepsFiles() throws {
        _ = NSApplication.shared
        let defaults = defaults(), library = ProjectLibrary(defaults: defaults)
        let a = try directory(), b = try directory(); library.opened(a); library.opened(b)
        let launcher = LauncherWindow(library: library, defaults: defaults)
        defer { launcher.window?.close() }
        let project = try XCTUnwrap(library.projects.first { $0.path == a.resolvingSymlinksInPath().path })
        let menu = launcher.projectMenu(project)
        let table = try XCTUnwrap(views(try XCTUnwrap(launcher.window?.contentView)).compactMap { $0 as? NSTableView }.first)
        table.selectRowIndexes(IndexSet(integer: 0), byExtendingSelection: false)
        let pin = try XCTUnwrap(menu.items.first { $0.title == "Pin" })
        XCTAssertTrue(NSApp.sendAction(try XCTUnwrap(pin.action), to: pin.target, from: pin))
        XCTAssertEqual(library.matching("", pinnedOnly: true).map(\.path), [project.path])
        let remove = try XCTUnwrap(menu.items.first { $0.title == "Remove from List" })
        XCTAssertTrue(NSApp.sendAction(try XCTUnwrap(remove.action), to: remove.target, from: remove))
        XCTAssertEqual(library.projects.count, 1); XCTAssertTrue(FileManager.default.fileExists(atPath: a.path))
        let unavailable = launcher.projectMenu(WorkspaceProject(path: "/missing/Website", lastOpened: Date(), pinned: false))
        XCTAssertEqual(unavailable.items.first?.title, "Locate Folder…")
        XCTAssertEqual(unavailable.items.first { $0.title == "Show in Finder" }?.isEnabled, false)
    }

    func testCreationSuggestsAvailableNameAndRemembersOnlySuccessfulLocation() throws {
        _ = NSApplication.shared
        let root = try directory(), defaults = defaults()
        _ = try ProjectCreation.create(name: "Untitled Project", in: root)
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("Untitled Project 2"), withDestinationURL: root.appendingPathComponent("missing"))
        XCTAssertEqual(ProjectCreation.suggestedName(in: root), "Untitled Project 3")
        let form = NewProjectWindow(location: root, defaults: defaults) { _ in }
        let descendants = views(try XCTUnwrap(form.window?.contentView))
        let name = try XCTUnwrap(descendants.compactMap { $0 as? NSTextField }.first { $0.isEditable })
        let create = try XCTUnwrap(descendants.compactMap { $0 as? NSButton }.first { $0.title == "Create Project" })
        name.stringValue = "Untitled Project"; create.performClick(nil)
        XCTAssertEqual(name.stringValue, "Untitled Project"); XCTAssertNil(defaults.string(forKey: "projectCreation.location"))
        XCTAssertNotNil(descendants.compactMap { $0 as? NSTextField }.first { !$0.isHidden && $0.stringValue.contains("already exists") })
        name.stringValue = "New Folder"; create.performClick(nil)
        XCTAssertEqual(defaults.string(forKey: "projectCreation.location"), root.path)
        let next = NewProjectWindow(defaults: defaults) { _ in }
        XCTAssertNotNil(views(try XCTUnwrap(next.window?.contentView)).compactMap { $0 as? NSTextField }.first { $0.stringValue == root.path })
        next.window?.close()
    }
}
