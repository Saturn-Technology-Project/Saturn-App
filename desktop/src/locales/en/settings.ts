// The interface's English for the settings screens, where it differs from the text in the code: the code's text is the
// key, and this is what an English reader sees.
import type { Dictionary } from "../../domain/i18n";

export default {
  // The rail and the header
  "LLM providers & models": "Providers and models",
  "MCP & Skills": "MCP and skills",
  "Tool servers & knowledge sources": "Tool servers and knowledge sources",
  "Usage & Billing": "Usage and billing",
  "Token spend & costs": "Token usage and costs",
  "What agents may do without asking": "What agents can do without asking",
  "Commands around tool calls and turns": "Commands that run around tool calls and turns",
  "Bundles of skills, commands, hooks and MCP servers": "Bundles of skills, commands, hooks, and MCP servers",
  "OpenTelemetry traces & logs": "OpenTelemetry traces and logs",
  "Live runtime event stream": "Live runtime events",
  "Project configuration & custom rules ({path})": "Project settings and rules ({path})",
  "Quick keyboard shortcuts for Saturn": "Keyboard shortcuts in Saturn",
  "What the earlier interface set going": "Work the previous interface started that is still running",

  // Saturn's own tool servers
  "Files, commands, web and plans": "Files, commands, web, and plans",
  "Schedules, rules, skills and plugins": "Schedules, rules, skills, and plugins",
  "A browser agents can drive": "A browser that agents can control",
  "Research records, runs and looking inside models": "Research records, runs, and model inspection",

  // Command line
  "Command Line": "Command line",
  ". It uses this app's own runtime, so it never goes out of date.": ". It uses this app's runtime, so it's always up to date.",
  "Installed at {path}, for another copy of Saturn: reinstall to point it here.":
    "Installed at {path} for another copy of Saturn. Reinstall to use this copy.",
  'Add {folder} to your PATH to type just "saturn".': 'Add {folder} to your PATH to run it as "saturn".',

  // Memory
  "One line per fact. Agents read these at the start of every chat (project notes in that project's chats, user notes everywhere). Delete a line to make Saturn forget it.":
    "One fact per line. Agents read these at the start of every chat: project notes in that project's chats, notes about you in every chat. Delete a line to make Saturn forget it.",
  "About you (every chat)": "About you (all chats)",
  'Nothing remembered yet. Notes appear after a few turns of chat, or write your own: "- Prefers short answers".':
    'No notes yet. Notes appear after a few turns of chat, or you can write your own, like "- Prefers short answers".',
  "Nothing remembered about this project yet.": "No notes for this project yet.",

  // MCP & Skills
  "Could not connect MCP": "Could not connect the MCP server",
  "Type the command that starts the server, for example npx -y @modelcontextprotocol/server-filesystem /path/to/folder":
    "Enter the command that starts the server, for example npx -y @modelcontextprotocol/server-filesystem /path/to/folder",
  '"{line}" is not NAME=value': '"{line}" isn\'t in NAME=value format',
  "Could not connect knowledge": "Could not connect the knowledge source",
  "Built in": "Built-in",
  ", with your user account's permissions. Allow it only if you trust it. It starts with only a minimal environment, not Saturn's keys.":
    ", with your user account's permissions. Allow it only if you trust it. It starts with a minimal environment and none of Saturn's keys.",
  "Allow and Start": "Allow and start",
  "Kind of MCP server": "MCP server type",
  "Local Program": "Local program",
  "An MCP server reached over HTTP(S). Tools are discovered automatically.": "An MCP server you reach over HTTP(S). Saturn finds its tools automatically.",
  "Connect MCP": "Connect server",
  "A server Saturn starts on this computer and talks to over stdio. It runs only after you allow its exact command. No shell is used, so ~, $VARIABLES and pipes are not expanded: write full paths.":
    "A server Saturn starts on this computer and talks to over stdio. It runs only after you allow its exact command. Commands don't run in a shell, so ~, $VARIABLES, and pipes aren't expanded. Use full paths.",
  "Add Local Server": "Add local server",
  "Installed MCP Servers": "Installed MCP servers",
  "Could not save tool configuration": "Could not save the tool settings",
  "Knowledge & RAG Endpoints": "Knowledge and RAG endpoints",
  "Connect Knowledge URL": "Knowledge source URL",
  "Connect Knowledge": "Connect knowledge source",

  // Models
  "Effort for {name}": "Reasoning effort for {name}",
  "Could not change the effort": "Could not change the reasoning effort",
  "Local Server": "Local server",
  "Key stored": "Key saved",
  "Replace Key": "Replace key",
  "Add Key": "Add key",
  "Failed to remove model": "Could not remove the model",
  "Paste {provider} API key…": "Paste your {provider} API key…",
  "Save Key": "Save key",
  "Model identifier in LM Studio": "Model ID in LM Studio",
  "Runs through the official Claude Code program on your own Claude login (Settings → General → Claude Code). Saturn never sends API requests for it, takes no API key, and does not schedule it.":
    "Runs through the official Claude Code program with your own Claude login (Settings → General → Claude Code). Saturn sends no API requests for it, needs no API key, and doesn't schedule it.",
  "Runs through the official Codex on your own ChatGPT login (Settings → General → Codex). No API key.":
    "Runs through the official Codex program with your own ChatGPT login (Settings → General → Codex). No API key needed.",
  "LM Studio Endpoint": "LM Studio endpoint",
  "API Key": "API key",
  "Using your saved {provider} key — paste to replace": "Using your saved {provider} key. Paste a new one to replace it.",
  "Paste provider API key…": "Paste the provider's API key…",
  "Connect Model": "Connect model",
  "Claude's effort setting (output_config.effort). Models without effort support ignore it.":
    "Claude's effort setting (output_config.effort). Models that don't support it ignore it.",

  // Logs
  "No log lines matching filter.": "No log lines match the filter.",

  // General
  "Agents browse in a visible window of your Chrome (or Edge, Brave), with Saturn's own profile: your logins and tabs stay out of it. You watch the cursor there.":
    "Agents browse in a visible Chrome (or Edge or Brave) window with Saturn's own profile, so your logins and tabs stay out of it. You can watch the cursor there.",
  "Agents browse in a Safari automation window (striped address bar), clean of your logins; you cannot click into it while the agent works. Turn on Develop → Allow Remote Automation in Safari once. The Browser tab shows it about once a second.":
    "Agents browse in a Safari automation window (striped address bar) without your logins. You can't click into it while the agent works. Turn on Develop → Allow Remote Automation in Safari once. The Browser tab shows it about once a second.",
  "The interface's language. Saturn reloads to show it.": "The language of the interface. Saturn reloads to apply it.",
  ": its hooks, permission rules and settings, as it would in a terminal there. Your own Claude settings are never loaded. Off by default, since a project's hooks run commands.":
    ": its hooks, permission rules, and settings, as it would in a terminal there. Your own Claude settings are never loaded. Off by default, because a project's hooks run commands.",
  "Background Model": "Background model",
  "Writes memory notes from your chats, and drafts automations when an agent's own model has no API. Chat content goes to this model. On Automatic, memory notes use the agent's model.":
    "Writes memory notes from your chats and drafts automations when an agent's model has no API. Chat content is sent to this model. On Automatic, memory notes use the agent's model.",
  "Every few turns, Saturn notes durable facts from the chat (how you like to work, a project's conventions) and gives them to agents in later chats. Read and edit the notes under Memory.":
    "Every few turns, Saturn notes lasting facts from the chat (how you like to work, a project's conventions) and shares them with agents in later chats. View and edit the notes under Memory.",
  "A system notification when an agent finishes, fails or needs your approval while you are not looking at its chat. Click it to open the chat.":
    "Get a system notification when an agent finishes, fails, or needs your approval while you're not viewing its chat. Click it to open the chat.",
  "Where a shell command run by an agent may write. ": "Where a shell command run by an agent can write. ",
  " confines it to the project folder (plus temp and cache folders) with the operating system's sandbox, so a stray ":
    " confines it to the project folder (plus temp and cache folders) using the operating system's sandbox, so a stray ",
  " or a script cannot touch anything else; ": " or script can't touch anything else; ",
  " lets it write nowhere; ": " blocks all writes; ",
  " runs it as you. An agent can ask to run one command outside the sandbox, which shows an approval card. macOS and Linux (with bubblewrap) sandbox; Windows cannot. A project can override this.":
    " runs it as you. An agent can ask to run a single command outside the sandbox, which shows an approval card. Sandboxing works on macOS and Linux (with bubblewrap), not on Windows. A project can override this.",
  "Whether sandboxed commands may use the network (package installs, git push, curl). Off blocks every connection except local sockets; the agent can still ask to run a command outside the sandbox.":
    "Whether sandboxed commands can use the network (package installs, git push, curl). When off, every connection except local sockets is blocked; the agent can still ask to run a command outside the sandbox.",
  "Network for commands": "Network access for commands",
  "Workspace Name": "Workspace name",
  "Shown in the title bar and settings.": "Shown in the title bar and in Settings.",
  "Log Level": "Log level",
  "How much the runtime writes to Logs.": "How much detail the runtime writes to Logs.",
  "API Keys": "API keys",
  "Kept on this Mac in a file only your user account can read.": "Stored on this Mac in a file only your user account can read.",

  // A project
  "Remove {name} from Saturn? Its chats go with it. The folder and its files stay where they are.":
    "Remove {name} from Saturn? Its chats are removed too. The folder and its files stay on disk.",
  "Failed to save project rules": "Could not save the project rules",
  "Project Details": "Project details",
  "Project Name": "Project name",
  "Workspace Path": "Project folder",
  "Git Branch": "Git branch",
  "Check After Changes": "Check after changes",
  'Run after an agent changes files here; a failure goes straight back to the agent to fix (at most twice per message). Use "auto" for package.json\'s typecheck or lint script, or leave empty to skip.':
    'Runs after an agent changes files here. If it fails, the agent gets the failure to fix, up to twice per message. Use "auto" for package.json\'s typecheck or lint script, or leave empty to skip.',
  "auto, or e.g. npm test": "auto, or a command like npm test",
  "Overrides the sandbox under Settings → General for commands run here. Workspace confines writes to this folder; Read-only allows none; Off runs commands as you.":
    "Overrides the sandbox setting in Settings → General for commands run here. Workspace limits writes to this folder, Read-only allows none, and Off runs commands as you.",
  "Project Rules & Custom Instructions": "Project rules and custom instructions",
  "Save Rules": "Save rules",

  // Shortcuts
  "Close popups": "Close pop-ups",
  "Keyboard Shortcuts": "Keyboard shortcuts",

  // Claude Code and Codex
  "Remove Saturn's copy of {program}? {program} models stop working until it is downloaded again or found on your system.":
    "Remove Saturn's copy of {program}? {program} models stop working until you download it again or Saturn finds it on your system.",
  "{program} is not installed": "{program} isn't installed",
  "Checking the download against its pinned checksum…": "Verifying the download against its pinned checksum…",
  "Saturn downloads the official {program} program ({version}) from the npm registry and checks it against a checksum pinned in Saturn, or uses one you have installed yourself.":
    "Saturn downloads the official {program} program ({version}) from the npm registry and verifies it against a checksum pinned in Saturn. You can also use a copy you installed yourself.",
  "Saturn downloads the official {program} program from the npm registry and checks it against a checksum pinned in Saturn, or uses one you have installed yourself.":
    "Saturn downloads the official {program} program from the npm registry and verifies it against a checksum pinned in Saturn. You can also use a copy you installed yourself.",
  "Try Again": "Try again",
  "Development copy": "Development build",
  "Codex Sign-In": "Codex sign-in",
  "Not signed in. You sign in to the official Codex program, which uses your ChatGPT plan; Saturn never sees your credentials.":
    "Not signed in. You sign in to the official Codex program, which uses your ChatGPT plan. Saturn never sees your credentials.",
  "Sign Out": "Sign out",
  "Sign In to Codex": "Sign in to Codex",
  "Codex shows this one-time code: open the OpenAI page, sign in, and enter it. It expires in 15 minutes; this card updates once you're done.":
    "Codex shows this one-time code. Open the OpenAI page, sign in, and enter it. The code expires in 15 minutes, and this card updates when you're done.",
  "Open Page": "Open page",
  "Finish signing in on the page that opened in your browser. Saturn keeps Codex listening for it until you're done.":
    "Finish signing in on the page that opened in your browser. Saturn keeps Codex waiting until you're done.",
  "Claude Account": "Claude account",
  "Check Again": "Check again",
  "To sign in, run this in Terminal and keep that window open until it says you're signed in. This card updates on its own.":
    "To sign in, run this command in Terminal and keep the window open until it says you're signed in. This card updates automatically.",
  " If the browser says it can't connect to localhost, that terminal sign-in had already ended: run the command again and use the new browser page.":
    " If the browser can't connect to localhost, the sign-in in Terminal has already ended. Run the command again and use the new browser page.",
} satisfies Dictionary;
