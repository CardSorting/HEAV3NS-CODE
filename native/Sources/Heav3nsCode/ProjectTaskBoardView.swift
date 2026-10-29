import AppKit

private final class TaskBoardDocumentView: NSView {
    override var isFlipped: Bool { true }
}
private final class TaskBoardScrollView: NSScrollView {
    var onLayout: (() -> Void)?
    override func layout() { super.layout(); onLayout?() }
}
private final class TaskMovePopup: NSPopUpButton {
    var task: ProjectTask?
}

final class ProjectTaskBoardView: NSView, NSComboBoxDelegate {
    enum Mode { case list, board }
    var onMove: ((ProjectTask, String) -> Void)?
    var onFiltersChanged: (([ProjectTaskFilter]) -> Void)?
    var onPreviousPage: (() -> Void)?
    var onNextPage: ((Int) -> Void)?
    private var canMove = false
    private let filters = NSStackView()
    private let scroll = TaskBoardScrollView()
    private let document = TaskBoardDocumentView()
    private let content = NSStackView()
    private let notice = JourneyStyle.label("Loading project tasks…", size: 11, secondary: true)
    private lazy var previousPage = JourneyButton("Previous") { [weak self] in self?.onPreviousPage?() }
    private lazy var nextPage = JourneyButton("Next") { [weak self] in guard let self, let snapshot = self.snapshot else { return }; self.onNextPage?(snapshot.nextOffset) }
    private var pageRow: NSStackView!
    private var operators = [ProjectTaskFilter.Field: NSPopUpButton]()
    private var values = [ProjectTaskFilter.Field: NSComboBox]()
    private var snapshot: ProjectTaskSnapshot?
    private var mode: Mode = .list
    private var unavailable = "Loading project tasks…"
    private var documentHeight: CGFloat = 0

    override init(frame: NSRect) {
        super.init(frame: frame)
        translatesAutoresizingMaskIntoConstraints = false
        filters.orientation = .vertical; filters.alignment = .leading; filters.spacing = 4
        for field in ProjectTaskFilter.Field.allCases {
            let label = JourneyStyle.label(field.rawValue, size: 11, secondary: true)
            label.widthAnchor.constraint(equalToConstant: 42).isActive = true
            let op = NSPopUpButton(); op.addItems(withTitles: ProjectTaskFilter.Operator.allCases.map(\.rawValue)); op.controlSize = .small
            op.target = self; op.action = #selector(filterChanged); op.setAccessibilityLabel("\(field.rawValue) filter operator")
            let value = NSComboBox(); value.controlSize = .small; value.target = self; value.action = #selector(filterChanged); value.delegate = self
            value.placeholderString = "All"; value.completes = true
            value.setAccessibilityLabel("\(field.rawValue) filter value")
            operators[field] = op; values[field] = value
            let row = JourneyStyle.stack([label, op, value], vertical: false, spacing: 6)
            filters.addArrangedSubview(row); row.widthAnchor.constraint(equalTo: filters.widthAnchor).isActive = true
            value.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        }
        content.orientation = .vertical; content.alignment = .leading; content.spacing = 8
        content.translatesAutoresizingMaskIntoConstraints = false; document.addSubview(content)
        NSLayoutConstraint.activate([content.leadingAnchor.constraint(equalTo: document.leadingAnchor), content.topAnchor.constraint(equalTo: document.topAnchor)])
        scroll.documentView = document; scroll.hasVerticalScroller = true; scroll.hasHorizontalScroller = true; scroll.autohidesScrollers = true; scroll.drawsBackground = false
        scroll.onLayout = { [weak self] in self?.layoutDocument() }
        scroll.setAccessibilityLabel("Project tasks")
        previousPage.controlSize = .small; nextPage.controlSize = .small
        pageRow = JourneyStyle.stack([previousPage, nextPage], vertical: false, spacing: 8)
        let root = JourneyStyle.stack([filters, notice, pageRow, scroll], spacing: 8)
        addSubview(root); JourneyStyle.pin(root, to: self)
        for view in root.arrangedSubviews { view.widthAnchor.constraint(equalTo: root.widthAnchor).isActive = true }
        scroll.setContentHuggingPriority(.init(1), for: .vertical); scroll.setContentCompressionResistancePriority(.init(1), for: .vertical)
        rebuildFilters(); rebuild()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    func setMode(_ mode: Mode) { self.mode = mode; rebuild() }
    func setCanMove(_ enabled: Bool) { canMove = enabled; rebuild() }
    func showLoading() { notice.stringValue = "Loading project tasks…"; previousPage.isEnabled = false; nextPage.isEnabled = false }
    func show(_ snapshot: ProjectTaskSnapshot) { self.snapshot = snapshot; rebuildFilters(); rebuild() }
    func showUnavailable(_ message: String) { snapshot = nil; unavailable = message; rebuildFilters(); rebuild() }
    private func rebuildFilters() {
        let tasks = snapshot?.tasks ?? []
        for field in ProjectTaskFilter.Field.allCases {
            guard let popup = values[field] else { continue }
            let selected = popup.stringValue
            if let editor = popup.currentEditor(), window?.firstResponder === editor { continue }
            let options: [String]
            switch field {
            case .status: options = ["Triage", "Backlog", "Todo", "Ready", "In Progress", "Blocked", "Review", "Done", "Canceled", "Archived"]
            case .owner: options = Array(Set(tasks.map(\.owner).filter { !$0.isEmpty })).sorted()
            case .tag: options = Array(Set(tasks.flatMap(\.tags))).sorted()
            }
            popup.removeAllItems(); popup.addItems(withObjectValues: options); popup.stringValue = selected
            popup.isEnabled = true; operators[field]?.isEnabled = true
        }
    }
    private var selectedFilters: [ProjectTaskFilter] {
        ProjectTaskFilter.Field.allCases.compactMap { field in
            guard let value = values[field]?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty,
                  let title = operators[field]?.titleOfSelectedItem, let op = ProjectTaskFilter.Operator(rawValue: title) else { return nil }
            return ProjectTaskFilter(field: field, operation: op, value: value)
        }
    }
    @objc private func filterChanged() {
        NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(applyFilters), object: nil)
        applyFilters()
    }
    func controlTextDidChange(_ notification: Notification) {
        NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(applyFilters), object: nil)
        perform(#selector(applyFilters), with: nil, afterDelay: 0.25)
    }
    @objc private func applyFilters() {
        if let onFiltersChanged { onFiltersChanged(selectedFilters) } else { rebuild() }
    }
    private func rebuild() {
        content.arrangedSubviews.forEach { content.removeArrangedSubview($0); $0.removeFromSuperview() }
        guard let snapshot else { notice.stringValue = unavailable; pageRow.isHidden = true; documentHeight = 0; needsLayout = true; return }
        let filtered = onFiltersChanged == nil ? snapshot.tasks.filter { task in selectedFilters.allSatisfy { $0.matches(task) } } : snapshot.tasks
        let summary = snapshot.limited ? (snapshot.tasks.isEmpty ? "No tasks on this page." : "Tasks \(snapshot.offset + 1)–\(snapshot.nextOffset) of \(snapshot.total).") : filtered.isEmpty ? (selectedFilters.isEmpty ? "No project tasks yet." : "No tasks match these filters.") : "\(filtered.count) \(filtered.count == 1 ? "task" : "tasks")"
        notice.stringValue = mode == .board ? summary + " · Scroll horizontally for all columns" : summary
        notice.maximumNumberOfLines = 2; notice.lineBreakMode = .byWordWrapping
        pageRow.isHidden = !snapshot.limited
        previousPage.isEnabled = snapshot.offset > 0; nextPage.isEnabled = snapshot.nextOffset < snapshot.total
        if mode == .list {
            content.orientation = .vertical; content.alignment = .leading
            for task in filtered { content.addArrangedSubview(taskRow(task, width: 260)) }
        } else {
            content.orientation = .horizontal; content.alignment = .top
            for column in ProjectTaskColumn.allCases {
                let columnTasks = filtered.filter { $0.column == column }
                let heading = JourneyStyle.label("\(column.rawValue) · \(columnTasks.count)", size: 12, weight: .semibold)
                let columnView = JourneyStyle.stack([heading] + columnTasks.map { taskRow($0, width: 190) }, spacing: 7)
                columnView.widthAnchor.constraint(equalToConstant: 190).isActive = true
                content.addArrangedSubview(columnView)
            }
        }
        documentHeight = max(1, content.fittingSize.height)
        needsLayout = true
    }
    private func taskRow(_ task: ProjectTask, width: CGFloat) -> NSView {
        let title = JourneyStyle.label(task.title.isEmpty ? "Untitled task" : task.title, size: 12, weight: .medium)
        title.lineBreakMode = .byTruncatingTail; title.toolTip = task.title
        let details = ([task.statusLabel, task.owner] + task.tags).filter { !$0.isEmpty }.joined(separator: " · ")
        let subtitle = JourneyStyle.label(details, size: 11, secondary: true); subtitle.lineBreakMode = .byTruncatingTail; subtitle.toolTip = details
        var children: [NSView] = [title, subtitle]
        if onMove != nil {
            let move = TaskMovePopup(); move.task = task; move.controlSize = .small
            move.addItem(withTitle: "Move…")
            for (label, status) in [("Backlog", "backlog"), ("In Progress", "in_progress"), ("Review", "review"), ("Done", "done")] {
                move.addItem(withTitle: label); move.lastItem?.representedObject = status
                move.lastItem?.isEnabled = status != task.status
            }
            move.isEnabled = canMove; move.target = self; move.action = #selector(moveTask(_:))
            move.setAccessibilityLabel("Move \(task.title)"); move.toolTip = "Change the task status"
            children.append(move)
        }
        let row = JourneyStyle.stack(children, spacing: 2)
        row.widthAnchor.constraint(equalToConstant: width).isActive = true
        row.setAccessibilityLabel("\(task.title), \(details), \(task.boardTitle)")
        return row
    }
    @objc private func moveTask(_ sender: TaskMovePopup) {
        let status = sender.selectedItem?.representedObject as? String
        sender.selectItem(at: 0)
        if canMove, let task = sender.task, let status { onMove?(task, status) }
    }
    override func layout() {
        super.layout()
        layoutDocument()
    }
    private func layoutDocument() {
        let width = mode == .board ? CGFloat(ProjectTaskColumn.allCases.count * 190 + 3 * 8) : max(260, scroll.contentSize.width, scroll.bounds.width)
        let size = NSSize(width: width, height: max(scroll.contentSize.height, documentHeight))
        if document.frame.size != size { document.setFrameSize(size) }
    }
}
