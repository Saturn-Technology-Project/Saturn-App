import type { McpConnection, ToolRoute } from "./model.js";

export const SATURN_AGENT_ID = "saturn-agent";
export const GENERAL_SKILLS_ID = "general-skills";
export const BUILTIN_MCP_URL = "builtin://general-skills";

import {
  COMPUTER_USE_ID,
  COMPUTER_USE_URL,
  CURSOR_COMPUTER_USE_ID,
  CURSOR_COMPUTER_USE_URL,
  ORIGIN_ID,
  ORIGIN_URL,
  CURSOR_ORIGIN_ID,
  CURSOR_ORIGIN_URL,
  COMPUTER_USE_TOOLS,
  ORIGIN_TOOLS,
  cursorComputerUseSkills,
  cursorOriginSkills,
} from "./cursor-tools.js";

import {
  AUTOMATIONS_SKILLS_ID,
  AUTOMATIONS_SKILLS_URL,
  ANTIGRAVITY_SKILLS_ID,
  ANTIGRAVITY_SKILLS_URL,
  ANTIGRAVITY_TOOLS,
  antigravitySkills,
} from "./antigravity-tools.js";

export {
  COMPUTER_USE_ID,
  COMPUTER_USE_URL,
  CURSOR_COMPUTER_USE_ID,
  CURSOR_COMPUTER_USE_URL,
  ORIGIN_ID,
  ORIGIN_URL,
  CURSOR_ORIGIN_ID,
  CURSOR_ORIGIN_URL,
  COMPUTER_USE_TOOLS,
  ORIGIN_TOOLS,
  cursorComputerUseSkills,
  cursorOriginSkills,
  AUTOMATIONS_SKILLS_ID,
  AUTOMATIONS_SKILLS_URL,
  ANTIGRAVITY_SKILLS_ID,
  ANTIGRAVITY_SKILLS_URL,
  ANTIGRAVITY_TOOLS,
  antigravitySkills,
};

export const DEFAULT_BUILTIN_MCP_IDS: readonly string[] = [
  GENERAL_SKILLS_ID,
  COMPUTER_USE_ID,
  ORIGIN_ID,
  AUTOMATIONS_SKILLS_ID,
];

export function withGeneralSkills(ids: string[]): string[] {
  return ids.includes(GENERAL_SKILLS_ID) ? ids : [...ids, GENERAL_SKILLS_ID];
}

const skill = (toolId: string, description: string, properties: Record<string, unknown>, required: string[]): ToolRoute => ({
  toolId,
  serverId: GENERAL_SKILLS_ID,
  description,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
  environments: ["production"],
});

export function generalSkills(): McpConnection {
  return {
    id: GENERAL_SKILLS_ID,
    name: "General Skills",
    url: BUILTIN_MCP_URL,
    tools: [
      skill(
        "files",
        "List, read, write, or patch files in the workspace. A patch starts with *** Begin Patch and ends with *** End Patch. File sections are *** Add File, *** Update File, or *** Delete File. Update hunks use @@ and lines that start with a space, + or -.",
        {
          action: { type: "string", enum: ["list", "read", "write", "patch"] },
          path: { type: "string" },
          content: { type: "string" },
          patch: { type: "string" },
          offset: { type: "integer" },
          limit: { type: "integer" },
        },
        ["action"],
      ),
      skill(
        "code",
        "Run a shell command in the workspace. cwd must stay inside the workspace. timeout is milliseconds, at most 30000. Commands run in a sandbox that can write only inside the workspace (and temp and cache folders); pass sandbox: \"off\" only when a command must write elsewhere or the sandbox blocks it, which asks the user first.",
        { command: { type: "string" }, cwd: { type: "string" }, timeout: { type: "integer" }, sandbox: { type: "string", enum: ["off"] }, background: { type: "boolean", description: "Start the command and return at once with a jobId (a dev server, a watcher, a long build). Read it with code_output, end it with code_stop; it keeps running after this turn." } },
        ["command"],
      ),
      skill(
        "code_output",
        "The recent output and state of a background command started with code { background: true }. wait is milliseconds to wait for more output or for it to end (at most 30000).",
        { jobId: { type: "string" }, wait: { type: "integer" } },
        ["jobId"],
      ),
      skill("code_stop", "Stops a background command started with code { background: true }.", { jobId: { type: "string" } }, ["jobId"]),
      skill(
        "skill",
        "Load a skill: the instructions for a particular kind of task, listed by name and description under Skills in your instructions. Load it before starting such a task and follow it.",
        { name: { type: "string" } },
        ["name"],
      ),
      skill(
        "load_tools",
        "Load toolkits listed as not loaded in your instructions (github, computer, browser, automations); their tools are available from the next step on, for the rest of the chat.",
        { toolkits: { type: "array", items: { type: "string" } } },
        ["toolkits"],
      ),
      skill(
        "delegate",
        "Hand a self-contained task to a sub-agent with a fresh context, and get back only its final answer: a wide search or investigation, a report on part of the code, an independent subtask. Several tasks run in parallel. tools: read-only (the default) lets the sub-agent only read and run read-only tools; all lets it change files and run commands under the same approvals as you. agent names another agent to run it; otherwise it is you, with your model.",
        {
          task: { type: "string", description: "What to do and what to report back, complete in itself: the sub-agent sees nothing of this conversation." },
          tasks: { type: "array", items: { type: "string" }, description: "Several independent tasks, run at the same time." },
          tools: { type: "string", enum: ["read-only", "all"] },
          agent: { type: "string", description: "Another agent's name, when its model or tools fit the task better." },
        },
        [],
      ),
      skill(
        "mcp",
        "Call a tool on another MCP server that is enabled for this agent.",
        { tool: { type: "string" }, arguments: { type: "object" } },
        ["tool"],
      ),
      skill("web", "Fetch the readable text of a public http or https page.", { url: { type: "string" } }, ["url"]),
      skill(
        "multi_step",
        "Keep the plan for this task. Each step has a status of pending, in_progress, or completed. Until the plan is finished, exactly one step is in progress.",
        {
          explanation: { type: "string" },
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: {
                step: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              },
              required: ["step", "status"],
            },
          },
        },
        ["steps"],
      ),
    ],
  };
}
