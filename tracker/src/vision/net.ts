// Optional neural airplane detector. The classical paths (findBlobs for
// specks, findLargeObject for big/near planes) see SHAPE; they cannot tell a
// compact cloud puff from an airframe. A COCO-pretrained detector adds the
// missing SEMANTIC signal: "is this thing an airplane?" — which both kills
// cloud locks and nails the easy big-overhead case.
//
// Design goals:
//  - OPTIONAL. onnxruntime-node is an optionalDependency and the model is
//    downloaded at setup (not committed). If either is missing, this module
//    is a graceful no-op and the tracker runs exactly as the classical-only
//    build does. Nothing here may throw on the hot path.
//  - The DECODE is pure and unit-tested (decodeYolox); only session creation
//    and the tensor run touch the runtime.
//
// Default model: YOLOX-Nano (Apache-2.0), 416×416, output [1, 3549, 85] in
// the standard YOLOX grid/stride layout. Preprocessing is letterbox + raw
// pixel values (YOLOX bakes normalization into the graph). All of this is
// config-driven so a different export can be pointed at without code changes.

import sharp from "sharp";

/** COCO class index for "airplane". */
const COCO_AIRPLANE = 4;
/** YOLOX feature-map strides. */
const STRIDES = [8, 16, 32];

export interface NetConfig {
  enabled: boolean;
  /** Absolute path to the .onnx model (downloaded at setup). */
  modelPath: string;
  /** Square network input size, px (YOLOX-Nano default 416). */
  inputSize: number;
  /** Min class score to emit a detection. */
  scoreThresh: number;
  /** COCO class id to keep (4 = airplane). */
  classId: number;
}

export interface NetDetection {
  /** Box in frame fractions (full frame, 0..1). */
  box: { x: number; y: number; w: number; h: number };
  /** Center in frame fractions. */
  cx: number;
  cy: number;
  /** Class confidence 0..1. */
  score: number;
}

/** A minimal structural view of an ORT tensor (avoids a type dependency). */
interface RawTensor {
  data: Float32Array | number[];
  dims: number[];
}

/**
 * Decode a YOLOX output tensor into airplane boxes (network-input pixel
 * coordinates). Pure — directly unit-testable with a synthetic tensor.
 *
 * YOLOX output is [1, A, 5+C] where A = Σ (size/stride)² anchors over the
 * stride pyramid, row = [x, y, w, h, obj, c0..c79]. x,y are cell offsets:
 * (x + col)·stride, (y + row)·stride; w,h are exp(w)·stride, exp(h)·stride.
 */
export function decodeYolox(
  out: RawTensor,
  inputSize: number,
  scoreThresh: number,
  classId: number,
  strides: number[] = STRIDES,
): { box: [number, number, number, number]; score: number }[] {
  const [, A, step] = out.dims.length === 3 ? out.dims : [1, out.dims[0], out.dims[1]];
  const d = out.data;
  // Grid cell (col,row,stride) for each anchor index, in pyramid order.
  const grid: [number, number, number][] = [];
  for (const s of strides) {
    const g = Math.round(inputSize / s);
    for (let r = 0; r < g; r++) {
      for (let c = 0; c < g; c++) grid.push([c, r, s]);
    }
  }
  if (grid.length !== A) {
    // Stride set / input size doesn't match this export — bail rather than
    // emit garbage boxes.
    return [];
  }
  const dets: { box: [number, number, number, number]; score: number }[] = [];
  for (let i = 0; i < A; i++) {
    const o = i * step;
    const obj = d[o + 4];
    const cls = d[o + 5 + classId];
    const score = obj * cls;
    if (score < scoreThresh) continue;
    const [col, row, s] = grid[i];
    const cx = (d[o] + col) * s;
    const cy = (d[o + 1] + row) * s;
    const w = Math.exp(d[o + 2]) * s;
    const h = Math.exp(d[o + 3]) * s;
    dets.push({ box: [cx - w / 2, cy - h / 2, w, h], score });
  }
  return dets;
}

/** Greedy non-max suppression on [x,y,w,h] boxes. */
export function nms(
  dets: { box: [number, number, number, number]; score: number }[],
  iouThresh = 0.45,
): { box: [number, number, number, number]; score: number }[] {
  const sorted = [...dets].sort((a, b) => b.score - a.score);
  const keep: typeof sorted = [];
  for (const d of sorted) {
    if (keep.every((k) => iou(k.box, d.box) < iouThresh)) keep.push(d);
  }
  return keep;
}

function iou(
  a: [number, number, number, number],
  b: [number, number, number, number],
): number {
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const uni = a[2] * a[3] + b[2] * b[3] - inter;
  return uni > 0 ? inter / uni : 0;
}

/**
 * Lazy ONNX session wrapper. Construction never throws; if the runtime or
 * model is unavailable, `ready` stays false and detect() returns []. The
 * caller treats "no neural detections" identically to the classical-only
 * build, so the feature is fully optional.
 */
export class PlaneNet {
  private session: unknown = null;
  private ort: typeof import("onnxruntime-node") | null = null;
  private loading: Promise<void> | null = null;
  private inputName = "images";
  private failed = false;
  private lastError: string | null = null;

  constructor(private cfg: NetConfig) {}

  get ready(): boolean {
    return this.session != null;
  }

  get error(): string | null {
    return this.lastError;
  }

  /** Kick off (or await) model load. Safe to call repeatedly. */
  async ensureLoaded(): Promise<void> {
    if (this.session || this.failed || !this.cfg.enabled) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        // Dynamic import: a missing optionalDependency must not crash the
        // process at startup.
        this.ort = (await import("onnxruntime-node")).default ??
          (await import("onnxruntime-node"));
        const sess = await this.ort.InferenceSession.create(this.cfg.modelPath, {
          // ONE core only: the Pi is already at its CPU ceiling during a pass
          // (ffmpeg substream decode + chromium kiosk). Total inference work
          // is the same as 2 threads (~0.5 core·s); capping concurrency to 1
          // leaves a free core so the TV stream doesn't stutter. ~500 ms
          // wall-clock is irrelevant for a ~1 Hz semantic check.
          intraOpNumThreads: 1,
          graphOptimizationLevel: "all",
        });
        this.inputName = sess.inputNames[0] ?? "images";
        this.session = sess;
        this.lastError = null;
      } catch (err) {
        this.failed = true;
        this.lastError = String((err as Error)?.message ?? err);
      }
    })();
    return this.loading;
  }

  /**
   * Detect airplanes in a JPEG frame (optionally within an ROI in frame
   * fractions). Returns boxes in FULL-frame fractions. [] when not ready —
   * never throws.
   */
  async detect(jpeg: Buffer, roi?: { x: number; y: number; w: number; h: number }): Promise<NetDetection[]> {
    if (!this.session || !this.ort) return [];
    const S = this.cfg.inputSize;
    try {
      let img = sharp(jpeg);
      const meta = await img.metadata();
      const fw = meta.width ?? 1280;
      const fh = meta.height ?? 720;
      let ex = 0, ey = 0, ew = 1, eh = 1;
      if (roi) {
        const left = Math.min(fw - 16, Math.max(0, Math.round(roi.x * fw)));
        const top = Math.min(fh - 16, Math.max(0, Math.round(roi.y * fh)));
        const w = Math.max(16, Math.min(fw - left, Math.round(roi.w * fw)));
        const h = Math.max(16, Math.min(fh - top, Math.round(roi.h * fh)));
        img = img.extract({ left, top, width: w, height: h });
        ex = left / fw; ey = top / fh; ew = w / fw; eh = h / fh;
      }
      const srcW = roi ? ew * fw : fw;
      const srcH = roi ? eh * fh : fh;
      // Letterbox to S×S preserving aspect (YOLOX convention), pad value 114.
      const scale = Math.min(S / srcW, S / srcH);
      const rw = Math.round(srcW * scale);
      const rh = Math.round(srcH * scale);
      const { data } = await img
        .resize(rw, rh, { fit: "fill" })
        .removeAlpha()
        .toColourspace("srgb")
        .raw()
        .toBuffer({ resolveWithObject: true });
      // CHW float tensor on a 114-padded S×S canvas. YOLOX expects BGR, raw
      // 0-255 (no /255), normalization baked into the graph.
      const chw = new Float32Array(3 * S * S).fill(114);
      for (let y = 0; y < rh; y++) {
        for (let x = 0; x < rw; x++) {
          const p = (y * rw + x) * 3;
          const r = data[p], g = data[p + 1], b = data[p + 2];
          const idx = y * S + x;
          chw[idx] = b;             // B plane
          chw[S * S + idx] = g;     // G plane
          chw[2 * S * S + idx] = r; // R plane
        }
      }
      const ort = this.ort;
      const tensor = new ort.Tensor("float32", chw, [1, 3, S, S]);
      const sess = this.session as import("onnxruntime-node").InferenceSession;
      const result = await sess.run({ [this.inputName]: tensor });
      const out = result[sess.outputNames[0]] as unknown as RawTensor;

      const raw = decodeYolox(out, S, this.cfg.scoreThresh, this.cfg.classId);
      const kept = nms(raw);
      // Map network-input px -> ROI fraction -> full-frame fraction.
      return kept.map((k) => {
        const fx = (k.box[0] / scale) / srcW;
        const fy = (k.box[1] / scale) / srcH;
        const fwf = (k.box[2] / scale) / srcW;
        const fhf = (k.box[3] / scale) / srcH;
        const box = {
          x: ex + fx * ew,
          y: ey + fy * eh,
          w: fwf * ew,
          h: fhf * eh,
        };
        return { box, cx: box.x + box.w / 2, cy: box.y + box.h / 2, score: k.score };
      });
    } catch (err) {
      this.lastError = String((err as Error)?.message ?? err);
      return [];
    }
  }
}

export { COCO_AIRPLANE };
