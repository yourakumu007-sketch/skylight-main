// H.264 passthrough for the TV: pull the camera's RTSP main stream and remux
// it (-c copy, NO transcode — near-zero CPU, full native quality/framerate)
// into fragmented MP4, fanned out over a WebSocket to MediaSource clients.
//
// Protocol on /video-ws: first message is JSON { codec: "avc1.PPCCLL" }
// (parsed from the avcC box), then binary: the init segment (ftyp+moov), then
// a continuous run of fragments. New clients get init + the stream starting
// at the next moof boundary, so they always join on a clean fragment.

import { spawn, type ChildProcess } from "node:child_process";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";

const STALL_MS = 10_000;
/** Drop a client whose socket has this much unsent data (slow consumer). */
const MAX_BUFFERED = 16 * 1024 * 1024;

interface Client {
  ws: WebSocket;
  /** Waiting for the next moof before forwarding (just joined). */
  awaitingFragment: boolean;
}

export class Mp4Stream {
  private proc: ChildProcess | null = null;
  private buffer = Buffer.alloc(0);
  private initSegment: Buffer | null = null;
  private codec: string | null = null;
  private clients = new Set<Client>();
  private wss: WebSocketServer | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private stopped = true;
  private lastError: string | undefined;
  private lastDataAt = 0;
  private generation = 0;

  constructor(private url: string) {}

  setUrl(url: string): void {
    if (url === this.url) return;
    this.url = url;
    if (!this.stopped) {
      this.kill();
      this.spawnProc();
    }
  }

  /** Init the WS endpoint (upgrades arrive via handleUpgrade from index). */
  attach(): void {
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", (ws) => {
      const client: Client = { ws, awaitingFragment: true };
      this.clients.add(client);
      if (this.codec) ws.send(JSON.stringify({ codec: this.codec }));
      if (this.initSegment) ws.send(this.initSegment);
      ws.on("close", () => this.clients.delete(client));
      ws.on("error", () => this.clients.delete(client));
    });
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss?.handleUpgrade(req, socket, head, (ws) =>
      this.wss!.emit("connection", ws, req),
    );
  }

  start(): void {
    this.stopped = false;
    this.spawnProc();
    if (!this.watchdog) {
      this.watchdog = setInterval(() => {
        if (this.stopped || !this.proc) return;
        if (this.lastDataAt && Date.now() - this.lastDataAt > STALL_MS) {
          console.error("[mse] stream stalled — restarting ffmpeg");
          this.lastError = "stream stalled; reconnecting";
          this.lastDataAt = 0;
          this.kill();
          this.restartTimer = setTimeout(() => this.spawnProc(), 1000);
        }
      }, 2000);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.kill();
  }

  status(): { running: boolean; gen: number; error?: string } {
    const fresh = this.lastDataAt > 0 && Date.now() - this.lastDataAt < STALL_MS;
    return { running: this.proc !== null && fresh, gen: this.generation, error: this.lastError };
  }

  private spawnProc(): void {
    if (this.proc || this.stopped) return;
    this.generation++;
    // Fresh stream epoch: clients must rejoin at the new init segment.
    this.initSegment = null;
    this.codec = null;
    this.buffer = Buffer.alloc(0);
    for (const c of this.clients) c.awaitingFragment = true;

    const args = [
      "-hide_banner", "-loglevel", "error",
      "-rtsp_transport", "tcp",
      "-i", this.url,
      "-c:v", "copy", "-an",
      "-f", "mp4",
      "-movflags", "frag_keyframe+empty_moov+default_base_moof",
      "pipe:1",
    ];
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc;
    this.lastError = undefined;
    console.log(`[mse] ffmpeg -c copy <- ${this.url}`);

    proc.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
    let stderrTail = "";
    proc.stderr!.on("data", (c: Buffer) => {
      stderrTail = (stderrTail + c.toString()).slice(-400);
    });
    proc.on("exit", (code) => {
      // A killed/superseded process must not clobber its replacement or
      // schedule a duplicate respawn.
      if (this.proc !== proc) return;
      this.proc = null;
      if (this.stopped) return;
      this.lastError = `ffmpeg exited (${code}): ${stderrTail.trim().split("\n").pop() ?? ""}`;
      console.error(`[mse] ${this.lastError}`);
      this.restartTimer = setTimeout(() => this.spawnProc(), 3000);
    });
  }

  private kill(): void {
    this.proc?.kill("SIGKILL");
    this.proc = null;
    this.buffer = Buffer.alloc(0);
  }

  /** Split the byte stream into top-level MP4 boxes. */
  private onData(chunk: Buffer): void {
    this.lastDataAt = Date.now();
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 8) return;
      let size = this.buffer.readUInt32BE(0);
      const type = this.buffer.toString("ascii", 4, 8);
      if (size === 1) {
        if (this.buffer.length < 16) return;
        const big = this.buffer.readBigUInt64BE(8);
        size = Number(big);
      }
      if (size < 8 || size > 64 * 1024 * 1024) {
        // Corrupt framing — drop the buffer and let the watchdog recover.
        this.buffer = Buffer.alloc(0);
        return;
      }
      if (this.buffer.length < size) return;
      const box = this.buffer.subarray(0, size);
      this.buffer = this.buffer.subarray(size);
      this.onBox(type, Buffer.from(box));
    }
  }

  private onBox(type: string, box: Buffer): void {
    if (type === "ftyp") {
      this.initSegment = box;
      return;
    }
    if (type === "moov") {
      this.codec = extractAvcCodec(box) ?? "avc1.640028";
      this.initSegment = this.initSegment ? Buffer.concat([this.initSegment, box]) : box;
      // (Re)prime everyone with the fresh init segment.
      for (const c of this.clients) {
        if (c.ws.readyState !== WebSocket.OPEN) continue;
        c.ws.send(JSON.stringify({ codec: this.codec }));
        c.ws.send(this.initSegment);
        c.awaitingFragment = true;
      }
      return;
    }
    // Fragments: moof starts a clean join point; forward moof+mdat runs.
    for (const c of this.clients) {
      if (c.ws.readyState !== WebSocket.OPEN) continue;
      if (c.awaitingFragment) {
        if (type !== "moof") continue;
        c.awaitingFragment = false;
      }
      if (c.ws.bufferedAmount > MAX_BUFFERED) {
        c.ws.close(); // slow consumer — let it reconnect fresh
        continue;
      }
      c.ws.send(box);
    }
  }
}

/** codec string from the avcC record inside moov: avc1.PPCCLL (hex). */
function extractAvcCodec(moov: Buffer): string | null {
  const idx = moov.indexOf("avcC");
  if (idx < 0 || idx + 8 > moov.length) return null;
  const profile = moov[idx + 5];
  const compat = moov[idx + 6];
  const level = moov[idx + 7];
  const h = (b: number) => b.toString(16).padStart(2, "0");
  return `avc1.${h(profile)}${h(compat)}${h(level)}`;
}
