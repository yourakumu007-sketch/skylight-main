// Accurate camera speed measurement via VIDEO (not pose inquiry, which stalls).
// Commands a move at a given speed byte, captures the camera's RTSP, and measures
// the true angular rate from the background frame-shift — the FOV is known at
// wide zoom, so px/frame -> deg/s directly. Measures DRIVE (06 01) and ABSOLUTE
// (06 02) for both axes across the speed-byte range.
//
// RUN ON THE PI with skylight-tracker STOPPED:
//   sudo systemctl stop skylight-tracker
//   cd ~/skylight/tracker && CAMERA_IP=192.168.5.206 pnpm exec tsx scripts/video-speed.ts
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
function drive(panStep: number, panDir: number, tiltStep: number, tiltDir: number): void {
  tx(0x0100, [0x81, 0x01, 0x06, 0x01, Math.max(1, panStep), Math.max(1, tiltStep), panDir, tiltDir, 0xff]);
}
const stop = () => drive(1, 0x03, 1, 0x03);
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
const ax = (s: { dx: number; dy: number }, axis: "pan" | "tilt") => Math.abs(axis === "pan" ? s.dx : s.dy);

/** Cruise px/frame from a steady window: rough adjacent estimate, then refine over a gap. */
function cruisePxPerFrame(frames: Uint8Array[], axis: "pan" | "tilt"): number {
  const lo = Math.floor(frames.length * 0.3), hi = Math.floor(frames.length * 0.9);
  const win = frames.slice(lo, hi);
  if (win.length < 6) return 0;
  const rough: number[] = [];
  for (let i = 1; i < Math.min(win.length, 10); i++) rough.push(ax(estimateShift(win[i - 1], win[i], W, H, 0, 0, 30), axis));
  const m = Math.max(0.4, med(rough));
  const G = Math.max(1, Math.min(12, Math.round(7 / m)));
  const search = Math.ceil(m * G) + 8;
  const refined: number[] = [];
  for (let i = G; i < win.length && refined.length < 10; i += 2) refined.push(ax(estimateShift(win[i - G], win[i], W, H, 0, 0, search), axis) / G);
  return med(refined);
}

async function position(pan: number, tilt: number): Promise<void> {
  gotoAbs(pan, tilt, 0x18, 0x14);
  await sleep(5000); // generous: max-speed move completes; no pose inquiry needed
}

async function measure(kind: "drive" | "abs", axis: "pan" | "tilt", byte: number): Promise<number> {
  // Start at one end with room to cruise toward the other.
  const startPan = axis === "pan" ? -150 : 0;
  const startTilt = axis === "tilt" ? -70 : 0;
  await position(startPan, startTilt);
  if (kind === "drive") {
    if (axis === "pan") drive(byte, 0x02, 1, 0x03); else drive(1, 0x03, byte, 0x01);
  } else {
    gotoAbs(axis === "pan" ? 150 : 0, axis === "tilt" ? 70 : 0, byte, byte);
  }
  await sleep(1000); // ramp + RTSP latency fill
  const frames = await capture(2.5);
  stop();
  return cruisePxPerFrame(frames, axis) * DEG_PER_PX * FPS;
}

async function main(): Promise<void> {
  await new Promise<void>((r) => sock.bind(() => r()));
  tx(0x0200, [0x01]); await sleep(400);
  zoomWide(); await sleep(2500);
  const bytes = [1, 2, 3, 4, 6, 8, 12, 18, 24];
  for (const axis of ["pan", "tilt"] as const) {
    for (const kind of ["drive", "abs"] as const) {
      const row: string[] = [];
      for (const b of bytes) {
        const dps = await measure(kind, axis, b);
        row.push(`${b}:${dps.toFixed(1)}`);
      }
      console.log(`${kind} ${axis}  ${row.join("  ")}`);
    }
  }
  await position(0, 0);
  stop();
  sock.close();
}
void main();
