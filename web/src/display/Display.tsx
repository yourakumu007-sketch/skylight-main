import { useEffect, useRef } from "react";
import type { Config, Theme } from "@shared/index.js";
import { DEFAULT_CONFIG } from "@shared/index.js";
import { useStream } from "../lib/useStream.js";
import { Renderer } from "./renderer.js";

const THEMES: Theme[] = ["ambient", "telemetry", "focus"];

const TOP_INDIAN_AIRPORTS = [
  { code: "VIDP", name: "Delhi (DEL)" },
  { code: "VABB", name: "Mumbai (BOM)" },
  { code: "VOBL", name: "Bengaluru (BLR)" },
  { code: "VOHS", name: "Hyderabad (HYD)" },
  { code: "VOMM", name: "Chennai (MAA)" },
  { code: "VECC", name: "Kolkata (CCU)" },
  { code: "VAAH", name: "Ahmedabad (AMD)" },
  { code: "VOCI", name: "Kochi (COK)" },
  { code: "VAPO", name: "Pune (PNQ)" },
  { code: "VOGO", name: "Goa (GOI)" },
];

export function Display() {
  const { state, conn } = useStream("display");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);

  // Keep the latest config in a ref so the RAF loop always reads fresh values.
  const configRef = useRef<Config>(state.config ?? DEFAULT_CONFIG);
  configRef.current = state.config ?? DEFAULT_CONFIG;

  // Create renderer once.
  useEffect(() => {
    if (!canvasRef.current) return;
    const r = new Renderer(canvasRef.current, () => configRef.current);
    rendererRef.current = r;
    r.start();
    const onResize = () => r.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      r.stop();
      rendererRef.current = null;
    };
  }, []);

  // Feed snapshots.
  useEffect(() => {
    rendererRef.current?.update(state.aircraft);
  }, [state.now, state.aircraft]);

  // Source health: during an outage the renderer holds planes instead of
  // staling them out. A dropped WebSocket counts as an outage too.
  useEffect(() => {
    rendererRef.current?.setSourceOk(state.connected && (state.status?.ok ?? true));
  }, [state.connected, state.status]);

  // Keyboard calibration (handy when a keyboard is plugged into the Pi).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const c = configRef.current;
      switch (e.key) {
        case "r":
          conn.patchConfig({ rotationDeg: (c.rotationDeg + 5) % 360 });
          break;
        case "R":
          conn.patchConfig({ rotationDeg: (c.rotationDeg - 5 + 360) % 360 });
          break;
        case "m":
          conn.patchConfig({ mirrorX: !c.mirrorX });
          break;
        case "M":
          conn.patchConfig({ mirrorY: !c.mirrorY });
          break;
        case "t": {
          const next = THEMES[(THEMES.indexOf(c.theme) + 1) % THEMES.length];
          conn.patchConfig({ theme: next });
          break;
        }
        case "[":
          conn.patchConfig({ radiusMiles: Math.max(0.5, c.radiusMiles - 0.5) });
          break;
        case "]":
          conn.patchConfig({ radiusMiles: c.radiusMiles + 0.5 });
          break;
        case "h":
          conn.patchConfig({ showHud: !c.showHud });
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [conn]);

  const quickSelectAirport = async (code: string) => {
    if (!code.trim()) return;
    try {
      const r = await fetch(`/api/airport?code=${encodeURIComponent(code.trim())}`);
      const body = await r.json();
      if (!r.ok) return;
      conn.patchConfig({ 
        airport: body, 
        showAirport: true,
        centerLat: body.lat,
        centerLon: body.lon,
        locationName: body.fullName ?? body.icao
      });
    } catch {}
  };

  const cfg = state.config;
  return (
    <div className="display-root">
      <canvas ref={canvasRef} className="display-canvas" />
      {cfg?.showHud && (
        <div className="hud">
          <div className={`hud-dot ${state.connected ? "ok" : "bad"}`} />
          <span>
            {state.status?.source ?? "—"} · {state.aircraft.length} ac ·{" "}
            rot {cfg.rotationDeg}° · mirror {cfg.mirrorX ? "X" : "–"}
            {cfg.mirrorY ? "Y" : ""} · r {cfg.radiusMiles}mi · {cfg.projectionMode} · {cfg.theme}
          </span>
        </div>
      )}
      {!state.connected && <div className="reconnect">connecting…</div>}
      
      <div className="quick-select-overlay" style={{ position: "absolute", bottom: "20px", right: "20px", zIndex: 100 }}>
        <select
          style={{ 
            padding: "0.6rem 1rem", 
            background: "rgba(10, 12, 16, 0.6)", 
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
            color: "#AEB6C6", 
            border: "1px solid rgba(255, 255, 255, 0.15)", 
            borderRadius: "8px",
            fontFamily: "Inter, system-ui, sans-serif",
            fontSize: "14px",
            cursor: "pointer",
            outline: "none",
            transition: "all 0.2s ease-in-out",
            boxShadow: "0 4px 6px rgba(0, 0, 0, 0.3)",
          }}
          onMouseOver={(e) => {
            e.currentTarget.style.background = "rgba(20, 24, 32, 0.8)";
            e.currentTarget.style.borderColor = "rgba(255, 255, 255, 0.3)";
          }}
          onMouseOut={(e) => {
            e.currentTarget.style.background = "rgba(10, 12, 16, 0.6)";
            e.currentTarget.style.borderColor = "rgba(255, 255, 255, 0.15)";
          }}
          value=""
          onChange={(e) => {
            const code = e.target.value;
            if (code) quickSelectAirport(code);
          }}
        >
          <option value="" disabled hidden>Quick Jump to Airport...</option>
          {TOP_INDIAN_AIRPORTS.map((a) => (
            <option key={a.code} value={a.code}>{a.name}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
