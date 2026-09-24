'use client';

import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import { LatLng } from '@/lib/types';

const SOURCE_ID = 'route-path';
const LAYER_ID = 'route-path-layer';

interface Props {
  map: mapboxgl.Map | null;
  path: LatLng[];
  startPoint: LatLng | null;
  endPoint: LatLng | null;
}

export default function RouteLayer({ map, path, startPoint, endPoint }: Props) {
  const startMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const endMarkerRef = useRef<mapboxgl.Marker | null>(null);

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
        'line-color': '#a855f7',
        'line-width': 6,
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

    if (path.length < 2) {
      src.setData({ type: 'FeatureCollection', features: [] });
      return;
    }

    src.setData({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: path.map((p) => [p.lng, p.lat]),
      },
    });
  }, [map, path]);

  useEffect(() => {
    if (!map) return;
    startMarkerRef.current?.remove();
    if (startPoint) {
      const el = document.createElement('div');
      el.style.width = '14px';
      el.style.height = '14px';
      el.style.borderRadius = '50%';
      el.style.background = '#22c55e';
      el.style.border = '3px solid white';
      el.style.boxShadow = '0 2px 6px rgba(0,0,0,0.4)';
      startMarkerRef.current = new mapboxgl.Marker({ element: el })
        .setLngLat([startPoint.lng, startPoint.lat])
        .addTo(map);
    }
    return () => { startMarkerRef.current?.remove(); };
  }, [map, startPoint]);

  useEffect(() => {
    if (!map) return;
    endMarkerRef.current?.remove();
    if (endPoint) {
      const el = document.createElement('div');
      el.style.width = '14px';
      el.style.height = '14px';
      el.style.borderRadius = '50%';
      el.style.background = '#ef4444';
      el.style.border = '3px solid white';
      el.style.boxShadow = '0 2px 6px rgba(0,0,0,0.4)';
      endMarkerRef.current = new mapboxgl.Marker({ element: el })
        .setLngLat([endPoint.lng, endPoint.lat])
        .addTo(map);
    }
    return () => { endMarkerRef.current?.remove(); };
  }, [map, endPoint]);

  return null;
}
