// Pass planner: aircraft trajectories are highly predictable, so instead of
// reactively chasing, project the path forward and plan the camera's moves.
//
// The hard case is a near-zenith pass: tracking azimuth continuously through
// overhead needs unbounded pan rate (at the zenith the azimuth flips 180°
// instantly). But the camera's tilt axis sweeps a clean 180° arc — so for a
// pass that crosses near the zenith, the right move is to PRE-ROTATE pan to
// the trajectory's EXIT azimuth while the plane is still inbound, hold tilt
// just below vertical with the zoom wide, and let the plane fly through the
// frame across the top. Tracking then resumes seamlessly on the outbound leg.

import {
  aircraftGeoPoint,
  azElFromSite,
  predictGeo,
  type Aircraft,
  type AzEl,
  type GeoPoint,
} from "@shared/index.js";

/** A pass peaking above this elevation is handled with the flip strategy. */
export const ZENITH_PASS_EL = 82;
/** While the target is above this elevation we are "in the crossing". */
export const ZENITH_REGIME_EL = 78;
/** Tilt commanded while holding for the fly-through (just below vertical). */
export const ZENITH_HOLD_TILT = 86;
/** Minimum HFOV while crossing, deg (wide so the fly-through stays framed). */
export const ZENITH_MIN_HFOV = 30;

export interface PassPlan {
  /** Peaks close enough to the zenith that pan can't keep up. */
  zenithPass: boolean;
  /** Max elevation over the horizon window. */
  elMaxDeg: number;
  /** Seconds from now until closest approach (negative = already past). */
  tCaSec: number;
  /** Azimuth where the target exits the high-elevation cone. */
  outboundAzDeg: number;
  /** Azimuth of closest approach (for the UI). */
  caAzDeg: number;
}

/**
 * Project the target's trajectory and characterize the pass. Cheap (one
 * dead-reckon + az/el per step), recomputed every fix so course changes are
 * absorbed automatically.
 */
export function planPass(
  ac: Aircraft,
  site: GeoPoint,
  now: number,
  horizonSec = 120,
  stepSec = 1,
): PassPlan | null {
  const geo = aircraftGeoPoint(ac);
  if (!geo || ac.gs == null || ac.track == null) return null;
  const kin = {
    lat: geo.lat,
    lon: geo.lon,
    altM: geo.altM,
    gsKt: ac.gs,
    trackDeg: ac.track,
    vRateFpm: ac.baroRate,
  };
  const fixAgeSec = Math.max(0, (now - (ac.ts ?? now)) / 1000) + (ac.seen ?? 0);

  let elMax = -90;
  let tCa = 0;
  let caAz = 0;
  let outboundAz: number | null = null;
  let prev: AzEl | null = null;

  for (let t = 0; t <= horizonSec; t += stepSec) {
    const p = azElFromSite(site, predictGeo(kin, fixAgeSec + t));
    if (p.elDeg > elMax) {
      elMax = p.elDeg;
      tCa = t;
      caAz = p.azDeg;
    }
    // First descent through the regime boundary after the peak = exit point.
    if (
      outboundAz === null &&
      prev &&
      prev.elDeg >= ZENITH_REGIME_EL &&
      p.elDeg < ZENITH_REGIME_EL
    ) {
      outboundAz = p.azDeg;
    }
    prev = p;
  }

  return {
    zenithPass: elMax >= ZENITH_PASS_EL,
    elMaxDeg: elMax,
    tCaSec: tCa,
    outboundAzDeg: outboundAz ?? caAz,
    caAzDeg: caAz,
  };
}

/**
 * The camera directive while inside a zenith crossing: park pan on the exit
 * azimuth, hold tilt just under vertical, and let the plane fly through the
 * top of the frame. Returns null when normal continuous tracking should run.
 */
export function zenithHold(
  plan: PassPlan | null,
  currentElDeg: number,
): { azDeg: number; elDeg: number } | null {
  if (!plan?.zenithPass) return null;
  if (currentElDeg < ZENITH_REGIME_EL) return null;
  return { azDeg: plan.outboundAzDeg, elDeg: ZENITH_HOLD_TILT };
}
