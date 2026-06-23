// Config deep-merge: partial patches must never drop sibling keys. The
// tracker's vision.net is a nested object inside a section, the easiest place
// to silently wipe the whole detector config with a one-field patch.

import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, mergeConfig, mergeTrackerConfig } from "../src/config.js";

describe("mergeTrackerConfig", () => {
  it("deep-merges a partial vision.net patch (keeps enabled/modelPath)", () => {
    const merged = mergeTrackerConfig(DEFAULT_CONFIG.tracker, {
      vision: { net: { everyNTicks: 3 } } as never,
    });
    expect(merged.vision.net.everyNTicks).toBe(3);
    // The fields the patch DIDN'T mention must survive.
    expect(merged.vision.net.enabled).toBe(DEFAULT_CONFIG.tracker.vision.net.enabled);
    expect(merged.vision.net.modelPath).toBe(DEFAULT_CONFIG.tracker.vision.net.modelPath);
    expect(merged.vision.net.inputSize).toBe(DEFAULT_CONFIG.tracker.vision.net.inputSize);
  });

  it("keeps other vision keys when patching net", () => {
    const merged = mergeTrackerConfig(DEFAULT_CONFIG.tracker, {
      vision: { net: { scoreThresh: 0.5 } } as never,
    });
    expect(merged.vision.enabled).toBe(DEFAULT_CONFIG.tracker.vision.enabled);
    expect(merged.vision.autoCalibrate).toBe(DEFAULT_CONFIG.tracker.vision.autoCalibrate);
    expect(merged.vision.net.scoreThresh).toBe(0.5);
  });

  it("restores a persisted config that predates the net section", () => {
    // Simulate loading an old persisted config (no net) against new defaults.
    const persisted = mergeConfig(DEFAULT_CONFIG, {
      tracker: { vision: { applyCorrection: true } } as never,
    });
    expect(persisted.tracker.vision.net).toEqual(DEFAULT_CONFIG.tracker.vision.net);
  });
});

describe("mergeConfig locationProfiles (#18)", () => {
  const profile = { id: "a1", name: "LAX", lat: 33.94, lon: -118.4, radiusMiles: 5 };

  it("persists saved profiles and replaces the array wholesale on patch", () => {
    const withOne = mergeConfig(DEFAULT_CONFIG, { locationProfiles: [profile] });
    expect(withOne.locationProfiles).toEqual([profile]);
    // A later patch of the array replaces it (the client sends the full list).
    const cleared = mergeConfig(withOne, { locationProfiles: [] });
    expect(cleared.locationProfiles).toEqual([]);
  });

  it("keeps saved profiles when an unrelated field is patched", () => {
    const base = mergeConfig(DEFAULT_CONFIG, { locationProfiles: [profile] });
    const after = mergeConfig(base, { brightness: 0.5 });
    expect(after.locationProfiles).toEqual([profile]);
  });
});
