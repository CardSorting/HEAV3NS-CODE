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
        let rules: [(String, NSColor)] = diff
            ? [(#"(?m)^\+[^\n]*"#, .systemGreen), (#"(?m)^-[^\n]*"#, .systemRed), (#"(?m)^@@[^\n]*"#, .systemBlue)]
            : [(#"\b(?:import|from|class|struct|enum|protocol|func|function|async|await|return|let|var|const|if|else|guard|private|public|export|type|interface|def|self|nil|true|false)\b"#, .systemPurple), (#"\"(?:[^\"\\]|\\.)*\""#, .systemRed), (#"(?m)//[^\n]*"#, .secondaryLabelColor)]
        for (pattern, color) in rules {
            guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
            for match in regex.matches(in: text, range: NSRange(location: 0, length: result.length)) { result.addAttribute(.foregroundColor, value: color, range: match.range) }
        }
        return result
    }
}
