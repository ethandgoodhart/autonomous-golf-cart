'use client';

import { useEffect } from 'react';
import mapboxgl from 'mapbox-gl';
import { RawLane, RawConnector, CenterLine } from '@/lib/types';

interface Props {
  map: mapboxgl.Map | null;
  lanes: RawLane[];
  connectors: RawConnector[];
  centerLines: CenterLine[];
}

// Engineering Quad. Center lines here are still routed on — they are just not
// drawn, so the freshly mapped lane boundaries stay readable.
const HIDE_CENTER_LINES = { minLat: 37.427, maxLat: 37.4292, minLng: -122.176, maxLng: -122.1725 };

function hidden(cl: CenterLine): boolean {
  return cl.points.some(
    (p) =>
      p.lat >= HIDE_CENTER_LINES.minLat &&
      p.lat <= HIDE_CENTER_LINES.maxLat &&
      p.lng >= HIDE_CENTER_LINES.minLng &&
      p.lng <= HIDE_CENTER_LINES.maxLng,
  );
}

export default function AnnotationLayers({ map, lanes, connectors, centerLines }: Props) {
  useEffect(() => {
    if (!map) return;
    const ids: string[] = [];

    lanes.forEach((lane, i) => {
      const srcId = `lane-${i}`;
      ids.push(srcId);
      map.addSource(srcId, {
        type: 'geojson',
        data: {
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: lane.points.map((p) => [p.lng, p.lat]) },
        },
      });
      map.addLayer({
        id: `layer-${srcId}`,
        type: 'line',
        source: srcId,
        paint: { 'line-color': '#44ff88', 'line-width': 3, 'line-opacity': 0.7 },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      });
    });

    connectors.forEach((conn, i) => {
      const srcId = `conn-${i}`;
      ids.push(srcId);
      map.addSource(srcId, {
        type: 'geojson',
        data: {
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: conn.points.map((p) => [p.lng, p.lat]) },
        },
      });
      map.addLayer({
        id: `layer-${srcId}`,
        type: 'line',
        source: srcId,
        paint: { 'line-color': '#4488ff', 'line-width': 2, 'line-dasharray': [6, 4], 'line-opacity': 0.6 },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      });
    });

    centerLines.forEach((cl, i) => {
      if (hidden(cl)) return;
      const srcId = `center-${i}`;
      ids.push(srcId);
      map.addSource(srcId, {
        type: 'geojson',
        data: {
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: cl.points.map((p) => [p.lng, p.lat]) },
        },
      });
      map.addLayer({
        id: `layer-${srcId}`,
        type: 'line',
        source: srcId,
        paint: { 'line-color': '#ffcc00', 'line-width': 2, 'line-dasharray': [4, 3], 'line-opacity': 0.5 },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      });
    });

    return () => {
      ids.forEach((srcId) => {
        if (map.getLayer(`layer-${srcId}`)) map.removeLayer(`layer-${srcId}`);
        if (map.getSource(srcId)) map.removeSource(srcId);
      });
    };
  }, [map, lanes, connectors, centerLines]);

  return null;
}
