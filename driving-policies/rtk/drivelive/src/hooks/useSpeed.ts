'use client';

import { useMemo, useRef } from 'react';
import { GpsPosition } from '@/lib/types';
import { haversineMeters } from '@/lib/geo';

// Ground speed derived from successive GPS fixes. We deliberately do NOT compute
// a heading here: steering is closed off the cart's own steering-angle sensor
// and the path geometry (cross-track), never a GPS-displacement heading. Speed
// is still useful for the ETA estimate and the on-screen readout, and is fed
// back to the follower as `current_speed_mph` so it can ramp to the target.
export function useSpeed(getHistory: () => GpsPosition[], historyVersion: number) {
  const smoothSpeedRef = useRef(0);

  return useMemo(() => {
    const history = getHistory();
    if (history.length < 2) {
      return { speed: 0, speedKmh: 0, speedMph: 0 };
    }

    const curr = history[history.length - 1];
    const prev = history[history.length - 2];
    const dt = curr.ts - prev.ts;
    const rawSpeed = dt > 0
      ? haversineMeters({ lat: prev.lat, lng: prev.lon }, { lat: curr.lat, lng: curr.lon }) / dt
      : 0;

    smoothSpeedRef.current = 0.6 * smoothSpeedRef.current + 0.4 * rawSpeed;
    const speed = smoothSpeedRef.current;

    return {
      speed,
      speedKmh: speed * 3.6,
      speedMph: speed * 2.237,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyVersion]);
}
