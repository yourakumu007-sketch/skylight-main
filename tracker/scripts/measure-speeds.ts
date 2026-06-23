// Measure the TONGVEO's drive-speed tables: every pan step 1..24 and tilt
// step 1..20.
//
// Method: two timed sweeps per step (T1=0.8 s, T2=1.8 s), positions read only
// while STATIONARY — this firmware's position inquiries bunch up or stall
// entirely during a drive, so any sampling-while-moving scheme is unreliable.
// The accel ramp and decel tail are identical in both sweeps and cancel:
//   rate = (dist2 - dist1) / (T2 - T1)
//
// RUN ON THE PI with skylight-tracker STOPPED (the camera answers only the
// most recent VISCA sender):
//   sudo systemctl stop skylight-tracker
//   cd ~/skylight/tracker && pnpm exec tsx scripts/measure-speeds.ts
//   sudo systemctl start skylight-tracker
//
// Output: JSON tables to paste into src/camera/visca.ts.

import dgram from "node:dgram";

const IP = process.env.CAMERA_IP ?? "192.168.0.206";
const PORT = 52381;

// Measured unit scales (HANDOFF).
const PAN_UPD = 71.714;
const PAN_ZERO = 12550;
const TILT_UPD = 69.333;
const TILT_ZERO = 6240;

const T1_MS = 800;
const T2_MS = 1800;

const PT_COMMAND = 0x0100;
const PT_INQUIRY = 0x0110;
const PT_CONTROL = 0x0200;

let sock = dgram.createSocket("udp4");
let seq = 0;

function transmit(payloadType: number, payload: number[]): void {
  const buf = Buffer.alloc(8 + payload.length);
  buf.writeUInt16BE(payloadType, 0);
  buf.writeUInt16BE(payload.length, 2);
  buf.writeUInt32BE(++seq, 4);
  Buffer.from(payload).copy(buf, 8);
  sock.send(buf, PORT, IP);
}

/**
 * Hard recovery from a reply stall: this firmware addresses replies to the
 * most recent CLIENT, and that state machine wedges. A brand-new source
 * port forces it to re-register us; a sequence reset alone does not.
 */
async function rebindSocket(): Promise<void> {
  try {
    sock.close();
  } catch {
    /* already closed */
  }
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

/** Latest pan/tilt reading (deg) + receive timestamp. */
let lastPose: { t: number; panDeg: number; tiltDeg: number } | null = null;

function onMessage(msg: Buffer): void {
  if (msg.length < 9) return;
  const payload = msg.subarray(8);
  const y = payload[1] ?? 0;
  // Same shape-classification as the tracker driver: 11 bytes = pan/tilt.
  if ((y & 0xf0) === 0x50 && payload.length === 11 && payload[10] === 0xff) {
    const pan = fromNibbles(payload.subarray(2, 6));
    const tilt = fromNibbles(payload.subarray(6, 10));
    lastPose = {
      t: Date.now(),
      panDeg: (pan - PAN_ZERO) / PAN_UPD,
      tiltDeg: (tilt - TILT_ZERO) / TILT_UPD,
    };
  }
}
sock.on("message", onMessage);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const inquire = () => transmit(PT_INQUIRY, [0x81, 0x09, 0x06, 0x12, 0xff]);

function gotoAbsolute(panDeg: number, tiltDeg: number): void {
  const p = nibbles(Math.round(PAN_ZERO + panDeg * PAN_UPD), 4);
  const t = nibbles(Math.round(TILT_ZERO + tiltDeg * TILT_UPD), 4);
  transmit(PT_COMMAND, [0x81, 0x01, 0x06, 0x02, 0x18, 0x14, ...p, ...t, 0xff]);
}

function drive(panStep: number, panDir: number, tiltStep: number, tiltDir: number): void {
  transmit(PT_COMMAND, [
    0x81, 0x01, 0x06, 0x01,
    Math.max(1, panStep), Math.max(1, tiltStep),
    panDir, tiltDir, 0xff,
  ]);
}

const stopMotion = () => drive(1, 0x03, 1, 0x03);

/**
 * Poll (gently, 5 Hz — the inquiry handler wedges under sustained load)
 * until two consecutive FRESH readings agree — camera still. Freshness is
 * critical: this firmware's inquiry replies stall around drives, and
 * comparing a stale reading against itself reads as "perfectly still" at a
 * position the camera left half a second ago.
 */
async function readStillPose(): Promise<{ panDeg: number; tiltDeg: number }> {
  let prev: { t: number; panDeg: number; tiltDeg: number } | null = null;
  let lastProgressAt = Date.now();
  for (let i = 0; i < 120; i++) {
    inquire();
    await sleep(200);
    const p = lastPose;
    if (!p || (prev && p.t === prev.t)) {
      // Replies stalled — recreate the socket on a NEW source port (the
      // firmware's reply-addressing wedges; sequence resets don't fix it).
      if (Date.now() - lastProgressAt > 3000) {
        console.error("  reply stall — rebinding socket");
        await rebindSocket();
        lastProgressAt = Date.now();
      }
      continue;
    }
    lastProgressAt = Date.now();
    if (
      prev &&
      p.t !== prev.t &&
      Math.abs(p.panDeg - prev.panDeg) < 0.03 &&
      Math.abs(p.tiltDeg - prev.tiltDeg) < 0.03
    ) {
      return { panDeg: p.panDeg, tiltDeg: p.tiltDeg };
    }
    prev = p;
  }
  throw new Error(`still-pose timeout (last: ${JSON.stringify(lastPose)})`);
}

/** Re-issue the absolute move until the camera is still near the target. */
async function settleAt(panDeg: number, tiltDeg: number, tolDeg = 4): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    gotoAbsolute(panDeg, tiltDeg);
    await sleep(800);
    try {
      const p = await readStillPose();
      if (Math.abs(p.panDeg - panDeg) < tolDeg && Math.abs(p.tiltDeg - tiltDeg) < tolDeg) {
        return;
      }
    } catch (err) {
      lastErr = err; // reply stall mid-settle — re-issue and keep trying
    }
  }
  throw new Error(
    `settle timeout at pan ${panDeg} tilt ${tiltDeg} (last: ${JSON.stringify(lastPose)}, err: ${lastErr})`,
  );
}

/** One timed sweep: still pose -> drive driveMs -> stop -> still pose. Deg. */
async function timedSweep(
  axis: "pan" | "tilt",
  step: number,
  dir: number,
  driveMs: number,
  startPan: number,
  startTilt: number,
): Promise<number> {
  await settleAt(startPan, startTilt);
  const a = await readStillPose();
  if (axis === "pan") drive(step, dir, 1, 0x03);
  else drive(1, 0x03, step, dir);
  await sleep(driveMs);
  stopMotion();
  await sleep(700); // decel tail
  const b = await readStillPose();
  return Math.abs(axis === "pan" ? b.panDeg - a.panDeg : b.tiltDeg - a.tiltDeg);
}

/**
 * Repeat the two-sweep measurement until two results AGREE (within 8% or
 * 0.5°/s), then return their mean; stale reads produce scattered values that
 * never agree with a clean one. Median of everything after 5 tries.
 */
async function measureStep(
  axis: "pan" | "tilt",
  step: number,
  dir: number,
  startPan: number,
  startTilt: number,
): Promise<number> {
  const rates: number[] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    let rate: number;
    try {
      const d1 = await timedSweep(axis, step, dir, T1_MS, startPan, startTilt);
      const d2 = await timedSweep(axis, step, dir, T2_MS, startPan, startTilt);
      rate = (d2 - d1) / ((T2_MS - T1_MS) / 1000);
    } catch (err) {
      console.error(`  ${axis} ${step}: ${err} — rebinding and retrying`);
      await rebindSocket();
      continue;
    }
    // The fastest sustained drive measures ~75°/s; outside this range a
    // stale/garbled position read slipped through.
    if (!(rate > 0.2 && rate < 90)) {
      console.error(`  ${axis} ${step}: implausible ${rate.toFixed(2)} deg/s — retrying`);
      continue;
    }
    for (const r of rates) {
      if (Math.abs(r - rate) < Math.max(0.5, 0.08 * rate)) {
        return (r + rate) / 2;
      }
    }
    rates.push(rate);
  }
  if (!rates.length) throw new Error(`no plausible rate for ${axis} step ${step}`);
  rates.sort((a, b) => a - b);
  const median = rates[Math.floor(rates.length / 2)];
  console.error(`  ${axis} ${step}: no agreement ${JSON.stringify(rates)} — median ${median}`);
  return median;
}

/** Parse "pan=4,5,9 tilt=10,11" style argv; no args = everything. */
function wantedSteps(): { pan: number[]; tilt: number[] } {
  const all = { pan: [] as number[], tilt: [] as number[] };
  let any = false;
  for (const arg of process.argv.slice(2)) {
    const m = /^(pan|tilt)=([\d,]+)$/.exec(arg);
    if (!m) continue;
    any = true;
    all[m[1] as "pan" | "tilt"].push(...m[2].split(",").map(Number));
  }
  if (!any) {
    all.pan = Array.from({ length: 24 }, (_, i) => i + 1);
    all.tilt = Array.from({ length: 20 }, (_, i) => i + 1);
  }
  return all;
}

async function main(): Promise<void> {
  await new Promise<void>((r) => sock.bind(() => r()));
  transmit(PT_CONTROL, [0x01]); // sequence reset
  await sleep(300);
  console.error(`start pose: ${JSON.stringify(await readStillPose())}`);
  const wanted = wantedSteps();

  const pan: [number, number][] = [];
  for (const step of wanted.pan) {
    // Alternate sweep direction so repositioning stays short.
    const rightward = step % 2 === 1;
    const dps = await measureStep(
      "pan", step, rightward ? 0x02 : 0x01, rightward ? -75 : 25, 0,
    );
    pan.push([step, Number(dps.toFixed(2))]);
    console.error(`pan ${step}: ${dps.toFixed(2)} deg/s`);
  }

  const tilt: [number, number][] = [];
  for (const step of wanted.tilt) {
    const upward = step % 2 === 1;
    const dps = await measureStep(
      "tilt", step, upward ? 0x01 : 0x02, 0, upward ? -28 : 25,
    );
    tilt.push([step, Number(dps.toFixed(2))]);
    console.error(`tilt ${step}: ${dps.toFixed(2)} deg/s`);
  }

  await settleAt(0, 15); // leave it somewhere civilised
  console.log(JSON.stringify({ pan, tilt }, null, 1));
  sock.close();
}

main().catch((err) => {
  console.error(err);
  stopMotion();
  setTimeout(() => process.exit(1), 500);
});
