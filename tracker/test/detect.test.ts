// Vision detector on synthetic luma frames: a plane-sized dark blob on a
// graded sky, with cloud-like large diffuse regions to reject.

import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { detectCandidatesInJpeg, findBlob, findBlobs } from "../src/vision/detect.js";

const W = 480;
const H = 270;

/** Sky with a vertical brightness gradient + mild noise (deterministic). */
function makeSky(): Uint8Array {
  const img = new Uint8Array(W * H);
  let seed = 7;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return ((seed / 2 ** 31) - 0.5) * 4;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      img[y * W + x] = Math.max(0, Math.min(255, 180 + y * 0.15 + noise()));
    }
  }
  return img;
}

function drawBlob(img: Uint8Array, cx: number, cy: number, r: number, delta: number): void {
  for (let y = Math.max(0, cy - r); y <= Math.min(H - 1, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x <= Math.min(W - 1, cx + r); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) {
        img[y * W + x] = Math.max(0, Math.min(255, img[y * W + x] + delta));
      }
    }
  }
}

describe("findBlob", () => {
  it("finds a small dark plane on clear sky", () => {
    const img = makeSky();
    drawBlob(img, 300, 100, 3, -60);
    const det = findBlob(img, W, H);
    expect(det).not.toBeNull();
    expect(det!.cx).toBeCloseTo(300 / W, 1);
    expect(det!.cy).toBeCloseTo(100 / H, 1);
    expect(det!.contrastSigma).toBeGreaterThan(5);
  });

  it("returns null on empty sky", () => {
    expect(findBlob(makeSky(), W, H)).toBeNull();
  });

  it("prefers the blob near the expected position", () => {
    const img = makeSky();
    drawBlob(img, 100, 60, 3, -55); // decoy (e.g. a bird)
    drawBlob(img, 360, 200, 3, -55); // the plane, where ADS-B says it is
    const det = findBlob(img, W, H, { expectedX: 360 / W, expectedY: 200 / H });
    expect(det).not.toBeNull();
    expect(det!.cx).toBeCloseTo(360 / W, 1);
  });

  it("rejects blobs embedded in ground clutter (trees/wires/roofs)", () => {
    const img = makeSky();
    // Textured "tree" region: lots of strong alternating residuals.
    let seed = 99;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let y = 150; y < 270; y++) {
      for (let x = 0; x < 200; x++) {
        img[y * W + x] = 60 + rnd() * 120;
      }
    }
    // A strong dot INSIDE the texture (branch gap) must be rejected...
    drawBlob(img, 100, 200, 3, -80);
    const inClutter = findBlob(img, W, H, { expectedX: 100 / W, expectedY: 200 / H });
    expect(inClutter?.cx ?? 0).not.toBeCloseTo(100 / W, 2);
    // ...while the same dot in clean sky is found.
    drawBlob(img, 350, 60, 3, -60);
    const onSky = findBlob(img, W, H, { expectedX: 350 / W, expectedY: 60 / H });
    expect(onSky).not.toBeNull();
    expect(onSky!.cx).toBeCloseTo(350 / W, 1);
  });

  it("hard-rejects blobs beyond maxDistFrac of the expected position", () => {
    const img = makeSky();
    drawBlob(img, 60, 40, 3, -60); // strong, but nowhere near expected
    const det = findBlob(img, W, H, {
      expectedX: 0.9, expectedY: 0.9, maxDistFrac: 0.2,
    });
    expect(det).toBeNull();
  });

  it("rejects a large diffuse cloud but keeps the plane", () => {
    const img = makeSky();
    // Big soft bright region (cloud): bright core much larger than maxArea.
    for (let y = 30; y < 130; y++) {
      for (let x = 40; x < 220; x++) {
        const d = Math.hypot(x - 130, y - 80);
        img[y * W + x] = Math.min(255, img[y * W + x] + Math.max(0, 60 - d * 0.8));
      }
    }
    drawBlob(img, 380, 150, 3, -60);
    const det = findBlob(img, W, H, { expectedX: 0.5, expectedY: 0.5 });
    expect(det).not.toBeNull();
    expect(det!.cx).toBeGreaterThan(0.7); // found the plane, not the cloud
  });
});

describe("findBlobs", () => {
  it("returns every plausible blob, best-scored first", () => {
    const img = makeSky();
    drawBlob(img, 360, 200, 3, -60); // near expectation -> best
    drawBlob(img, 250, 140, 3, -60); // decoy: same contrast, inside the leash
    const dets = findBlobs(img, W, H, { expectedX: 360 / W, expectedY: 200 / H });
    expect(dets.length).toBe(2);
    expect(dets[0].cx).toBeCloseTo(360 / W, 1);
    expect(dets[1].cx).toBeCloseTo(250 / W, 1);
    expect(dets[0].score).toBeGreaterThan(dets[1].score);
  });
});

describe("detectCandidatesInJpeg with ROI", () => {
  async function jpegOf(img: Uint8Array): Promise<Buffer> {
    // Upscale to a 1280×720 "substream frame" so the ROI path has native
    // resolution to crop from.
    return sharp(Buffer.from(img), { raw: { width: W, height: H, channels: 1 } })
      .resize(1280, 720, { fit: "fill", kernel: "nearest" })
      .jpeg({ quality: 92 })
      .toBuffer();
  }

  it("maps ROI detections back to full-frame fractions", async () => {
    const img = makeSky();
    drawBlob(img, 360, 200, 4, -60);
    const jpeg = await jpegOf(img);
    const exX = 360 / W;
    const exY = 200 / H;
    const dets = await detectCandidatesInJpeg(
      jpeg,
      { expectedX: exX, expectedY: exY, maxDistFrac: 0.15, minArea: 2, maxArea: 4000 },
      { x: exX - 0.1875, y: exY - 0.1875, w: 0.375, h: 0.375 },
    );
    expect(dets.length).toBeGreaterThan(0);
    expect(dets[0].cx).toBeCloseTo(exX, 1);
    expect(dets[0].cy).toBeCloseTo(exY, 1);
  });

  it("does not see blobs outside the ROI", async () => {
    const img = makeSky();
    drawBlob(img, 60, 40, 4, -60); // far corner only
    const jpeg = await jpegOf(img);
    const dets = await detectCandidatesInJpeg(
      jpeg,
      { expectedX: 0.75, expectedY: 0.75, maxDistFrac: 0.5 },
      { x: 0.75 - 0.1875, y: 0.75 - 0.1875, w: 0.375, h: 0.375 },
    );
    expect(dets.length).toBe(0);
  });
});
