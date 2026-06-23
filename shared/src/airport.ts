// Airport runway geometry, drawn on the ceiling at true geographic position
// so departures and arrivals visibly line up with the runways. SFO ships as
// the default; any other airport can be imported from the control panel by
// ICAO/IATA code (the server resolves it from the OurAirports dataset).

export interface Runway {
  leIdent: string;
  heIdent: string;
  le: [number, number]; // [lat, lon]
  he: [number, number];
  widthFt: number;
}

export interface Airport {
  icao: string;
  /** Short label drawn at the runway centroid (IATA code when known). */
  name: string;
  /** Official name, shown in the control panel. */
  fullName?: string;
  lat: number;
  lon: number;
  runways: Runway[];
}

/** Coordinates from OurAirports (VECC). */
export const CCU_AIRPORT: Airport = {
  icao: "VECC",
  name: "CCU",
  fullName: "Netaji Subhash Chandra Bose International Airport",
  lat: 22.654012,
  lon: 88.44765,
  runways: [
    { leIdent: "01L", heIdent: "19R", le: [22.6402, 88.444], he: [22.661699, 88.446503], widthFt: 150 },
    { leIdent: "01R", heIdent: "19L", le: [22.6422, 88.446297], he: [22.674801, 88.450104], widthFt: 150 },
  ],
};

/** Coordinates from OurAirports (KSFO). */
export const SFO_AIRPORT: Airport = {
  icao: "KSFO",
  name: "SFO",
  fullName: "San Francisco International Airport",
  lat: 37.6213,
  lon: -122.379,
  runways: [
    { leIdent: "10L", heIdent: "28R", le: [37.628742, -122.39341], he: [37.613538, -122.35716], widthFt: 200 },
    { leIdent: "10R", heIdent: "28L", le: [37.626298, -122.393124], he: [37.61172, -122.358367], widthFt: 200 },
    { leIdent: "1L", heIdent: "19R", le: [37.607898, -122.38295], he: [37.626476, -122.37063], widthFt: 200 },
    { leIdent: "1R", heIdent: "19L", le: [37.606333, -122.381061], he: [37.627346, -122.367124], widthFt: 200 },
  ],
};
