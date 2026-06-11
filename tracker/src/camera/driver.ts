// The camera driver contract. Two implementations: the real VISCA-over-IP
// driver (visca.ts) and a software simulator (sim.ts) so the entire pipeline
// runs and is debuggable with zero hardware.

import type { CameraDiagnostics, CameraPose } from "@shared/index.js";

export interface CameraDriver {
  readonly kind: "sim" | "visca";

  start(): void;
  stop(): void;

  /**
   * Absolute move (mount-frame degrees + raw zoom units). Fire-and-forget:
   * the implementation queues/throttles; the latest call wins. Optional
   * per-axis speeds (deg/s) — used by "carrot" pursuit to glide: a goal
   * slightly ahead, at a speed matched to arrive exactly when the next goal
   * lands, never decelerates.
   */
  gotoAbsolute(pose: CameraPose, speeds?: { panDps?: number; tiltDps?: number }): void;

  /** Continuous jog. Components in [-1, 1] of max speed; 0 = stop that axis. */
  jog(pan: number, tilt: number, zoom: number): void;

  /**
   * Closed-loop velocity pursuit, deg/s per axis. Used while tracking — a
   * continuous drive glides where streamed absolute moves stutter (each
   * absolute move runs at max speed and hard-stops).
   */
  trackRate(panDps: number, tiltDps: number): void;

  /** Command zoom alone (tracking-time zoom updates). */
  setZoom(zoomUnits: number): void;

  /**
   * Pin focus at infinity (manual mode + drive to the far stop) — autofocus
   * has nothing to lock onto when a long lens points at open sky and hunts
   * the image soft. false = back to autofocus.
   */
  setFocusInfinity(on: boolean): void;

  /**
   * Trigger a single autofocus sweep on the current subject, then hold
   * (one-push AF). Used once the plane is zoomed in and vision-centered: the
   * lens isn't parfocal, so the infinity far-stop goes soft at high zoom —
   * focusing on the actual plane is the only reliable way to stay sharp.
   */
  onePushAutofocus(): void;

  /** Stop all motion. */
  stopMotion(): void;

  /** Last pose reported by the camera (inquiry / integrator), or null. */
  getPose(): CameraPose | null;

  /**
   * Best-estimate CURRENT pose: the last report dead-reckoned forward by the
   * commanded velocity (position replies stall around drives on the real
   * camera). Use this for limit guards and control-loop error terms.
   */
  getPoseEstimate(): CameraPose | null;

  diagnostics(): CameraDiagnostics;
}
