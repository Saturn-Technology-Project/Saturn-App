import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { startTelemetry } from "./infrastructure/telemetry";
import { App } from "./presentation/App";
import "./app.css";

startTelemetry();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
