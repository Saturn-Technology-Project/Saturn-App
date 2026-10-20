import type { McpConnection, ToolRoute } from "./model.js";

export const AUTOMATIONS_SKILLS_ID = "automations";
export const AUTOMATIONS_SKILLS_URL = "builtin://automations";
export const ANTIGRAVITY_SKILLS_ID = AUTOMATIONS_SKILLS_ID;
export const ANTIGRAVITY_SKILLS_URL = AUTOMATIONS_SKILLS_URL;

export const ANTIGRAVITY_TOOLS: ToolRoute[] = [
  // --- Automation Tools (5) ---
  {
    toolId: "automation_list",
    serverId: ANTIGRAVITY_SKILLS_ID,
    category: "read",
    description: "List all scheduled background automations, including their schedule (cron), assigned agent, enabled status, and last/next execution slots.",
    inputSchema: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          enum: ["all", "enabled", "disabled"],
          description: "Optional filter by enabled status.",
        },
      },
      additionalProperties: false,
    },
    environments: ["production"],
  },
  {
    toolId: "automation_create",
    serverId: ANTIGRAVITY_SKILLS_ID,
    category: "write",
    description: "Create a new scheduled background automation (cron job) that runs a fresh agent conversation on each trigger.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Descriptive name for the scheduled automation (e.g. 'Daily Git Summary' or 'Hourly Issue Sync').",
        },
        prompt: {
          type: "string",
          description: "The instruction prompt to execute on each scheduled run.",
        },
        cron: {
          type: "string",
          description: "5-field cron, optionally prefixed with CRON_TZ=<IANA zone>. Supported: hourly 'M * * * *', daily 'M H * * *', weekdays 'M H * * 1-5', weekly 'M H * * D' (0 = Sunday). E.g. 'CRON_TZ=Asia/Taipei 0 9 * * 1-5'. Without CRON_TZ the computer's time zone is used.",
        },
        agentId: {
          type: "string",
          description: "The ID of the agent to execute this automation. If omitted, the agent making this call runs it.",
        },
        enabled: {
          type: "boolean",
          description: "Whether the automation is active upon creation. Defaults to true.",
        },
      },
      required: ["name", "prompt", "cron"],
      additionalProperties: false,
    },
    environments: ["production"],
  },
  {
    toolId: "automation_trigger",
    serverId: ANTIGRAVITY_SKILLS_ID,
    category: "write",
    description: "Immediately trigger execution of a scheduled automation without waiting for its next cron slot.",
    inputSchema: {
      type: "object",
      properties: {
        automationId: {
          type: "string",
          description: "The ID of the automation to trigger.",
        },
      },
      required: ["automationId"],
      additionalProperties: false,
    },
    environments: ["production"],
  },
  {
    toolId: "automation_toggle",
    serverId: ANTIGRAVITY_SKILLS_ID,
    category: "write",
    description: "Enable or disable a scheduled automation.",
    inputSchema: {
      type: "object",
      properties: {
        automationId: {
          type: "string",
          description: "The ID of the automation.",
        },
        enabled: {
          type: "boolean",
          description: "True to enable, false to disable.",
        },
      },
      required: ["automationId", "enabled"],
      additionalProperties: false,
    },
    environments: ["production"],
  },
  {
    toolId: "automation_delete",
    serverId: ANTIGRAVITY_SKILLS_ID,
    category: "write",
    description: "Delete a scheduled background automation.",
    inputSchema: {
      type: "object",
      properties: {
        automationId: {
          type: "string",
          description: "The ID of the automation to delete.",
        },
      },
      required: ["automationId"],
      additionalProperties: false,
    },
    environments: ["production"],
  },

  // --- Generative UI Tools (2) ---
  {
    toolId: "generative_ui_template",
    serverId: ANTIGRAVITY_SKILLS_ID,
    category: "read",
    description: "Retrieve recommended Generative UI templates, design system tokens, and boilerplate code.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["metrics_dashboard", "interactive_filter", "flow_diagram", "form_wizard", "empty_boilerplate"],
          description: "The type of widget template to retrieve.",
        },
      },
      required: ["type"],
      additionalProperties: false,
    },
    environments: ["production"],
  },

  // --- Customizations & Rules Tools (3) ---
  {
    toolId: "customizations_list",
    serverId: ANTIGRAVITY_SKILLS_ID,
    category: "read",
    description: "List the workspace's project rules (.agents/rules/*.md) and on-demand skills (.agents/skills/<name>/SKILL.md).",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["all", "workspace"],
          description: "Only the workspace is scanned; kept for compatibility. Defaults to all.",
        },
      },
      additionalProperties: false,
    },
    environments: ["production"],
  },
  {
    toolId: "customizations_create_skill",
    serverId: ANTIGRAVITY_SKILLS_ID,
    category: "write",
    description: "Create an on-demand skill directory under .agents/skills/<name>/ with SKILL.md containing metadata, description, and multi-step procedures.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Skill identifier (lowercase, dashes or underscores, e.g. 'deploy-preview' or 'db-seed').",
        },
        description: {
          type: "string",
          description: "When and why the agent should activate this skill.",
        },
        instructions: {
          type: "string",
          description: "Full markdown instructions, workflows, and guidelines for the skill.",
        },
      },
      required: ["name", "description", "instructions"],
      additionalProperties: false,
    },
    environments: ["production"],
  },
  {
    toolId: "customizations_create_rule",
    serverId: ANTIGRAVITY_SKILLS_ID,
    category: "write",
    description: "Create or update a project or directory coding rule (.agents/rules/<name>.md or AGENTS.md) to enforce guidelines and styles.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Rule filename or name (e.g. 'typescript-style' or 'security-rules').",
        },
        content: {
          type: "string",
          description: "Markdown content of the rule to enforce.",
        },
        path: {
          type: "string",
          description: "Optional relative directory to scope this rule to. Defaults to root (.agents/rules/).",
        },
      },
      required: ["name", "content"],
      additionalProperties: false,
    },
    environments: ["production"],
  },

  // --- Workflows Migration Tools (2) ---
  {
    toolId: "workflows_scan",
    serverId: ANTIGRAVITY_SKILLS_ID,
    category: "read",
    description: "Scan the workspace and global configuration for deprecated legacy workflow files (.agents/workflows/*.md, workflows.json) that can be migrated to modern skills.",
    inputSchema: {
      type: "object",
      properties: {
        directory: {
          type: "string",
          description: "Optional specific root directory to scan.",
        },
      },
      additionalProperties: false,
    },
    environments: ["production"],
  },
  {
    toolId: "workflows_migrate",
    serverId: ANTIGRAVITY_SKILLS_ID,
    category: "write",
    description: "Migrate legacy workflow files into modern .agents/skills/<name>/SKILL.md structures and safely archive old files.",
    inputSchema: {
      type: "object",
      properties: {
        workflowName: {
          type: "string",
          description: "Name of the workflow to migrate, or '*' to migrate all discovered legacy workflows.",
        },
        archiveOld: {
          type: "boolean",
          description: "Whether to safely move the old workflow files to an archive directory. Defaults to true.",
        },
      },
      required: ["workflowName"],
      additionalProperties: false,
    },
    environments: ["production"],
  },

  // --- Plugins Tools (3) ---
  {
    toolId: "plugins_list",
    serverId: ANTIGRAVITY_SKILLS_ID,
    category: "read",
    description: "List all installed, workspace, and global plugins with their lifecycle status and bundled components.",
    inputSchema: {
      type: "object",
      properties: {
        includeDisabled: {
          type: "boolean",
          description: "Whether to include disabled plugins. Defaults to true.",
        },
      },
      additionalProperties: false,
    },
    environments: ["production"],
  },
  {
    toolId: "plugins_bundle",
    serverId: ANTIGRAVITY_SKILLS_ID,
    category: "write",
    description: "Create or package a new plugin bundle manifest (plugin.json) declaring bundled skills, rules, MCP servers, and hooks.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Plugin identifier.",
        },
        displayName: {
          type: "string",
          description: "Human-friendly display name.",
        },
        description: {
          type: "string",
          description: "Brief summary of what the plugin bundle provides.",
        },
        skills: {
          type: "array",
          items: { type: "string" },
          description: "List of skill folder names bundled within this plugin.",
        },
        mcpServers: {
          type: "array",
          items: { type: "string" },
          description: "List of MCP server configuration identifiers bundled within this plugin.",
        },
      },
      required: ["name", "displayName", "description"],
      additionalProperties: false,
    },
    environments: ["production"],
  },
  {
    toolId: "plugins_toggle",
    serverId: ANTIGRAVITY_SKILLS_ID,
    category: "write",
    description: "Enable or disable a plugin bundle and all its constituent components at once.",
    inputSchema: {
      type: "object",
      properties: {
        pluginName: {
          type: "string",
          description: "Name of the plugin.",
        },
        enabled: {
          type: "boolean",
          description: "True to enable, false to disable.",
        },
      },
      required: ["pluginName", "enabled"],
      additionalProperties: false,
    },
    environments: ["production"],
  },

  // --- UI Plugin Navigation (2) ---
];

export function antigravitySkills(): McpConnection {
  return {
    id: ANTIGRAVITY_SKILLS_ID,
    name: "Automations",
    url: ANTIGRAVITY_SKILLS_URL,
    tools: ANTIGRAVITY_TOOLS,
  };
}
