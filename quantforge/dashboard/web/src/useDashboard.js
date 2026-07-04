/**
 * WebSocket state hook. The client NEVER polls: one initial REST fetch for
 * first paint, then everything arrives as WS pushes ("state" payloads on
 * change, "trade" messages for individual tape lines). Reconnects with
 * exponential backoff on drop.
 */

import { useEffect, useRef, useState } from "react";

const TAPE_LIMIT = 80;

export function useDashboard() {
  const [state, setState] = useState(null);
  const [connected, setConnected] = useState(false);
  const [tape, setTape] = useState([]); // newest first
  const tapeSeeded = useRef(false);
  const backoff = useRef(1000);

  useEffect(() => {
    let ws = null;
    let closed = false;
    let reconnectTimer = null;

    const seedTape = (trades) => {
      if (tapeSeeded.current) return;
      tapeSeeded.current = true;
      setTape(trades.slice(0, TAPE_LIMIT));
    };

    // Initial REST fetch for first paint (the only HTTP data call ever made).
    fetch("/api/state")
      .then((r) => r.json())
      .then((s) => {
        setState((prev) => prev ?? s);
        seedTape(s.trades ?? []);
      })
      .catch(() => {});

    const connect = () => {
      if (closed) return;
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${window.location.host}/ws`);
      ws.onopen = () => {
        setConnected(true);
        backoff.current = 1000;
      };
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "state") {
          setState(msg.state);
          seedTape(msg.state.trades ?? []);
        } else if (msg.type === "trade") {
          setTape((prev) => [msg.trade, ...prev].slice(0, TAPE_LIMIT));
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        reconnectTimer = setTimeout(connect, backoff.current);
        backoff.current = Math.min(backoff.current * 2, 15_000);
      };
      ws.onerror = () => ws.close();
    };
    connect();

    return () => {
      closed = true;
      clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, []);

  return { state, connected, tape };
}

/** POST helper for the two (and only two) write endpoints. */
export async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}
