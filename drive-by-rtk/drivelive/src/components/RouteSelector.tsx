'use client';

import { useEffect } from 'react';
import mapboxgl from 'mapbox-gl';
import { LatLng } from '@/lib/types';

interface Props {
  map: mapboxgl.Map | null;
  selecting: 'start' | 'end' | 'none';
  onMapClick: (latlng: LatLng) => void;
}

export default function RouteSelector({ map, selecting, onMapClick }: Props) {
  useEffect(() => {
    if (!map) return;
    const canvas = map.getCanvas();

    if (selecting === 'none') {
      canvas.style.cursor = '';
      return;
    }

    canvas.style.cursor = 'crosshair';

    const handler = (e: mapboxgl.MapMouseEvent) => {
      onMapClick({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    };

    map.on('click', handler);
    return () => {
      map.off('click', handler);
      canvas.style.cursor = '';
    };
  }, [map, selecting, onMapClick]);

  return null;
}
