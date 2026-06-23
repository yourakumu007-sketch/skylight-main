import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Stream } from "./Stream.js";
import "../styles/tracker.css"; // SkyPolar styles
import "../styles/stream.css"; // vertical 9:16 layout

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Stream />
  </StrictMode>,
);
