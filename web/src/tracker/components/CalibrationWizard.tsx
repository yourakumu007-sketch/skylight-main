// Calibration: pick a reference (Moon / bright star / a live aircraft), jog
// until it's centered in the video, Capture. Repeat across the sky, Solve,
// review residuals, Apply (persists the mount model to config).

import { useState } from "react";
import type { CalibrationRef, TrackerState } from "@shared/index.js";
import type { TrackerConnection } from "../connection.js";

export function CalibrationWizard({
  state,
  conn,
}: {
  state: TrackerState;
  conn: TrackerConnection;
}) {
  const [refName, setRefName] = useState<string>("");
  const [solveGains, setSolveGains] = useState(false);
  const [solveLevel, setSolveLevel] = useState(false);
  const calib = state.calibration;

  const selectedRef = (): CalibrationRef | null => {
    if (!refName) return null;
    if (refName.startsWith("ac:")) return { kind: "aircraft", hex: refName.slice(3) };
    return { kind: "body", name: refName };
  };

  const ref = selectedRef();
  const goto = () => {
    if (refName.startsWith("ac:")) {
      const c = state.candidates.find((x) => x.hex === refName.slice(3));
      if (c) conn.send({ type: "gotoAzEl", azDeg: c.azEl.azDeg, elDeg: c.azEl.elDeg });
      return;
    }
    const body = calib.visibleBodies.find((b) => b.name === refName);
    if (body) conn.send({ type: "gotoAzEl", azDeg: body.azDeg, elDeg: body.elDeg });
  };

  return (
    <div className="calib">
      <div className="calib-row">
        <select value={refName} onChange={(e) => setRefName(e.target.value)}>
          <option value="">— pick a reference —</option>
          <optgroup label="Celestial (truth from astronomy engine)">
            {calib.visibleBodies.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name} (az {b.azDeg.toFixed(0)}° el {b.elDeg.toFixed(0)}°)
              </option>
            ))}
          </optgroup>
          <optgroup label="Aircraft (truth from ADS-B)">
            {state.candidates.map((c) => (
              <option key={c.hex} value={`ac:${c.hex}`}>
                {c.flight ?? c.hex} (el {c.azEl.elDeg.toFixed(0)}°)
              </option>
            ))}
          </optgroup>
        </select>
        <button disabled={!refName} onClick={goto}
          title="point the camera at it using the current mount model">
          go to
        </button>
        <button
          className="primary"
          disabled={!ref}
          onClick={() => ref && conn.send({ type: "calibCapture", ref })}
          title="record (camera pose, true az/el) — center the reference first!"
        >
          capture
        </button>
      </div>

      {calib.captures.length > 0 && (
        <table className="calib-table">
          <thead>
            <tr><th>ref</th><th>pan°</th><th>tilt°</th><th>true az°</th><th>true el°</th>
              <th>resid°</th><th></th></tr>
          </thead>
          <tbody>
            {calib.captures.map((c, i) => (
              <tr key={c.id}>
                <td>{c.refName}</td>
                <td>{c.panDeg.toFixed(2)}</td>
                <td>{c.tiltDeg.toFixed(2)}</td>
                <td>{c.azDeg.toFixed(2)}</td>
                <td>{c.elDeg.toFixed(2)}</td>
                <td>{calib.residualsDeg[i]?.toFixed(3) ?? "—"}</td>
                <td>
                  <button className="mini" onClick={() => conn.send({ type: "calibRemove", id: c.id })}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="calib-row">
        <label><input type="checkbox" checked={solveGains}
          onChange={(e) => setSolveGains(e.target.checked)} /> gains (≥3 pts)</label>
        <label><input type="checkbox" checked={solveLevel}
          onChange={(e) => setSolveLevel(e.target.checked)} /> level (≥4 pts)</label>
        <button
          disabled={calib.captures.length < 1}
          onClick={() => conn.send({ type: "calibSolve", solveGains, solveLevel })}
        >
          solve
        </button>
        <button
          className="primary"
          disabled={!calib.solved}
          onClick={() => conn.send({ type: "calibApply" })}
          title="persist the solved mount model to config"
        >
          apply
        </button>
        <button onClick={() => conn.send({ type: "calibReset" })}>reset</button>
      </div>

      {calib.solved && (
        <div className="calib-solved">
          rms <b>{calib.rmsDeg?.toFixed(3)}°</b> · pan0 {calib.solved.panOffsetDeg.toFixed(2)}°
          · tilt0 {calib.solved.tiltOffsetDeg.toFixed(2)}°
          · gains {calib.solved.panGain.toFixed(4)}/{calib.solved.tiltGain.toFixed(4)}
          · level {calib.solved.levelTiltDeg.toFixed(2)}°@{calib.solved.levelDirDeg.toFixed(0)}°
        </div>
      )}
    </div>
  );
}
