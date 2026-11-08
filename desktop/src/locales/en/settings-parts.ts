// The interface's English for the settings-parts screens, where it differs from the text in the code: the code's text is the
// key, and this is what an English reader sees.
import type { Dictionary } from "../../domain/i18n";

export default {
  // About
  "Your questions, code, experiments, models, samples and findings, with a research assistant beside them.":
    "Your questions, code, experiments, models, samples, and findings, with a research assistant at your side.",
  "The local core": "Local core",
  "Runs on this computer at 127.0.0.1. It runs your experiments, calls the models, keeps your keys, and writes research records as plain files in each project.":
    "Runs on this computer at 127.0.0.1. It runs your experiments, calls models, stores your keys, and writes research records as plain files in each project.",
  "A run freezes what it computed. Only runs measured the same way are compared, and a verdict is always yours to set.":
    "Each run freezes what it computed. Only runs measured the same way are compared, and you always set the verdict.",
  "A line of models": "Model lineage",
  "Follow checkpoints and their fine-tuned branches, read one sample across them, and look inside to see what changed.":
    "Follow checkpoints and their fine-tuned branches, read the same sample across them, and look inside to see what changed.",
  "In each chat, the assistant only reads, proposes changes for you to approve, or works on a task apart until you merge it.":
    "In each chat, the assistant only reads, proposes changes for you to approve, or works on a separate task until you merge it.",
  "Claude through your Claude plan, Codex through your ChatGPT plan, API keys for Anthropic, OpenAI, Google and DeepSeek, or a local model from a server on this computer such as LM Studio or Ollama.":
    "Use Claude with your Claude plan, Codex with your ChatGPT plan, API keys for Anthropic, OpenAI, Google, and DeepSeek, or a local model from a server on this computer such as LM Studio or Ollama.",
  "An agent works in a folder only after you allow it, and you can take that back at any time. Its edits can be reviewed and reverted.":
    "An agent works in a folder only after you allow it, and you can revoke that at any time. You can review and revert its edits.",
  "Stays on this computer": "Stays on your computer",
  "The runtime listens only on 127.0.0.1 behind a session token. Telemetry stays here unless you send it somewhere, and every request it sends is in the network log.":
    "The runtime listens only on 127.0.0.1, behind a session token. Telemetry stays here unless you send it elsewhere, and every request the runtime sends appears in the network log.",
  "Saturn is a desktop workbench for AI research. Read the method, write the code yourself, run the experiment and inspect every sample, with as much help from AI as you choose. The app and its runtime run locally, and your records stay in your project.":
    "Saturn is a desktop workbench for AI research. Read the method, write the code yourself, run the experiment, and inspect every sample, with as much AI help as you choose. The app and its runtime run locally, and your records stay in your project.",

  // Computer permissions
  "Lets agents click, type and read what is on screen.": "Lets agents click, type, and read what's on screen.",
  "Lets agents take screenshots to see what they are doing.": "Lets agents take screenshots to see what they're doing.",
  "Nothing to grant on Windows: agents can take screenshots and control apps already.": "Nothing to grant on Windows. Agents can already take screenshots and control apps.",
  "Nothing to grant on this system: agents can take screenshots and control apps already.": "Nothing to grant on this system. Agents can already take screenshots and control apps.",
  allowed: "Allowed",
  Request: "Request access",

  // Hooks
  "Before a tool": "Before a tool call",
  'Exit 2 blocks the call (stderr goes to the agent). Print {"decision": "allow" | "ask" | "deny"} to skip the card, ask, or refuse.':
    'Exit code 2 blocks the call and sends stderr to the agent. Print {"decision": "allow" | "ask" | "deny"} to skip the approval card, ask, or refuse.',
  "After a tool": "After a tool call",
  "Exit 2 adds stderr to the result as feedback for the agent (a linter, a formatter's complaint).":
    "Exit code 2 adds stderr to the result as feedback for the agent (for example, a linter or formatter warning).",
  "Exit 2 sends stderr back to the agent as a follow-up, at most twice per message (insist on green tests).":
    "Exit code 2 sends stderr back to the agent as a follow-up, at most twice per message (for example, to insist on passing tests).",
  "pre tool": "Before tool",
  "post tool": "After tool",
  stop: "Turn end",
  "any tool": "Any tool",
  "A hook is a shell command that runs around an agent's tool calls, or when its turn ends.":
    "A hook is a shell command that runs before or after an agent's tool calls, or when its turn ends.",
  "It runs in the chat's project folder, and gets the event as JSON on stdin: the tool, its arguments and result, and the turn's answer.":
    "It runs in the chat's project folder and receives the event as JSON on stdin: the tool, its arguments and result, and the turn's answer.",
  "Your hooks below run in every project.": "The hooks you add below run in every project.",
  "A project can bring its own hooks file:": "A project can include its own hooks file:",
  "The hooks in its Claude Code settings are read too (PreToolUse, PostToolUse and Stop):":
    "Hooks in its Claude Code settings are also read (PreToolUse, PostToolUse, and Stop):",
  "Those run only after you allow them here, and any change to the file asks again.":
    "Project hooks run only after you allow them here, and you're asked again whenever the file changes.",
  "tools: code, files, github_* (empty: all)": "Tools: code, files, github_* (leave empty for all)",
  "Not running: needs your approval": "Needs approval to run",
  "These commands come with the folder and run with your permissions. Read them before allowing.":
    "These commands come with the folder and run with your permissions. Review them before you allow them.",

  // Older features
  "Scheduled runs and pull request follow-up came from the earlier interface. The runtime keeps doing them until they are turned off here. They can use your models and your GitHub token.":
    "Scheduled runs and pull request follow-ups were set up in the earlier interface. The runtime keeps running them until you turn them off here. They can use your models and your GitHub token.",
  "Turn them all off": "Turn all off",
  "scheduled, on {agent}": "Scheduled on {agent}",
  "pull request": "Pull request",

  // Permissions
  allow: "Allow",
  "Allow runs without asking, in every approval mode.": "Allow runs the call without asking, in every approval mode.",
  ask: "Ask",
  deny: "Deny",
  "Deny is refused; the agent is told why.": "Deny refuses the call and tells the agent why.",
  "other…": "Other…",
  "Tool id": "Tool ID",
  "tool id, e.g. github_*": "Tool ID, e.g. github_*",
  "Waiting for you.": "Needs your approval.",
  "These allow rules came with the folder, so they apply only after you allow them; until then these commands ask like any other. Allow them only if you trust whoever wrote this file:":
    "These allow rules came with the folder, so they apply only after you allow them. Until then, these commands ask like any other. Allow them only if you trust whoever wrote this file:",
  "You allowed this file's allow rules; a change to them asks again.": "You allowed this file's allow rules. You'll be asked again if they change.",
  "Never applied, since they would allow every call:": "Never applied, because they would allow every call:",
  "Read from this file in the project folder; edit it to change them:": "Read from this file in the project folder. Edit the file to change them:",
  "A rule names a tool and a pattern. Deny refuses the call, ask shows an approval card, and allow runs it without asking. Deny beats ask, and ask beats allow.":
    "A rule names a tool and a pattern. Deny refuses the call, Ask shows an approval card, and Allow runs it without asking. Deny overrides Ask, and Ask overrides Allow.",
  "They come with the folder (a cloned repository, say), so their deny and ask rules apply at once, but their allow rules only after you allow them in the project's rules here.":
    "They come with the folder (a cloned repository, for example), so their deny and ask rules apply immediately, but their allow rules apply only after you allow them in the project's rules here.",
  "Everywhere applies to every agent in every project; a project's or an agent's rules add to it.":
    "Everywhere applies to every agent in every project. Rules for a project or an agent add to it.",
  "this project": "This project",
  "this agent": "This agent",
  everywhere: "Everywhere",

  // Plugins
  "A plugin bundles skills, slash commands, hooks and MCP servers in one folder with a plugin.json; Claude Code plugins (.claude-plugin/plugin.json) install as they are. Installing copies the folder, or clones the git repository, into Saturn and runs nothing: its hooks and local MCP servers each wait for your approval.":
    "A plugin bundles skills, slash commands, hooks, and MCP servers in one folder with a plugin.json. Claude Code plugins (.claude-plugin/plugin.json) install as is. Installing copies the folder, or clones the git repository, into Saturn and runs nothing: its hooks and local MCP servers each wait for your approval.",
  "Choose Folder…": "Choose folder…",
  "Turn Off": "Turn off",
  "Turn On": "Turn on",
  "Remove {name}? Its files and its MCP servers are removed.": "Remove {name}? Its files and MCP servers will be removed.",
  "Allow These Hooks": "Allow these hooks",
  "No plugins installed.": "No plugins installed yet.",

  // Snapshot storage
  "Could not read the snapshots": "Could not load snapshots",
  "Delete all folder snapshots? Changes made in earlier chats can still be reverted; the next command in a folder takes a fresh snapshot.":
    "Delete all folder snapshots? You can still revert changes made in earlier chats. The next command in a folder takes a new snapshot.",
  "Delete the snapshots of {folder}? Changes made in earlier chats can still be reverted; the next command in a folder takes a fresh snapshot.":
    "Delete the snapshots of {folder}? You can still revert changes made in earlier chats. The next command in a folder takes a new snapshot.",
  "Delete the snapshots of this folder? Changes made in earlier chats can still be reverted; the next command in a folder takes a fresh snapshot.":
    "Delete the snapshots of this folder? You can still revert changes made in earlier chats. The next command in a folder takes a new snapshot.",
  "For project folders outside git, Saturn keeps a private snapshot in its own data folder, so what a shell command changes can be reviewed and reverted.":
    "For project folders not in git, Saturn keeps a private snapshot in its data folder so you can review and revert changes made by shell commands.",
  "1 folder, {size} in all.": "1 folder, {size} total.",
  "{count} folders, {size} in all.": "{count} folders, {size} total.",

  // Usage & billing
  "No official price for this model, so it is not included in the bill": "This model has no official price, so it isn't included in the total cost",
  "Total bill": "Total cost",
  "{count} calls on unpriced models not included": "{count} calls to unpriced models not included",
  "Priced at the rate in force when each call was made": "Priced at the rate in effect when each call was made",
  "Each call counts toward the model the agent was using at that moment": "Each call counts toward the model the agent was using at the time",
  "{count} of these from the cache, billed at its lower rate": "{count} of these from cache, billed at the lower cached rate",
  deleted: "Deleted",
  unpriced: "Unpriced",

  // Telemetry
  "telemetry.json as saved, for this page": "The telemetry.json file as Saturn saves it",
  "One event per line for Elastic, Splunk, Sentinel": "One event per line, for Elastic, Splunk, or Sentinel",
  "Info and up": "Info and above",
  "Warnings and up": "Warnings and above",
  "This runtime does not serve telemetry yet. Restart it to load the new version.": "This runtime doesn't provide telemetry yet. Restart it to load the new version.",
  "Empties the page and telemetry.json": "Clears this page and telemetry.json",
  "Show {count} more ({left} left)": "Show {count} more ({left} remaining)",
  "Filter by span name or trace id…": "Filter by span name or trace ID…",
  "Send a message to an agent or run an automation, then come back.": "Send a message to an agent or run an automation, then check back here.",
  "Trace id": "Trace ID",
  "Span id": "Span ID",
  counter: "Counter",
  "up-down": "Up-down counter",
  "No log records": "No logs yet",
  "Runtime log lines show up here as OpenTelemetry log records.": "Runtime log lines appear here as OpenTelemetry log records.",
  "trace {id}": "Trace {id}",
  "Every HTTP(S) request the Saturn runtime has sent since {time}: hosts and paths only, never query strings or bodies. Claude Code, Codex and git run as their own programs and are not listed here; watch them with your system's firewall or network monitor.":
    "Every HTTP(S) request the Saturn runtime has sent since {time}, with hosts and paths only, never query strings or bodies. Claude Code, Codex, and git run as separate programs and aren't listed here. Use your system's firewall or network monitor to watch them.",
  "1 outside host": "1 external host",
  "{count} outside hosts": "{count} external hosts",
  "this computer": "This computer",
  internet: "Internet",
  "Latest requests": "Recent requests",
} satisfies Dictionary;
