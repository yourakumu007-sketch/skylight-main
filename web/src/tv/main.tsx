import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Tv } from "./Tv.js";
import "../styles/tracker.css"; // SkyPolar styles
import "../styles/tv.css"; // overrides for the lean-back layout

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Tv />
  </StrictMode>,
);
