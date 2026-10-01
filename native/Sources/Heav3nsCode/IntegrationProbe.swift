import AppKit

/// Opt-in development harness. Uses the actual composer/bridge and never supplies
/// agent output. It is not a substitute for keyboard or accessibility testing.
final class IntegrationProbe {
    let destination: URL
    let instruction: String?
    let cancelAfter: Double?
    let perWorkspace: Bool
    let navigationPass: Bool
    let steps: [String]
    let draftRoot: URL?
    let podsPass: Bool
    let podsContainmentPass: Bool
    let launcherPass: Bool
    let projectPaths: [String]
    private let captureWalkthroughStages: Bool
    private var capturedStages = Set<String>()
    private var submitted = false
    private var finished = false
    init?() {
        let args = ProcessInfo.processInfo.arguments
        guard let index = args.firstIndex(of: "--integration-probe"), args.indices.contains(index + 1) else { return nil }
        let source = URL(fileURLWithPath: args[index + 1])
        guard let data = try? Data(contentsOf: source), let config = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let output = config["output"] as? String else { return nil }
        destination = URL(fileURLWithPath: output)
        instruction = config["instruction"] as? String
        cancelAfter = config["cancelAfter"] as? Double
        perWorkspace = config["perWorkspace"] as? Bool ?? false
        navigationPass = config["navigationPass"] as? Bool ?? false
        steps = config["steps"] as? [String] ?? ["files", "changes", "narrow", "dark", "palette"]
        draftRoot = (config["draftRoot"] as? String).map { URL(fileURLWithPath: $0, isDirectory: true) }
        podsPass = config["podsPass"] as? Bool ?? false
        podsContainmentPass = config["podsContainmentPass"] as? Bool ?? false
        launcherPass = config["launcherPass"] as? Bool ?? false
        projectPaths = config["projectPaths"] as? [String] ?? []
        captureWalkthroughStages = config["captureWalkthroughStages"] as? Bool ?? false
    }
    func capturePods(_ pods: PodsWindow, suffix: String) {
        guard let window = pods.window else { return }
        pods.refresh(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        window.contentView?.layoutSubtreeIfNeeded()
        // Let native post-layout reading anchors settle before recording the presented window.
        RunLoop.main.run(until: Date().addingTimeInterval(0.05)); window.displayIfNeeded()
        try? FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
        let capture = Process(); capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        capture.arguments = ["-x", "-o", "-l", String(window.windowNumber), destination.appendingPathComponent("\(suffix).png").path]
        try? capture.run(); capture.waitUntilExit()
        if let data = try? JSONSerialization.data(withJSONObject: pods.diagnostics) { try? data.write(to: destination.appendingPathComponent("\(suffix).json")) }
    }
    func connected(_ launcher: LauncherWindow) {
        func step(_ index: Int) {
            guard steps.indices.contains(index), let window = launcher.window else { return }
            launcher.navigateProbe(steps[index])
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
                window.contentView?.layoutSubtreeIfNeeded()
                try? FileManager.default.createDirectory(at: self.destination, withIntermediateDirectories: true)
                let capture = Process(); capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
                capture.arguments = ["-x", "-o", "-l", String(window.windowNumber), self.destination.appendingPathComponent("launcher-\(self.steps[index]).png").path]
                try? capture.run(); capture.waitUntilExit()
                let report: [String: Any] = ["appPID": ProcessInfo.processInfo.processIdentifier, "harness": "Native launcher with isolated project fixture; no authentication performed", "width": window.frame.width, "height": window.frame.height]
                if let data = try? JSONSerialization.data(withJSONObject: report) { try? data.write(to: self.destination.appendingPathComponent("launcher-\(self.steps[index]).json")) }
                step(index + 1)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { step(0) }
    }
    func connected(_ workspace: WorkspaceWindow) {
        if podsPass { return }
        guard !submitted else { return }; submitted = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self, weak workspace] in
            guard let self, let workspace else { return }
            self.capture(workspace, suffix: "initial")
            if let instruction = self.instruction { workspace.submitProbe(instruction) }
            if self.navigationPass { self.navigationStep(workspace, index: 0); return }
            if let delay = self.cancelAfter { DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak workspace] in workspace?.stop() } }
        }
    }
    func walkthroughChanged(_ workspace: WorkspaceWindow, stage: String) {
        guard captureWalkthroughStages, !stage.isEmpty, !capturedStages.contains(stage) else { return }
        capturedStages.insert(stage)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self, weak workspace] in
            guard let self, let workspace, workspace.walkthroughStage == stage else { return }
            let name = stage.lowercased().replacingOccurrences(of: " ", with: "-")
            self.capture(workspace, suffix: "stage-\(name)")
        }
    }
    func outcome(_ workspace: WorkspaceWindow, state: String) {
        guard !finished, !navigationPass, !podsPass else { return }; finished = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self, weak workspace] in
            guard let self, let workspace else { return }
            self.capture(workspace, suffix: "result", state: state)
            workspace.navigateProbe("narrow")
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self, weak workspace] in
                guard let workspace else { return }; self?.capture(workspace, suffix: "narrow", state: state)
            }
        }
    }
    private func navigationStep(_ workspace: WorkspaceWindow, index: Int) {
        guard steps.indices.contains(index) else { return }
        workspace.navigateProbe(steps[index])
        let delay = ["project-stop", "checkpoint-restore"].contains(steps[index]) ? 2.2 : 0.7
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self, weak workspace] in
            guard let self, let workspace else { return }
            self.capture(workspace, suffix: "ui-\(steps[index])")
            self.navigationStep(workspace, index: index + 1)
        }
    }
    private func capture(_ workspace: WorkspaceWindow, suffix: String, state: String? = nil) {
        guard let view = workspace.window?.contentView else { return }
        let destination = perWorkspace ? self.destination.appendingPathComponent(workspace.folder.lastPathComponent) : self.destination
        try? FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
        view.layoutSubtreeIfNeeded()
        // Capture must not manufacture the focus state a keyboard check asserts.
        let beforeCapture = workspace.probeLayout
        var ownedWindow = NSApp.keyWindow
        while let window = ownedWindow, window !== workspace.window {
            ownedWindow = window.sheetParent ?? window.parent
        }
        if ownedWindow !== workspace.window { workspace.window?.makeKeyAndOrderFront(nil) }
        NSApp.activate(ignoringOtherApps: true)
        // View caching omits layer-backed AppKit controls. Capture the owned
        // window, including native chrome, rather than treating that as evidence.
        let capture = Process()
        capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        capture.arguments = ["-x", "-o", "-l", String(workspace.window!.windowNumber), destination.appendingPathComponent("\(suffix).png").path]
        try? capture.run(); capture.waitUntilExit()
        // Popovers and editing sheets are separate native windows. Include them
        // in an opt-in visual pass so the new controls can actually be reviewed.
        for (index, window) in NSApp.windows.filter({ $0.isVisible && $0 !== workspace.window }).enumerated() {
            let overlay = Process(); overlay.executableURL = capture.executableURL
            overlay.arguments = ["-x", "-o", "-l", String(window.windowNumber), destination.appendingPathComponent("\(suffix)-overlay-\(index).png").path]
            try? overlay.run(); overlay.waitUntilExit()
        }
        var report: [String: Any] = ["appPID": ProcessInfo.processInfo.processIdentifier, "workspace": workspace.folder.path, "windowWidth": view.bounds.width, "windowHeight": view.bounds.height, "capturedAt": ISO8601DateFormatter().string(from: Date()), "harness": "native composer and configured stdio worker"]
        if let pid = workspace.client.pid { report["workerPID"] = pid }
        if let state { report["state"] = state }
        report["layout"] = workspace.probeLayout
        report["focusBeforeCapture"] = ["workspaceKey": beforeCapture["workspaceKey"] as? Bool ?? false, "composerFocused": beforeCapture["composerFocused"] as? Bool ?? false]
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) { try? data.write(to: destination.appendingPathComponent("\(suffix).json")) }
    }
}
