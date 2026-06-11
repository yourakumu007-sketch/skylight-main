import { describe, expect, it } from "vitest";
import { computeSky } from "../src/celestial.js";

// Planet Mode (#12): the naked-eye planets are computed through the same
// ephemeris path as the sun/moon and returned as sky bodies.

const NAMES = new Set(["Venus", "Jupiter", "Mars", "Saturn", "Mercury"]);
const SFO = { lat: 37.6213, lon: -122.379 };
const OPTS = {
  sun: false,
  moon: false,
  stars: false,
  satellites: false,
  magLimit: 3,
  tles: [],
};

describe("computeSky planets", () => {
  it("returns no planets when the flag is off", () => {
    const sky = computeSky(new Date("2026-06-08T08:00:00Z"), SFO.lat, SFO.lon, {
      ...OPTS,
      planets: false,
    });
    expect(sky.planets).toEqual([]);
  });

  it("returns valid, named, above-horizon planet bodies when on", () => {
    const sky = computeSky(new Date("2026-06-08T08:00:00Z"), SFO.lat, SFO.lon, {
      ...OPTS,
      planets: true,
    });
    for (const p of sky.planets) {
      expect(p.kind).toBe("planet");
      expect(NAMES.has(p.name ?? "")).toBe(true);
      expect(p.az).toBeGreaterThanOrEqual(0);
      expect(p.az).toBeLessThanOrEqual(360);
      expect(p.alt).toBeGreaterThan(-2);
      expect(Number.isFinite(p.mag)).toBe(true);
    }
  });

  it("surfaces every planet at some point across a day", () => {
    const seen = new Set<string>();
    for (let h = 0; h < 24; h += 2) {
      const sky = computeSky(
        new Date(`2026-06-08T${String(h).padStart(2, "0")}:00:00Z`),
        SFO.lat,
        SFO.lon,
        { ...OPTS, planets: true },
      );
      for (const p of sky.planets) if (p.name) seen.add(p.name);
    }
    expect(seen.size).toBe(5);
  });
});
