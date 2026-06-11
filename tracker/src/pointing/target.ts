// Target selection: score every aircraft with a usable 3D fix, pick one, and
// hold it with hysteresis so the camera never ping-pongs between planes.

import {
  MI_TO_M,
  aircraftGeoPoint,
  azElFromSite,
  type Aircraft,
  type AzEl,
  type Candidate,
  type GeoPoint,
  type TargetCriteria,
  type TargetMode,
} from "@shared/index.js";

export interface Selection {
  hex: string | null;
  candidates: Candidate[];
}

export interface CurrentTarget {
  hex: string;
  sinceMs: number;
}

function score(ac: Aircraft, azEl: AzEl, mode: TargetMode, c: TargetCriteria): { s: number; note: string } {
  const rangeFrac = Math.max(0, 1 - azEl.slantM / (c.maxRangeMi * MI_TO_M));
  switch (mode) {
    case "overhead": {
      // Best filming geometry: high elevation, close.
      const s = azEl.elDeg / 90 + 0.3 * rangeFrac;
      return { s, note: `el ${azEl.elDeg.toFixed(0)}°` };
    }
    case "closest": {
      // Plain nearest-by-slant-range.
      const s = 2 * rangeFrac;
      return { s, note: `${(azEl.slantM / MI_TO_M).toFixed(1)} mi` };
    }
    case "approach": {
      // Prefer low traffic that is actively landing or departing.
      const vr = ac.baroRate ?? 0;
      const vertical = Math.abs(vr) > 300 ? 0.5 : 0;
      const low = ac.altBaro != null && ac.altBaro < 6000 ? 0.4 : 0;
      const s = rangeFrac + vertical + low + 0.15 * (azEl.elDeg / 90);
      return { s, note: vr < -300 ? "descending" : vr > 300 ? "climbing" : "level" };
    }
    case "sticky": {
      // Same geometry score as overhead; stickiness handled by the holder.
      const s = azEl.elDeg / 90 + 0.3 * rangeFrac;
      return { s, note: `el ${azEl.elDeg.toFixed(0)}°` };
    }
  }
}

/**
 * Pick the aircraft to film. `current` survives unless it becomes invalid
 * (below min elevation / out of range / stale) or a challenger beats it by
 * `switchMargin` after `hysteresisSec` of dwell. In sticky mode the current
 * target is only abandoned when it becomes invalid.
 */
export function selectTarget(
  aircraft: Aircraft[],
  site: GeoPoint,
  now: number,
  current: CurrentTarget | null,
  mode: TargetMode,
  c: TargetCriteria,
  staleSec = 15,
): Selection {
  const candidates: Candidate[] = [];

  for (const ac of aircraft) {
    if (ac.onGround) continue;
    const altFt = ac.altGeom ?? ac.altBaro;
    if (altFt == null || altFt < c.minAltFt) continue;
    const fixAge = (now - (ac.ts ?? 0)) / 1000 + (ac.seen ?? 0);
    if (fixAge > staleSec) continue;
    const geo = aircraftGeoPoint(ac);
    if (!geo) continue;
    const azEl = azElFromSite(site, geo);
    if (azEl.elDeg < c.minElevationDeg) continue;
    if (azEl.slantM > c.maxRangeMi * MI_TO_M) continue;
    const { s, note } = score(ac, azEl, mode, c);
    candidates.push({
      hex: ac.hex,
      flight: ac.flight,
      typeCode: ac.typeCode,
      azEl,
      score: s,
      note,
    });
  }

  candidates.sort((a, b) => b.score - a.score);

  const cur = current ? candidates.find((x) => x.hex === current.hex) : undefined;
  const best = candidates[0];

  if (!best) return { hex: null, candidates };
  if (!cur || !current) return { hex: best.hex, candidates };

  if (mode === "sticky") return { hex: cur.hex, candidates };

  const heldSec = (now - current.sinceMs) / 1000;
  const challengerWins =
    best.hex !== cur.hex &&
    heldSec >= c.hysteresisSec &&
    best.score > cur.score + c.switchMargin;
  return { hex: challengerWins ? best.hex : cur.hex, candidates };
}
