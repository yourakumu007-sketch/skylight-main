import { describe, expect, it } from "vitest";
import { convertSpeed, formatSpeed } from "../src/format.js";

describe("convertSpeed", () => {
  it("passes knots through unchanged", () => {
    expect(convertSpeed(450, "kt")).toBe(450);
  });
  it("converts knots to mph", () => {
    expect(convertSpeed(100, "mph")).toBeCloseTo(115.078, 2);
  });
  it("converts knots to km/h", () => {
    expect(convertSpeed(100, "kmh")).toBeCloseTo(185.2, 2);
  });
});

describe("formatSpeed", () => {
  it("rounds and suffixes each unit", () => {
    expect(formatSpeed(450, "kt")).toBe("450 kt");
    expect(formatSpeed(450, "mph")).toBe("518 mph");
    expect(formatSpeed(450, "kmh")).toBe("833 km/h");
  });
  it("handles zero", () => {
    expect(formatSpeed(0, "mph")).toBe("0 mph");
  });
});
