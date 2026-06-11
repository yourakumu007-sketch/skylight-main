// Mount-frame degrees <-> raw VISCA position units. The scales are unknown
// until measured against the real camera (milestone M4); everything routes
// through the configurable ViscaUnitScale so re-measuring is a config patch.

import type { CameraLimits, CameraPose, ViscaUnitScale } from "@shared/index.js";

export function panDegToUnits(deg: number, s: ViscaUnitScale): number {
  return Math.round(s.panZeroUnits + deg * s.panUnitsPerDeg);
}
export function tiltDegToUnits(deg: number, s: ViscaUnitScale): number {
  return Math.round(s.tiltZeroUnits + deg * s.tiltUnitsPerDeg);
}
export function panUnitsToDeg(units: number, s: ViscaUnitScale): number {
  return (units - s.panZeroUnits) / s.panUnitsPerDeg;
}
export function tiltUnitsToDeg(units: number, s: ViscaUnitScale): number {
  return (units - s.tiltZeroUnits) / s.tiltUnitsPerDeg;
}

export function clampPose(pose: CameraPose, lim: CameraLimits, s: ViscaUnitScale): CameraPose {
  const zoomMin = Math.min(s.zoomWideUnits, s.zoomTeleUnits);
  const zoomMax = Math.max(s.zoomWideUnits, s.zoomTeleUnits);
  return {
    panDeg: Math.min(lim.panMaxDeg, Math.max(lim.panMinDeg, pose.panDeg)),
    tiltDeg: Math.min(lim.tiltMaxDeg, Math.max(lim.tiltMinDeg, pose.tiltDeg)),
    zoomUnits: Math.min(zoomMax, Math.max(zoomMin, Math.round(pose.zoomUnits))),
  };
}
