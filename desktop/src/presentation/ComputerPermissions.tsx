import { useEffect, useState } from "react";
import { desktop } from "../application/desktop";

type Which = "accessibility" | "screenRecording";
type Status = { platform: string; required: boolean; accessibility: boolean; screenRecording: boolean; error?: string };

const ROWS: { which: Which; label: string; detail: string }[] = [
  { which: "accessibility", label: "Accessibility", detail: "Lets agents click, type and read what is on screen." },
  { which: "screenRecording", label: "Screen Recording", detail: "Lets agents take screenshots to see what they are doing." },
];

/**
 * Asks macOS for a permission from the app itself, so macOS shows its prompt and lists Saturn in System Settings;
 * in a plain browser (no desktop bridge) it opens the System Settings pane instead.
 */
export async function requestPermission(which: Which): Promise<void> {
  const request = (globalThis as { saturnDesktop?: { requestPermission?: (which: Which) => Promise<{ granted: boolean }> } }).saturnDesktop?.requestPermission;
  const answer = request ? await request(which).catch(() => ({ granted: false })) : { granted: false };
  if (!answer.granted) await desktop.admin.openPermissionPane(which).catch(() => undefined);
}

/** The computer-use permissions with their state, a Request button each, and a re-check while one is pending. */
export function ComputerPermissions(props: { compact?: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    let stale = false;
    const load = () => desktop.admin.computerPermissions().then((next) => { if (!stale) setStatus(next); }, () => undefined);
    void load();
    // After a request the answer arrives in System Settings, not here: look again every few seconds.
    const timer = asked ? window.setInterval(() => void load(), 3000) : undefined;
    return () => {
      stale = true;
      if (timer) window.clearInterval(timer);
    };
  }, [asked]);

  if (status && !status.required) {
    return <p className="hint">Nothing to grant on {status.platform === "win32" ? "Windows" : "this system"}: agents can take screenshots and control apps already.</p>;
  }
  return (
    <ul className={props.compact ? "onboarding-list" : "permission-list"}>
      {ROWS.map((row) => {
        const granted = status?.[row.which] ?? false;
        return (
          <li key={row.which}>
            <strong>{row.label}</strong>
            <span className="hint">{row.detail}</span>
            {granted ? (
              <span className="onboarding-ok">✓ allowed</span>
            ) : (
              <span className="permission-actions">
                <button type="button" className="btn ghost tiny" onClick={() => { setAsked(true); void requestPermission(row.which); }}>Request</button>
                <button type="button" className="btn ghost tiny" onClick={() => void desktop.admin.openPermissionPane(row.which)}>Open System Settings</button>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
