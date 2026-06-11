// Measure the video pipeline's exposure->arrival latency (vision.encodeLagMs):
// command a fast pan step and compare WHEN THE ENCODER FIRST MOVES (position
// inquiry) against WHEN THE IMAGE FIRST SHIFTS (frame diff on the SAME ffmpeg
// pipeline the production VideoStream uses — identical args, identical lag).
//
//   encodeLag ≈ t(video shift) - t(encoder moves) - halfFrameInterval
//
// RUN ON THE PI with skylight-tracker STOPPED:
//   sudo systemctl stop skylight-tracker
//   cd ~/skylight/tracker && pnpm exec tsx scripts/measure-latency.ts
//   sudo systemctl start skylight-tracker

import { spawn } from "node:child_process";
import dgram from "node:dgram";
import sharp from "sharp";

const IP = process.env.CAMERA_IP ?? "192.168.0.206";
const PORT = 52381;
const RTSP = process.env.RTSP_URL ?? `rtsp://${IP}:554/live/av1`;
const TRIALS = 8;
const FPS = 8; // production VideoStream rate

const PAN_UPD = 71.714;
const PAN_ZERO = 12550;
const TILT_UPD = 69.333;
const TILT_ZERO = 6240;

const sock = dgram.createSocket("udp4");
let seq = 0;

function transmit(payloadType: number, payload: number[]): void {
  const buf = Buffer.alloc(8 + payload.length);
  buf.writeUInt16BE(payloadType, 0);
  buf.writeUInt16BE(payload.length, 2);
  buf.writeUInt32BE(++seq, 4);
  Buffer.from(payload).copy(buf, 8);
  sock.send(buf, PORT, IP);
}

function fromNibbles(bytes: Uint8Array): number {
  let v = 0;
  for (const b of bytes) v = (v << 4) | (b & 0x0f);
  if (bytes.length === 4 && v & 0x8000) v -= 0x10000;
  return v;
}

let lastPose: { t: number; panDeg: number; tiltDeg: number } | null = null;
sock.on("message", (msg) => {
  if (msg.length < 9) return;
  const payload = msg.subarray(8);
  if (((payload[1] ?? 0) & 0xf0) === 0x50 && payload.length === 11 && payload[10] === 0xff) {
    lastPose = {
      t: Date.now(),
      panDeg: (fromNibbles(payload.subarray(2, 6)) - PAN_ZERO) / PAN_UPD,
      tiltDeg: (fromNibbles(payload.subarray(6, 10)) - TILT_ZERO) / TILT_UPD,
    };
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const inquire = () => transmit(0x0110, [0x81, 0x09, 0x06, 0x12, 0xff]);
const drive = (step: number, dir: number) =>
  transmit(0x0100, [0x81, 0x01, 0x06, 0x01, step, 1, dir, 0x03, 0xff]);
const stopMotion = () => transmit(0x0100, [0x81, 0x01, 0x06, 0x01, 1, 1, 0x03, 0x03, 0xff]);

function gotoAbsolute(panDeg: number, tiltDeg: number): void {
  const nib = (v: number) => {
    const x = Math.round(v) & 0xffff;
    return [(x >> 12) & 0xf, (x >> 8) & 0xf, (x >> 4) & 0xf, x & 0xf];
  };
  transmit(0x0100, [
    0x81, 0x01, 0x06, 0x02, 0x18, 0x14,
    ...nib(PAN_ZERO + panDeg * PAN_UPD),
    ...nib(TILT_ZERO + tiltDeg * TILT_UPD),
    0xff,
  ]);
}

// --- frame feed: PRODUCTION-identical ffmpeg args ---
type Frame = { t: number; diff: number };
const frames: Frame[] = [];
let prevLuma: Uint8Array | null = null;
let decodeBusy = false;

async function onJpeg(jpeg: Buffer, t: number): Promise<void> {
  if (decodeBusy) return;
  decodeBusy = true;
  try {
    const { data } = await sharp(jpeg).resize(160, 90, { fit: "fill" }).grayscale().raw()
      .toBuffer({ resolveWithObject: true });
    const luma = new Uint8Array(data.buffer, data.byteOffset, data.length);
    if (prevLuma) {
      let sum = 0;
      for (let i = 0; i < luma.length; i++) sum += Math.abs(luma[i] - prevLuma[i]);
      frames.push({ t, diff: sum / luma.length });
      if (frames.length > 400) frames.shift();
    }
    prevLuma = luma;
  } finally {
    decodeBusy = false;
  }
}

function startFfmpeg(): ReturnType<typeof spawn> {
  const proc = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-rtsp_transport", "tcp",
    "-i", RTSP,
    "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "7", "-r", String(FPS),
    "pipe:1",
  ], { stdio: ["ignore", "pipe", "inherit"] });
  let buffer = Buffer.alloc(0);
  proc.stdout!.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const start = buffer.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) { buffer = Buffer.alloc(0); return; }
      const end = buffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end < 0) { if (start > 0) buffer = buffer.subarray(start); return; }
      void onJpeg(Buffer.from(buffer.subarray(start, end + 2)), Date.now());
      buffer = buffer.subarray(end + 2);
    }
  });
  return proc;
}

async function trial(n: number): Promise<number | null> {
  // Re-center, settle, let the diff baseline quiesce.
  gotoAbsolute(n % 2 === 0 ? -20 : 10, 10);
  await sleep(3500);
  const baselineWindow = frames.slice(-Math.min(frames.length, 2 * FPS));
  const baseline = baselineWindow.reduce((a, f) => a + f.diff, 0) / Math.max(1, baselineWindow.length);

  // Fire the step; find encoder-motion onset via 20 Hz inquiries.
  const before = lastPose;
  const t0 = Date.now();
  drive(12, n % 2 === 0 ? 0x02 : 0x01);
  let tMove = 0;
  for (let i = 0; i < 20 && !tMove; i++) {
    inquire();
    await sleep(50);
    if (lastPose && before && Math.abs(lastPose.panDeg - before.panDeg) > 0.08) {
      tMove = lastPose.t;
    }
  }
  await sleep(400);
  stopMotion();
  await sleep(1500); // let the shifted frames flush through

  if (!tMove) {
    console.error(`trial ${n}: no encoder onset (inquiries stalled?) — skipped`);
    return null;
  }
  // First frame AFTER t0 whose diff clearly exceeds baseline.
  const hit = frames.find((f) => f.t > t0 && f.diff > Math.max(3, baseline * 6));
  if (!hit) {
    console.error(`trial ${n}: no video onset — skipped (baseline ${baseline.toFixed(2)})`);
    return null;
  }
  const lag = hit.t - tMove - (1000 / FPS) / 2;
  console.error(
    `trial ${n}: cmd->encoder ${tMove - t0} ms, encoder->video ${hit.t - tMove} ms, ` +
    `encodeLag est ${Math.round(lag)} ms`,
  );
  return lag;
}

async function main(): Promise<void> {
  await new Promise<void>((r) => sock.bind(() => r()));
  transmit(0x0200, [0x01]); // sequence reset
  await sleep(300);
  const ff = startFfmpeg();
  // Wait for the feed to produce diffs.
  for (let i = 0; i < 100 && frames.length < 5; i++) await sleep(100);
  if (frames.length < 5) throw new Error("no video frames from ffmpeg");

  const lags: number[] = [];
  for (let n = 0; n < TRIALS; n++) {
    const l = await trial(n);
    if (l != null) lags.push(l);
  }
  gotoAbsolute(0, 15);
  ff.kill("SIGKILL");
  sock.close();

  lags.sort((a, b) => a - b);
  const median = lags[Math.floor(lags.length / 2)];
  console.log(JSON.stringify({
    trials: lags.map(Math.round),
    medianEncodeLagMs: Math.round(median ?? -1),
  }, null, 1));
}

main().catch((err) => {
  console.error(err);
  stopMotion();
  setTimeout(() => process.exit(1), 500);
});
