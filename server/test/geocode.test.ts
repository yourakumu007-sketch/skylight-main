import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseCoords,
  validLatLon,
  geocodePlace,
  resolveLocation,
} from "../src/geocode.js";

describe("validLatLon", () => {
  it("accepts in-range and rejects out-of-range / non-finite", () => {
    expect(validLatLon(37.6, -122.4)).toBe(true);
    expect(validLatLon(-90, 180)).toBe(true);
    expect(validLatLon(91, 0)).toBe(false);
    expect(validLatLon(0, 181)).toBe(false);
    expect(validLatLon(NaN, 0)).toBe(false);
  });
});

describe("parseCoords", () => {
  it("parses comma- and space-separated pairs", () => {
    expect(parseCoords("37.6213,-122.379")).toEqual({
      lat: 37.6213,
      lon: -122.379,
      name: "37.6213, -122.3790",
    });
    expect(parseCoords("40.71 -74.0")?.lat).toBeCloseTo(40.71, 4);
  });
  it("returns null for non-coordinate text and out-of-range pairs", () => {
    expect(parseCoords("London")).toBe(null);
    expect(parseCoords("SFO")).toBe(null);
    expect(parseCoords("200,0")).toBe(null);
  });
});

describe("geocodePlace (stubbed network)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the first hit, trimmed to the leading name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => [
          { lat: "51.5074", lon: "-0.1278", display_name: "London, Greater London, England, UK" },
        ],
      })),
    );
    const r = await geocodePlace("London", { userAgent: "test" });
    expect(r).toEqual({ lat: 51.5074, lon: -0.1278, name: "London" });
  });

  it("returns null on an empty result set (no 0,0 fallback)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => [] })));
    expect(await geocodePlace("asdfqwer", { userAgent: "test" })).toBe(null);
  });

  it("returns null on an HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => [] })));
    expect(await geocodePlace("London", { userAgent: "test" })).toBe(null);
  });
});

describe("resolveLocation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("short-circuits coords without hitting the network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const r = await resolveLocation("37.6213, -122.379", { userAgent: "test" });
    expect(r?.lat).toBeCloseTo(37.6213, 4);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls through to geocoding for names", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => [{ lat: "48.85", lon: "2.35", display_name: "Paris, France" }] })),
    );
    expect((await resolveLocation("Paris", { userAgent: "test" }))?.name).toBe("Paris");
  });
});
