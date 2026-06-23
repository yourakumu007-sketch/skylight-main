// Measure the TONGVEO's ABSOLUTE-position-move speeds at the LOW speed bytes —
// the thing measure-speeds.ts never checked (it only timed the velocity DRIVE
// command, and always sent absolute moves at MAX speed to reposition). If a slow
// absolute move (06 02 VV WW ...) creeps below the 3.6°/s drive floor, smooth
// slow tracking becomes possible.
//
// Method: same two-timed-sweep as measure-speeds.ts (T1=0.8s, T2=1.8s, ramp
// cancels), but each "sweep" is an absolute move toward a FAR target at speed
// byte S, interrupted by a drive-stop (which supersedes the in-flight absolute
// move). Positions read only while stationary.
//
// RUN ON THE PI with skylight-tracker STOPPED:
//   sudo systemctl stop skylight-tracker
//   cd ~/skylight/tracker && CAMERA_IP=192.168.5.206 pnpm exec tsx scripts/measure-abs.ts
//   sudo systemctl start skylight-tracker

import dgram from "node:dgram";

const IP = process.env.CAMERA_IP ?? "192.168.5.206";
const PORT = 52381;
const PAN_UPD = 71.714, PAN_ZERO = 12550, TILT_UPD = 69.333, TILT_ZERO = 6240;
const T1_MS = 800, T2_MS = 1800;
const PT_COMMAND = 0x0100, PT_INQUIRY = 0x0110, PT_CONTROL = 0x0200;

let sock = dgram.createSocket("udp4");
let seq = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function transmit(payloadType: number, payload: number[]): void {
  const buf = Buffer.alloc(8 + payload.length);
  buf.writeUInt16BE(payloadType, 0);
  buf.writeUInt16BE(payload.length, 2);
  buf.writeUInt32BE(++seq, 4);
  Buffer.from(payload).copy(buf, 8);
  sock.send(buf, PORT, IP);
}
async function rebindSocket(): Promise<void> {
  try { sock.close(); } catch { /* closed */ }
  sock = dgram.createSocket("udp4");
  sock.on("message", onMessage);
  await new Promise<void>((r) => sock.bind(() => r()));
  seq = 0;
  transmit(PT_CONTROL, [0x01]);
  await sleep(500);
}
function nibbles(value: number, count: number): number[] {
  const v = value & 0xffff;
  const out: number[] = [];
  for (let i = count - 1; i >= 0; i--) out.push((v >> (i * 4)) & 0x0f);
  return out;
}
function fromNibbles(bytes: Uint8Array): number {
  let v = 0;
  for (const b of bytes) v = (v << 4) | (b & 0x0f);
  if (bytes.length === 4 && v & 0x8000) v -= 0x10000;
  return v;
}
let lastPose: { t: number; panDeg: number; tiltDeg: number } | null = null;
function onMessage(msg: Buffer): void {
  if (msg.length < 9) return;
  const payload = msg.subarray(8);
  const y = payload[1] ?? 0;
  if ((y & 0xf0) === 0x50 && payload.length === 11 && payload[10] === 0xff) {
    const pan = fromNibbles(payload.subarray(2, 6));
    const tilt = fromNibbles(payload.subarray(6, 10));
    lastPose = { t: Date.now(), panDeg: (pan - PAN_ZERO) / PAN_UPD, tiltDeg: (tilt - TILT_ZERO) / TILT_UPD };
  }
}
sock.on("message", onMessage);
const inquire = () => transmit(PT_INQUIRY, [0x81, 0x09, 0x06, 0x12, 0xff]);

/** Absolute move with explicit speed bytes vv (pan) / ww (tilt). */
function gotoAbs(panDeg: number, tiltDeg: number, vv: number, ww: number): void {
  const p = nibbles(Math.round(PAN_ZERO + panDeg * PAN_UPD), 4);
  const t = nibbles(Math.round(TILT_ZERO + tiltDeg * TILT_UPD), 4);
  transmit(PT_COMMAND, [0x81, 0x01, 0x06, 0x02, vv & 0x1f, ww & 0x1f, ...p, ...t, 0xff]);
}
function drive(panStep: number, panDir: number, tiltStep: number, tiltDir: number): void {
  transmit(PT_COMMAND, [0x81, 0x01, 0x06, 0x01, Math.max(1, panStep), Math.max(1, tiltStep), panDir, tiltDir, 0xff]);
}
const stopMotion = () => drive(1, 0x03, 1, 0x03);

async function readStillPose(): Promise<{ panDeg: number; tiltDeg: number }> {
  let prev: { t: number; panDeg: number; tiltDeg: number } | null = null;
  let lastProgressAt = Date.now();
  for (let i = 0; i < 120; i++) {
    inquire();
    await sleep(200);
    const p = lastPose;
    if (!p || (prev && p.t === prev.t)) {
      if (Date.now() - lastProgressAt > 3000) { await rebindSocket(); lastProgressAt = Date.now(); }
      continue;
    }
    lastProgressAt = Date.now();
    if (prev && p.t !== prev.t && Math.abs(p.panDeg - prev.panDeg) < 0.03 && Math.abs(p.tiltDeg - prev.tiltDeg) < 0.03) {
      return { panDeg: p.panDeg, tiltDeg: p.tiltDeg };
    }
    prev = p;
  }
  throw new Error("still-pose timeout");
}
async function settleAt(panDeg: number, tiltDeg: number, tolDeg = 4): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    gotoAbs(panDeg, tiltDeg, 0x18, 0x14);
    await sleep(900);
    try {
      const p = await readStillPose();
      if (Math.abs(p.panDeg - panDeg) < tolDeg && Math.abs(p.tiltDeg - tiltDeg) < tolDeg) return;
    } catch { /* retry */ }
  }
  throw new Error(`settle timeout pan ${panDeg} tilt ${tiltDeg}`);
}

/** One timed sweep with a moving command toward a far target. Returns deg moved. */
async function timedSweep(
  axis: "pan" | "tilt", kind: "abs" | "drive", speedByte: number, ms: number,
): Promise<number> {
  const startPan = axis === "pan" ? 0 : 0;
  const startTilt = 0;
  await settleAt(startPan, startTilt);
  const a = await readStillPose();
  // Far target so the move never completes within the window.
  const farPan = axis === "pan" ? 140 : 0;
  const farTilt = axis === "tilt" ? 70 : 0;
  if (kind === "abs") gotoAbs(farPan, farTilt, speedByte, speedByte);
  else if (axis === "pan") drive(speedByte, 0x02, 1, 0x03);
  else drive(1, 0x03, speedByte, 0x01);
  await sleep(ms);
  stopMotion();
  await sleep(700);
  const b = await readStillPose();
  return Math.abs(axis === "pan" ? b.panDeg - a.panDeg : b.tiltDeg - a.tiltDeg);
}

async function measure(axis: "pan" | "tilt", kind: "abs" | "drive", speedByte: number): Promise<number> {
  // Retry with socket rebind — the firmware's inquiry replies stall around
  // moves; stale reads scatter and never agree, so collect until two agree.
  const rates: number[] = [];
  for (let attempt = 0; attempt < 7; attempt++) {
    let rate: number;
    try {
      const d1 = await timedSweep(axis, kind, speedByte, T1_MS);
      const d2 = await timedSweep(axis, kind, speedByte, T2_MS);
      rate = ((d2 - d1) / (T2_MS - T1_MS)) * 1000;
    } catch {
      await rebindSocket();
      continue;
    }
    if (!(rate > 0.05 && rate < 90)) continue; // stale/garbled read slipped through
    for (const r of rates) {
      if (Math.abs(r - rate) < Math.max(0.4, 0.1 * rate)) return (r + rate) / 2;
    }
    rates.push(rate);
  }
  if (!rates.length) return NaN;
  rates.sort((a, b) => a - b);
  return rates[rates.length >> 1];
}

async function main(): Promise<void> {
  await new Promise<void>((r) => sock.bind(() => r()));
  transmit(PT_CONTROL, [0x01]);
  await sleep(500);
  console.log(`camera ${IP}`);
  // Warm up the reply channel before timing anything.
  for (let i = 0; i < 3; i++) {
    try { console.log(`  warmup pose: ${JSON.stringify(await readStillPose())}`); break; }
    catch { await rebindSocket(); }
  }
  console.log("--- DRIVE pan byte 1 (sanity vs known 3.6) ---");
  console.log(`  drive pan@1 = ${(await measure("pan", "drive", 1)).toFixed(2)} deg/s`);
  console.log("--- ABSOLUTE-move speeds at low bytes (the question) ---");
  for (const b of [1, 2, 3]) {
    console.log(`  ABS pan@${b}  = ${(await measure("pan", "abs", b)).toFixed(2)} deg/s`);
  }
  for (const b of [1, 2, 3]) {
    console.log(`  ABS tilt@${b} = ${(await measure("tilt", "abs", b)).toFixed(2)} deg/s`);
  }
  await settleAt(0, 0);
  sock.close();
}
void main();
