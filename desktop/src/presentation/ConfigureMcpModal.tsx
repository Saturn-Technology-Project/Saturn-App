import { useState } from "react";
import type { Mcp, McpTool } from "../domain/model.js";

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
      for (const t of tools) {
        if (action === "allow") {
          next.delete(t.toolId);
        } else {
          next.add(t.toolId);
        }
      }
      return next;
    });
  };

  const getSectionStatus = (tools: McpTool[]): "Allow all" | "Block all" | "Custom" => {
    if (tools.length === 0) return "Allow all";
    const allAllowed = tools.every((t) => !disabled.has(t.toolId));
    if (allAllowed) return "Allow all";
    const allBlocked = tools.every((t) => disabled.has(t.toolId));
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
      <div className="configure-mcp-section">
        <div className="configure-mcp-section-header">
          <span className="configure-mcp-section-title">{title}</span>
          <div className="configure-mcp-dropdown-wrap">
            <select
              className="configure-mcp-dropdown"
              value={status}
              onChange={(e) => {
                if (e.target.value === "Allow all") handleBatchSelect(tools, "allow");
                else if (e.target.value === "Block all") handleBatchSelect(tools, "block");
              }}
            >
              <option value="Allow all">Allow all</option>
              <option value="Block all">Block all</option>
              {status === "Custom" && <option value="Custom">Custom</option>}
            </select>
          </div>
        </div>
        <div className="configure-mcp-tool-list">
          {tools.map((tool) => {
            const isEnabled = !disabled.has(tool.toolId);
            return (
              <div key={tool.toolId} className="configure-mcp-tool-row">
                <span className="configure-mcp-tool-name">{tool.toolId}</span>
                <label className="cursor-switch">
                  <input
                    type="checkbox"
                    checked={isEnabled}
                    onChange={() => toggleTool(tool.toolId)}
                  />
                  <span className="cursor-slider round"></span>
                </label>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="modal-backdrop configure-mcp-overlay" onClick={onClose}>
      <div className="configure-mcp-dialog" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="configure-mcp-header">
          <div className="configure-mcp-title-wrap">
            <h2 className="configure-mcp-title">Configure {server.name}</h2>
            <span className="configure-mcp-source-badge">1 source</span>
          </div>
          <button className="configure-mcp-close-btn" type="button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="configure-mcp-body">
          {renderSection("Reads", reads)}
          {renderSection("Writes", writes)}
        </div>

        {/* Footer */}
        <div className="configure-mcp-footer">
          <button
            className="configure-mcp-reload-btn"
            type="button"
            onClick={() => void handleReload()}
            disabled={reloading}
          >
            <span className={`reload-icon ${reloading ? "spinning" : ""}`}>↻</span>
            <span>Reload</span>
          </button>
          <button
            className="configure-mcp-done-btn"
            type="button"
            onClick={() => void handleDone()}
            disabled={saving}
          >
            {saving ? "Saving..." : "Done"}
          </button>
        </div>
      </div>
    </div>
  );
}
