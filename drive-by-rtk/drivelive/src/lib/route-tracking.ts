import { LatLng } from './types';
import { haversineMeters, nearestPointOnPolyline } from './geo';

export function snapToRoute(position: LatLng, routePath: LatLng[]) {
  if (routePath.length < 2) return null;
  const result = nearestPointOnPolyline(position, routePath);
  return {
    nearestPoint: result.point,
    segmentIndex: result.index,
    fraction: result.fraction,
  };
}

export function computeRouteProgress(
  segmentIndex: number,
  fraction: number,
  routePath: LatLng[]
) {
  let totalDist = 0;
  let distTraveled = 0;

  for (let i = 0; i < routePath.length - 1; i++) {
    const segLen = haversineMeters(routePath[i], routePath[i + 1]);
    totalDist += segLen;
    if (i < segmentIndex) {
      distTraveled += segLen;
    } else if (i === segmentIndex) {
      distTraveled += segLen * fraction;
    }
  }

  const distRemaining = Math.max(0, totalDist - distTraveled);
  const progress = totalDist > 0 ? distTraveled / totalDist : 0;

  return { distTraveled, distRemaining, totalDist, progress };
}

export function computeEta(distanceRemaining: number, speedMps: number): number | null {
  if (speedMps < 0.3) return null;
  return distanceRemaining / speedMps;
}
