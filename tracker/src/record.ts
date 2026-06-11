// JSONL session recorder. One line per event; replayable via ReplayUpstream
// (snapshots) and greppable for everything else (commands, poses, VISCA hex).

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";

export class Recorder {
  private stream: WriteStream | null = null;
  private path: string | null = null;

  constructor(private dir: string) {}

  get recording(): boolean {
    return this.stream !== null;
  }

  start(): string {
    if (this.stream && this.path) return this.path;
    mkdirSync(this.dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.path = join(this.dir, `session-${stamp}.jsonl`);
    this.stream = createWriteStream(this.path, { flags: "a" });
    this.write("meta", { startedAt: Date.now() });
    console.log(`[record] -> ${this.path}`);
    return this.path;
  }

  stop(): void {
    this.stream?.end();
    this.stream = null;
    this.path = null;
  }

  write(kind: string, data: Record<string, unknown>): void {
    if (!this.stream) return;
    this.stream.write(JSON.stringify({ kind, t: Date.now(), ...data }) + "\n");
  }
}
