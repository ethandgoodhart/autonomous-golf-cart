'use client';

import { useEffect, useMemo } from 'react';
import mapboxgl from 'mapbox-gl';
import { GpsPosition } from '@/lib/types';
import { predictTrajectory } from '@/lib/geo';

const SOURCE_ID = 'trajectory-path';
const LAYER_ID = 'trajectory-path-layer';
const PREDICT_SECONDS = 3.0;

interface Props {
  map: mapboxgl.Map | null;
  position: GpsPosition | null;
  speed: number;             // ground speed (m/s) from useSpeed
  heading: number | null;    // cart heading (compass deg); null => unknown
  steerDeg: number | null;   // steering-column angle (deg); null => unknown
}

// The turquoise line: where the cart is headed over the next ~2 s if it holds
// its current speed and wheel angle. Unlike the orange recovery line (a purely
// geometric path back onto the lane), this is a forward dead-reckoning of the
// cart's own motion — heading + a turn radius from the steered wheel angle.
// Shown only while we have live heading + steering telemetry (i.e. a drive).
export default function TrajectoryLayer({ map, position, speed, heading, steerDeg }: Props) {
  const traj = useMemo(() => {
    if (!position || heading === null || steerDeg === null) return [];
    return predictTrajectory(
      { lat: position.lat, lng: position.lon },
      heading,
      speed,
      steerDeg,
      PREDICT_SECONDS
    );
  }, [position, speed, heading, steerDeg]);

  useEffect(() => {
    if (!map) return;

    map.addSource(SOURCE_ID, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    map.addLayer({
      id: LAYER_ID,
      type: 'line',
      source: SOURCE_ID,
      paint: {
        'line-color': '#40e0d0',
        'line-width': 4,
        'line-opacity': 0.9,
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    });

    return () => {
      if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    };
  }, [map]);

  useEffect(() => {
    if (!map) return;
    const src = map.getSource(SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;
    if (!src) return;

    if (traj.length < 2) {
      src.setData({ type: 'FeatureCollection', features: [] });
      return;
    }

    src.setData({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: traj.map((p) => [p.lng, p.lat]),
      },
    });
  }, [map, traj]);

  return null;
}
