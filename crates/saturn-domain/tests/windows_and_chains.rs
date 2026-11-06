//! Rules that must hold whatever the command: Windows' destructive commands and the everyday ones that are not, file paths
//! outside the workspace, what an allow or deny rule covers on a shell line, and cutting at stop sequences.
use saturn_domain::Arguments;
use saturn_domain::completions::cut_at_stop;
use saturn_domain::permissions::{
    Effect, Layer, Rule, Scope, command_segments, resolve_permission,
};
use saturn_domain::policies::is_sensitive_operation;
use serde_json::json;

/// The arguments of a shell call.
fn shell(command: &str) -> Arguments {
    json!({ "command": command })
        .as_object()
        .expect("an object")
        .clone()
}

/// The arguments of a file write.
fn write_to(path: &str) -> Arguments {
    json!({ "action": "write", "path": path })
        .as_object()
        .expect("an object")
        .clone()
}

/// A small generator with no dependencies; the same cases on every run.
struct Numbers(u64);

impl Numbers {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 33
    }

    fn below(&mut self, limit: usize) -> usize {
        (self.next() % limit as u64) as usize
    }

    fn pick<'a>(&mut self, from: &[&'a str]) -> &'a str {
        from[self.below(from.len())]
    }
}

const PROGRAMS: [&str; 8] = [
    "git", "npm", "node", "cargo", "ls", "make", "python3", "rm-old",
];
const ARGUMENTS: [&str; 6] = ["status", "--all", "-x=1", "src/main.ts", "a_b", "./c.d"];
const SEPARATORS: [&str; 4] = [" && ", " || ", "; ", " | "];
const SCOPES: [Scope; 3] = [Scope::User, Scope::Project, Scope::Agent];
const EFFECTS: [Effect; 3] = [Effect::Allow, Effect::Ask, Effect::Deny];

fn rule(pattern: String, effect: Effect) -> Rule {
    Rule {
        tool: "code".to_owned(),
        pattern,
        effect,
    }
}

fn layer(scope: Scope, rules: Vec<Rule>) -> Layer {
    Layer {
        scope,
        rules,
        path: None,
    }
}

/// One command: a program and a few arguments.
fn command(numbers: &mut Numbers, program: &str) -> String {
    let mut parts = vec![program.to_owned()];
    for _ in 0..numbers.below(4) {
        parts.push(numbers.pick(&ARGUMENTS).to_owned());
    }
    parts.join(" ")
}

/// A shell line of one to four commands.
fn shell_line(numbers: &mut Numbers) -> String {
    let mut line = String::new();
    for index in 0..=numbers.below(4) {
        if index > 0 {
            line.push_str(numbers.pick(&SEPARATORS));
        }
        let program = numbers.pick(&PROGRAMS);
        line.push_str(&command(numbers, program));
    }
    line
}

/// Up to three layers of rules for the shell, each for every command or for one program.
fn some_layers(numbers: &mut Numbers) -> Vec<Layer> {
    (0..numbers.below(4))
        .map(|_| {
            let rules = (0..numbers.below(6))
                .map(|_| {
                    let pattern = if numbers.below(3) == 0 {
                        "*".to_owned()
                    } else {
                        format!("{} *", numbers.pick(&PROGRAMS))
                    };
                    rule(pattern, EFFECTS[numbers.below(EFFECTS.len())])
                })
                .collect();
            layer(SCOPES[numbers.below(SCOPES.len())], rules)
        })
        .collect()
}

#[test]
fn windows_destructive_commands_need_approval() {
    for command in [
        "del /s /q C:\\work\\build",
        "DEL /Q *.log",
        "erase /s old",
        "rd /s /q node_modules",
        "rmdir /S dist",
        "Remove-Item -Recurse -Force .\\out",
        "ri .\\out -r",
        "rm dist -Recurse",
        "format D:",
        "Format-Volume -DriveLetter D",
        "diskpart /s wipe.txt",
        "Clear-Disk -Number 1 -RemoveData",
        "reg delete HKCU\\Software\\Saturn /f",
        "reg.exe add HKLM\\Software\\X /v Y /d 1",
        "Remove-Item HKCU:\\Software\\Saturn",
        "Stop-Process -Name node -Force",
        "taskkill /f /im node.exe",
        "shutdown /s /t 0",
        "vssadmin delete shadows /all",
        "Set-ExecutionPolicy Unrestricted",
        "Start-Process powershell -Verb RunAs",
    ] {
        assert!(is_sensitive_operation("code", &shell(command)), "{command}");
    }
}

#[test]
fn everyday_windows_commands_run_without_approval() {
    for command in [
        "dir /s",
        "del notes.txt",
        "Remove-Item notes.txt",
        "Get-ChildItem -Recurse",
        "git status",
        "node --version",
        "python -m pytest",
        "reg query HKCU\\Software",
        "echo \"hello world\"",
    ] {
        assert!(
            !is_sensitive_operation("code", &shell(command)),
            "{command}"
        );
    }
}

#[test]
fn unix_commands_are_judged_the_same() {
    assert!(is_sensitive_operation("code", &shell("rm -rf build")));
    assert!(is_sensitive_operation("code", &shell("sudo ls")));
    assert!(!is_sensitive_operation("code", &shell("ls -la")));
}

#[test]
fn file_paths_outside_the_workspace_include_windows_absolute_ones() {
    for path in [
        "C:\\Windows\\win.ini",
        "c:/temp/x",
        "\\\\server\\share\\x",
        "/etc/hosts",
        "../outside.txt",
    ] {
        assert!(is_sensitive_operation("files", &write_to(path)), "{path}");
    }
    assert!(!is_sensitive_operation("files", &write_to("notes/a.md")));
}

#[test]
fn a_deny_rule_for_every_command_beats_any_other_rules_whatever_the_shell_line() {
    let mut numbers = Numbers(1);
    for _ in 0..1000 {
        let mut layers = some_layers(&mut numbers);
        layers.push(layer(Scope::User, vec![rule("*".to_owned(), Effect::Deny)]));
        let line = shell_line(&mut numbers);
        let decision = resolve_permission(&layers, "code", &shell(&line)).expect("a decision");
        assert_eq!(decision.effect, Effect::Deny, "{line}");
    }
}

#[test]
fn a_shell_line_is_allowed_only_when_an_allow_rule_covers_every_one_of_its_commands() {
    let mut numbers = Numbers(2);
    let mut allowed = 0;
    for _ in 0..2000 {
        let layers = some_layers(&mut numbers);
        let line = shell_line(&mut numbers);
        let Some(decision) = resolve_permission(&layers, "code", &shell(&line)) else {
            continue;
        };
        if decision.effect != Effect::Allow {
            continue;
        }
        allowed += 1;
        for segment in command_segments(&line) {
            let program = segment.split_whitespace().next().expect("a program");
            assert!(
                layers.iter().flat_map(|layer| &layer.rules).any(|rule| {
                    rule.effect == Effect::Allow
                        && (rule.pattern == "*" || rule.pattern == format!("{program} *"))
                }),
                "{segment} of {line} was allowed by no rule"
            );
        }
    }
    assert!(
        allowed > 50,
        "too few lines were allowed to say much: {allowed}"
    );
}

#[test]
fn an_allow_rule_for_one_program_never_allows_a_line_that_chains_another() {
    let mut numbers = Numbers(3);
    for _ in 0..1000 {
        let allowed_program = numbers.pick(&PROGRAMS);
        let other = numbers.pick(&PROGRAMS);
        if allowed_program == other {
            continue;
        }
        let layers = [layer(
            Scope::Project,
            vec![rule(format!("{allowed_program} *"), Effect::Allow)],
        )];
        let first = command(&mut numbers, allowed_program);
        let line = format!("{first}{}{other} --anything", numbers.pick(&SEPARATORS));
        let decision = resolve_permission(&layers, "code", &shell(&line));
        assert_ne!(
            decision.map(|decision| decision.effect),
            Some(Effect::Allow),
            "{line}"
        );
    }
}

#[test]
fn cutting_at_stop_sequences_keeps_a_prefix_with_no_stop_sequence_left() {
    assert_eq!(
        cut_at_stop("foo();\n<|fim_pad|>bar", &["<|fim_pad|>"]),
        "foo();\n"
    );
    let alphabet = ["a", "b", "<", "|", "\n", "é", "中"];
    let mut numbers = Numbers(4);
    let word = |numbers: &mut Numbers, longest: usize| -> String {
        (0..numbers.below(longest))
            .map(|_| numbers.pick(&alphabet))
            .collect()
    };
    for _ in 0..2000 {
        let text = word(&mut numbers, 24);
        let stops: Vec<String> = (0..numbers.below(5))
            .map(|_| word(&mut numbers, 5))
            .filter(|stop| !stop.is_empty())
            .collect();
        let stops: Vec<&str> = stops.iter().map(String::as_str).collect();
        let cut = cut_at_stop(&text, &stops);
        assert!(text.starts_with(cut), "{text:?} {stops:?}");
        for stop in &stops {
            assert!(!cut.contains(stop), "{text:?} {stops:?} gave {cut:?}");
        }
        if stops.iter().all(|stop| !text.contains(stop)) {
            assert_eq!(cut, text);
        }
    }
}
