import { describe, expect, it } from "vitest";
import { buildHostMatcher, originHostname } from "../src/allowed-hosts.js";

// The host/origin allowlist is a security boundary (DNS-rebinding + cross-site
// WS hijack). These tests lock in the allow set AND, more importantly, the
// spoofs that must stay rejected.

describe("buildHostMatcher (default topology)", () => {
  const m = buildHostMatcher({});

  it("allows loopback + localhost (with and without port)", () => {
    for (const h of ["localhost", "localhost:3000", "127.0.0.1", "127.0.0.1:8080", "[::1]", "[::1]:3000"]) {
      expect(m.test(h), h).toBe(true);
    }
  });

  it("allows the documented LAN + mDNS topology", () => {
    for (const h of ["192.168.1.42", "10.0.0.5", "172.16.0.1", "172.31.255.254", "169.254.1.1", "skylight.local"]) {
      expect(m.test(h), h).toBe(true);
    }
  });

  it("allows IPv6 ULA and link-local", () => {
    for (const h of ["[fd00::1]", "[fc00::abcd]", "[fe80::1]"]) {
      expect(m.test(h), h).toBe(true);
    }
  });

  it("rejects public hosts and IPs", () => {
    for (const h of ["evil.com", "example.com", "8.8.8.8", "1.1.1.1", "[2606:4700::1111]"]) {
      expect(m.test(h), h).toBe(false);
    }
  });

  it("rejects subdomain + ip-prefix spoofs", () => {
    for (const h of [
      "localhost.evil.com", // suffix trick
      "127.0.0.1.evil.com", // ip-prefix trick
      "127-0-0-1.attacker.com", // nip.io-style
      "10.0.0.1.evil.com",
      "notlocalhost",
    ]) {
      expect(m.test(h), h).toBe(false);
    }
  });

  it("rejects out-of-range / malformed IPv4 that only looks private", () => {
    for (const h of ["172.15.0.1", "172.32.0.1", "192.169.0.1", "256.0.0.1", "10.0.0"]) {
      expect(m.test(h), h).toBe(false);
    }
  });

  it("rejects empty / missing host", () => {
    expect(m.test(undefined)).toBe(false);
    expect(m.test("")).toBe(false);
  });
});

describe("ALLOW_PRIVATE_LAN=0 (loopback-only lockdown)", () => {
  const m = buildHostMatcher({ ALLOW_PRIVATE_LAN: "0" });

  it("still allows loopback + mDNS", () => {
    expect(m.test("localhost")).toBe(true);
    expect(m.test("127.0.0.1")).toBe(true);
    expect(m.test("skylight.local")).toBe(true);
  });

  it("closes the LAN window", () => {
    expect(m.test("192.168.1.42")).toBe(false);
    expect(m.test("10.0.0.5")).toBe(false);
    expect(m.test("[fd00::1]")).toBe(false);
  });
});

describe("ALLOWED_HOSTS extras", () => {
  const m = buildHostMatcher({ ALLOWED_HOSTS: "skylight.example.com, *.trycloudflare.com" });

  it("allows exact + wildcard extras", () => {
    expect(m.test("skylight.example.com")).toBe(true);
    expect(m.test("abc.trycloudflare.com")).toBe(true);
  });

  it("wildcard does not match the bare apex or a deeper tail spoof", () => {
    expect(m.test("trycloudflare.com")).toBe(false);
    expect(m.test("evil-trycloudflare.com")).toBe(false);
  });
});

describe("originHostname", () => {
  it("extracts hostname from an Origin URL", () => {
    expect(originHostname("http://localhost:3000")).toBe("localhost");
    expect(originHostname("https://skylight.local")).toBe("skylight.local");
    expect(originHostname("http://[::1]:3000")).toBe("::1");
  });

  it("returns null for missing / opaque origins", () => {
    expect(originHostname(undefined)).toBe(null);
    expect(originHostname("null")).toBe(null);
  });
});
