import type { FileCheckpoint } from "../domain/skills/checkpoint.js";
import { GeneralSkills, type ToolCaller } from "./skills/general-skills.js";
import type { CodeOptions } from "./skills/code-skill.js";
import { ComputerUseSkill } from "./skills/computer-use-skill.js";
import { OriginSkill, type OriginContext } from "./skills/origin-skill.js";
import { AntigravitySkill, type AntigravityContext } from "./skills/antigravity-skill.js";
import { BrowserSkill, type BrowserMode } from "./skills/browser-skill.js";

const browsers = new Map<string, BrowserSkill>();

/** The agent's browser (one per runtime data dir; it closes itself when idle). */
/** The agent browser of a data folder (one per runtime), created on first use. */
export function browserFor(dataDir: string): BrowserSkill {
  let browser = browsers.get(dataDir);
  if (!browser) {
    browser = new BrowserSkill(dataDir);
    browsers.set(dataDir, browser);
  }
  return browser;
}

export async function runBrowserSkill(dataDir: string, toolId: string, args: Record<string, unknown>, signal?: AbortSignal, mode?: BrowserMode): Promise<unknown> {
  const browser = browserFor(dataDir);
  if (mode) await browser.setMode(mode);
  return browser.run(toolId, args, signal);
}

export async function runGeneralSkill(
  dataDir: string,
  toolId: string,
  args: Record<string, unknown>,
  callTool?: ToolCaller,
  signal?: AbortSignal,
  workdir?: string,
  checkpoint?: FileCheckpoint,
  code: CodeOptions = {},
): Promise<unknown> {
  return new GeneralSkills(dataDir, callTool, signal, workdir, checkpoint, code).run(toolId, args);
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
