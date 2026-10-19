import { useEffect, useRef, useState } from "react";
import type { Model } from "../domain/model.js";
import type { SettingsPage } from "./Settings.js";

function getModelMetadata(model: Model) {
  const id = model.id.toLowerCase();
  const name = model.name.toLowerCase();

  let tier: string | null = null;
  if (name.includes("high") || id.includes("opus") || id.includes("pro") || id.includes("flash")) {
    tier = name.includes("high") ? "High" : id.includes("flash") ? "High" : "Medium";
  } else if (name.includes("medium") || id.includes("sonnet") || id.includes("argon")) {
    tier = "Medium";
  } else if (name.includes("low") || id.includes("haiku")) {
    tier = "Low";
  }

  const isNew = id.includes("argon") || id.includes("5-5") || id.includes("5.5") || id.includes("v4") || name.includes("argon");

  return { tier, isNew };
}

export function ModelSelector(props: {
  models: Model[];
  selectedModelId?: string | null;
  disabled?: boolean;
  variant?: "pill" | "form";
  onChange: (modelId: string | null) => void;
  onOpenUsage?: () => void;
  onOpenSettings?: (page: SettingsPage) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const isForm = props.variant === "form";

  const activeModel = props.models.find((item) => item.id === props.selectedModelId) ?? null;

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className={`composer-model-anchor${isForm ? " form-style" : ""}`} ref={containerRef}>
      <button
        type="button"
        className={`composer-model-btn${isForm ? " form-style" : ""}${open ? " active" : ""}`}
        disabled={props.disabled}
        onClick={() => setOpen((prev) => !prev)}
        title={`Active model: ${activeModel ? activeModel.name : "None"}`}
        aria-haspopup="true"
        aria-expanded={open}
      >
        <div style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          {!isForm && <span className="model-btn-prefix">Model</span>}
          <span className="model-btn-label">{activeModel ? activeModel.name : isForm ? "None (Select a model)" : "None"}</span>
          {activeModel && !activeModel.hasSecret && (
            <span className="model-btn-warn" title="No API key saved">
              ⚠️
            </span>
          )}
        </div>
        <svg
          className={`model-btn-chevron${open ? " open" : ""}`}
          width="10"
          height="10"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M4 10l4-4 4 4" />
        </svg>
      </button>

      {open && (
        <div className={`model-popover${isForm ? " form-style" : ""}`} role="menu">
          <div className="model-popover-header">Model</div>

          <div className="model-popover-list">
            <button
              type="button"
              role="menuitem"
              className={`model-menu-item${!props.selectedModelId ? " selected" : ""}`}
              onClick={() => {
                props.onChange(null);
                setOpen(false);
              }}
            >
              <div className="model-item-left">
                <span className="model-item-name">None</span>
              </div>
              {!props.selectedModelId && (
                <div className="model-item-check" aria-hidden="true">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3.5 8.5l3 3 6-7" />
                  </svg>
                </div>
              )}
            </button>

            {props.models.map((item) => {
              const isSelected = item.id === props.selectedModelId;
              const meta = getModelMetadata(item);
              return (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  className={`model-menu-item${isSelected ? " selected" : ""}`}
                  onClick={() => {
                    props.onChange(item.id);
                    setOpen(false);
                  }}
                >
                  <div className="model-item-left">
                    <span className="model-item-name">{item.name}</span>
                  </div>

                  <div className="model-item-right">
                    {meta.tier && <span className="model-item-tier">{meta.tier}</span>}
                    {!item.hasSecret && (
                      <span className="model-item-warn" title="API key missing">
                        ⚠️
                      </span>
                    )}
                    {meta.isNew && <span className="model-item-badge">New</span>}

                    {isSelected ? (
                      <div className="model-item-check" aria-hidden="true">
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3.5 8.5l3 3 6-7" />
                        </svg>
                      </div>
                    ) : (
                      <div className="model-item-arrow" aria-hidden="true">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="m9 18 6-6-6-6" />
                        </svg>
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="model-popover-divider" />

          {props.onOpenUsage && (
            <button
              type="button"
              className="model-popover-action"
              onClick={() => {
                props.onOpenUsage?.();
                setOpen(false);
              }}
            >
              <div className="model-action-left">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m12 14 4-4" />
                  <path d="M3.34 19a10 10 0 1 1 17.32 0" />
                </svg>
                <span>View Usage</span>
              </div>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>
          )}

          {props.onOpenSettings && (
            <button
              type="button"
              className="model-popover-action"
              onClick={() => {
                props.onOpenSettings?.("llm");
                setOpen(false);
              }}
            >
              <div className="model-action-left">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
                <span>Manage Models</span>
              </div>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
