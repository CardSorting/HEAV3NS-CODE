import XCTest
import AppKit
@testable import Heav3nsCode

final class JourneyTests: XCTestCase {
    func testAccountPipeCancelsBrowserFlowAndCanRestartWithoutOpeningABrowser() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        var repository = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { repository.deleteLastPathComponent() }
        let node = repository.appendingPathComponent("build/HEAV3NS-CODE.app/Contents/Resources/runtime/node")
        guard FileManager.default.isExecutableFile(atPath: node.path) else { throw XCTSkip("Build the desktop app first") }
        let peer = root.appendingPathComponent("account.cjs")
        try """
        let pending;
        const reply = (value) => process.stdout.write(JSON.stringify({v:1,...value})+'\\n');
        require('node:readline').createInterface({input:process.stdin}).on('line', line => {
          const r = JSON.parse(line);
          if (r.method === 'status') reply({id:r.id,result:{saved:false}});
          if (r.method === 'signIn') { pending=r.id; reply({event:'browser',url:'https://auth.openai.com/oauth/authorize?state=fixture'}); }
          if (r.method === 'cancel') { reply({id:r.id,result:{cancelling:true}}); reply({id:pending,error:'Sign-in cancelled.'}); }
        }).on('close',()=>process.exit(0));
        """.write(to: peer, atomically: true, encoding: .utf8)
        let client = AccountClient(node: node, cli: peer)
        defer { client.stop() }
        let cancelled = expectation(description: "cancel completes the original sign-in request")
        client.onBrowser = { url in XCTAssertEqual(url.host, "auth.openai.com"); client.request("cancel") { _ in } }
        client.request("signIn") { result in
            if case .failure(let error) = result { XCTAssertTrue(error.localizedDescription.contains("cancelled")) } else { XCTFail("Expected cancellation") }
            cancelled.fulfill()
        }
        wait(for: [cancelled], timeout: 3)
        client.stop()
        let restarted = expectation(description: "a new pipe can read status after cancellation")
        client.request("status") { result in
            if case .success(let status) = result { XCTAssertEqual(status["saved"] as? Bool, false) } else { XCTFail("Status failed") }
            restarted.fulfill()
        }
        wait(for: [restarted], timeout: 3)
    }
    func testProjectLibraryCanonicalizesPinsFiltersAndPersistsWithoutDeletingFolders() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let alias = root.appendingPathComponent("alias")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: root)
        let suite = "JourneyTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let library = ProjectLibrary(defaults: defaults)
        library.opened(root); library.opened(alias)
        XCTAssertEqual(library.projects.count, 1)
        let path = root.resolvingSymlinksInPath().path
        library.togglePin(path)
        XCTAssertEqual(ProjectLibrary(defaults: defaults).matching(root.lastPathComponent, pinnedOnly: true).count, 1)
        library.remove(path)
        XCTAssertTrue(library.projects.isEmpty)
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.path))
    }
    func testDraftsForOtherConversationsSurviveAnEmptyActiveDraftAndReopen() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = WorkspaceDraftStore(folder: root, root: root.appendingPathComponent("drafts"))
        try store.save(text: "", submission: nil, conversation: "second", conversations: ["first": "Keep this 🌱", "second": ""])
        let saved = try XCTUnwrap(store.load())
        XCTAssertEqual(saved.conversation, "second"); XCTAssertEqual(saved.conversations?["first"], "Keep this 🌱")
        XCTAssertEqual(saved.text, ""); XCTAssertNil(saved.submission)
    }
    func testAuthorizationBrowserRestrictsHostSchemeAndEndpoint() {
        XCTAssertNotNil(AccountClient.authorizationURL("https://auth.openai.com/oauth/authorize?state=fixture"))
        for url in ["http://auth.openai.com/oauth/authorize", "https://auth.openai.com.evil.test/oauth/authorize", "https://evil.test@auth.openai.com/oauth/authorize", "file:///etc/passwd", "https://auth.openai.com:1234/oauth/authorize", "https://auth.openai.com/logout"] {
            XCTAssertNil(AccountClient.authorizationURL(url), url)
        }
    }
    func testOutlineSelectsActualDeclarationRangesAndKeepsItsPageBoundary() {
        let source = "// struct Ignored {}\npublic final class WorkspaceWindow {\n    private func render() {}\n}\n"
        let declarations = CodeOutline.declarations(in: source, path: "WorkspaceWindow.swift")
        XCTAssertEqual(declarations.count, 2)
        XCTAssertEqual(declarations.map { (source as NSString).substring(with: $0.range) }, ["WorkspaceWindow", "render"])
        XCTAssertTrue(CodeOutline.declarations(in: source, path: "README.md").isEmpty)
    }
}
