// Zoom choice: the open-loop pointing floor should keep it wide while
// searching, but a vision lock must let it tighten to the framing target
// (the "rarely zooms past 5×" fix).

import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type AzEl, type Aircraft } from "@shared/index.js";
import { chooseZoom } from "../src/pointing/zoom.js";

const cfg = DEFAULT_CONFIG.tracker;
// A real measured FOV LUT (wide 56.5°, tele 4°) so the numbers are realistic.
const cfgM = {
  ...cfg,
  zoom: {
    ...cfg.zoom,
    fovLut: [
      { units: 0, hfovDeg: 56.48 },
      { units: 720, hfovDeg: 23.02 },
      { units: 1080, hfovDeg: 11.18 },
      { units: 1437, hfovDeg: 4.04 },
    ],
  },
};

// Airliner high overhead: ~60 m span at ~8 km slant -> ~0.43° angular size.
const AC: Aircraft = { hex: "a", typeCode: "B738", gs: 250, track: 90 };
const AZEL: AzEl = { azDeg: 180, elDeg: 60, slantM: 8000 };

describe("chooseZoom", () => {
  it("stays wide(ish) open-loop with rate + lag uncertainty", () => {
    // No vision lock: the pointing floor keeps it from punching in.
    const z = chooseZoom(AC, AZEL, cfgM, 2 /*rate*/, 2 /*lag*/);
    expect(z.hfovDeg).toBeGreaterThan(10); // floored well short of tele
  });

  it("tightens toward the framing target once vision is locked", () => {
    const open = chooseZoom(AC, AZEL, cfgM, 2, 2);
    const locked = chooseZoom(AC, AZEL, cfgM, 2, 2, cfgM.zoom.lockedSigmaDeg);
    expect(locked.hfovDeg).toBeLessThan(open.hfovDeg); // zooms further in
    // Framing target ≈ (theta/fillFrac)*16/9 ≈ (0.43/0.28)*1.78 ≈ 2.7° → tele.
    expect(locked.hfovDeg).toBeLessThan(8);
  });

  it("a locked lock still widens near the zenith", () => {
    const mid = chooseZoom(AC, { ...AZEL, elDeg: 60 }, cfgM, 1, 0, cfgM.zoom.lockedSigmaDeg);
    const zen = chooseZoom(AC, { ...AZEL, elDeg: 86 }, cfgM, 1, 0, cfgM.zoom.lockedSigmaDeg);
    expect(zen.hfovDeg).toBeGreaterThan(mid.hfovDeg);
  });

  it("respects manual zoom (auto off)", () => {
    const z = chooseZoom(AC, AZEL, { ...cfgM, zoom: { ...cfgM.zoom, auto: false } }, 0, 0, 0.3);
    expect(z.hfovDeg).toBe(cfgM.zoom.manualHfovDeg);
  });
});
