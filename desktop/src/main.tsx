import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { startTelemetry } from "./infrastructure/telemetry";
import { App } from "./presentation/App";
import type { SettingsPage } from "./presentation/Settings";
import { SettingsWindow } from "./presentation/SettingsWindow";
import "./app.css";

startTelemetry();

// The Electron main process opens "#settings" (or "#settings/<page>") for the Settings-only window.
const [windowKind, settingsPage] = window.location.hash.replace(/^#/, "").split("/");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {windowKind === "settings" ? <SettingsWindow initialPage={(settingsPage || undefined) as SettingsPage | undefined} /> : <App />}
  </StrictMode>,
);
