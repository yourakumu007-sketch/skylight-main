// Velocity-drive safety + smoothness math in the VISCA driver: the
// soft-margin limit guard on the dead-reckoned pose, and the sigma-delta
// speed-step dither. The driver is constructed but never start()ed, so no
// socket exists and every send is a no-op — these tests poke the internal
// state the way position replies would.

import { describe, expect, it } from "vitest";
import type { CameraLimits, ViscaUnitScale } from "@shared/index.js";
import { ViscaCamera } from "../src/camera/visca.js";

const UNITS: ViscaUnitScale = {
  panUnitsPerDeg: 71.714,
  tiltUnitsPerDeg: 69.333,
  panZeroUnits: 12550,
  tiltZeroUnits: 6240,
  zoomWideUnits: 0,
  zoomTeleUnits: 1437,
};
const LIMITS: CameraLimits = {
  panMinDeg: -175,
  panMaxDeg: 175,
  tiltMinDeg: -90,
  tiltMaxDeg: 90,
  panSpeedMaxDps: 65,
  tiltSpeedMaxDps: 55,
};

function makeCam(): ViscaCamera {
  return new ViscaCamera({ ip: "127.0.0.1", port: 1, units: UNITS, limits: LIMITS });
}

/** Inject a "position reply" the way onMessage would. */
function setPose(cam: ViscaCamera, panDeg: number, tiltDeg: number, ageMs = 0): void {
  const c = cam as unknown as {
    pose: { panDeg: number; tiltDeg: number; zoomUnits: number };
    lastPanTiltReplyAt: number;
  };
  c.pose = { panDeg, tiltDeg, zoomUnits: 0 };
  c.lastPanTiltReplyAt = Date.now() - ageMs;
}

const cmdRates = (cam: ViscaCamera) =>
  cam as unknown as { cmdPanDps: number; cmdTiltDps: number };

describe("trackRate limit guard", () => {
  it("cuts drives toward a stop inside the soft margin", () => {
    const cam = makeCam();
    setPose(cam, 174, 0); // 1° from the +175 stop (margin is 2.5°)
    cam.trackRate(20, 0);
    expect(cmdRates(cam).cmdPanDps).toBe(0);
    // Driving AWAY from the stop stays allowed.
    cam.trackRate(-20, 0);
    expect(cmdRates(cam).cmdPanDps).toBe(-20);
  });

  it("dead-reckons a stale pose forward before the guard", () => {
    const cam = makeCam();
    // Last reply 2 s ago at 165°, while we were commanding +30°/s: the real
    // head is at the stop NOW even though the last report looks safe.
    setPose(cam, 165, 0, 2000);
    cmdRates(cam).cmdPanDps = 30;
    cam.trackRate(30, 0);
    expect(cmdRates(cam).cmdPanDps).toBe(0);
  });

  it("a fresh pose away from limits passes rates through", () => {
    const cam = makeCam();
    setPose(cam, 0, 10);
    cam.trackRate(12, -7);
    expect(cmdRates(cam).cmdPanDps).toBe(12);
    expect(cmdRates(cam).cmdTiltDps).toBe(-7);
  });

  it("never velocity-drives blind (no pose at all)", () => {
    const cam = makeCam();
    cam.trackRate(20, 10);
    expect(cmdRates(cam).cmdPanDps).toBe(0);
    expect(cmdRates(cam).cmdTiltDps).toBe(0);
  });

  it("guards tilt limits too", () => {
    const cam = makeCam();
    setPose(cam, 0, 88.5);
    cam.trackRate(0, 5);
    expect(cmdRates(cam).cmdTiltDps).toBe(0);
    cam.trackRate(0, -5);
    expect(cmdRates(cam).cmdTiltDps).toBe(-5);
  });
});

describe("getPoseEstimate", () => {
  it("integrates the commanded rate since the last reply", () => {
    const cam = makeCam();
    setPose(cam, 10, 5, 1000); // 1 s stale
    cmdRates(cam).cmdPanDps = 20;
    cmdRates(cam).cmdTiltDps = -4;
    const est = cam.getPoseEstimate()!;
    expect(est.panDeg).toBeCloseTo(30, 0);
    expect(est.tiltDeg).toBeCloseTo(1, 0);
  });

  it("returns the raw pose when idle", () => {
    const cam = makeCam();
    setPose(cam, 10, 5, 5000); // very stale but nothing commanded
    const est = cam.getPoseEstimate()!;
    expect(est.panDeg).toBe(10);
    expect(est.tiltDeg).toBe(5);
  });

  it("caps extrapolation at the mechanical limits", () => {
    const cam = makeCam();
    setPose(cam, 170, 0, 3000);
    cmdRates(cam).cmdPanDps = 50;
    expect(cam.getPoseEstimate()!.panDeg).toBe(175);
  });
});

describe("flushWanted gate", () => {
  type Internals = {
    flushWanted(): void;
    lastSent: { panDeg: number; tiltDeg: number } | null;
    lastSentAt: number;
  };
  const internals = (cam: ViscaCamera) => cam as unknown as Internals;

  it("absolute after a velocity-pursuit session transmits immediately", () => {
    const cam = makeCam();
    const c = internals(cam);
    // An old absolute era: goal 118/15 (home), camera arrived there.
    setPose(cam, 118, 15);
    cam.gotoAbsolute({ panDeg: 118, tiltDeg: 15, zoomUnits: 0 });
    c.flushWanted();
    expect(c.lastSent?.panDeg).toBeCloseTo(118);
    // A pursuit drags the camera far away (lastSent must be invalidated).
    cam.trackRate(10, 5);
    setPose(cam, -60, 25);
    // Pass ends -> home again, SAME goal as last time: this is the exact
    // case that used to be suppressed forever ("never returns to SFO").
    cam.gotoAbsolute({ panDeg: 118, tiltDeg: 15, zoomUnits: 0 });
    c.flushWanted();
    expect(c.lastSent?.panDeg).toBeCloseTo(118);
    expect(c.lastSent?.tiltDeg).toBeCloseTo(15);
  });

  it("suppresses small mid-slew retargets, then expires on the clock", () => {
    const cam = makeCam();
    const c = internals(cam);
    setPose(cam, 0, 0);
    cam.gotoAbsolute({ panDeg: 100, tiltDeg: 0, zoomUnits: 0 });
    c.flushWanted();
    expect(c.lastSent?.panDeg).toBeCloseTo(100);
    // 5° goal jitter while traveling (< RETARGET 12°): held back, no
    // ramp-restart.
    cam.gotoAbsolute({ panDeg: 105, tiltDeg: 0, zoomUnits: 0 });
    c.flushWanted();
    expect(c.lastSent?.panDeg).toBeCloseTo(100);
    // ...but the suppression has a hard expiry even with no position reply.
    c.lastSentAt = Date.now() - 60_000;
    c.flushWanted();
    expect(c.lastSent?.panDeg).toBeCloseTo(105);
  });

  it("big retargets preempt mid-slew", () => {
    const cam = makeCam();
    const c = internals(cam);
    setPose(cam, 0, 0);
    cam.gotoAbsolute({ panDeg: 100, tiltDeg: 0, zoomUnits: 0 });
    c.flushWanted();
    cam.gotoAbsolute({ panDeg: 140, tiltDeg: 0, zoomUnits: 0 }); // 40° jump
    c.flushWanted();
    expect(c.lastSent?.panDeg).toBeCloseTo(140);
  });
});

describe("sigma-delta dither", () => {
  // Synthetic two-step table: 3.6 and 14.8 °/s (the real pan step 1→2 gap,
  // the widest in the table and the worst case for ripple).
  const TABLE: [number, number][] = [
    [1, 3.6],
    [2, 14.8],
  ];
  const rateOf = (step: number) => (step === 1 ? 3.6 : step === 2 ? 14.8 : 0);

  function run(want: number, seconds: number) {
    const cam = makeCam() as unknown as {
      pickDithered(
        st: { onHi: boolean; since: number; acc: number; lastAt: number },
        table: [number, number][],
        want: number,
        now: number,
      ): number;
    };
    const st = { onHi: false, since: 0, acc: 0, lastAt: 0 };
    const dt = 1000 / 15; // 15 Hz tick, ms
    const t0 = 1_000_000;
    let dist = 0;
    let flips = 0;
    let prev = -1;
    const pos: number[] = [];
    const n = Math.round((seconds * 1000) / dt);
    for (let i = 0; i < n; i++) {
      const step = cam.pickDithered(st, TABLE, want, t0 + i * dt);
      if (prev >= 0 && step !== prev) flips++;
      prev = step;
      dist += rateOf(step) * (dt / 1000);
      pos.push(dist);
    }
    // Detrended ripple = peak deviation from the mean-rate line. (The mean-
    // rate error itself is absorbed by the control loop's P/I term; what the
    // eye sees as wobble is the oscillation AROUND it.)
    const meanStep = (pos[n - 1] - pos[0]) / (n - 1);
    let ripple = 0;
    for (let i = 0; i < n; i++) {
      ripple = Math.max(ripple, Math.abs(pos[i] - pos[0] - meanStep * i));
    }
    return { avg: dist / seconds, flips, ripple };
  }

  it("time-averaged rate converges on the wanted rate", () => {
    const { avg } = run(9, 10);
    expect(avg).toBeGreaterThan(8.2);
    expect(avg).toBeLessThan(9.8);
  });

  it("bounds the detrended position ripple at the worst speed-step gap", () => {
    // Wanted 9 °/s sits mid-gap between 3.6 and 14.8 — the hardest case, and
    // the slow-pan rate band where wobble was reported. The 60 ms dwell keeps
    // the oscillation under ~0.5° (the old 260 ms dwell gave ~1.5°).
    const { ripple, flips } = run(9, 10);
    expect(ripple).toBeLessThan(0.6);
    expect(flips).toBeGreaterThan(4); // it must actually dither
  });

  it("holds a single step when the want sits on it", () => {
    const { flips, avg } = run(14.5, 5); // within 7% of step 2 -> no dither
    expect(flips).toBeLessThanOrEqual(1);
    expect(avg).toBeCloseTo(14.8, 1);
  });

  it("rests below the duty-cycle floor", () => {
    const { avg } = run(0.3, 2); // < 15% of the table floor
    expect(avg).toBe(0);
  });
});
