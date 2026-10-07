import path from "node:path";
import { TaskPlan } from "../../domain/skills/plan.js";
import { Workspace } from "../../domain/skills/workspace.js";
import { CodeSkill } from "./code-skill.js";
import { FileSkill } from "./file-skill.js";
import { text } from "./text.js";
import { WebSkill } from "./web-skill.js";

const DIRECT_SKILLS = ["chat", "files", "code", "mcp", "web", "multi_step"];

export type ToolCaller = (toolId: string, args: Record<string, unknown>) => Promise<unknown>;

/** The six built-in skills. Each one is its own object; this class only chooses which to run. */
export class GeneralSkills {
  private readonly workspace: Workspace;
  private readonly files: FileSkill;
  private readonly code: CodeSkill;
  private readonly web = new WebSkill();

  constructor(
    dataDir: string,
    private readonly callTool?: ToolCaller,
    private readonly signal?: AbortSignal,
  ) {
    this.workspace = new Workspace(path.join(dataDir, "workspace"));
    this.files = new FileSkill(this.workspace);
    this.code = new CodeSkill(this.workspace);
  }

  async run(toolId: string, args: Record<string, unknown>): Promise<unknown> {
    if (toolId === "chat") return { message: text(args.message) };
    if (toolId === "files") return this.files.run(args);
    if (toolId === "code") return this.code.run(args, this.signal);
    if (toolId === "web") return this.web.run(args, this.signal);
    if (toolId === "multi_step") {
      const plan = TaskPlan.fromArgs(args);
      return { explanation: plan.explanation, steps: plan.steps };
    }
    if (toolId === "mcp") return this.callMcp(args);
    throw new Error(`Unknown skill: ${toolId}`);
  }

  private callMcp(args: Record<string, unknown>): Promise<unknown> {
    const tool = text(args.tool || args.toolId);
    if (!tool) throw new Error("Name the MCP tool to call");
    if (DIRECT_SKILLS.includes(tool)) throw new Error("Call that skill directly");
    if (!this.callTool) throw new Error("No other MCP server is enabled");
    const nested = args.arguments && typeof args.arguments === "object" ? (args.arguments as Record<string, unknown>) : {};
    return this.callTool(tool, nested);
  }
}
