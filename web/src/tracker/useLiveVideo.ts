// Self-healing MJPEG <img> wiring. A multipart stream dies silently whenever
// the tracker restarts (deploys!), ffmpeg respawns, or the network blips —
// and an <img> never recovers on its own. Reconnect on SIGNALS, not timers:
//   - tracker WebSocket reconnects (tracker process restarted)
//   - video.gen changes (ffmpeg respawned server-side)
//   - video.running rises (stall watchdog recovered the stream)
//   - <img> onError (connection refused / reset), with backoff

import { useEffect, useRef, useState } from "react";
import type { TrackerState } from "@shared/index.js";
import { trackerHttp } from "./connection.js";

export function useLiveVideo(
  connected: boolean,
  video: TrackerState["video"] | undefined,
): { src: string; epoch: number; onError: () => void } {
  const [epoch, setEpoch] = useState(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prev = useRef({ connected: false, gen: -1, running: false });

  useEffect(() => {
    const p = prev.current;
    const reconnectedWs = connected && !p.connected;
    const newGen = video != null && video.gen !== p.gen && p.gen !== -1;
    const recovered = Boolean(video?.running) && !p.running;
    prev.current = {
      connected,
      gen: video?.gen ?? p.gen,
      running: Boolean(video?.running),
    };
    if (reconnectedWs || newGen || recovered) {
      setEpoch((e) => e + 1);
    }
  }, [connected, video?.gen, video?.running]);

  useEffect(
    () => () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
    },
    [],
  );

  const onError = () => {
    if (retryTimer.current) return;
    retryTimer.current = setTimeout(() => {
      retryTimer.current = null;
      setEpoch((e) => e + 1);
    }, 2000);
  };

  // Cache-bust per epoch so the browser opens a FRESH multipart request
  // instead of reusing a dead cached connection.
  return { src: trackerHttp(`/video?e=${epoch}`), epoch, onError };
}
