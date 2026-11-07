//! The skills that ship with Saturn: how to use the research tools to carry out a study. They are read through `research_skill`,
//! so they reach every backend. A project's or the user's skill of the same name comes first. `docs/research-skills.md` lists
//! them for people.

/// Every skill, by name, in the order a study meets them.
const SKILLS: [(&str, &str); 67] = [
    (
        "research-autopilot",
        include_str!("skills/research-autopilot.md"),
    ),
    (
        "saturn-research-tools",
        include_str!("skills/saturn-research-tools.md"),
    ),
    (
        "modes-and-boundaries",
        include_str!("skills/modes-and-boundaries.md"),
    ),
    ("task-worktrees", include_str!("skills/task-worktrees.md")),
    ("starting-tasks", include_str!("skills/starting-tasks.md")),
    (
        "scoping-a-question",
        include_str!("skills/scoping-a-question.md"),
    ),
    (
        "literature-review",
        include_str!("skills/literature-review.md"),
    ),
    (
        "writing-hypotheses",
        include_str!("skills/writing-hypotheses.md"),
    ),
    ("study-design", include_str!("skills/study-design.md")),
    (
        "baselines-and-controls",
        include_str!("skills/baselines-and-controls.md"),
    ),
    (
        "environment-setup",
        include_str!("skills/environment-setup.md"),
    ),
    ("reproducibility", include_str!("skills/reproducibility.md")),
    ("compute-budget", include_str!("skills/compute-budget.md")),
    (
        "dataset-preparation",
        include_str!("skills/dataset-preparation.md"),
    ),
    (
        "data-leakage-audit",
        include_str!("skills/data-leakage-audit.md"),
    ),
    (
        "importing-results",
        include_str!("skills/importing-results.md"),
    ),
    (
        "tokenizer-and-format",
        include_str!("skills/tokenizer-and-format.md"),
    ),
    (
        "experiment-program",
        include_str!("skills/experiment-program.md"),
    ),
    ("evaluation-spec", include_str!("skills/evaluation-spec.md")),
    ("scorer-design", include_str!("skills/scorer-design.md")),
    ("freeze-and-run", include_str!("skills/freeze-and-run.md")),
    ("run-provenance", include_str!("skills/run-provenance.md")),
    ("run-failures", include_str!("skills/run-failures.md")),
    (
        "pause-and-resume",
        include_str!("skills/pause-and-resume.md"),
    ),
    ("remote-runs", include_str!("skills/remote-runs.md")),
    ("notebooks", include_str!("skills/notebooks.md")),
    (
        "training-smoke-test",
        include_str!("skills/training-smoke-test.md"),
    ),
    ("pretraining", include_str!("skills/pretraining.md")),
    ("fine-tuning", include_str!("skills/fine-tuning.md")),
    (
        "preference-training",
        include_str!("skills/preference-training.md"),
    ),
    (
        "training-debugging",
        include_str!("skills/training-debugging.md"),
    ),
    (
        "hyperparameter-search",
        include_str!("skills/hyperparameter-search.md"),
    ),
    (
        "checkpoints-and-lineage",
        include_str!("skills/checkpoints-and-lineage.md"),
    ),
    ("gpu-and-memory", include_str!("skills/gpu-and-memory.md")),
    (
        "statistics-for-comparisons",
        include_str!("skills/statistics-for-comparisons.md"),
    ),
    ("reading-samples", include_str!("skills/reading-samples.md")),
    (
        "counterexample-mining",
        include_str!("skills/counterexample-mining.md"),
    ),
    (
        "paired-comparisons",
        include_str!("skills/paired-comparisons.md"),
    ),
    (
        "comparing-across-lineage",
        include_str!("skills/comparing-across-lineage.md"),
    ),
    (
        "plots-and-analysis",
        include_str!("skills/plots-and-analysis.md"),
    ),
    (
        "analysis-outputs",
        include_str!("skills/analysis-outputs.md"),
    ),
    (
        "activation-reading",
        include_str!("skills/activation-reading.md"),
    ),
    (
        "inspection-sessions",
        include_str!("skills/inspection-sessions.md"),
    ),
    (
        "activation-patching",
        include_str!("skills/activation-patching.md"),
    ),
    ("layer-sweeps", include_str!("skills/layer-sweeps.md")),
    (
        "transformer-lens-probes",
        include_str!("skills/transformer-lens-probes.md"),
    ),
    (
        "sparse-autoencoders",
        include_str!("skills/sparse-autoencoders.md"),
    ),
    (
        "recording-findings",
        include_str!("skills/recording-findings.md"),
    ),
    ("study-report", include_str!("skills/study-report.md")),
    (
        "research-bundles",
        include_str!("skills/research-bundles.md"),
    ),
    ("handing-back", include_str!("skills/handing-back.md")),
    ("red-teaming", include_str!("skills/red-teaming.md")),
    (
        "safety-benchmarks",
        include_str!("skills/safety-benchmarks.md"),
    ),
    (
        "behavioral-evals",
        include_str!("skills/behavioral-evals.md"),
    ),
    ("agentic-evals", include_str!("skills/agentic-evals.md")),
    ("linear-probes", include_str!("skills/linear-probes.md")),
    (
        "steering-vectors",
        include_str!("skills/steering-vectors.md"),
    ),
    (
        "circuit-discovery",
        include_str!("skills/circuit-discovery.md"),
    ),
    ("tuned-lens", include_str!("skills/tuned-lens.md")),
    (
        "reward-models-and-rl",
        include_str!("skills/reward-models-and-rl.md"),
    ),
    (
        "ablation-studies",
        include_str!("skills/ablation-studies.md"),
    ),
    (
        "scaling-and-efficiency",
        include_str!("skills/scaling-and-efficiency.md"),
    ),
    ("model-cards", include_str!("skills/model-cards.md")),
    (
        "human-evaluation",
        include_str!("skills/human-evaluation.md"),
    ),
    (
        "replication-review",
        include_str!("skills/replication-review.md"),
    ),
    ("data-provenance", include_str!("skills/data-provenance.md")),
    ("paper-writing", include_str!("skills/paper-writing.md")),
];

/// Every bundled skill: its name and its whole file.
pub(super) fn bundled_skills() -> impl Iterator<Item = (&'static str, &'static str)> {
    SKILLS.into_iter()
}

/// A bundled skill by name, in any case: its whole file and its name as shipped.
pub(super) fn bundled_skill(name: &str) -> Option<(&'static str, &'static str)> {
    let wanted = name.strip_prefix('/').unwrap_or(name);
    SKILLS
        .iter()
        .find(|(skill, _)| skill.eq_ignore_ascii_case(wanted))
        .map(|(skill, file)| (*file, *skill))
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use saturn_domain::skill_files::{SKILL_LIMIT, parse_skill, valid_name};

    use super::*;

    #[test]
    fn every_file_in_the_folder_is_listed_and_every_skill_is_well_formed() {
        let folder = concat!(env!("CARGO_MANIFEST_DIR"), "/src/research/skills");
        let on_disk: HashSet<String> = std::fs::read_dir(folder)
            .unwrap()
            .map(|entry| {
                entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .trim_end_matches(".md")
                    .to_owned()
            })
            .collect();
        let listed: HashSet<String> = SKILLS.iter().map(|(name, _)| (*name).to_owned()).collect();
        assert_eq!(on_disk, listed);
        for (name, file) in SKILLS {
            let parsed = parse_skill(file, "fallback");
            assert_eq!(parsed.name, name, "the file's name is its skill's");
            assert!(valid_name(name), "{name}");
            assert!(!parsed.description.is_empty(), "{name} has no description");
            assert!(
                parsed.description.len() < 200,
                "{name}'s description is long"
            );
            assert!(
                parsed.body.len() < SKILL_LIMIT,
                "{name} is too long to hand over whole"
            );
        }
    }

    #[test]
    fn a_skill_only_points_at_skills_and_tools_that_exist() {
        let names: HashSet<&str> = SKILLS.iter().map(|(name, _)| *name).collect();
        let starts: HashSet<&str> = names
            .iter()
            .filter_map(|name| name.split('-').next())
            .collect();
        let servers: serde_json::Value =
            serde_json::from_str(include_str!("../builtin-servers.json")).unwrap();
        let tools: HashSet<&str> = servers
            .as_array()
            .unwrap()
            .iter()
            .filter(|server| server["id"] == "research")
            .flat_map(|server| server["tools"].as_array().unwrap())
            .map(|tool| tool["toolId"].as_str().unwrap())
            .collect();
        for (name, file) in SKILLS {
            // What is between backticks: a tool's name at the start of a call, or a skill's name on its own.
            for quoted in file
                .split("```")
                .step_by(2)
                .flat_map(|prose| prose.split('`').skip(1).step_by(2))
            {
                let first = quoted.split_whitespace().next().unwrap_or("");
                if first.starts_with("research_") {
                    assert!(tools.contains(first), "{name} names a tool called {quoted}");
                }
                let is_word = quoted.contains('-')
                    && quoted
                        .chars()
                        .all(|letter| letter.is_ascii_lowercase() || letter == '-');
                if is_word
                    && quoted
                        .split('-')
                        .next()
                        .is_some_and(|start| starts.contains(start))
                {
                    assert!(
                        names.contains(quoted),
                        "{name} points at a skill called {quoted}"
                    );
                }
            }
        }
    }

    #[test]
    fn the_list_for_people_names_every_skill() {
        let list = include_str!("../../../../docs/research-skills.md");
        for (name, _) in SKILLS {
            assert!(list.contains(&format!("`{name}`")), "{name}");
        }
    }

    #[test]
    fn the_first_skill_reaches_every_stage_of_a_study() {
        let (first, _) = bundled_skill("Research-Autopilot").unwrap();
        for stage in [
            "writing-hypotheses",
            "freeze-and-run",
            "pretraining",
            "reading-samples",
            "handing-back",
        ] {
            assert!(first.contains(stage), "{stage}");
        }
    }
}
