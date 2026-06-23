// Neural detector decode + NMS. The ONNX runtime itself is optional and not
// exercised here; the DECODE math is pure and must be exactly right or the
// boxes land in the wrong place. We synthesize a YOLOX output tensor with a
// known airplane anchor and assert it decodes to the right box.

import { describe, expect, it } from "vitest";
import { decodeYolox, nms } from "../src/vision/net.js";

const INPUT = 416;
const STRIDES = [8, 16, 32];
const NUM_CLASSES = 80;
const STEP = 5 + NUM_CLASSES;

/** Total anchors over the YOLOX stride pyramid for a given input size. */
function anchorCount(size: number): number {
  return STRIDES.reduce((a, s) => a + (size / s) * (size / s), 0);
}

/** Build a zeroed YOLOX output tensor, then plant one airplane detection at
 *  the given anchor index with explicit raw box regression values. */
function tensorWith(
  anchorIdx: number,
  raw: { x: number; y: number; w: number; h: number; obj: number; cls: number },
  classId = 4,
) {
  const A = anchorCount(INPUT);
  const data = new Float32Array(A * STEP);
  const o = anchorIdx * STEP;
  data[o] = raw.x;
  data[o + 1] = raw.y;
  data[o + 2] = raw.w;
  data[o + 3] = raw.h;
  data[o + 4] = raw.obj;
  data[o + 5 + classId] = raw.cls;
  return { data, dims: [1, A, STEP] };
}

describe("decodeYolox", () => {
  it("decodes a centered airplane anchor to the right pixel box", () => {
    // First stride is 8 -> 52×52 grid. Pick the center-ish cell (26,26).
    const g = INPUT / 8; // 52
    const col = 26, row = 26;
    const idx = row * g + col;
    // Cell offset 0.5 -> center at (col+0.5)*8 ; exp(0)=1 -> w=h=1*8.
    const out = tensorWith(idx, { x: 0.5, y: 0.5, w: 0, h: 0, obj: 1, cls: 0.9 });
    const dets = decodeYolox(out, INPUT, 0.3, 4);
    expect(dets.length).toBe(1);
    const cx = dets[0].box[0] + dets[0].box[2] / 2;
    const cy = dets[0].box[1] + dets[0].box[3] / 2;
    expect(cx).toBeCloseTo((col + 0.5) * 8, 3);
    expect(cy).toBeCloseTo((row + 0.5) * 8, 3);
    expect(dets[0].box[2]).toBeCloseTo(8, 3);
    expect(dets[0].score).toBeCloseTo(0.9, 5);
  });

  it("applies exp() to width/height regression", () => {
    const idx = 0; // stride-8 cell (0,0)
    const out = tensorWith(idx, { x: 0, y: 0, w: Math.log(4), h: Math.log(2), obj: 1, cls: 1 });
    const dets = decodeYolox(out, INPUT, 0.3, 4);
    expect(dets[0].box[2]).toBeCloseTo(4 * 8, 3); // exp(log4)*stride
    expect(dets[0].box[3]).toBeCloseTo(2 * 8, 3);
  });

  it("thresholds on obj×cls and respects the class id", () => {
    const idx = 100;
    // Strong airplane, but score = 0.5*0.5 = 0.25 < 0.3 -> dropped.
    const weak = tensorWith(idx, { x: 0.5, y: 0.5, w: 0, h: 0, obj: 0.5, cls: 0.5 });
    expect(decodeYolox(weak, INPUT, 0.3, 4).length).toBe(0);
    // Same numbers but for a DIFFERENT class -> not an airplane.
    const other = tensorWith(idx, { x: 0.5, y: 0.5, w: 0, h: 0, obj: 0.9, cls: 0.9 }, 7);
    expect(decodeYolox(other, INPUT, 0.3, 4).length).toBe(0);
  });

  it("bails (no garbage boxes) when the grid doesn't match dims", () => {
    const out = { data: new Float32Array(10 * STEP), dims: [1, 10, STEP] };
    expect(decodeYolox(out, INPUT, 0.3, 4)).toEqual([]);
  });

  it("uses the larger strides too (anchor in the 32-stride block)", () => {
    const A = anchorCount(INPUT);
    const out = tensorWith(A - 1, { x: 0.5, y: 0.5, w: 0, h: 0, obj: 1, cls: 1 });
    const dets = decodeYolox(out, INPUT, 0.3, 4);
    expect(dets.length).toBe(1);
    // Last anchor is the bottom-right cell of the 13×13 stride-32 map.
    const g = INPUT / 32; // 13
    const cx = dets[0].box[0] + dets[0].box[2] / 2;
    expect(cx).toBeCloseTo((g - 1 + 0.5) * 32, 3);
  });
});

describe("nms", () => {
  it("suppresses overlapping lower-score boxes", () => {
    const dets = [
      { box: [10, 10, 20, 20] as [number, number, number, number], score: 0.9 },
      { box: [12, 12, 20, 20] as [number, number, number, number], score: 0.6 }, // overlaps strongly
      { box: [100, 100, 20, 20] as [number, number, number, number], score: 0.8 }, // separate
    ];
    const kept = nms(dets, 0.45);
    expect(kept.length).toBe(2);
    expect(kept[0].score).toBe(0.9);
    expect(kept.some((k) => k.box[0] === 100)).toBe(true);
  });
});
