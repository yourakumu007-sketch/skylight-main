// Wingspan lookup (meters) by ICAO type code, for zoom framing. Coarse is
// fine — a 20% span error is a 20% framing error, invisible in practice.

const SPANS: Record<string, number> = {
  // Airbus
  A19N: 35.8, A20N: 35.8, A21N: 35.8, A318: 34.1, A319: 35.8, A320: 35.8,
  A321: 35.8, A332: 60.3, A333: 60.3, A338: 64.0, A339: 64.0, A342: 60.3,
  A343: 60.3, A345: 63.45, A346: 63.45, A359: 64.75, A35K: 64.75, A388: 79.75,
  // Boeing
  B712: 28.4, B731: 28.4, B732: 28.4, B733: 28.9, B734: 28.9, B735: 28.9,
  B736: 34.3, B737: 34.3, B738: 35.8, B739: 35.8, B37M: 35.9, B38M: 35.9,
  B39M: 35.9, B3XM: 35.9, B741: 59.6, B742: 59.6, B743: 59.6, B744: 64.4,
  B748: 68.4, B752: 38.0, B753: 38.0, B762: 47.6, B763: 47.6, B764: 51.9,
  B772: 60.9, B773: 60.9, B77L: 64.8, B77W: 64.8, B788: 60.1, B789: 60.1,
  B78X: 60.1,
  // Regional / bizjets / GA / props
  E170: 26.0, E175: 26.0, E190: 28.7, E195: 28.7, E75L: 26.0, E75S: 26.0,
  CRJ2: 21.2, CRJ7: 23.2, CRJ9: 24.9, DH8D: 28.4, AT76: 27.1, AT75: 27.1,
  C172: 11.0, C182: 11.0, C208: 15.9, SR22: 11.7, PC12: 16.3, BE36: 10.2,
  GLF6: 30.4, GLEX: 28.7, CL35: 21.0, C68A: 22.0, E55P: 16.2, LJ60: 13.4,
  // Helicopters (rotor diameter)
  EC30: 10.7, EC35: 10.2, EC45: 11.0, A109: 11.0, B407: 10.7, R44: 10.1,
  S76: 13.4, H60: 16.4,
};

/** Fallbacks by ADS-B emitter category (A1 light ... A5 heavy). */
const CATEGORY_SPANS: Record<string, number> = {
  A1: 11, A2: 18, A3: 34, A4: 60, A5: 65, A7: 11,
};

const DEFAULT_SPAN_M = 34;

export function wingspanM(typeCode?: string, category?: string): number {
  if (typeCode) {
    const exact = SPANS[typeCode.toUpperCase()];
    if (exact) return exact;
  }
  if (category) {
    const byCat = CATEGORY_SPANS[category.toUpperCase()];
    if (byCat) return byCat;
  }
  return DEFAULT_SPAN_M;
}
