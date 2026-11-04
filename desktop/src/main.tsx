import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./presentation/App";
import { ResearchApp } from "./presentation/shell/ResearchApp";
import "./styles/tokens.css";
import "./app.css";
import "./styles/ui.css";
import "./styles/shell.css";
import "./styles/workspace.css";
import "./styles/assistant.css";

// The new interface beside the old one until it replaces it.
const research = new URLSearchParams(location.search).has("research");

createRoot(document.getElementById("root")!).render(
  <StrictMode>{research ? <ResearchApp /> : <App />}</StrictMode>,
);
