import type { FileCheckpoint } from "../domain/skills/checkpoint.js";
import { GeneralSkills, type ToolCaller } from "./skills/general-skills.js";
import { ComputerUseSkill } from "./skills/computer-use-skill.js";
import { OriginSkill, type OriginContext } from "./skills/origin-skill.js";
import { AntigravitySkill, type AntigravityContext } from "./skills/antigravity-skill.js";

export async function runGeneralSkill(
  dataDir: string,
  toolId: string,
  args: Record<string, unknown>,
  callTool?: ToolCaller,
  signal?: AbortSignal,
  workdir?: string,
  checkpoint?: FileCheckpoint,
): Promise<unknown> {
  return new GeneralSkills(dataDir, callTool, signal, workdir, checkpoint).run(toolId, args);
}

export async function runComputerUseSkill(
  dataDir: string,
  toolId: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  return new ComputerUseSkill(dataDir).run(toolId, args, signal);
}

export async function runOriginSkill(
  dataDir: string,
  toolId: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  context: OriginContext = {},
): Promise<unknown> {
  return new OriginSkill(dataDir, context).run(toolId, args, signal);
}

export async function runAntigravitySkill(
  dataDir: string,
  toolId: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  context: AntigravityContext = {},
): Promise<unknown> {
  return new AntigravitySkill(dataDir, context).run(toolId, args, signal);
}
