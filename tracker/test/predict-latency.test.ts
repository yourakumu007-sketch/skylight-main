// Motor-latency lead: the aim point must be evaluated where the plane will
// be when the command BITES (UDP + firmware + accel ramp), not when it's
// sent — otherwise the camera trails the plane by exactly that latency.

import { describe, expect, it } from "vitest";
import type { Aircraft, CameraLimits, GeoPoint, MountModel } from "@shared/index.js";
import { predictAim, TrackHistory } from "../src/pointing/predict.js";

const SITE: GeoPoint = { lat: 37.6213, lon: -122.379, altM: 0 };
const MOUNT: MountModel = {
  panOffsetDeg: 180,
  tiltOffsetDeg: 0,
  panGain: 1,
  tiltGain: 1,
  levelTiltDeg: 0,
  levelDirDeg: 0,
};
const LIMITS: CameraLimits = {
  panMinDeg: -175,
  panMaxDeg: 175,
  tiltMinDeg: -90,
  tiltMaxDeg: 90,
  panSpeedMaxDps: 65,
  tiltSpeedMaxDps: 55,
};

const now = 1_000_000;
/** Eastbound plane due north of the site. */
const PLANE: Aircraft = {
  hex: "abc123",
  lat: SITE.lat + 0.05,
  lon: SITE.lon,
  altGeom: 5000,
  gs: 300,
  track: 90,
  ts: now,
  seen: 0,
};

const params = (motorLatencySec: number) => ({
  adsbLatencySec: 0.6,
  motorLatencySec,
  maxLeadSec: 5,
});

describe("predictAim motor latency", () => {
  it("extends the lead by the motor latency", () => {
    const hist = new TrackHistory();
    const base = predictAim(PLANE, SITE, now, hist, params(0), MOUNT, LIMITS, {
      panDeg: 0,
      tiltDeg: 10,
    })!;
    const lagged = predictAim(PLANE, SITE, now, hist, params(0.5), MOUNT, LIMITS, {
      panDeg: 0,
      tiltDeg: 10,
    })!;
    expect(lagged.leadSec).toBeCloseTo(base.leadSec + 0.5, 1);
    // Eastbound plane -> the lagged aim is further east (greater azimuth).
    expect(lagged.azEl.azDeg).toBeGreaterThan(base.azEl.azDeg);
  });

  it("omitted motorLatencySec behaves like zero (persisted configs)", () => {
    const hist = new TrackHistory();
    const noField = predictAim(
      PLANE, SITE, now, hist,
      { adsbLatencySec: 0.6, maxLeadSec: 5 },
      MOUNT, LIMITS, { panDeg: 0, tiltDeg: 10 },
    )!;
    const zero = predictAim(PLANE, SITE, now, hist, params(0), MOUNT, LIMITS, {
      panDeg: 0,
      tiltDeg: 10,
    })!;
    expect(noField.leadSec).toBeCloseTo(zero.leadSec, 5);
    expect(noField.azEl.azDeg).toBeCloseTo(zero.azEl.azDeg, 5);
  });

  it("still clamps at maxLeadSec", () => {
    const hist = new TrackHistory();
    const p = predictAim(PLANE, SITE, now, hist, {
      adsbLatencySec: 0.6,
      motorLatencySec: 10,
      maxLeadSec: 5,
    }, MOUNT, LIMITS, { panDeg: 0, tiltDeg: 10 })!;
    expect(p.leadSec).toBeLessThanOrEqual(5.01);
    expect(p.clamped).toBe(true);
  });
});
