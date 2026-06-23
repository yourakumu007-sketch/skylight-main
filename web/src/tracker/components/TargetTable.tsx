// Candidate aircraft with scores; click to pin one as a manual target.

import { metersToMiles, type TrackerState } from "@shared/index.js";

export function TargetTable({
  state,
  onPick,
}: {
  state: TrackerState;
  onPick: (hex: string | null) => void;
}) {
  return (
    <div className="target-table">
      <table>
        <thead>
          <tr>
            <th>flight</th><th>type</th><th>az°</th><th>el°</th><th>mi</th>
            <th>score</th><th></th>
          </tr>
        </thead>
        <tbody>
          {state.candidates.map((c) => {
            const isTarget = c.hex === state.target.hex;
            return (
              <tr
                key={c.hex}
                className={isTarget ? "target" : ""}
                onClick={() => onPick(isTarget ? null : c.hex)}
                title={isTarget ? "click to release" : "click to pin as target"}
              >
                <td>{c.flight ?? c.hex}</td>
                <td>{c.typeCode ?? "—"}</td>
                <td>{c.azEl.azDeg.toFixed(0)}</td>
                <td>{c.azEl.elDeg.toFixed(0)}</td>
                <td>{metersToMiles(c.azEl.slantM).toFixed(1)}</td>
                <td>{c.score.toFixed(2)}</td>
                <td className="note">{c.note}</td>
              </tr>
            );
          })}
          {!state.candidates.length && (
            <tr><td colSpan={7} className="empty">no candidates above {""}
              the elevation / range filters</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
