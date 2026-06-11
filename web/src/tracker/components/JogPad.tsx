// Manual pan/tilt/zoom jog: hold a button to move, release to stop. Drives
// calibration captures and all the hardware bring-up milestones.

import { useRef, useState } from "react";
import type { TrackerConnection } from "../connection.js";

export function JogPad({ conn }: { conn: TrackerConnection }) {
  const [speed, setSpeed] = useState(0.3);
  const active = useRef(false);

  const start = (pan: number, tilt: number, zoom: number) => {
    active.current = true;
    conn.send({ type: "jog", pan: pan * speed, tilt: tilt * speed, zoom: zoom * speed });
  };
  const stop = () => {
    if (!active.current) return;
    active.current = false;
    conn.send({ type: "stopJog" });
  };

  const btn = (label: string, pan: number, tilt: number, zoom: number, cls = "") => (
    <button
      className={`jog-btn ${cls}`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        start(pan, tilt, zoom);
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onPointerLeave={stop}
    >
      {label}
    </button>
  );

  return (
    <div className="jog-pad">
      <div className="jog-grid">
        <span />
        {btn("▲", 0, 1, 0)}
        <span />
        {btn("◀", -1, 0, 0)}
        {btn("■", 0, 0, 0, "stop")}
        {btn("▶", 1, 0, 0)}
        <span />
        {btn("▼", 0, -1, 0)}
        <span />
      </div>
      <div className="jog-zoom">
        {btn("T+", 0, 0, 1, "wide")}
        {btn("W−", 0, 0, -1, "wide")}
      </div>
      <label className="jog-speed">
        speed
        <input type="range" min={0.05} max={1} step={0.05} value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))} />
        {(speed * 100).toFixed(0)}%
      </label>
    </div>
  );
}
