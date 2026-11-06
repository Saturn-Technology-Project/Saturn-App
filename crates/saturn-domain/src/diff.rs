//! Line diffs for reviewing agent edits: Myers' algorithm (from `similar`), printed as a unified diff.
use similar::{Algorithm, DiffOp, DiffTag, capture_diff_slices};

/// Above this many changed lines on both sides together, the file is shown as replaced instead of diffed line by line.
const MAX_LINES: usize = 40_000;
/// Past this many inserted and deleted lines together, the file is shown as replaced too.
const MAX_EDITS: usize = 4_000;

/// A file's diff and its counts.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DiffResult {
    pub diff: String,
    pub additions: usize,
    pub deletions: usize,
    pub binary: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct Line<'a> {
    text: &'a str,
    /// The line has no trailing newline (end of file).
    bare: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Same,
    Removed,
    Added,
}

/// Whether bytes look binary: a zero byte among the first 8000.
pub fn is_binary(bytes: Option<&[u8]>) -> bool {
    bytes.is_some_and(|bytes| bytes.iter().take(8000).any(|byte| *byte == 0))
}

/// A unified diff from `before` to `after`; `None` means the file did not exist on that side.
pub fn unified_diff(
    file: &str,
    before: Option<&[u8]>,
    after: Option<&[u8]>,
    context: usize,
) -> DiffResult {
    if is_binary(before) || is_binary(after) {
        let same = before.is_some() && before == after;
        return DiffResult {
            diff: if same {
                String::new()
            } else {
                format!("Binary file {file} changed\n")
            },
            binary: true,
            ..DiffResult::default()
        };
    }
    let before_text = before.map(String::from_utf8_lossy);
    let after_text = after.map(String::from_utf8_lossy);
    let a = lines_of(before_text.as_deref());
    let b = lines_of(after_text.as_deref());
    let mut rows = Vec::new();
    let (mut ai, mut bi) = (0, 0);
    for (kind, line) in diff_lines(&a, &b) {
        rows.push((kind, line, ai, bi));
        if kind != Kind::Added {
            ai += 1;
        }
        if kind != Kind::Removed {
            bi += 1;
        }
    }
    let additions = rows.iter().filter(|row| row.0 == Kind::Added).count();
    let deletions = rows.iter().filter(|row| row.0 == Kind::Removed).count();
    if additions == 0 && deletions == 0 {
        return DiffResult::default();
    }
    let mut diff = format!(
        "--- {}\n+++ {}\n",
        before.map_or("/dev/null".to_owned(), |_| format!("a/{file}")),
        after.map_or("/dev/null".to_owned(), |_| format!("b/{file}")),
    );
    let mut index = 0;
    while index < rows.len() {
        while index < rows.len() && rows[index].0 == Kind::Same {
            index += 1;
        }
        if index >= rows.len() {
            break;
        }
        let start = index.saturating_sub(context);
        let mut end = index;
        // Grow the hunk while the next change is within two context windows.
        loop {
            while end < rows.len() && rows[end].0 != Kind::Same {
                end += 1;
            }
            let mut next = end;
            while next < rows.len() && rows[next].0 == Kind::Same {
                next += 1;
            }
            if next < rows.len() && next - end <= context * 2 {
                end = next;
                continue;
            }
            end = rows.len().min(end + context);
            break;
        }
        let slice = &rows[start..end];
        let old_count = slice.iter().filter(|row| row.0 != Kind::Added).count();
        let new_count = slice.iter().filter(|row| row.0 != Kind::Removed).count();
        diff.push_str(&format!(
            "@@ -{} +{} @@\n",
            range(slice[0].2, old_count),
            range(slice[0].3, new_count)
        ));
        for (kind, line, _, _) in slice {
            diff.push(match kind {
                Kind::Same => ' ',
                Kind::Removed => '-',
                Kind::Added => '+',
            });
            diff.push_str(line.text);
            diff.push('\n');
            if line.bare {
                diff.push_str("\\ No newline at end of file\n");
            }
        }
        index = end;
    }
    DiffResult {
        diff,
        additions,
        deletions,
        binary: false,
    }
}

/// Unified diffs number from 1; an empty side names the line before it.
fn range(start: usize, count: usize) -> String {
    let first = if count == 0 { start } else { start + 1 };
    if count == 1 {
        first.to_string()
    } else {
        format!("{first},{count}")
    }
}

fn lines_of(text: Option<&str>) -> Vec<Line<'_>> {
    let Some(text) = text.filter(|text| !text.is_empty()) else {
        return Vec::new();
    };
    let newline = text.ends_with('\n');
    let body = if newline {
        &text[..text.len() - 1]
    } else {
        text
    };
    let mut parts: Vec<Line<'_>> = body
        .split('\n')
        .map(|part| Line {
            text: part,
            bare: false,
        })
        .collect();
    if !newline && let Some(last) = parts.last_mut() {
        last.bare = true;
    }
    parts
}

/// The shortest edit script from a to b, with a whole-file replace when that gets too costly.
fn diff_lines<'a>(a: &[Line<'a>], b: &[Line<'a>]) -> Vec<(Kind, Line<'a>)> {
    let mut prefix = 0;
    while prefix < a.len() && prefix < b.len() && a[prefix] == b[prefix] {
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix < a.len() - prefix
        && suffix < b.len() - prefix
        && a[a.len() - 1 - suffix] == b[b.len() - 1 - suffix]
    {
        suffix += 1;
    }
    let mut ops: Vec<(Kind, Line<'a>)> =
        a[..prefix].iter().map(|line| (Kind::Same, *line)).collect();
    ops.extend(myers(
        &a[prefix..a.len() - suffix],
        &b[prefix..b.len() - suffix],
    ));
    ops.extend(a[a.len() - suffix..].iter().map(|line| (Kind::Same, *line)));
    ops
}

fn replaced<'a>(a: &[Line<'a>], b: &[Line<'a>]) -> Vec<(Kind, Line<'a>)> {
    a.iter()
        .map(|line| (Kind::Removed, *line))
        .chain(b.iter().map(|line| (Kind::Added, *line)))
        .collect()
}

/// The shortest edit script between two runs of lines, from `similar`'s Myers; a whole-file replace when a side is empty or either
/// side is too long, or the script has more edits than `MAX_EDITS`.
fn myers<'a>(a: &[Line<'a>], b: &[Line<'a>]) -> Vec<(Kind, Line<'a>)> {
    if a.is_empty() || b.is_empty() || a.len() + b.len() > MAX_LINES {
        return replaced(a, b);
    }
    let script = capture_diff_slices(Algorithm::Myers, a, b);
    let edits: usize = script
        .iter()
        .map(|op| match op {
            DiffOp::Equal { .. } => 0,
            DiffOp::Delete { old_len, .. } => *old_len,
            DiffOp::Insert { new_len, .. } => *new_len,
            DiffOp::Replace {
                old_len, new_len, ..
            } => old_len + new_len,
        })
        .sum();
    if edits > MAX_EDITS {
        return replaced(a, b);
    }
    let mut ops = Vec::new();
    for op in script {
        let (old, new) = (op.old_range(), op.new_range());
        match op.tag() {
            DiffTag::Equal => ops.extend(a[old].iter().map(|line| (Kind::Same, *line))),
            DiffTag::Delete => ops.extend(a[old].iter().map(|line| (Kind::Removed, *line))),
            DiffTag::Insert => ops.extend(b[new].iter().map(|line| (Kind::Added, *line))),
            DiffTag::Replace => {
                ops.extend(a[old].iter().map(|line| (Kind::Removed, *line)));
                ops.extend(b[new].iter().map(|line| (Kind::Added, *line)));
            }
        }
    }
    ops
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_change_is_a_hunk_with_context_and_the_missing_newline_is_marked() {
        let result = unified_diff(
            "a.txt",
            Some(b"one\ntwo\nthree"),
            Some(b"one\n2\nthree\n"),
            1,
        );
        assert_eq!(
            result.diff,
            "--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n-three\n\\ No newline at end of file\n+2\n+three\n"
        );
        assert_eq!((result.additions, result.deletions), (2, 2));
    }

    #[test]
    fn too_many_edits_show_the_file_as_replaced() {
        let lines = |prefix: &str| -> Vec<u8> {
            (0..MAX_EDITS)
                .flat_map(|number| format!("{prefix}{number}\n").into_bytes())
                .collect()
        };
        let result = unified_diff("big.txt", Some(&lines("a")), Some(&lines("b")), 3);
        assert_eq!((result.additions, result.deletions), (MAX_EDITS, MAX_EDITS));
        assert!(
            result
                .diff
                .contains(&format!("@@ -1,{MAX_EDITS} +1,{MAX_EDITS} @@\n-a0\n-a1\n"))
        );
    }

    #[test]
    fn a_missing_side_is_all_added_or_all_removed() {
        let added = unified_diff("new.txt", None, Some(b"x\ny\n"), 3);
        assert_eq!(
            added.diff,
            "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+x\n+y\n"
        );
        let gone = unified_diff("old.txt", Some(b"x\n"), None, 3);
        assert_eq!(
            gone.diff,
            "--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n"
        );
    }
}
