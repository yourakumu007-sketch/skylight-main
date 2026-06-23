// Final verification: can ANYTHING in the VISCA command space pan slower than
// the ~8°/s DRIVE floor? Three untested avenues left open by video-speed.ts:
//
//   A. DRIVE (06 01) with pan speed byte 0x00 — never sent (every code path
//      clamps Math.max(1, step)). Some firmwares treat 0 as a distinct
//      slowest speed.
//   B. RELATIVE move (06 03) at low speed bytes — never probed. Absolute
//      ignores its speed byte (~60°/s flat); relative may not.
//   C. Pulsed DRIVE micro-stepping — the driver already sigma-delta dithers
//      byte-1 against stop, so the question isn't the average rate, it's the
//      VISUAL quality: how far does one minimal pulse move (the displacement
//      quantum) and how sharp is the ramp? Quantum ≪ 0.5° + soft ramp means
//      dithered slow pan can look smooth; a hard 0.5°+ lunge means it can't
//      and the digital crop-follow is the only fix.
//
// Measurement is video-based like video-speed.ts (background frame-shift off
// RTSP, known wide-zoom FOV) but reports per-frame VELOCITY PROFILES, not just
// averages — smoothness is the question, so the profile is the answer.
//
// RUN ON THE PI with skylight-tracker STOPPED:
//   sudo systemctl stop skylight-tracker
//   cd ~/skylight/tracker && CAMERA_IP=192.168.5.206 pnpm exec tsx scripts/slow-limits.ts
//   sudo systemctl start skylight-tracker

import dgram from "node:dgram";
import { spawn } from "node:child_process";
import { estimateShift } from "../src/vision/motion.js";

const IP = process.env.CAMERA_IP ?? "192.168.5.206";
const PORT = 52381;
const RTSP = `rtsp://${IP}:554/live/av1`;
const PAN_UPD = 71.714, PAN_ZERO = 12550, TILT_UPD = 69.333, TILT_ZERO = 6240;
const W = 480, H = 270, FPS = 30;
const HFOV = 56.48; // measured hfov at zoom-wide (units 0)
const DEG_PER_PX = HFOV / W;

const sock = dgram.createSocket("udp4");
let seq = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function tx(pt: number, p: number[]): void {
  const b = Buffer.alloc(8 + p.length);
  b.writeUInt16BE(pt, 0); b.writeUInt16BE(p.length, 2); b.writeUInt32BE(++seq, 4);
  Buffer.from(p).copy(b, 8); sock.send(b, PORT, IP);
}
function nib(v: number, n: number): number[] {
  v &= 0xffff; const o: number[] = [];
  for (let i = n - 1; i >= 0; i--) o.push((v >> (i * 4)) & 0x0f);
  return o;
}
function gotoAbs(pan: number, tilt: number, vv: number, ww: number): void {
  tx(0x0100, [0x81, 0x01, 0x06, 0x02, vv & 0x1f, ww & 0x1f,
    ...nib(Math.round(PAN_ZERO + pan * PAN_UPD), 4),
    ...nib(Math.round(TILT_ZERO + tilt * TILT_UPD), 4), 0xff]);
}
/** Raw drive — NO byte clamping, so 0x00 actually goes on the wire. */
function driveRaw(panByte: number, panDir: number, tiltByte: number, tiltDir: number): void {
  tx(0x0100, [0x81, 0x01, 0x06, 0x01, panByte & 0x1f, tiltByte & 0x1f, panDir, tiltDir, 0xff]);
}
const stop = () => driveRaw(1, 0x03, 1, 0x03);
/** RELATIVE move (06 03): signed pan/tilt offsets in units, speed bytes vv/ww. */
function gotoRel(panDeg: number, tiltDeg: number, vv: number, ww: number): void {
  tx(0x0100, [0x81, 0x01, 0x06, 0x03, vv & 0x1f, ww & 0x1f,
    ...nib(Math.round(panDeg * PAN_UPD), 4),
    ...nib(Math.round(tiltDeg * TILT_UPD), 4), 0xff]);
}
const zoomWide = () => tx(0x0100, [0x81, 0x01, 0x04, 0x47, 0, 0, 0, 0, 0xff]);

/** Capture `secs` of RTSP as W×H gray frames. */
function capture(secs: number): Promise<Uint8Array[]> {
  return new Promise((resolve) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-rtsp_transport", "tcp", "-i", RTSP,
      "-vf", `scale=${W}:${H},format=gray`, "-t", String(secs), "-f", "rawvideo", "pipe:1",
    ]);
    const fb = W * H; let buf = Buffer.alloc(0); const frames: Uint8Array[] = [];
    ff.stdout.on("data", (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      while (buf.length >= fb) { frames.push(new Uint8Array(buf.subarray(0, fb))); buf = buf.subarray(fb); }
    });
    ff.on("close", () => resolve(frames));
  });
}
const med = (a: number[]): number => a.slice().sort((x, y) => x - y)[a.length >> 1] ?? 0;

/** Per-frame pan shift series in px (adjacent frames). */
function shiftSeries(frames: Uint8Array[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    out.push(estimateShift(frames[i - 1], frames[i], W, H, 0, 0, 30).dx);
  }
  return out;
}
/** Cruise °/s from a steady window (same approach as video-speed.ts). */
function cruiseDps(frames: Uint8Array[]): number {
  const lo = Math.floor(frames.length * 0.3), hi = Math.floor(frames.length * 0.9);
  const win = frames.slice(lo, hi);
  if (win.length < 6) return 0;
  const rough: number[] = [];
  for (let i = 1; i < Math.min(win.length, 10); i++) rough.push(Math.abs(estimateShift(win[i - 1], win[i], W, H, 0, 0, 30).dx));
  const m = Math.max(0.4, med(rough));
  const G = Math.max(1, Math.min(12, Math.round(7 / m)));
  const search = Math.ceil(m * G) + 8;
  const refined: number[] = [];
  for (let i = G; i < win.length && refined.length < 10; i += 2) refined.push(Math.abs(estimateShift(win[i - G], win[i], W, H, 0, 0, search).dx) / G);
  return med(refined) * DEG_PER_PX * FPS;
}
/** Total displacement between two still frames, deg (single wide-search match). */
function totalDeg(a: Uint8Array, b: Uint8Array): number {
  return Math.abs(estimateShift(a, b, W, H, 0, 0, 80).dx) * DEG_PER_PX;
}
/** Compact velocity-profile row: per-frame °/s, one char per frame. */
function profile(series: number[]): string {
  const GLYPHS = " .:-=+*#%@";
  return series.map((px) => {
    const dps = Math.abs(px) * DEG_PER_PX * FPS;
    return GLYPHS[Math.min(GLYPHS.length - 1, Math.floor(dps / 1.5))];
  }).join("");
}
function stats(series: number[]): { peak: number; mean: number } {
  const dps = series.map((px) => Math.abs(px) * DEG_PER_PX * FPS);
  return { peak: Math.max(...dps, 0), mean: dps.reduce((a, b) => a + b, 0) / Math.max(1, dps.length) };
}

async function position(pan: number, tilt: number): Promise<void> {
  gotoAbs(pan, tilt, 0x18, 0x14);
  await sleep(5000);
}

// ---------------------------------------------------------------------------

async function testByteZero(): Promise<void> {
  console.log("\n=== A. DRIVE pan @ byte 0x00 (never sent before) ===");
  await position(-60, 0);
  driveRaw(0x00, 0x02, 0x00, 0x03);
  await sleep(1000);
  const frames = await capture(2.5);
  stop();
  const dps = cruiseDps(frames);
  console.log(`  cruise: ${dps.toFixed(2)} °/s  ${dps < 0.2 ? "(no motion — byte 0 is a no-op or stop)" : dps < 7 ? "*** SLOWER THAN FLOOR — new lever! ***" : "(same/faster than byte 1 — dead end)"}`);
}

async function testRelative(): Promise<void> {
  console.log("\n=== B. RELATIVE move (06 03) at low speed bytes ===");
  for (const b of [1, 2]) {
    await position(-60, 0);
    gotoRel(40, 0, b, b); // far target: still in flight during the window
    await sleep(1000);
    const frames = await capture(2.5);
    stop();
    await sleep(600);
    const dps = cruiseDps(frames);
    if (dps > 0.2 && dps < 7) {
      console.log(`  rel pan @${b}: cruise ${dps.toFixed(2)} °/s  *** SLOWER THAN FLOOR — new lever! ***`);
    } else if (dps >= 7) {
      console.log(`  rel pan @${b}: cruise ${dps.toFixed(2)} °/s  (no slow lever)`);
    } else {
      // Saw nothing — either the move finished at high speed before the
      // capture window, or 06 03 is unsupported. Disambiguate by displacement.
      await position(-60, 0);
      const a = (await capture(0.4)).pop()!;
      gotoRel(5, 0, b, b);
      await sleep(3000);
      stop();
      const z = (await capture(0.4)).pop()!;
      const moved = totalDeg(a, z);
      console.log(`  rel pan @${b}: cruise ~0 in window; 5° probe moved ${moved.toFixed(1)}°  ${moved > 3 ? "(supported but FAST — ignores speed byte, dead end)" : "(06 03 unsupported on this firmware)"}`);
    }
  }
  // Chained small relatives — the "creep by inches" variant.
  console.log("  chained 0.5° relatives @byte1, 300ms period:");
  await position(-60, 0);
  const cap = capture(4.5);
  await sleep(800);
  for (let i = 0; i < 10; i++) { gotoRel(0.5, 0, 1, 1); await sleep(300); }
  const frames = await cap;
  stop();
  const s = shiftSeries(frames);
  const { peak, mean } = stats(s);
  console.log(`    profile |${profile(s)}|`);
  console.log(`    mean ${mean.toFixed(2)} °/s, peak ${peak.toFixed(2)} °/s ${peak < 4 ? "(gentle — usable!)" : "(lunges — same stutter)"}`);
}

async function testPulseQuantum(): Promise<void> {
  console.log("\n=== C. Pulsed DRIVE @byte1 — displacement quantum + ramp ===");
  console.log("  (one row per pulse width; quantum = total moved / pulses)");
  for (const widthMs of [40, 70, 120, 200]) {
    await position(-60, 0);
    const stillBefore = (await capture(0.4)).pop()!;
    // 5 pulses keeps the worst-case total (200ms ≈ 1.6°/pulse ≈ 68px) inside
    // the 80px still-frame search window.
    const PULSES = 5, PERIOD = 700;
    const cap = capture((PULSES * PERIOD) / 1000 + 1.5);
    await sleep(600); // RTSP latency fill
    for (let i = 0; i < PULSES; i++) {
      driveRaw(1, 0x02, 1, 0x03);
      await sleep(widthMs);
      stop();
      await sleep(PERIOD - widthMs);
    }
    const frames = await cap;
    await sleep(400);
    const stillAfter = (await capture(0.4)).pop()!;
    const quantum = totalDeg(stillBefore, stillAfter) / PULSES;
    const s = shiftSeries(frames);
    const { peak } = stats(s);
    console.log(`  ${String(widthMs).padStart(3)}ms: quantum ${quantum.toFixed(3)}°/pulse, peak ${peak.toFixed(1)} °/s`);
    console.log(`        |${profile(s)}|`);
  }
  console.log("  Verdict guide: quantum ≤0.1° + peak ≤4°/s → dither CAN look smooth.");
  console.log("                 quantum ≥0.3° or peak ≥7°/s → mechanical wall confirmed; crop-follow is the fix.");
}

async function main(): Promise<void> {
  await new Promise<void>((r) => sock.bind(() => r()));
  tx(0x0200, [0x01]); await sleep(400);
  zoomWide(); await sleep(2500);
  await testByteZero();
  await testRelative();
  await testPulseQuantum();
  await position(0, 0);
  stop();
  sock.close();
  console.log("\ndone — restart the tracker: sudo systemctl start skylight-tracker");
}
void main();
