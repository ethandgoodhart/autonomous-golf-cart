'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { GpsPosition, FollowState, NtripStatus, RemoteRoute } from '@/lib/types';

const MAX_HISTORY = 500;

export function useGps(wsUrl: string) {
  const [position, setPosition] = useState<GpsPosition | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [follow, setFollow] = useState<FollowState | null>(null);
  const [ntrip, setNtrip] = useState<NtripStatus | null>(null);
  const [remoteRoute, setRemoteRoute] = useState<RemoteRoute | null>(null);
  const historyRef = useRef<GpsPosition[]>([]);
  const remoteSeqRef = useRef(0);
  const [historyVersion, setHistoryVersion] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);

  const getHistory = useCallback(() => historyRef.current, []);

  const sendCommand = useCallback((obj: object) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }, []);

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout>;
    // Guards the reconnect race: React Strict Mode / HMR tears this effect down
    // (setup→cleanup→setup). The cleanup calls ws.close(), but ws.onclose fires
    // AFTER cleanup has already run and would schedule a fresh reconnect that
    // nothing cancels — leaving a SECOND live socket. With two sockets the
    // server broadcasts every remote_route twice, so a single remote "start"
    // drove the cart twice (start, 1s, restart). `tornDown` makes onclose skip
    // the reconnect once this effect run is dead, so there's exactly one socket.
    let tornDown = false;

    function connect() {
      if (tornDown) return;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => setIsConnected(true);

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'position') {
          const p = msg.data as GpsPosition;
          setPosition(p);
          historyRef.current.push(p);
          if (historyRef.current.length > MAX_HISTORY) {
            historyRef.current = historyRef.current.slice(-MAX_HISTORY);
          }
          setHistoryVersion((v) => v + 1);
        } else if (msg.type === 'history') {
          historyRef.current = msg.data as GpsPosition[];
          if (historyRef.current.length > 0) {
            setPosition(historyRef.current[historyRef.current.length - 1]);
          }
          setHistoryVersion((v) => v + 1);
        } else if (msg.type === 'ntrip') {
          setNtrip(msg.data as NtripStatus);
        } else if (msg.type === 'follow') {
          setFollow({ ...(msg.data as FollowState), active: true });
        } else if (msg.type === 'follow_end') {
          setFollow({ ...(msg.data as FollowState), active: false });
        } else if (msg.type === 'remote_route') {
          // A remote client (companion app) picked a destination. Drop the pin
          // + plan the purple route in the UI, and drive it if autostart is set.
          const d = msg.data as { lat: number; lon: number; autostart?: boolean };
          if (d && d.lat != null && d.lon != null) {
            remoteSeqRef.current += 1;
            setRemoteRoute({ lat: d.lat, lng: d.lon, autostart: !!d.autostart, seq: remoteSeqRef.current });
          }
        }
      };

      ws.onclose = () => {
        setIsConnected(false);
        wsRef.current = null;
        if (!tornDown) reconnectTimer = setTimeout(connect, 2000);
      };

      ws.onerror = () => ws.close();
    }

    connect();

    return () => {
      tornDown = true;
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [wsUrl]);

  return { position, isConnected, getHistory, historyVersion, follow, ntrip, sendCommand, remoteRoute };
}
