// Full-quality clip recorder: a dedicated ffmpeg pulls the camera's RTSP MAIN
// stream and writes it straight to disk with `-c copy` (no transcode — native
// 1080p H.264 at full framerate, near-zero CPU). Fragmented MP4 so a clip stays
// playable even if the process is killed mid-recording. Decoupled from the live
// MSE/MJPEG pipelines (its own RTSP connection), so recording never disturbs the
// display or the vision loop.

import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

export interface RecordingInfo {
  name: string;
  sizeBytes: number;
  mtime: number;
}

export interface VideoRecStatus {
  recording: boolean;
  file?: string;
  startedAt?: number;
}

const NAME_RE = /^clip-[\w-]+\.mp4$/;

export class VideoRecorder {
  private proc: ChildProcess | null = null;
  private current: { name: string; startedAt: number } | null = null;

  constructor(
    private dir: string,
    private url: string,
  ) {}

  /** Camera IP/URL can change at runtime; the new URL applies to the next clip. */
  setUrl(url: string): void {
    this.url = url;
  }

  get recording(): boolean {
    return this.proc !== null;
  }

  status(): VideoRecStatus {
    return {
      recording: this.recording,
      file: this.current?.name,
      startedAt: this.current?.startedAt,
    };
  }

  /** Begin a clip. Idempotent: a second call while recording is a no-op. */
  start(): VideoRecStatus & { error?: string } {
    if (this.proc) return this.status();
    if (!this.url) return { recording: false, error: "no camera stream" };
    mkdirSync(this.dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");
    const name = `clip-${stamp}.mp4`;
    const path = join(this.dir, name);
    const args = [
      "-hide_banner", "-loglevel", "error",
      "-rtsp_transport", "tcp",
      "-i", this.url,
      "-an", "-c:v", "copy",
      "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
      "-f", "mp4",
      path,
    ];
    // stdin piped so we can send 'q' for a graceful finalize on stop.
    const proc = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
    this.proc = proc;
    this.current = { name, startedAt: Date.now() };
    let errTail = "";
    proc.stderr?.on("data", (c: Buffer) => {
      errTail = (errTail + c.toString()).slice(-400);
    });
    proc.on("exit", (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.current = null;
      if (code) console.error(`[rec-video] ffmpeg exited (${code}): ${errTail.trim().split("\n").pop() ?? ""}`);
    });
    console.log(`[rec-video] -> ${path}`);
    return this.status();
  }

  /** Stop the current clip, finalizing the file gracefully. */
  stop(): void {
    const proc = this.proc;
    if (!proc) return;
    try {
      proc.stdin?.write("q"); // ffmpeg's graceful-quit key
    } catch {
      /* fall through to the kill fallback */
    }
    // Hard stop if it doesn't exit on its own (e.g. stdin ignored by firmware).
    setTimeout(() => {
      if (proc.exitCode === null && !proc.killed) {
        try {
          proc.kill("SIGINT");
        } catch {
          /* exiting anyway */
        }
      }
    }, 2000);
  }

  list(): RecordingInfo[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => NAME_RE.test(f))
      .map((f) => {
        const s = statSync(join(this.dir, f));
        return { name: f, sizeBytes: s.size, mtime: s.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  }

  /** Resolve a clip name to a path, guarding against traversal. null if absent. */
  resolve(name: string): string | null {
    if (!NAME_RE.test(name)) return null;
    const path = join(this.dir, name);
    return existsSync(path) ? path : null;
  }

  remove(name: string): boolean {
    const path = this.resolve(name);
    if (!path) return false;
    if (this.current?.name === name) return false; // don't delete while writing
    try {
      unlinkSync(path);
      return true;
    } catch {
      return false;
    }
  }
}
