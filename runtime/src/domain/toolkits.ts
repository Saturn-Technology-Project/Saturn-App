/**
 * Toolkits an agent loads when it needs them, the way Claude Code defers tools behind a search: their tool
 * definitions are a large share of every request (GitHub's alone ~9k tokens) and most turns use none of them.
 * The system prompt still names each one's tools; `load_tools` adds the definitions for the rest of the chat.
 */
export const ON_DEMAND_TOOLKITS: Record<string, { name: string; aliases: string[] }> = {
  origin: { name: "github", aliases: ["github", "git", "origin", "cursor-origin"] },
  "computer-use": { name: "computer", aliases: ["computer", "computer-use", "desktop", "cursor-computer-use"] },
  browser: { name: "browser", aliases: ["browser"] },
  automations: { name: "automations", aliases: ["automations", "automation", "customizations", "plugins", "antigravity"] },
};

/** The server id a toolkit name (or alias, any case) stands for. */
export function toolkitServer(name: string): string | undefined {
  const wanted = name.trim().toLowerCase();
  return Object.entries(ON_DEMAND_TOOLKITS).find(([id, kit]) => id === wanted || kit.aliases.includes(wanted))?.[0];
}

/** The note under a toolkit's section of the system prompt while it is not loaded. */
export function loadNote(serverId: string): string {
  const kit = ON_DEMAND_TOOLKITS[serverId];
  return kit ? `- Not loaded yet: call \`load_tools\` with toolkits: ["${kit.name}"] before using these.` : "";
}
