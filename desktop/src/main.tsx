import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ResearchApp } from "./presentation/shell/ResearchApp";
import "./styles/tokens.css";
import "./styles/theme.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ResearchApp />
  </StrictMode>,
);
