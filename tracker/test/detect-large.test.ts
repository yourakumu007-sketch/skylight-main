// Large/near plane detector: the regime the speck detector is blind to.
// Synthetic luma — a smooth (possibly gradient) sky with a big solid object.

import { describe, expect, it } from "vitest";
import { findLargeObject, findBlobs } from "../src/vision/detect.js";

const W = 480;
const H = 270;

/** Sky with a linear gradient + an optional filled rectangle ("plane"). */
function scene(
  opts: {
    skyBase?: number;
    gradX?: number;
    gradY?: number;
    rect?: { x: number; y: number; w: number; h: number; luma: number };
    noise?: number;
  } = {},
): Uint8Array {
  const { skyBase = 180, gradX = 0, gradY = 0, rect, noise = 0 } = opts;
  const a = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = skyBase + gradX * (x / W) + gradY * (y / H);
      if (noise) v += Math.sin(x * 1.7 + y * 0.9) * noise; // deterministic
      a[y * W + x] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  if (rect) {
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        if (x >= 0 && x < W && y >= 0 && y < H) a[y * W + x] = rect.luma;
      }
    }
  }
  return a;
}

describe("findLargeObject", () => {
  it("detects a big dark plane on bright sky (centroid + box)", () => {
    const a = scene({ skyBase: 200, rect: { x: 200, y: 110, w: 80, h: 50, luma: 40 } });
    const det = findLargeObject(a, W, H, { expectedX: 0.5, expectedY: 0.5 });
    expect(det).not.toBeNull();
    expect(det!.cx).toBeCloseTo((200 + 40) / W, 1);
    expect(det!.cy).toBeCloseTo((110 + 25) / H, 1);
    expect(det!.areaPx).toBeGreaterThan(2000);
  });

  it("detects a bright plane on darker sky", () => {
    const a = scene({ skyBase: 60, rect: { x: 180, y: 90, w: 70, h: 45, luma: 230 } });
    const det = findLargeObject(a, W, H, { expectedX: 0.45, expectedY: 0.5 });
    expect(det).not.toBeNull();
    expect(det!.cx).toBeCloseTo((180 + 35) / W, 1);
  });

  it("sees through a strong sky gradient (planar sky model)", () => {
    const a = scene({
      skyBase: 120, gradX: 120, gradY: -40,
      rect: { x: 240, y: 120, w: 60, h: 40, luma: 30 },
    });
    const det = findLargeObject(a, W, H, { expectedX: 0.55, expectedY: 0.5 });
    expect(det).not.toBeNull();
    expect(det!.cx).toBeCloseTo((240 + 30) / W, 1);
  });

  it("returns null on clear sky (no object)", () => {
    const a = scene({ skyBase: 175, gradX: 60, noise: 1.5 });
    expect(findLargeObject(a, W, H, {})).toBeNull();
  });

  it("rejects an object far from the expectation", () => {
    const a = scene({ skyBase: 200, rect: { x: 20, y: 20, w: 70, h: 45, luma: 40 } });
    // Expect the plane center-right; the object is top-left corner.
    const det = findLargeObject(a, W, H, { expectedX: 0.8, expectedY: 0.8, maxDistFrac: 0.25 });
    expect(det).toBeNull();
  });

  it("is the complement of the speck path: speck misses the big plane", () => {
    const a = scene({ skyBase: 200, rect: { x: 200, y: 110, w: 80, h: 50, luma: 40 } });
    // Speck detector with its normal wide-mode area ceiling finds nothing...
    const specks = findBlobs(a, W, H, { maxArea: 600, useMask: false });
    expect(specks.length).toBe(0);
    // ...but the large path nails it.
    expect(findLargeObject(a, W, H, {})).not.toBeNull();
  });
});
