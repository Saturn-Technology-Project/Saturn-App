//! Splits a source file into chunks worth embedding: one per top-level declaration (function, class, method, export…) where
//! the language has recognizable ones, else fixed windows of lines. Chunks carry the lines they cover, so a search hit can
//! point at the file and line.
use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;

/// A piece of a file, with the lines it covers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Chunk {
    pub start: usize,
    pub end: usize,
    pub text: String,
    pub name: Option<String>,
}

/// Longest chunk; declarations past this are split into windows.
const MAX_LINES: usize = 120;
/// Fallback window and its overlap.
const WINDOW: usize = 60;
const OVERLAP: usize = 10;
/// Files past this many lines are not indexed (generated code, bundles).
pub const MAX_FILE_LINES: usize = 20_000;

/// A line that opens a top-level (or one-indented) definition, by language. JavaScript's `\w` is ASCII, so it is spelled out.
static DECLARATION: LazyLock<HashMap<&'static str, Regex>> = LazyLock::new(|| {
    [
        ("ts", r"^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|namespace|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)"),
        ("js", r"^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)"),
        ("py", r"^(?:async\s+)?(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)"),
        ("go", r"^(?:func|type)\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)"),
        ("rs", r"^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|impl|mod|type|const|static)\s+([A-Za-z_][A-Za-z0-9_]*)"),
        ("java", r"^\s{0,4}(?:public|private|protected|static|final|abstract|synchronized|\s)*\s*(?:class|interface|enum|record|[A-Za-z0-9_<>\[\],\s]+?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(|\{|<)"),
        ("rb", r"^\s*(?:def|class|module)\s+([A-Za-z_][A-Za-z0-9_.?!]*)"),
        ("php", r"^\s*(?:abstract\s+|final\s+)?(?:public\s+|private\s+|protected\s+|static\s+)*(?:function|class|interface|trait)\s+([A-Za-z_][A-Za-z0-9_]*)"),
        ("swift", r"^\s*(?:public\s+|private\s+|internal\s+|open\s+|fileprivate\s+|static\s+|final\s+)*(?:func|class|struct|enum|protocol|extension)\s+([A-Za-z_][A-Za-z0-9_]*)"),
        ("kt", r"^\s*(?:public\s+|private\s+|internal\s+|open\s+|data\s+|sealed\s+|abstract\s+|suspend\s+)*(?:fun|class|object|interface)\s+([A-Za-z_][A-Za-z0-9_]*)"),
        ("cs", r"^\s{0,4}(?:public|private|protected|internal|static|abstract|sealed|virtual|override|async|\s)*\s*(?:class|interface|struct|enum|record|[A-Za-z0-9_<>\[\],\s]+?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(|\{|<)"),
        ("c", r"^(?:static\s+|inline\s+|extern\s+)*[A-Za-z0-9_*\s]+?\b([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*$"),
    ]
    .into_iter()
    .map(|(language, pattern)| (language, Regex::new(pattern).expect("a valid pattern")))
    .collect()
});

static COMMENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^\s*(//|/\*|\*|#|@|"""|''')"#).expect("a valid pattern"));

/// The language key for a file, if it has declarations to look for.
pub fn language_of(file: &str) -> Option<&'static str> {
    let extension = file.rsplit('.').next().unwrap_or(file).to_lowercase();
    Some(match extension.as_str() {
        "ts" | "tsx" | "mts" | "cts" => "ts",
        "js" | "jsx" | "mjs" | "cjs" => "js",
        "py" => "py",
        "go" => "go",
        "rs" => "rs",
        "java" => "java",
        "rb" => "rb",
        "php" => "php",
        "swift" => "swift",
        "kt" | "kts" => "kt",
        "cs" => "cs",
        "c" | "h" | "cc" | "cpp" | "hpp" | "m" | "mm" => "c",
        _ => return None,
    })
}

/// A file's chunks.
pub fn chunk_file(file: &str, content: &str) -> Vec<Chunk> {
    let lines: Vec<&str> = content.split('\n').collect();
    if lines.len() > MAX_FILE_LINES {
        return Vec::new();
    }
    let Some(pattern) = language_of(file).and_then(|language| DECLARATION.get(language)) else {
        return windows(&lines, 0, lines.len(), None);
    };
    // Declaration starts, then each chunk runs to the next start; a leading comment block stays with its declaration.
    let starts: Vec<(usize, &str)> = lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| {
            let found = pattern.captures(line)?;
            Some((index, found.get(1)?.as_str()))
        })
        .collect();
    if starts.len() < 2 {
        return windows(&lines, 0, lines.len(), None);
    }
    let mut chunks = Vec::new();
    let first = comment_above(&lines, starts[0].0);
    if first > 0 {
        chunks.extend(windows(&lines, 0, first, None));
    }
    for (index, (line, name)) in starts.iter().enumerate() {
        let start = comment_above(&lines, *line);
        let next = starts.get(index + 1).map_or(lines.len(), |(following, _)| {
            comment_above(&lines, *following)
        });
        let end = (start + 1).max(next);
        if end - start > MAX_LINES {
            chunks.extend(windows(&lines, start, end, Some(name)));
        } else {
            chunks.push(Chunk {
                start: start + 1,
                end,
                text: lines[start..end].join("\n"),
                name: Some((*name).to_owned()),
            });
        }
    }
    chunks.retain(|chunk| !chunk.text.trim().is_empty());
    chunks
}

/// Where the comment or decorators above a declaration begin, so they travel with it.
fn comment_above(lines: &[&str], line: usize) -> usize {
    let mut start = line;
    while start > 0 && COMMENT.is_match(lines[start - 1]) && !lines[start - 1].trim().is_empty() {
        start -= 1;
    }
    start
}

fn windows(lines: &[&str], from: usize, to: usize, name: Option<&str>) -> Vec<Chunk> {
    let mut chunks = Vec::new();
    let mut start = from;
    while start < to {
        let end = to.min(start + WINDOW);
        let text = lines[start..end].join("\n");
        if !text.trim().is_empty() {
            chunks.push(Chunk {
                start: start + 1,
                end,
                text,
                name: name.map(str::to_owned),
            });
        }
        if end >= to {
            break;
        }
        start += WINDOW - OVERLAP;
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    #[test]
    fn the_cases_the_typescript_runtime_answers_too() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../../contract/cases/chunks.json")).unwrap();
        assert!(cases.len() > 20);
        for case in &cases {
            let content = case["content"].as_str().map_or_else(
                || vec!["x"; case["repeat"].as_u64().unwrap() as usize].join("\n"),
                str::to_owned,
            );
            let file = case["file"].as_str().unwrap();
            let chunks: Vec<Value> = chunk_file(file, &content)
                .into_iter()
                .map(|chunk| {
                    let mut answer =
                        json!({ "start": chunk.start, "end": chunk.end, "text": chunk.text });
                    if let Some(name) = chunk.name {
                        answer["name"] = json!(name);
                    }
                    answer
                })
                .collect();
            assert_eq!(json!(chunks), case["chunks"], "{file}");
        }
    }
}
