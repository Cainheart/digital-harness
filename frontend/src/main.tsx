import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ReadinessPage } from "./features/readiness/ReadinessPage";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ReadinessPage />
  </StrictMode>,
);
