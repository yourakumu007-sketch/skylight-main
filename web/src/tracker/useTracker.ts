import { useEffect, useRef, useState } from "react";
import { TrackerConnection, type TrackerStreamState } from "./connection.js";

/** One tracker WS connection for the page lifetime + its live state. */
export function useTracker(): { stream: TrackerStreamState; conn: TrackerConnection } {
  const ref = useRef<TrackerConnection | null>(null);
  if (!ref.current) ref.current = new TrackerConnection();
  const conn = ref.current;

  const [stream, setStream] = useState<TrackerStreamState>(conn.stream);

  useEffect(() => {
    const unsub = conn.subscribe(setStream);
    conn.connect();
    return () => {
      unsub();
      conn.close();
    };
  }, [conn]);

  return { stream, conn };
}
