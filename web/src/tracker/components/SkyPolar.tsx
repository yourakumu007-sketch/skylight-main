// Polar all-sky plot (zenith at center, horizon at the rim): every candidate
// aircraft, the selected target, the camera's actual aim, and — in calibrate
// mode — the visible celestial bodies.

import {
  worldFromMount,
  type TrackerConfig,
  type TrackerState,
} from "@shared/index.js";

const R = 130;

function polar(azDeg: number, elDeg: number): { x: number; y: number } {
  const r = ((90 - Math.max(0, elDeg)) / 90) * R;
  const a = ((azDeg - 90) * Math.PI) / 180; // 0° = North = up
  return { x: 150 + r * Math.cos(a), y: 150 + r * Math.sin(a) };
}

export function SkyPolar({
  state,
  config,
  onPick,
}: {
  state: TrackerState;
  config: TrackerConfig;
  onPick: (hex: string) => void;
}) {
  const aim = state.pose ? worldFromMount(state.pose, config.mount) : null;
  const showBodies = state.mode === "calibrate";

  return (
    <svg className="sky-polar" viewBox="0 0 300 300">
      {/* elevation rings at 0/30/60° */}
      {[90, 60, 30].map((el) => (
        <circle key={el} cx="150" cy="150" r={((90 - el) / 90) * R + (el === 90 ? 2 : 0)}
          className="ring" />
      ))}
      <circle cx="150" cy="150" r={R} className="ring horizon" />
      {/* min-elevation filter ring */}
      <circle cx="150" cy="150" r={((90 - config.target.minElevationDeg) / 90) * R}
        className="ring min-el" />
      {(["N", "E", "S", "W"] as const).map((label, i) => {
        const p = polar(i * 90, -8);
        return (
          <text key={label} x={p.x} y={p.y + 3} className="compass">{label}</text>
        );
      })}

      {showBodies &&
        state.calibration.visibleBodies.map((b) => {
          const p = polar(b.azDeg, b.elDeg);
          return (
            <g key={b.name}>
              <circle cx={p.x} cy={p.y} r={b.name === "Sun" || b.name === "Moon" ? 5 : 2.5}
                className={`body ${b.name.toLowerCase()}`} />
              <text x={p.x + 6} y={p.y + 3} className="body-label">{b.name}</text>
            </g>
          );
        })}

      {state.candidates.map((c) => {
        const p = polar(c.azEl.azDeg, c.azEl.elDeg);
        const isTarget = c.hex === state.target.hex;
        return (
          <g key={c.hex} onClick={() => onPick(c.hex)} className="candidate-g">
            <circle cx={p.x} cy={p.y} r={isTarget ? 5 : 3.5}
              className={`candidate ${isTarget ? "target" : ""}`} />
            <text x={p.x + 7} y={p.y + 3} className="candidate-label">
              {c.flight ?? c.hex}
            </text>
          </g>
        );
      })}

      {state.target.predicted && (
        (() => {
          const p = polar(state.target.predicted.azDeg, state.target.predicted.elDeg);
          return <circle cx={p.x} cy={p.y} r="7" className="predicted-ring" />;
        })()
      )}

      {aim && (
        (() => {
          const p = polar(aim.azDeg, aim.elDeg);
          return (
            <g className="camera-aim">
              <line x1={p.x - 7} y1={p.y} x2={p.x + 7} y2={p.y} />
              <line x1={p.x} y1={p.y - 7} x2={p.x} y2={p.y + 7} />
            </g>
          );
        })()
      )}
    </svg>
  );
}
