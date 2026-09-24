'use client';

import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import { GpsPosition } from '@/lib/types';

const FIX_COLORS: Record<number, string> = {
  4: '#44ff44',
  5: '#ffcc00',
  2: '#ff8800',
  1: '#ff4444',
  0: '#888888',
};

interface Props {
  map: mapboxgl.Map | null;
  position: GpsPosition | null;
  heading?: number | null;   // estimated compass heading (deg); null => unknown
}

export default function GpsMarker({ map, position, heading }: Props) {
  const markerRef = useRef<mapboxgl.Marker | null>(null);
  const dotRef = useRef<HTMLDivElement | null>(null);
  const arrowRef = useRef<HTMLDivElement | null>(null);
  // Heading is interpolated every animation frame toward `targetHeadingRef`,
  // rather than snapped on each 15 Hz telemetry tick — that's what makes the
  // needle glide instead of jitter. `displayHeadingRef` is the live on-screen
  // angle the easing converges to the target.
  const targetHeadingRef = useRef<number | null>(null);
  const displayHeadingRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!map) return;

    // Container centered on the cart. A triangle points in the cart's heading
    // (shown only when we have a heading estimate); a dot marks the position.
    const container = document.createElement('div');
    container.style.position = 'relative';
    container.style.width = '22px';
    container.style.height = '22px';

    // Heading triangle — base pinned at the cart position, tip pointing "up";
    // the Marker's rotation swings it to the true compass heading.
    const arrow = document.createElement('div');
    arrow.style.position = 'absolute';
    arrow.style.left = '50%';
    arrow.style.top = '50%';
    arrow.style.width = '0';
    arrow.style.height = '0';
    arrow.style.borderLeft = '9px solid transparent';
    arrow.style.borderRight = '9px solid transparent';
    arrow.style.borderBottom = '22px solid #38bdf8';
    arrow.style.transform = 'translate(-50%, -100%)';
    arrow.style.filter = 'drop-shadow(0 0 3px rgba(0,0,0,0.6))';
    arrow.style.display = 'none';
    arrowRef.current = arrow;

    const dot = document.createElement('div');
    dot.className = 'gps-pulse-dot';
    dot.style.position = 'absolute';
    dot.style.left = '50%';
    dot.style.top = '50%';
    dot.style.transform = 'translate(-50%, -50%)';
    dot.style.width = '22px';
    dot.style.height = '22px';
    dot.style.borderRadius = '50%';
    dot.style.border = '3px solid white';
    dot.style.background = '#888';
    dot.style.boxShadow = '0 0 6px rgba(0,0,0,0.5)';
    dotRef.current = dot;

    container.appendChild(arrow);
    container.appendChild(dot);

    const marker = new mapboxgl.Marker({
      element: container,
      rotationAlignment: 'map',   // heading is geographic, rotate with the map
    })
      .setLngLat([-122.1663, 37.4269])
      .addTo(map);
    markerRef.current = marker;

    // Per-frame easing toward the latest target heading, along the shortest
    // angular path (handles the 0/360 wrap). ~0.2/frame ≈ 80 ms settle — snappy
    // but smooth, independent of how steppy the incoming telemetry is.
    const animate = () => {
      const target = targetHeadingRef.current;
      if (target !== null) {
        let cur = displayHeadingRef.current;
        if (cur === null) {
          cur = target;
        } else {
          const delta = ((target - cur + 540) % 360) - 180;
          cur = (cur + delta * 0.2 + 360) % 360;
        }
        displayHeadingRef.current = cur;
        marker.setRotation(cur);
      }
      rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      marker.remove();
      markerRef.current = null;
    };
  }, [map]);

  useEffect(() => {
    if (!markerRef.current || !position) return;
    markerRef.current.setLngLat([position.lon, position.lat]);
    if (dotRef.current) {
      dotRef.current.style.background = FIX_COLORS[position.fix_code] || FIX_COLORS[0];
    }
  }, [position]);

  useEffect(() => {
    if (!arrowRef.current) return;
    if (heading === null || heading === undefined || Number.isNaN(heading)) {
      arrowRef.current.style.display = 'none';
      targetHeadingRef.current = null;
      return;
    }
    arrowRef.current.style.display = 'block';
    // Hand the new angle to the rAF loop; it eases the marker there smoothly.
    targetHeadingRef.current = heading;
  }, [heading]);

  return null;
}
