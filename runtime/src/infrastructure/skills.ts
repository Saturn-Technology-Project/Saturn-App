import { GeneralSkills, type ToolCaller } from "./skills/general-skills.js";

export async function runGeneralSkill(
  dataDir: string,
  toolId: string,
  args: Record<string, unknown>,
  callTool?: ToolCaller,
  signal?: AbortSignal,
): Promise<unknown> {
  return new GeneralSkills(dataDir, callTool, signal).run(toolId, args);
}
