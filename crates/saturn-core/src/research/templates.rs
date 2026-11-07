//! The programs that ship with Saturn as starting points: a small SDK an experiment imports to write its records right,
//! and one runnable template per kind of study the skills teach. The assistant reads them through `research_template`
//! and writes a copy into the project with its file tools, so the program is the project's, frozen with its versions
//! and read by the evidence like any other. Nothing here runs inside Saturn.

use serde_json::{Value, json};

/// Every template: its name, the file as shipped, and the path a copy usually goes to in a project.
const TEMPLATES: [(&str, &str, &str); 9] = [
    (
        "saturn_run",
        include_str!("templates/saturn_run.py"),
        "saturn_run.py",
    ),
    (
        "eval_harness",
        include_str!("templates/eval_harness.py"),
        "scripts/eval_harness.py",
    ),
    (
        "red_team",
        include_str!("templates/red_team.py"),
        "scripts/red_team.py",
    ),
    (
        "trajectory",
        include_str!("templates/trajectory.py"),
        "scripts/trajectory.py",
    ),
    (
        "lean_check",
        include_str!("templates/lean_check.py"),
        "scripts/lean_check.py",
    ),
    (
        "probe_train",
        include_str!("templates/probe_train.py"),
        "scripts/probe_train.py",
    ),
    (
        "steering_sweep",
        include_str!("templates/steering_sweep.py"),
        "scripts/steering_sweep.py",
    ),
    (
        "train_loop",
        include_str!("templates/train_loop.py"),
        "scripts/train_loop.py",
    ),
    (
        "compile_paper",
        include_str!("templates/compile_paper.sh"),
        "scripts/compile_paper.sh",
    ),
];

/// A template's one-line description: the first line of a Python file's docstring, or the first comment after a
/// shell script's shebang.
pub(super) fn description(file: &str) -> String {
    let mut lines = file.lines();
    let Some(first) = lines.next() else {
        return String::new();
    };
    if first.starts_with("#!") {
        return lines
            .map(str::trim)
            .find(|line| line.starts_with('#'))
            .map(|line| line.trim_start_matches('#').trim().to_owned())
            .unwrap_or_default();
    }
    let opened = first.trim_start_matches("\"\"\"").trim();
    if !opened.is_empty() {
        return opened.trim_end_matches("\"\"\"").trim().to_owned();
    }
    lines
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .trim_end_matches("\"\"\"")
        .trim()
        .to_owned()
}

/// The language a template is in, by its path.
fn language(path: &str) -> &'static str {
    if path.ends_with(".sh") {
        "sh"
    } else {
        "python"
    }
}

/// The list of templates, or one whole, for `research_template`.
pub(super) fn answer(name: &str) -> Result<Value, String> {
    let wanted = name.trim().trim_end_matches(".py").trim_end_matches(".sh");
    if wanted.is_empty() {
        let templates: Vec<Value> = TEMPLATES
            .iter()
            .map(|(name, file, path)| {
                json!({ "name": name, "description": description(file), "language": language(path), "suggestedPath": path })
            })
            .collect();
        return Ok(json!({
            "templates": templates,
            "note": "Read one by name, write it into the project at its suggested path with your file tools, and change it where it says. Every Python template imports saturn_run.py from beside it, so copy that one too.",
        }));
    }
    TEMPLATES
        .iter()
        .find(|(name, _, _)| name.eq_ignore_ascii_case(wanted))
        .map(|(name, file, path)| {
            json!({ "name": name, "description": description(file), "language": language(path), "suggestedPath": path, "text": file })
        })
        .ok_or_else(|| {
            format!("No template named \"{name}\". Call research_template with no name to list them.")
        })
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[test]
    fn every_file_in_the_folder_is_listed_and_each_has_a_description() {
        let folder = concat!(env!("CARGO_MANIFEST_DIR"), "/src/research/templates");
        // Files only: a Python run beside the templates may leave a bytecode folder, which is not a template.
        let on_disk: HashSet<String> = std::fs::read_dir(folder)
            .unwrap()
            .map(Result::unwrap)
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
            .map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                name.trim_end_matches(".py")
                    .trim_end_matches(".sh")
                    .to_owned()
            })
            .collect();
        let listed: HashSet<String> = TEMPLATES
            .iter()
            .map(|(name, _, _)| (*name).to_owned())
            .collect();
        assert_eq!(on_disk, listed);
        for (name, file, path) in TEMPLATES {
            let said = description(file);
            assert!(!said.is_empty(), "{name} has no description line");
            assert!(said.len() < 200, "{name}'s description is long: {said}");
            assert!(
                path.ends_with(".py") || path.ends_with(".sh"),
                "{name}'s path"
            );
            assert!(!file.contains("TODO"), "{name} leaves a TODO");
            // Every Python template but the SDK imports the SDK.
            if path.ends_with(".py") && name != "saturn_run" {
                assert!(
                    file.contains("from saturn_run import Run"),
                    "{name} does not import saturn_run"
                );
            }
        }
    }

    #[test]
    fn a_template_is_read_by_name_in_any_case_and_the_list_names_them_all() {
        let listed = answer("").unwrap();
        assert_eq!(
            listed["templates"].as_array().unwrap().len(),
            TEMPLATES.len()
        );
        let one = answer("Saturn_Run.py").unwrap();
        assert_eq!(one["name"], "saturn_run");
        assert!(one["text"].as_str().unwrap().contains("class Run"));
        assert!(answer("nothing").is_err());
    }
}
