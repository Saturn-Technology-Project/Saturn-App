use serde::Serialize;

use crate::js;

/// Closes a hunk that ends at the end of its file.
const END_OF_FILE: &str = "*** End of File";

/// Lines a patch expects in a file, and what it puts in their place.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Hunk {
    pub old: Vec<String>,
    pub next: Vec<String>,
}

/// One file's part of a patch.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum FileChange {
    Add {
        path: String,
        lines: Vec<String>,
    },
    Delete {
        path: String,
    },
    Update {
        path: String,
        #[serde(rename = "moveTo", skip_serializing_if = "Option::is_none")]
        move_to: Option<String>,
        hunks: Vec<Hunk>,
    },
}

/// The apply_patch document: Begin/End Patch, Add, Delete, Update, and Move.
pub fn parse_patch(raw: &str) -> Result<Vec<FileChange>, String> {
    let unified = raw.replace("\r\n", "\n");
    let body = unified.strip_suffix('\n').unwrap_or(&unified);
    let lines: Vec<&str> = body.split('\n').collect();
    if !lines[0].starts_with("*** Begin Patch") {
        return Err("Patch must start with *** Begin Patch".to_owned());
    }
    let line_at = |index: usize| lines.get(index).copied().unwrap_or_default();
    let mut changes = Vec::new();
    let mut index = 1;
    while index < lines.len() {
        let line = line_at(index);
        if js::trim(line) == "*** End Patch" {
            return Ok(changes);
        }
        if let Some(file) = line.strip_prefix("*** Add File: ") {
            index += 1;
            let mut added = Vec::new();
            while let Some(row) = lines.get(index).and_then(|row| row.strip_prefix('+')) {
                added.push(row.to_owned());
                index += 1;
            }
            changes.push(FileChange::Add {
                path: js::trim(file).to_owned(),
                lines: added,
            });
            continue;
        }
        if let Some(file) = line.strip_prefix("*** Delete File: ") {
            changes.push(FileChange::Delete {
                path: js::trim(file).to_owned(),
            });
            index += 1;
            continue;
        }
        if let Some(file) = line.strip_prefix("*** Update File: ") {
            let file = js::trim(file).to_owned();
            index += 1;
            let move_to = line_at(index)
                .strip_prefix("*** Move to: ")
                .map(|target| js::trim(target).to_owned());
            if move_to.is_some() {
                index += 1;
            }
            let mut hunks = Vec::new();
            while line_at(index).starts_with("@@") {
                index += 1;
                let mut old = Vec::new();
                let mut next = Vec::new();
                while index < lines.len() {
                    let row = line_at(index);
                    if row == END_OF_FILE {
                        index += 1;
                        break;
                    }
                    if row.starts_with("***") || row.starts_with("@@") {
                        break;
                    }
                    if row.is_empty() {
                        // A blank context line whose leading space was dropped (models often do).
                        old.push(String::new());
                        next.push(String::new());
                    } else if let Some(added) = row.strip_prefix('+') {
                        next.push(added.to_owned());
                    } else if let Some(removed) = row.strip_prefix('-') {
                        old.push(removed.to_owned());
                    } else if let Some(context) = row.strip_prefix(' ') {
                        old.push(context.to_owned());
                        next.push(context.to_owned());
                    } else {
                        return Err("A patch line must start with a space, + or -".to_owned());
                    }
                    index += 1;
                }
                hunks.push(Hunk { old, next });
            }
            if hunks.is_empty() && move_to.is_none() {
                return Err(format!("Update for {file} has no hunk"));
            }
            changes.push(FileChange::Update {
                path: file,
                move_to,
                hunks,
            });
            continue;
        }
        return Err(format!("Unknown patch line: {line}"));
    }
    // A patch complete but for its closing line: models often drop it, and nothing is ambiguous without it.
    if changes.is_empty() {
        return Err("Patch must end with *** End Patch".to_owned());
    }
    Ok(changes)
}

/// The file's text with the hunks applied in order.
pub fn apply_hunks(source: &str, hunks: &[Hunk]) -> Result<String, String> {
    let ended = source.ends_with('\n');
    let mut lines = split_lines(source);
    let mut cursor = 0;
    for hunk in hunks {
        if hunk.old.is_empty() {
            lines.splice(cursor..cursor, hunk.next.iter().cloned());
            cursor += hunk.next.len();
            continue;
        }
        let at = find_sequence(&lines, &hunk.old, cursor)
            .ok_or_else(|| "Patch context was not found".to_owned())?;
        lines.splice(at..at + hunk.old.len(), hunk.next.iter().cloned());
        cursor = at + hunk.next.len();
    }
    let mut text = lines.join("\n");
    if (ended || source.is_empty()) && !text.ends_with('\n') {
        text.push('\n');
    }
    Ok(text)
}

/// A file's lines, without the empty one after a final line break.
pub fn split_lines(content: &str) -> Vec<String> {
    let unified = content.replace("\r\n", "\n");
    let mut lines: Vec<String> = unified.split('\n').map(str::to_owned).collect();
    if content.ends_with('\n') {
        lines.pop();
    }
    lines
}

fn find_sequence(lines: &[String], needle: &[String], start: usize) -> Option<usize> {
    if start > lines.len() {
        return None;
    }
    lines[start..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|found| found + start)
}
