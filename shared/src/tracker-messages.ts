// WebSocket message contracts between the tracker debug UI and the tracker
// process (separate from the display/control <-> server contract).

import type { TrackerConfig, TrackerConfigPatch } from "./config.js";
import type {
  CalibrationRef,
  TargetMode,
  TrackerMode,
  TrackerState,
} from "./camera.js";

/** Tracker -> UI. */
export type TrackerServerMessage =
  | { type: "trackerState"; state: TrackerState }
  | { type: "trackerConfig"; config: TrackerConfig }
  | { type: "log"; level: "info" | "warn" | "error"; line: string; t: number };

/** UI -> tracker. */
export type TrackerClientMessage =
  | { type: "hello"; role: "tracker-ui" }
  | { type: "setMode"; mode: TrackerMode }
  | { type: "setTargetMode"; mode: TargetMode }
  /** Continuous jog; components in [-1, 1] of max speed. */
  | { type: "jog"; pan: number; tilt: number; zoom: number }
  | { type: "stopJog" }
  /** Force a target by hex (manual mode), or null to release. */
  | { type: "manualTarget"; hex: string | null }
  /** Point at a world direction (calibration verify). */
  | { type: "gotoAzEl"; azDeg: number; elDeg: number }
  /** Raw mechanical move (units-per-degree measurement). */
  | { type: "gotoPanTilt"; panDeg: number; tiltDeg: number; zoomUnits?: number }
  | { type: "patchTracker"; patch: TrackerConfigPatch }
  | { type: "calibCapture"; ref: CalibrationRef }
  | { type: "calibRemove"; id: string }
  | { type: "calibSolve"; solveGains: boolean; solveLevel: boolean }
  /** Persist the last solved model into config. */
  | { type: "calibApply" }
  | { type: "calibReset" }
  | { type: "record"; on: boolean };
