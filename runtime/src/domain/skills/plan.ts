type StepStatus = "pending" | "in_progress" | "completed";
export type PlanStep = { step: string; status: StepStatus };

/** A task plan with exactly one step in progress until every step is completed. */
export class TaskPlan {
  private constructor(
    readonly explanation: string,
    readonly steps: PlanStep[],
  ) {}

  static fromArgs(args: Record<string, unknown>): TaskPlan {
    const raw = Array.isArray(args.steps) ? args.steps : [];
    if (!raw.length) throw new Error("Plan needs at least one step");
    const steps = raw.map((item, index): PlanStep => {
      if (typeof item === "string") {
        return { step: item, status: index === 0 ? "in_progress" : "pending" };
      }
      if (!item || typeof item !== "object") throw new Error("Each step needs a description and a status");
      const record = item as { step?: unknown; status?: unknown };
      const step = text(record.step);
      const status = text(record.status);
      if (!step) throw new Error("Each step needs a description");
      if (status !== "pending" && status !== "in_progress" && status !== "completed") {
        throw new Error("Step status must be pending, in_progress, or completed");
      }
      return { step, status };
    });
    const active = steps.filter((item) => item.status === "in_progress").length;
    const open = steps.some((item) => item.status !== "completed");
    if (open && active !== 1) throw new Error("Keep exactly one step in progress");
    if (!open && active !== 0) throw new Error("A finished plan has no step in progress");
    return new TaskPlan(text(args.explanation), steps);
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}
