'use client';

import { useEffect, useMemo } from 'react';
import mapboxgl from 'mapbox-gl';
import { LatLng, GpsPosition } from '@/lib/types';
import { recoveryArc } from '@/lib/geo';

const SOURCE_ID = 'recovery-path';
const LAYER_ID = 'recovery-path-layer';

interface Props {
  map: mapboxgl.Map | null;
  position: GpsPosition | null;
  path: LatLng[];            // the purple lane centerline
  heading?: number | null;   // cart course over ground (compass deg); null => unknown
}

// The orange line: the ideal recovery curve from the cart's current
// position+heading back onto the purple lane center. It leaves along the cart's
// actual heading (so it's a path the cart can really follow) and arrives tangent
// to the lane — overlay the turquoise prediction onto it to converge on the lane.
export default function RecoveryLayer({ map, position, path, heading }: Props) {
  const arc = useMemo(() => {
    if (!position || path.length < 2) return [];
    return recoveryArc({ lat: position.lat, lng: position.lon }, path, heading ?? null);
  }, [position, path, heading]);

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
        'line-color': '#f97316',
        'line-width': 4,
        'line-opacity': 0.9,
        'line-dasharray': [2, 1.5],
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

    if (arc.length < 2) {
      src.setData({ type: 'FeatureCollection', features: [] });
      return;
    }

    src.setData({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: arc.map((p) => [p.lng, p.lat]),
      },
    });
  }, [map, arc]);

  return null;
}
