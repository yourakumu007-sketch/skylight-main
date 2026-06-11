// Full-quality clip recording: start/stop a native-quality .mp4 capture of the
// camera's main stream and download finished clips to your computer.

import { useCallback, useEffect, useRef, useState } from "react";
import type { TrackerState } from "@shared/index.js";
import { trackerHttp } from "../connection.js";

interface Rec {
  name: string;
  sizeBytes: number;
  mtime: number;
}

function fmtSize(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(b / 1e3))} KB`;
}
function fmtDur(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

export function RecordPanel({
  state,
  connected,
}: {
  state: TrackerState;
  connected: boolean;
}) {
  const [recs, setRecs] = useState<Rec[]>([]);
  const rec = state.videoRec;
  const wasRecording = useRef(false);

  const refresh = useCallback(() => {
    fetch(trackerHttp("/api/recordings"))
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setRecs(d as Rec[]))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Refresh the clip list right after a recording finishes (file is finalized).
  useEffect(() => {
    if (wasRecording.current && !rec.recording) setTimeout(refresh, 800);
    wasRecording.current = rec.recording;
  }, [rec.recording, refresh]);

  const toggle = () => {
    fetch(trackerHttp("/api/record/video"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ on: !rec.recording }),
    }).catch(() => {});
  };

  const del = (name: string) => {
    fetch(trackerHttp(`/api/recordings/${name}`), { method: "DELETE" })
      .then(refresh)
      .catch(() => {});
  };

  const canRecord = state.driver.kind === "visca";
  const elapsed = rec.recording && rec.startedAt ? (state.now - rec.startedAt) / 1000 : 0;

  return (
    <div className="record-panel">
      <div className="record-head">
        <button
          className={`rec-btn ${rec.recording ? "on" : ""}`}
          disabled={!connected || !canRecord}
          onClick={toggle}
          title={
            canRecord
              ? "record a full-quality clip of the main camera stream"
              : "switch to the visca driver to record the real camera"
          }
        >
          {rec.recording ? `● REC ${fmtDur(elapsed)}` : "⬤ Record clip"}
        </button>
        <span className="record-hint">
          {canRecord ? "native 1080p · -c copy" : "real camera only"}
        </span>
      </div>
      {recs.length > 0 && (
        <ul className="record-list">
          {recs.map((r) => (
            <li key={r.name}>
              <a href={trackerHttp(`/recordings/${r.name}`)} download>
                {r.name.replace(/^clip-/, "").replace(/\.mp4$/, "")}
              </a>
              <span className="rec-size">{fmtSize(r.sizeBytes)}</span>
              <button className="rec-del" aria-label={`delete ${r.name}`} onClick={() => del(r.name)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
