// Follow-up to slow-limits.ts: characterize the newly discovered DRIVE speed
// byte 0x00 (pan measured at ~1.5°/s — below the byte-1 "floor" of ~8°/s).
// Questions: symmetric both directions? steady over many seconds (no auto-
// stop)? does tilt have it too? Reports cruise rate + full velocity profile.
//
// RUN ON THE PI with skylight-tracker STOPPED:
//   sudo systemctl stop skylight-tracker
//   cd ~/skylight/tracker && CAMERA_IP=192.168.5.206 pnpm exec tsx scripts/byte0-verify.ts
//   sudo systemctl start skylight-tracker

import dgram from "node:dgram";
import { spawn } from "node:child_process";
import { estimateShift } from "../src/vision/motion.js";

const IP = process.env.CAMERA_IP ?? "192.168.5.206";
const PORT = 52381;
const RTSP = `rtsp://${IP}:554/live/av1`;
const PAN_UPD = 71.714, PAN_ZERO = 12550, TILT_UPD = 69.333, TILT_ZERO = 6240;
const W = 480, H = 270, FPS = 30;
const HFOV = 56.48;
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
function gotoAbs(pan: number, tilt: number): void {
  tx(0x0100, [0x81, 0x01, 0x06, 0x02, 0x18, 0x14,
    ...nib(Math.round(PAN_ZERO + pan * PAN_UPD), 4),
    ...nib(Math.round(TILT_ZERO + tilt * TILT_UPD), 4), 0xff]);
}
function driveRaw(panByte: number, panDir: number, tiltByte: number, tiltDir: number): void {
  tx(0x0100, [0x81, 0x01, 0x06, 0x01, panByte & 0x1f, tiltByte & 0x1f, panDir, tiltDir, 0xff]);
}
const stop = () => driveRaw(1, 0x03, 1, 0x03);
const zoomWide = () => tx(0x0100, [0x81, 0x01, 0x04, 0x47, 0, 0, 0, 0, 0xff]);

function captureOnce(secs: number): Promise<Uint8Array[]> {
  return new Promise((resolve) => {
    const ff = spawn("ffmpeg", [
      // NOTE: no -rw_timeout — this ffmpeg build rejects it for RTSP
      // ("Option rw_timeout not found") and exits instantly with 0 frames.
      // The SIGKILL watchdog below is the hang protection.
      "-hide_banner", "-loglevel", "error", "-rtsp_transport", "tcp", "-i", RTSP,
      "-vf", `scale=${W}:${H},format=gray`, "-t", String(secs), "-f", "rawvideo", "pipe:1",
    ]);
    // Belt & braces: the camera's RTSP server can wedge and feed nothing.
    const watchdog = setTimeout(() => ff.kill("SIGKILL"), (secs + 12) * 1000);
    const fb = W * H; let buf = Buffer.alloc(0); const frames: Uint8Array[] = [];
    ff.stdout.on("data", (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      while (buf.length >= fb) { frames.push(new Uint8Array(buf.subarray(0, fb))); buf = buf.subarray(fb); }
    });
    ff.on("close", () => { clearTimeout(watchdog); resolve(frames); });
  });
}
const med = (a: number[]): number => a.slice().sort((x, y) => x - y)[a.length >> 1] ?? 0;
const ax = (s: { dx: number; dy: number }, axis: "pan" | "tilt") => Math.abs(axis === "pan" ? s.dx : s.dy);

/** Gap-refined °/s over consecutive sub-windows — shows drift/steadiness. */
function windowedRates(frames: Uint8Array[], axis: "pan" | "tilt"): number[] {
  const G = 12, STRIDE = 15; // 12-frame gap = 0.4s; one estimate every 0.5s
  const out: number[] = [];
  for (let i = G; i < frames.length; i += STRIDE) {
    const px = ax(estimateShift(frames[i - G], frames[i], W, H, 0, 0, 14), axis) / G;
    out.push(px * DEG_PER_PX * FPS);
  }
  return out;
}

async function run(label: string, pan: number, tilt: number, cmd: () => void, axis: "pan" | "tilt"): Promise<void> {
  // Whole-measurement retry: the camera's RTSP server occasionally wedges and
  // a capture comes back empty — reposition, re-command, and try again.
  for (let attempt = 0; attempt < 3; attempt++) {
    gotoAbs(pan, tilt);
    await sleep(5000);
    cmd();
    await sleep(1000); // ramp + RTSP latency fill
    const frames = await captureOnce(8);
    stop();
    if (frames.length < 20) {
      console.log(`  ${label}: capture failed (${frames.length} frames) — retrying`);
      await sleep(4000);
      continue;
    }
    const rates = windowedRates(frames, axis);
    const m = med(rates);
    console.log(`  ${label}: median ${m.toFixed(2)} °/s   per-0.5s: [${rates.map((r) => r.toFixed(1)).join(" ")}]`);
    return;
  }
  console.log(`  ${label}: FAILED — RTSP never recovered`);
}

async function main(): Promise<void> {
  await new Promise<void>((r) => sock.bind(() => r()));
  tx(0x0200, [0x01]); await sleep(400);
  zoomWide(); await sleep(2500);

  console.log("=== DRIVE byte 0x00 characterization (8s windows) ===");
  // Already confirmed: pan right @0 = pan left @0 = 1.47°/s steady;
  // mixed pan@0 + tilt@2 accepted (pan ~1.2°/s during combined motion).
  // KEEP THE SESSION COUNT LOW — ~17 rapid ffmpeg connects wedged the
  // camera's RTSP daemon once already (recovery: onvif-cmd.ts reboot).
  // Remaining question: does TILT have the 0x00 slow gear too? (Its byte-1
  // floor is 3.0°/s; high passes want 0.5-1.5°/s tilt.)
  await run("tilt up   @0", 0, -30, () => driveRaw(0, 0x03, 0, 0x01), "tilt");
  await run("tilt down @0", 0, 20, () => driveRaw(0, 0x03, 0, 0x02), "tilt");

  await gotoAbs(0, 0);
  await sleep(4000);
  stop();
  sock.close();
  console.log("done — restart the tracker: sudo systemctl start skylight-tracker");
}
void main();
