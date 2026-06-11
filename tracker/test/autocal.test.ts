// Continuous auto-calibration: samples from locked passes refit the mount.
// Synthesizes truth under a KNOWN model and checks the calibrator recovers
// it from a wrong initial guess — and that the apply guards hold.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mountFromWorld, norm180, type MountModel } from "@shared/index.js";
import { AutoCalibrator, rmsUnder, type AutoCalSample } from "../src/calibration/auto.js";

const TRUE_MOUNT: MountModel = {
  panOffsetDeg: 182.5, // the body rotated 2.5° off the configured 180
  tiltOffsetDeg: -0.8,
  panGain: 1,
  tiltGain: 1,
  levelTiltDeg: 0,
  levelDirDeg: 0,
};
const CONFIGURED: MountModel = {
  panOffsetDeg: 180,
  tiltOffsetDeg: 0,
  panGain: 1,
  tiltGain: 1,
  levelTiltDeg: 0,
  levelDirDeg: 0,
};

/** A sample as the loop would synthesize it: the mechanical pose that
 *  centers the plane (generated under the TRUE mount), paired with truth. */
function sampleAt(azDeg: number, elDeg: number, t: number): AutoCalSample {
  const pt = mountFromWorld(azDeg, elDeg, TRUE_MOUNT);
  return { panDeg: pt.panDeg, tiltDeg: pt.tiltDeg, azDeg, elDeg, t };
}

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "autocal-"));
  file = join(dir, "autocal.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Spread samples across a realistic pass diversity. */
function feed(cal: AutoCalibrator, n: number, t0: number): number {
  let t = t0;
  let added = 0;
  for (let i = 0; i < n; i++) {
    const az = (i * 47) % 360;
    const el = 12 + ((i * 13) % 50);
    if (cal.add(sampleAt(az, el, t))) added++;
    t += 2000;
  }
  return added;
}

describe("AutoCalibrator", () => {
  it("recovers a rotated-base offset from pass samples", () => {
    const cal = new AutoCalibrator(file);
    const t0 = 1_000_000_000;
    feed(cal, 20, t0);
    const out = cal.trySolve(CONFIGURED, t0 + 60_000);
    expect(out).not.toBeNull();
    expect(norm180(out!.model.panOffsetDeg - TRUE_MOUNT.panOffsetDeg)).toBeCloseTo(0, 1);
    expect(out!.model.tiltOffsetDeg).toBeCloseTo(TRUE_MOUNT.tiltOffsetDeg, 1);
    expect(out!.rmsAfterDeg).toBeLessThan(0.1);
    expect(out!.rmsAfterDeg).toBeLessThan(out!.rmsBeforeDeg);
  });

  it("refuses to apply when the current model is already good", () => {
    const cal = new AutoCalibrator(file);
    const t0 = 1_000_000_000;
    feed(cal, 20, t0);
    // Solving against the TRUE mount: nothing to improve -> no apply.
    const out = cal.trySolve(TRUE_MOUNT, t0 + 60_000);
    expect(out).toBeNull();
  });

  it("needs a minimum sample count", () => {
    const cal = new AutoCalibrator(file);
    const t0 = 1_000_000_000;
    feed(cal, 6, t0);
    expect(cal.trySolve(CONFIGURED, t0 + 60_000)).toBeNull();
  });

  it("rejects pathological jumps (bad data, not a rotated base)", () => {
    const cal = new AutoCalibrator(file);
    const t0 = 1_000_000_000;
    let t = t0;
    for (let i = 0; i < 20; i++) {
      const az = (i * 47) % 360;
      const el = 12 + ((i * 13) % 50);
      // Truth shifted 25° — way past MAX_OFFSET_STEP. Must refuse.
      const pt = mountFromWorld(az, el, {
        ...TRUE_MOUNT,
        panOffsetDeg: 205,
      });
      cal.add({ panDeg: pt.panDeg, tiltDeg: pt.tiltDeg, azDeg: az, elDeg: el, t });
      t += 2000;
    }
    expect(cal.trySolve(CONFIGURED, t0 + 60_000)).toBeNull();
  });

  it("rate-limits sample intake", () => {
    const cal = new AutoCalibrator(file);
    const t0 = 1_000_000_000;
    expect(cal.add(sampleAt(100, 30, t0))).toBe(true);
    expect(cal.add(sampleAt(101, 30, t0 + 300))).toBe(false); // too soon
    expect(cal.add(sampleAt(101, 30, t0 + 2000))).toBe(true);
  });

  it("persists samples across restarts", () => {
    const t0 = 1_000_000_000;
    {
      const cal = new AutoCalibrator(file);
      feed(cal, 20, t0);
      // Force a save by triggering a solve (saves on success).
      cal.trySolve(CONFIGURED, t0 + 60_000);
    }
    const cal2 = new AutoCalibrator(file);
    expect(cal2.status(CONFIGURED).samples).toBeGreaterThanOrEqual(12);
  });

  it("rmsUnder measures model error over samples", () => {
    const samples = Array.from({ length: 10 }, (_, i) =>
      sampleAt((i * 36) % 360, 20 + i * 3, 1_000_000_000 + i * 2000),
    );
    expect(rmsUnder(samples, TRUE_MOUNT)).toBeLessThan(1e-6);
    expect(rmsUnder(samples, CONFIGURED)).toBeGreaterThan(1.5);
  });
});
