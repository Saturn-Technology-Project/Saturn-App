//! Line diffs for reviewing agent edits: Myers' algorithm, printed as a unified diff.

/// Above this many changed lines on both sides together, the file is shown as replaced instead of diffed line by line.
const MAX_LINES: usize = 40_000;
/// Myers' edit distance cap; past it the trace would cost too much memory.
const MAX_EDITS: usize = 4_000;

/// A file's diff and its counts.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DiffResult {
    pub diff: String,
    pub additions: usize,
    pub deletions: usize,
    pub binary: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
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

/// The shortest edit script from a to b (Myers 1986), with a whole-file replace when that gets too costly.
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

fn myers<'a>(a: &[Line<'a>], b: &[Line<'a>]) -> Vec<(Kind, Line<'a>)> {
    let (n, m) = (a.len() as i64, b.len() as i64);
    if n == 0 || m == 0 || a.len() + b.len() > MAX_LINES {
        return replaced(a, b);
    }
    let max = (n + m).min(MAX_EDITS as i64);
    let offset = max + 1;
    let slot = |k: i64| (offset + k) as usize;
    let mut v = vec![0_i64; (2 * max + 3) as usize];
    // trace[d] is v as it was before step d.
    let mut trace: Vec<Vec<i64>> = Vec::new();
    let mut found = false;
    let mut d = 0;
    while d <= max && !found {
        trace.push(v.clone());
        let mut k = -d;
        while k <= d {
            let mut x = if k == -d || (k != d && v[slot(k - 1)] < v[slot(k + 1)]) {
                v[slot(k + 1)]
            } else {
                v[slot(k - 1)] + 1
            };
            let mut y = x - k;
            while x < n && y < m && a[x as usize] == b[y as usize] {
                x += 1;
                y += 1;
            }
            v[slot(k)] = x;
            if x >= n && y >= m {
                found = true;
                break;
            }
            k += 2;
        }
        d += 1;
    }
    if !found {
        return replaced(a, b);
    }
    let mut ops = Vec::new();
    let (mut x, mut y) = (n, m);
    for d in (0..trace.len() as i64).rev() {
        let prev = &trace[d as usize];
        let k = x - y;
        let prev_k = if d == 0 {
            0
        } else if k == -d || (k != d && prev[slot(k - 1)] < prev[slot(k + 1)]) {
            k + 1
        } else {
            k - 1
        };
        let prev_x = if d == 0 { 0 } else { prev[slot(prev_k)] };
        let prev_y = prev_x - prev_k;
        // The snake: equal lines after the step's single edit.
        let start_x = if d == 0 {
            0
        } else if prev_k == k + 1 {
            prev_x
        } else {
            prev_x + 1
        };
        let start_y = start_x - k;
        while x > start_x && y > start_y {
            ops.push((Kind::Same, a[(x - 1) as usize]));
            x -= 1;
            y -= 1;
        }
        if d > 0 {
            if prev_k == k + 1 {
                ops.push((Kind::Added, b[(y - 1) as usize]));
            } else {
                ops.push((Kind::Removed, a[(x - 1) as usize]));
            }
        }
        x = prev_x;
        y = prev_y;
    }
    ops.reverse();
    ops
}
