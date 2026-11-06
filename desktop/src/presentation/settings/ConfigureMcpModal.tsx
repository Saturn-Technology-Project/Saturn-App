import { useState } from "react";
import { t } from "../../domain/i18n.js";
import type { Mcp, McpTool } from "../../domain/model.js";
import { Button } from "../ui/base/Button.js";
import { Checkbox } from "../ui/base/Checkbox.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/base/Dialog.js";
import { Choice } from "../ui/base/Field.js";

interface Props {
  server: Mcp;
  onClose: () => void;
  onSave: (disabledTools: string[]) => Promise<void>;
  onReload: () => Promise<void>;
}

export function ConfigureMcpModal({ server, onClose, onSave, onReload }: Props) {
  const [disabled, setDisabled] = useState<Set<string>>(new Set(server.disabledTools ?? []));
  const [reloading, setReloading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Group tools into Reads and Writes
  const reads: McpTool[] = [];
  const writes: McpTool[] = [];

  for (const tool of server.tools) {
    if (tool.category === "read") {
      reads.push(tool);
    } else if (tool.category === "write") {
      writes.push(tool);
    } else {
      // Fallback heuristics
      const name = tool.toolId.toLowerCase();
      if (
        name.startsWith("get_") ||
        name.startsWith("list_") ||
        name.startsWith("read_") ||
        name.endsWith("_read") ||
        name.startsWith("grep_") ||
        name.startsWith("compare_") ||
        name.startsWith("checks_")
      ) {
        reads.push(tool);
      } else {
        writes.push(tool);
      }
    }
  }

  const toggleTool = (toolId: string) => {
    setDisabled((prev) => {
      const next = new Set(prev);
      if (next.has(toolId)) {
        next.delete(toolId);
      } else {
        next.add(toolId);
      }
      return next;
    });
  };

  const handleBatchSelect = (tools: McpTool[], action: "allow" | "block") => {
    setDisabled((prev) => {
      const next = new Set(prev);
      for (const tool of tools) {
        if (action === "allow") {
          next.delete(tool.toolId);
        } else {
          next.add(tool.toolId);
        }
      }
      return next;
    });
  };

  const getSectionStatus = (tools: McpTool[]): "Allow all" | "Block all" | "Custom" => {
    if (tools.length === 0) return "Allow all";
    const allAllowed = tools.every((tool) => !disabled.has(tool.toolId));
    if (allAllowed) return "Allow all";
    const allBlocked = tools.every((tool) => disabled.has(tool.toolId));
    if (allBlocked) return "Block all";
    return "Custom";
  };

  const handleDone = async () => {
    setSaving(true);
    try {
      await onSave(Array.from(disabled));
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleReload = async () => {
    setReloading(true);
    try {
      await onReload();
    } finally {
      setReloading(false);
    }
  };

  const renderSection = (title: string, tools: McpTool[]) => {
    if (tools.length === 0) return null;
    const status = getSectionStatus(tools);

    return (
      <div className="flex flex-col">
        <div className="flex items-center justify-between border-b border-border pb-2">
          <span className="text-sm font-semibold text-foreground">{title}</span>
          <Choice
            ariaLabel={t("{section} tools", { section: title })}
            value={status}
            options={[
              { value: "Allow all", label: t("Allow all") },
              { value: "Block all", label: t("Block all") },
              ...(status === "Custom" ? [{ value: "Custom", label: t("Custom") }] : []),
            ]}
            onChange={(next) => {
              if (next === "Allow all") handleBatchSelect(tools, "allow");
              else if (next === "Block all") handleBatchSelect(tools, "block");
            }}
          />
        </div>
        <div className="flex flex-col">
          {tools.map((tool) => {
            const isEnabled = !disabled.has(tool.toolId);
            return (
              <div key={tool.toolId} className="flex items-center justify-between border-b border-border py-2 last:border-b-0">
                <span className="font-mono text-[13px] text-foreground">{tool.toolId}</span>
                <Checkbox aria-label={tool.toolId} checked={isEnabled} onCheckedChange={() => toggleTool(tool.toolId)} />
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[84vh] max-w-[92vw] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-[580px]" aria-label={t("Configure {name}", { name: server.name })}>
        <DialogHeader className="border-b border-border px-5.5 pt-4.5 pb-3.5">
          <DialogTitle className="text-[17px] font-semibold tracking-tight">{t("Configure {name}", { name: server.name })}</DialogTitle>
          <DialogDescription>{t("1 source")}</DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-col gap-5.5 overflow-y-auto px-5.5 py-4">
          {renderSection(t("Reads"), reads)}
          {renderSection(t("Writes"), writes)}
        </div>

        <DialogFooter className="items-center justify-between border-t border-border px-5.5 py-3.5">
          <Button type="button" variant="outline" onClick={() => void handleReload()} disabled={reloading}>
            <span className={reloading ? "inline-block animate-spin" : undefined}>↻</span>
            <span>{t("Reload")}</span>
          </Button>
          <Button type="button" onClick={() => void handleDone()} disabled={saving}>
            {saving ? t("Saving…") : t("Done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
