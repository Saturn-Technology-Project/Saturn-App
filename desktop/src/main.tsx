import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ResearchApp } from "./presentation/shell/ResearchApp";
import "./styles/tokens.css";
import "./styles/components.css";
import "./styles/ui.css";
import "./styles/shell.css";
import "./styles/workspace.css";
import "./styles/assistant.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ResearchApp />
  </StrictMode>,
);
