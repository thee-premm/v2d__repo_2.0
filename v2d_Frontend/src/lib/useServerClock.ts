import { useEffect, useRef, useState } from "react";

/**
 * A ticking "now" aligned to the server's clock. The server sends its time
 * with every meal list; we keep the offset so countdowns match the deadline
 * the server will actually enforce, even if the phone's clock is wrong.
 */
export function useServerNow(serverTime: string | undefined, intervalMs = 1000) {
  const offset = useRef(0);
  useEffect(() => {
    if (serverTime) offset.current = new Date(serverTime).getTime() - Date.now();
  }, [serverTime]);
  const [now, setNow] = useState(() => Date.now() + offset.current);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() + offset.current), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
