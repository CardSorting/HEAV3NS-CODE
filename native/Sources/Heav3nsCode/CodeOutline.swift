import AppKit

struct CodeDeclaration: Equatable {
    let title: String
    let range: NSRange
}

/// A bounded lexical outline of the displayed page, never presented as a language-server index.
enum CodeOutline {
    static func declarations(in text: String, path: String) -> [CodeDeclaration] {
        let ext = (path as NSString).pathExtension.lowercased()
        let pattern: String
        switch ext {
        case "swift": pattern = #"(?m)^\s*(?:(?:public|private|fileprivate|internal|open|final|static|class|override|mutating|nonisolated|indirect)\s+)*(?:struct|class|enum|protocol|extension|actor|func)\s+([\w.]+)"#
        case "ts", "tsx", "js", "jsx": pattern = #"(?m)^\s*(?:(?:export|default|declare|abstract|async)\s+)*(?:class|interface|type|enum|function|const|let)\s+([\w$]+)"#
        case "py": pattern = #"(?m)^\s*(?:async\s+)?(?:class|def)\s+(\w+)"#
        case "rs": pattern = #"(?m)^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:struct|enum|trait|impl|fn)\s+(\w+)"#
        default: return []
        }
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        return regex.matches(in: text, range: NSRange(location: 0, length: (text as NSString).length)).prefix(100).map { match in
            CodeDeclaration(title: (text as NSString).substring(with: match.range).trimmingCharacters(in: .whitespacesAndNewlines), range: match.range(at: 1))
        }
    }
    static func highlight(_ text: String, diff: Bool) -> NSAttributedString {
        let result = NSMutableAttributedString(string: text, attributes: [.font: NSFont.monospacedSystemFont(ofSize: 12, weight: .regular), .foregroundColor: NSColor.labelColor])
        if !diff {
            let rules: [(String, NSColor)] = [
                (#"\b(?:import|from|class|struct|enum|protocol|func|function|async|await|return|let|var|const|if|else|guard|private|public|export|type|interface|def|self|nil|true|false)\b"#, .systemPurple),
                (#"\"(?:[^\"\\]|\\.)*\""#, .systemRed),
                (#"(?m)//[^\n]*"#, .secondaryLabelColor)
            ]
            for (pattern, color) in rules {
                guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
                for match in regex.matches(in: text, range: NSRange(location: 0, length: result.length)) {
                    result.addAttribute(.foregroundColor, value: color, range: match.range)
                }
            }
            return result
        }

        // Two-tier diff highlighting: line wash + intra-line word/token highlights
        let lines = text.components(separatedBy: "\n")
        var lineOffsets = [Int]()
        var currentOffset = 0
        for line in lines {
            lineOffsets.append(currentOffset)
            currentOffset += (line as NSString).length + 1
        }

        var i = 0
        while i < lines.count {
            let line = lines[i]
            let offset = lineOffsets[i]
            let lineRange = NSRange(location: offset, length: (line as NSString).length)

            if line.hasPrefix("@@") {
                result.addAttribute(.foregroundColor, value: NSColor.systemBlue, range: lineRange)
                result.addAttribute(.backgroundColor, value: NSColor.systemBlue.withAlphaComponent(0.08), range: lineRange)
                i += 1
            } else if line.hasPrefix("-") && !line.hasPrefix("---") {
                result.addAttribute(.foregroundColor, value: NSColor.systemRed, range: lineRange)
                result.addAttribute(.backgroundColor, value: NSColor.systemRed.withAlphaComponent(0.09), range: lineRange)
                // Check if followed by an added line for intra-line highlighting
                if i + 1 < lines.count && lines[i + 1].hasPrefix("+") && !lines[i + 1].hasPrefix("+++") {
                    let nextLine = lines[i + 1]
                    let nextOffset = lineOffsets[i + 1]
                    let nextLineRange = NSRange(location: nextOffset, length: (nextLine as NSString).length)
                    result.addAttribute(.foregroundColor, value: NSColor.systemGreen, range: nextLineRange)
                    result.addAttribute(.backgroundColor, value: NSColor.systemGreen.withAlphaComponent(0.09), range: nextLineRange)

                    let oldSlice = Array(line.dropFirst())
                    let newSlice = Array(nextLine.dropFirst())
                    var p = 0
                    while p < oldSlice.count && p < newSlice.count && oldSlice[p] == newSlice[p] { p += 1 }
                    var s = 0
                    while s < (oldSlice.count - p) && s < (newSlice.count - p) && oldSlice[oldSlice.count - 1 - s] == newSlice[newSlice.count - 1 - s] { s += 1 }

                    let oldChangeLen = oldSlice.count - p - s
                    if oldChangeLen > 0 {
                        let oldChangeRange = NSRange(location: offset + 1 + p, length: oldChangeLen)
                        result.addAttribute(.backgroundColor, value: NSColor.systemRed.withAlphaComponent(0.32), range: oldChangeRange)
                        result.addAttribute(.font, value: NSFont.monospacedSystemFont(ofSize: 12, weight: .semibold), range: oldChangeRange)
                    }
                    let newChangeLen = newSlice.count - p - s
                    if newChangeLen > 0 {
                        let newChangeRange = NSRange(location: nextOffset + 1 + p, length: newChangeLen)
                        result.addAttribute(.backgroundColor, value: NSColor.systemGreen.withAlphaComponent(0.35), range: newChangeRange)
                        result.addAttribute(.font, value: NSFont.monospacedSystemFont(ofSize: 12, weight: .semibold), range: newChangeRange)
                    }
                    i += 2
                } else {
                    i += 1
                }
            } else if line.hasPrefix("+") && !line.hasPrefix("+++") {
                result.addAttribute(.foregroundColor, value: NSColor.systemGreen, range: lineRange)
                result.addAttribute(.backgroundColor, value: NSColor.systemGreen.withAlphaComponent(0.09), range: lineRange)
                i += 1
            } else {
                i += 1
            }
        }
        return result
    }
}
