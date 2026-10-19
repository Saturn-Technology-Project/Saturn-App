import { useEffect, useRef, useState } from "react";
import type { Autonomy } from "../domain/model.js";
import {
  GUARDRAIL_MODES,
  normalizeGuardrailMode,
  type GuardrailModeId,
} from "../domain/conversation.js";

export function GuardrailShieldIcon(props: {
  variant: "eye" | "lock" | "star" | "exclamation";
  size?: number;
  className?: string;
}) {
  const size = props.size ?? 15;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
      aria-hidden="true"
    >
      {/* Base Shield Contour */}
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      {/* Inner glyph */}
      {props.variant === "eye" && (
        <>
          <circle cx="12" cy="11.5" r="1.5" fill="currentColor" />
          <path d="M8.5 11.5c1-1.8 2.2-2.5 3.5-2.5s2.5.7 3.5 2.5c-1 1.8-2.2 2.5-3.5 2.5s-2.5-.7-3.5-2.5z" strokeWidth="1.3" />
        </>
      )}
      {props.variant === "lock" && (
        <>
          <rect x="9" y="11" width="6" height="4.5" rx="1" fill="currentColor" stroke="none" />
          <path d="M10 11V9a2 2 0 0 1 4 0v2" strokeWidth="1.5" />
        </>
      )}
      {props.variant === "star" && (
        <path
          d="M12 7.5l1.1 2.4 2.6.2-2 1.6.7 2.5-2.4-1.4-2.4 1.4.7-2.5-2-1.6 2.6-.2z"
          fill="currentColor"
          strokeWidth="0.8"
        />
      )}
      {props.variant === "exclamation" && (
        <>
          <path d="M12 8.5v3.5" strokeWidth="2.2" />
          <circle cx="12" cy="14.8" r="1" fill="currentColor" stroke="none" />
        </>
      )}
    </svg>
  );
}

export function GuardrailSelector(props: {
  autonomy?: Autonomy;
  disabled?: boolean;
  onChange: (mode: GuardrailModeId) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const activeModeId = normalizeGuardrailMode(props.autonomy);
  const activeOption = GUARDRAIL_MODES.find((item) => item.id === activeModeId) ?? GUARDRAIL_MODES[1];

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
    <div className="composer-guardrail-anchor" ref={containerRef}>
      <button
        type="button"
        className={`composer-guardrail-btn${open ? " active" : ""}`}
        disabled={props.disabled}
        onClick={() => setOpen((prev) => !prev)}
        title={`Guardrail mode: ${activeOption.title} (${activeOption.description})`}
        aria-haspopup="true"
        aria-expanded={open}
      >
        <GuardrailShieldIcon variant={activeOption.icon} className="guardrail-btn-icon" />
        <span className="guardrail-btn-label">{activeOption.title}</span>
        <svg
          className={`guardrail-btn-chevron${open ? " open" : ""}`}
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
        <div className="guardrail-popover" role="menu">
          {GUARDRAIL_MODES.map((mode) => {
            const isSelected = mode.id === activeModeId;
            return (
              <button
                key={mode.id}
                type="button"
                role="menuitem"
                className={`guardrail-menu-item${isSelected ? " selected" : ""}`}
                onClick={() => {
                  props.onChange(mode.id);
                  setOpen(false);
                }}
              >
                <div className="guardrail-item-icon">
                  <GuardrailShieldIcon variant={mode.icon} size={16} />
                </div>
                <div className="guardrail-item-text">
                  <div className="guardrail-item-title-row">
                    <span className="guardrail-item-title">{mode.title}</span>
                    {mode.badge && <span className="guardrail-item-badge">{mode.badge}</span>}
                  </div>
                  <span className="guardrail-item-desc">{mode.description}</span>
                </div>
                {isSelected && (
                  <div className="guardrail-item-check" aria-hidden="true">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3.5 8.5l3 3 6-7" />
                    </svg>
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
