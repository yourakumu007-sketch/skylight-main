// Live camera video (MJPEG) with a center crosshair and an overlay marker at
// the position where the pipeline PREDICTS the target should appear — the
// core truth check for Phase A, and the error signal Phase B will close.

import { useMemo } from "react";
import {
  hfovFromZoomUnits,
  norm180,
  worldFromMount,
  type TrackerConfig,
  type TrackerState,
} from "@shared/index.js";
import { useLiveVideo } from "../useLiveVideo.js";

export function VideoPane({
  state,
  config,
  connected = true,
}: {
  state: TrackerState;
  config: TrackerConfig;
  connected?: boolean;
}) {
  const liveVideo = useLiveVideo(connected, state.video);

  const overlay = useMemo(() => {
    const { pose, target } = state;
    if (!pose || !target.predicted) return null;
    // Where is the camera actually looking, in the world?
    const aim = worldFromMount(pose, config.mount);
    const hfov = hfovFromZoomUnits(pose.zoomUnits, config.zoom.fovLut);
    const vfov = hfov * (9 / 16);
    // Small-angle offsets of the predicted target from frame center, in
    // fractions of the frame (x right, y down).
    const dxDeg = norm180(target.predicted.azDeg - aim.azDeg) *
      Math.cos((target.predicted.elDeg * Math.PI) / 180);
    const dyDeg = target.predicted.elDeg - aim.elDeg;
    return {
      x: 0.5 + dxDeg / hfov,
      y: 0.5 - dyDeg / vfov,
      inFrame: Math.abs(dxDeg) < hfov / 2 && Math.abs(dyDeg) < vfov / 2,
      offDeg: Math.hypot(dxDeg, dyDeg),
    };
  }, [state, config]);

  const showVideo = state.video.running;

  return (
    <div className="video-pane">
      {showVideo ? (
        <img
          key={liveVideo.epoch}
          className="video-img"
          src={liveVideo.src}
          alt="camera"
          onError={liveVideo.onError}
        />
      ) : (
        <div className="video-placeholder">
          {state.driver.kind === "sim"
            ? "SIM driver — no video (switch to visca for the real camera)"
            : (state.video.error ?? "waiting for video…")}
        </div>
      )}

      {/* center crosshair */}
      <svg className="video-overlay" viewBox="0 0 100 56.25" preserveAspectRatio="none">
        <line x1="46" y1="28.125" x2="54" y2="28.125" className="crosshair" />
        <line x1="50" y1="25.875" x2="50" y2="30.375" className="crosshair" />
        <circle cx="50" cy="28.125" r="6" className="crosshair-ring" />
        {overlay && (
          <g
            className={`predicted ${overlay.inFrame ? "" : "out"}`}
            transform={`translate(${Math.min(98, Math.max(2, overlay.x * 100))}, ${Math.min(54, Math.max(2, overlay.y * 56.25))})`}
          >
            <rect x="-2.2" y="-2.2" width="4.4" height="4.4" className="predicted-box" />
          </g>
        )}
        {state.vision.detection && state.vision.detection.ageMs < 1500 && (
          <rect
            className="detection-box"
            x={state.vision.detection.boxX * 100 - 0.6}
            y={state.vision.detection.boxY * 56.25 - 0.6}
            width={Math.max(1.6, state.vision.detection.boxW * 100 + 1.2)}
            height={Math.max(1.6, state.vision.detection.boxH * 56.25 + 1.2)}
          />
        )}
      </svg>

      <div className="video-caption">
        {state.target.hex ? (
          <>
            <b>{state.target.flight ?? state.target.hex}</b>
            {state.target.predicted &&
              ` · az ${state.target.predicted.azDeg.toFixed(1)}° el ${state.target.predicted.elDeg.toFixed(1)}°`}
            {state.target.hfovDeg != null && ` · HFOV ${state.target.hfovDeg.toFixed(1)}°`}
            {overlay && ` · off-center ${overlay.offDeg.toFixed(2)}°`}
            {state.target.leadSec > 0 && ` · lead ${state.target.leadSec.toFixed(1)}s`}
            {state.vision.detection && state.vision.detection.ageMs < 1500 &&
              ` · 👁 ${state.vision.detection.contrastSigma.toFixed(0)}σ off(${state.vision.detection.offAzDeg.toFixed(2)}°,${state.vision.detection.offElDeg.toFixed(2)}°)`}
            {state.vision.applying &&
              ` · corr(${state.vision.correctionAzDeg.toFixed(2)}°,${state.vision.correctionElDeg.toFixed(2)}°)`}
          </>
        ) : (
          "no target"
        )}
      </div>
    </div>
  );
}
