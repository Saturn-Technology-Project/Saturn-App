import type { Agent, Model, Run } from "./model.js";

export function isBusy(run: Run | undefined): boolean {
  return run?.status === "running" || run?.status === "queued";
}

export function visibleThread(thread: Run[], editingId: string | null): { visible: Run[]; editIndex: number } {
  const editIndex = editingId ? thread.findIndex((item) => item.id === editingId) : -1;
  return { visible: editIndex >= 0 ? thread.slice(0, editIndex + 1) : thread, editIndex };
}

export function upsertRun(list: Run[], run: Run): Run[] {
  return list.some((item) => item.id === run.id) ? list.map((item) => (item.id === run.id ? run : item)) : [...list, run];
}

export function replaceRevised(list: Run[], run: Run, removed: string[]): Run[] {
  return upsertRun(list.filter((item) => !removed.includes(item.id)), run);
}

export function modelLabel(models: Model[], agent: Agent | null): string {
  const model = models.find((item) => item.id === agent?.modelConnectionId);
  if (!model) return "No model";
  return model.hasSecret ? model.name : `${model.name} · no key`;
}

export function avatarInitial(name: string): string {
  return (name.trim()[0] || "S").toUpperCase();
}
