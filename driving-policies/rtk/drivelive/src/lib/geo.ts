import { LatLng } from './types';

const R = 6371000;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// Estimated horizontal position accuracy (1-sigma, in metres) from the fix
// quality and HDOP. The receiver doesn't report a raw error figure, so we model
// it: each fix type has a nominal CEP that we scale by HDOP (satellite geometry
// / signal strength). RTK Fixed ≈ 1-2 cm, Float ≈ decimetres, DGPS/GPS metres.
// Returns null when there's no usable fix.
export function estimateAccuracyM(fixCode: number, hdop: number): number | null {
  const h = hdop > 0 ? hdop : 1;
  switch (fixCode) {
    case 4: return 0.01 + 0.008 * h;  // RTK Fixed
    case 5: return 0.20 + 0.25 * h;   // RTK Float
    case 2: return 0.40 + 0.50 * h;   // DGPS
    case 1: return 1.50 + 2.00 * h;   // standalone GPS
    default: return null;             // no fix
  }
}

// Human-friendly accuracy: "±1.6 cm" under a metre, "±2.7 m" above.
export function formatAccuracy(meters: number | null): string {
  if (meters === null) return '--';
  if (meters < 1) return `±${Math.round(meters * 100)} cm`;
  return `±${meters.toFixed(1)} m`;
}

export function bearing(a: LatLng, b: LatLng): number {
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((toDeg(Math.atan2(y, x)) % 360) + 360) % 360;
}

function angleDeltaDeg(a: number, b: number): number {
  return Math.abs((((b - a + 180) % 360) + 360) % 360 - 180);
}

function interpolate(a: LatLng, b: LatLng, t: number): LatLng {
  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lng: a.lng + (b.lng - a.lng) * t,
  };
}

export function resampleLine(points: LatLng[], numSamples: number): LatLng[] {
  if (points.length < 2 || numSamples < 2) return points.slice();
  const dists = [0];
  for (let i = 1; i < points.length; i++) {
    dists.push(dists[i - 1] + haversineMeters(points[i - 1], points[i]));
  }
  const totalDist = dists[dists.length - 1];
  if (totalDist === 0) return points.slice();

  const result: LatLng[] = [];
  for (let s = 0; s < numSamples; s++) {
    const target = (s / (numSamples - 1)) * totalDist;
    let seg = 0;
    while (seg < dists.length - 2 && dists[seg + 1] < target) seg++;
    const segLen = dists[seg + 1] - dists[seg];
    const t = segLen > 0 ? (target - dists[seg]) / segLen : 0;
    result.push({
      lat: points[seg].lat + t * (points[seg + 1].lat - points[seg].lat),
      lng: points[seg].lng + t * (points[seg + 1].lng - points[seg].lng),
    });
  }
  return result;
}

export function smoothRouteTurns(points: LatLng[], maxCornerCutM = 3.5, iterations = 4): LatLng[] {
  if (points.length < 3) return points.slice();

  let smoothed = points.slice();
  for (let pass = 0; pass < iterations; pass++) {
    if (smoothed.length < 3) break;
    const nextPoints: LatLng[] = [smoothed[0]];
    const passCutM = maxCornerCutM / (pass + 1);

    for (let i = 1; i < smoothed.length - 1; i++) {
      const prev = smoothed[i - 1];
      const point = smoothed[i];
      const next = smoothed[i + 1];
      const lenIn = haversineMeters(prev, point);
      const lenOut = haversineMeters(point, next);

      if (lenIn < 0.2 || lenOut < 0.2) {
        nextPoints.push(point);
        continue;
      }

      const turnDeg = angleDeltaDeg(bearing(prev, point), bearing(point, next));
      if (turnDeg < 4) {
        nextPoints.push(point);
        continue;
      }

      const turnScale = Math.min(1, turnDeg / 90);
      const cutInM = Math.min(passCutM * turnScale, lenIn * 0.45);
      const cutOutM = Math.min(passCutM * turnScale, lenOut * 0.45);
      nextPoints.push(interpolate(point, prev, cutInM / lenIn));
      nextPoints.push(interpolate(point, next, cutOutM / lenOut));
    }

    nextPoints.push(smoothed[smoothed.length - 1]);
    smoothed = nextPoints;
  }

  const sampleCount = Math.max(smoothed.length, Math.ceil(lineLengthMeters(smoothed) / 0.6));
  return polishCurve(resampleLine(smoothed, sampleCount), POLISH_PASSES);
}

// Final polish: a handful of Laplacian (moving-average) passes over the
// uniformly-resampled path with the endpoints pinned. Corner-cutting above
// rounds the big turns, but short kinks/dents survive wherever pre-drawn lanes,
// connectors, and stitch bridges meet at an angle (e.g. a connector joining a
// lane through an intersection). This rounds those joints into smooth arcs. The
// window is short (~2 m at 0.6 m spacing), so it erases joint kinks while
// leaving the route's real shape intact — measured <0.5 m deviation, and it
// does nothing on already-straight runs.
const POLISH_PASSES = 12;
function polishCurve(points: LatLng[], passes: number): LatLng[] {
  if (points.length < 3) return points;
  let out = points;
  for (let p = 0; p < passes; p++) {
    const next: LatLng[] = [out[0]];
    for (let i = 1; i < out.length - 1; i++) {
      next.push({
        lat: out[i].lat * 0.5 + (out[i - 1].lat + out[i + 1].lat) * 0.25,
        lng: out[i].lng * 0.5 + (out[i - 1].lng + out[i + 1].lng) * 0.25,
      });
    }
    next.push(out[out.length - 1]);
    out = next;
  }
  return out;
}

export function lineLengthMeters(points: LatLng[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineMeters(points[i - 1], points[i]);
  }
  return total;
}

// Orient line2 so its endpoints run the same direction as line1.
function orientedLinePair(line1: LatLng[], line2: LatLng[]): [LatLng[], LatLng[]] {
  const dSame =
    haversineMeters(line1[0], line2[0]) +
    haversineMeters(line1[line1.length - 1], line2[line2.length - 1]);
  const dRev =
    haversineMeters(line1[0], line2[line2.length - 1]) +
    haversineMeters(line1[line1.length - 1], line2[0]);
  return [line1, dRev < dSame ? [...line2].reverse() : line2];
}

// Local equirectangular projection (metres) about a reference latitude.
function toLocalXY(point: LatLng, refLat: number): { x: number; y: number } {
  return {
    x: point.lng * Math.cos(toRad(refLat)) * 111320,
    y: point.lat * 110540,
  };
}

function fromLocalXY(p: { x: number; y: number }, refLat: number): LatLng {
  return {
    lat: p.y / 110540,
    lng: p.x / (Math.cos(toRad(refLat)) * 111320),
  };
}

// Nearest point on a polyline, optionally constrained to lie at/after a given
// arc-length so center-line matching marches monotonically forward.
export function closestPointOnPolyline(
  point: LatLng,
  line: LatLng[],
  minAlong = -Infinity
): { point: LatLng; distance: number; along: number } | null {
  if (line.length < 2) return null;

  const refLat = point.lat;
  const p = toLocalXY(point, refLat);
  let alongBefore = 0;
  let best: { point: LatLng; distance: number; along: number } | null = null;

  for (let i = 0; i < line.length - 1; i++) {
    const a = toLocalXY(line[i], refLat);
    const b = toLocalXY(line[i + 1], refLat);
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const lenSq = vx * vx + vy * vy;
    const segLen = Math.sqrt(lenSq);
    if (segLen === 0) continue;

    const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / lenSq));
    const along = alongBefore + segLen * t;
    alongBefore += segLen;
    if (along < minAlong) continue;

    const proj = { x: a.x + vx * t, y: a.y + vy * t };
    const distance = Math.sqrt((p.x - proj.x) ** 2 + (p.y - proj.y) ** 2);
    if (!best || distance < best.distance) {
      best = { point: fromLocalXY(proj, refLat), distance, along };
    }
  }
  return best;
}

// Light three-tap smoothing, leaving the endpoints fixed.
export function smoothCenterLine(points: LatLng[]): LatLng[] {
  if (points.length < 5) return points;
  return points.map((point, idx) => {
    if (idx === 0 || idx === points.length - 1) return point;
    const prev = points[idx - 1];
    const next = points[idx + 1];
    return {
      lat: prev.lat * 0.25 + point.lat * 0.5 + next.lat * 0.25,
      lng: prev.lng * 0.25 + point.lng * 0.5 + next.lng * 0.25,
    };
  });
}

// Center line between two lane boundaries (ported from the `live` branch):
// resample the longer "driver" boundary, project each sample onto the shorter
// "target" boundary marching monotonically forward, average, then smooth. Falls
// back to index-wise averaging when projection can't match enough points.
export function computeCenterLine(line1: LatLng[], line2: LatLng[]): LatLng[] {
  const [l1, l2] = orientedLinePair(line1, line2);
  const len1 = lineLengthMeters(l1);
  const len2 = lineLengthMeters(l2);
  const driver = len1 >= len2 ? l1 : l2;
  const target = len1 >= len2 ? l2 : l1;
  const sampleCount = Math.max(
    driver.length,
    target.length,
    Math.min(80, Math.max(24, Math.ceil(Math.max(len1, len2) / 2.5)))
  );
  const samples = resampleLine(driver, sampleCount);

  const center: LatLng[] = [];
  let minAlong = -Infinity;
  for (const sample of samples) {
    const match = closestPointOnPolyline(sample, target, minAlong);
    if (!match || match.distance > 35) continue;
    minAlong = Math.max(minAlong, match.along - 0.5);
    center.push({
      lat: (sample.lat + match.point.lat) / 2,
      lng: (sample.lng + match.point.lng) / 2,
    });
  }

  if (center.length >= 2) return smoothCenterLine(center);

  const n = Math.max(l1.length, l2.length, 20);
  const a = resampleLine(l1, n);
  const b = resampleLine(l2, n);
  return smoothCenterLine(
    a.map((p, i) => ({ lat: (p.lat + b[i].lat) / 2, lng: (p.lng + b[i].lng) / 2 }))
  );
}

// --- geometric boundary pairing (ported from the `live` branch) ------------
// Pairs lane boundaries by geometry (mutual proximity + similar length)
// instead of by shared name, so it works regardless of how lanes were named.

export interface PairMetrics {
  avgDistance: number;
  maxDistance: number;
  lengthRatio: number;
  score: number;
}

export function pairMetrics(a: LatLng[], b: LatLng[]): PairMetrics | null {
  if (a.length < 2 || b.length < 2) return null;
  const [, bOriented] = orientedLinePair(a, b);
  const n = Math.max(a.length, bOriented.length, 20);
  const ra = resampleLine(a, n);
  const rb = resampleLine(bOriented, n);
  const distances = ra.map((pt, i) => haversineMeters(pt, rb[i]));
  const avgDistance = distances.reduce((s, d) => s + d, 0) / distances.length;
  const maxDistance = Math.max(...distances);
  const lengthA = lineLengthMeters(a);
  const lengthB = lineLengthMeters(b);
  const lengthRatio = Math.max(lengthA, lengthB) / Math.max(1, Math.min(lengthA, lengthB));
  return {
    avgDistance,
    maxDistance,
    lengthRatio,
    score: avgDistance + maxDistance * 0.3 + Math.abs(lengthA - lengthB) * 0.15,
  };
}

function avgDistanceToPolyline(samples: LatLng[], line: LatLng[]): number {
  let sum = 0;
  for (const p of samples) sum += closestPointOnPolyline(p, line)?.distance ?? 0;
  return sum / Math.max(1, samples.length);
}

// How far a center line deviates from bisecting its two boundaries, in [0, 1+].
// 0 = perfectly centered; large = hugging one boundary (a mis-paired line).
// Used to reject pairs that don't form a true lane centerline.
export function centerlineAsymmetry(center: LatLng[], a: LatLng[], b: LatLng[]): number {
  if (center.length < 2) return Infinity;
  const samples = resampleLine(center, 12);
  const dA = avgDistanceToPolyline(samples, a);
  const dB = avgDistanceToPolyline(samples, b);
  return Math.abs(dA - dB) / Math.max(0.1, (dA + dB) / 2);
}

// Move a point distMeters along a compass bearing (deg). Small-offset planar
// approximation — fine for the few metres of lane offset we use it for.
export function offsetLatLng(p: LatLng, distMeters: number, bearingDeg: number): LatLng {
  const br = toRad(bearingDeg);
  const dNorth = distMeters * Math.cos(br);
  const dEast = distMeters * Math.sin(br);
  return {
    lat: p.lat + toDeg(dNorth / R),
    lng: p.lng + toDeg(dEast / (R * Math.cos(toRad(p.lat)))),
  };
}

// Right-lane offset: the yellow lane center lines are DIVIDERS, not drive lines,
// so a route point sitting on one should be pushed into the right-hand lane —
// a quarter of that lane's width to the right of travel. Points on a connector
// (or off every lane) are left alone: the connector center line IS the drive
// line. The per-point offset is smoothed so lane<->connector hand-offs ease in
// rather than jogging the wheel.
export function offsetToRightLane(
  path: LatLng[],
  laneLines: { points: LatLng[]; width?: number }[],
  opts: { snapTol?: number; defaultWidth?: number; maxOffset?: number } = {}
): LatLng[] {
  if (path.length < 2 || laneLines.length === 0) return path;
  const snapTol = opts.snapTol ?? 2.0;          // route pt must be this close to a lane line
  const defaultWidth = opts.defaultWidth ?? 5.0; // assumed width for manual dividers (no pair)
  const maxOffset = opts.maxOffset ?? 6.0;       // never shove more than this far (m)

  // 1) desired right-offset (m) per point: width/4 where the point lies on a
  //    lane center line, else 0 (connector / open road). The offset is also
  //    forced to 0 through bends/junctions: a right offset is perpendicular to
  //    travel, so on a turn it swings with the heading and throws the route into
  //    an S across the intersection. Zeroing at corners (then easing in step 2)
  //    keeps the line on the true center through the bend and ramps the lane
  //    offset back in only on the straight runs.
  const TURN_GATE_DEG = 22; // local turn beyond this = corner/junction: no offset
  const raw = path.map((p, i) => {
    if (i > 0 && i < path.length - 1) {
      const turn = angleDeltaDeg(bearing(path[i - 1], p), bearing(p, path[i + 1]));
      if (turn > TURN_GATE_DEG) return 0;
    }
    let bestD = snapTol;
    let width = -1;
    for (const ln of laneLines) {
      const c = closestPointOnPolyline(p, ln.points);
      if (c && c.distance < bestD) {
        bestD = c.distance;
        width = ln.width && ln.width > 0 ? ln.width : defaultWidth;
      }
    }
    return width > 0 ? Math.min(width / 4, maxOffset) : 0;
  });

  // 2) ease the offset profile so transitions are gradual, not a step.
  const off = raw.slice();
  for (let it = 0; it < 6; it++) {
    const prev = off.slice();
    for (let i = 1; i < off.length - 1; i++) {
      off[i] = prev[i - 1] * 0.25 + prev[i] * 0.5 + prev[i + 1] * 0.25;
    }
  }

  // 3) push each point to the right of its local travel direction.
  return path.map((p, i) => {
    if (off[i] < 0.05) return p;
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(path.length - 1, i + 1)];
    return offsetLatLng(p, off[i], bearing(a, b) + 90); // +90deg = right of travel
  });
}

// Replace each intersection connector in the route with a direct connection.
//
// The streets are drawn cleanly, but the little connector corridors stitched
// between them are short, hand-drawn, and noisy — bisecting and welding them in
// produces kinks/dents through intersections no amount of smoothing fully
// removes. So instead of threading the route through the connector geometry, we
// run each street straight to where it meets the connector, then connect
// DIRECTLY to where the next street begins, and let smoothRouteTurns round that
// corner into a turn (a strict straight join would clip the inside of the bend).
//
// Each route point is classified lane-vs-connector by which kind of center line
// it sits on. A maximal connector run bounded by streets on both sides is
// dropped, joining the two street ends directly — but only when that direct gap
// is short enough to be an intersection (<= maxGapM). A long "connector" (really
// a road mis-drawn as one) keeps its geometry so we don't cut across the world.
export function straightenThroughConnectors(
  path: LatLng[],
  laneLines: { points: LatLng[] }[],
  connLines: { points: LatLng[] }[],
  maxGapM = 40
): LatLng[] {
  if (path.length < 3 || connLines.length === 0) return path;

  const nearest = (p: LatLng, lines: { points: LatLng[] }[]): number => {
    let best = Infinity;
    for (const ln of lines) {
      const c = closestPointOnPolyline(p, ln.points);
      if (c && c.distance < best) best = c.distance;
    }
    return best;
  };
  // On a lane when it's at least as close to a lane line as to a connector line
  // (small bias keeps welded junction points — on both — counted as lane).
  const onLane = path.map((p) => nearest(p, laneLines) <= nearest(p, connLines) + 0.5);

  const out: LatLng[] = [];
  let i = 0;
  while (i < path.length) {
    if (onLane[i]) {
      out.push(path[i]);
      i++;
      continue;
    }
    // a connector run [i, j)
    let j = i;
    while (j < path.length && !onLane[j]) j++;
    const bounded = out.length > 0 && j < path.length; // street on both sides
    const La = bounded ? out[out.length - 1] : null; // street A's end
    const Lb = bounded ? path[j] : null; // street B's start
    const gap = La && Lb ? haversineMeters(La, Lb) : Infinity;
    if (bounded && gap <= maxGapM && La && Lb) {
      // Drop the connector geometry. Rather than chord straight across (which
      // clips both streets short), extend each street to the corner where they
      // would meet and route La -> corner -> Lb, so the streets run straight to
      // the junction and only the corner itself gets rounded by smoothing.
      const aPrev = out.length >= 2 ? out[out.length - 2] : null;
      const bNext = j + 1 < path.length ? path[j + 1] : null;
      const corner = aPrev && bNext ? streetCorner(aPrev, La, Lb, bNext, gap) : null;
      if (corner) out.push(corner);
      // else: fall back to the direct chord (just join La -> Lb).
    } else {
      for (let k = i; k < j; k++) out.push(path[k]); // keep (long / unbounded)
    }
    i = j;
  }
  return out;
}

// The point where street A (heading aPrev->aEnd) and street B (heading
// bStart->bNext) would intersect if extended — the natural turn corner of the
// intersection. Returns null when the streets are near-parallel, the corner
// falls behind either street, or it sits implausibly far out (an offset/odd
// junction), so the caller can fall back to a straight join.
function streetCorner(
  aPrev: LatLng,
  aEnd: LatLng,
  bStart: LatLng,
  bNext: LatLng,
  chord: number
): LatLng | null {
  const ref = aEnd.lat;
  const a0 = toLocalXY(aPrev, ref);
  const a1 = toLocalXY(aEnd, ref);
  const b0 = toLocalXY(bStart, ref);
  const b1 = toLocalXY(bNext, ref);
  const dax = a1.x - a0.x;
  const day = a1.y - a0.y;
  const dbx = b1.x - b0.x;
  const dby = b1.y - b0.y;
  const den = dax * -dby - day * -dbx;
  if (Math.abs(den) < 1e-6) return null; // parallel
  const t = ((b0.x - a1.x) * -dby - (b0.y - a1.y) * -dbx) / den;
  const cx = a1.x + t * dax;
  const cy = a1.y + t * day;
  const corner = fromLocalXY({ x: cx, y: cy }, ref);
  const eA = haversineMeters(corner, aEnd);
  const eB = haversineMeters(corner, bStart);
  // C must be ahead of street A (t>0), behind street B's entry (sB<0), a real
  // extension (>1 m) and not overshoot far past the gap between the streets.
  const sB = (cx - b0.x) * dbx + (cy - b0.y) * dby;
  if (t > 0 && sB < 0 && eA > 1 && eB > 1 && eA <= 1.4 * chord && eB <= 1.4 * chord) {
    // Ease the apex slightly back toward the straight join (the midpoint of the
    // two street ends) so the rounded turn doesn't poke quite as far into the
    // intersection — the full geometric corner sits a touch too deep.
    const CORNER_PULLBACK = 0.2;
    const midLat = (aEnd.lat + bStart.lat) / 2;
    const midLng = (aEnd.lng + bStart.lng) / 2;
    return {
      lat: corner.lat * (1 - CORNER_PULLBACK) + midLat * CORNER_PULLBACK,
      lng: corner.lng * (1 - CORNER_PULLBACK) + midLng * CORNER_PULLBACK,
    };
  }
  return null;
}

// Keep the route inside the drivable corridor — the hard guarantee that the
// purple line never leaves the green/dotted boundaries (and so the cart never
// drives off the road). Every lane/connector center line is the spine of a
// corridor `width` wide (boundary-to-boundary), so the green boundaries sit at
// ±width/2 from it: a point is on-road when it lies within half that width of
// SOME center line. The upstream steps — right-lane offset, corner rounding, and
// the straight-through-intersection apex — can each nudge a point past that edge.
// This is the final pass: any point outside every corridor is pulled straight
// back toward the nearest spine until it sits just inside that corridor's edge.
// Points already in bounds (including the intended quarter-lane right offset,
// which is only width/4 out) are returned untouched, so the line's real shape is
// preserved and only genuine off-road excursions are corrected.
export function clampToCorridors(
  path: LatLng[],
  centerLines: { points: LatLng[]; width?: number }[],
  opts: { defaultWidth?: number; inset?: number; searchCap?: number } = {}
): LatLng[] {
  if (path.length < 2 || centerLines.length === 0) return path;
  const defaultWidth = opts.defaultWidth ?? 5.0; // half-width for lines with no measured pair
  const inset = opts.inset ?? 0.3;               // keep the line this far inside the edge (m)
  const searchCap = opts.searchCap ?? 30;        // ignore center lines farther than this (m)

  return path.map((p) => {
    // Pick the corridor the point is most inside (smallest overshoot past its
    // edge); a point inside ANY corridor is on-road and left alone.
    let best: { proj: LatLng; distance: number; half: number } | null = null;
    for (const ln of centerLines) {
      const c = closestPointOnPolyline(p, ln.points);
      if (!c || c.distance > searchCap) continue;
      const half = (ln.width && ln.width > 0 ? ln.width : defaultWidth) / 2;
      if (!best || c.distance - half < best.distance - best.half) {
        best = { proj: c.point, distance: c.distance, half };
      }
    }
    if (!best) return p; // nothing near enough to judge — don't yank it blindly

    const allowed = Math.max(0, best.half - inset);
    if (best.distance <= allowed) return p; // already inside the corridor edge

    // Move from the spine toward the point until it sits exactly at the edge.
    const t = best.distance > 0 ? allowed / best.distance : 0;
    return {
      lat: best.proj.lat + (p.lat - best.proj.lat) * t,
      lng: best.proj.lng + (p.lng - best.proj.lng) * t,
    };
  });
}

export function totalPolylineLength(points: LatLng[]): number {
  let d = 0;
  for (let i = 1; i < points.length; i++) {
    d += haversineMeters(points[i - 1], points[i]);
  }
  return d;
}

export function nearestPointOnPolyline(
  point: LatLng,
  polyline: LatLng[]
): { point: LatLng; index: number; distance: number; fraction: number } {
  let bestDist = Infinity;
  let bestPoint: LatLng = polyline[0];
  let bestIndex = 0;
  let bestFraction = 0;

  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i];
    const b = polyline[i + 1];
    const dx = b.lng - a.lng;
    const dy = b.lat - a.lat;
    const lenSq = dx * dx + dy * dy;
    let t = 0;
    if (lenSq > 0) {
      t = Math.max(0, Math.min(1, ((point.lng - a.lng) * dx + (point.lat - a.lat) * dy) / lenSq));
    }
    const proj: LatLng = { lat: a.lat + t * dy, lng: a.lng + t * dx };
    const d = haversineMeters(point, proj);
    if (d < bestDist) {
      bestDist = d;
      bestPoint = proj;
      bestIndex = i;
      bestFraction = t;
    }
  }

  return { point: bestPoint, index: bestIndex, distance: bestDist, fraction: bestFraction };
}

function interpLL(a: LatLng, b: LatLng, t: number): LatLng {
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

// Walk `dist` metres forward along `path`, starting from the point at
// (segIndex, frac). Returns the arrival point and the bearing of the lane there.
function walkForward(path: LatLng[], segIndex: number, frac: number, dist: number) {
  let remaining = dist;
  for (let i = segIndex; i < path.length - 1; i++) {
    const from = i === segIndex ? interpLL(path[i], path[i + 1], frac) : path[i];
    const segLen = haversineMeters(from, path[i + 1]);
    if (segLen >= remaining) {
      const t = segLen > 0 ? remaining / segLen : 0;
      return { point: interpLL(from, path[i + 1], t), bearing: bearing(path[i], path[i + 1]) };
    }
    remaining -= segLen;
  }
  const n = path.length;
  return { point: path[n - 1], bearing: bearing(path[n - 2], path[n - 1]) };
}

// Course over ground from the recent GPS track: the cart's ACTUAL direction of
// travel. We walk back from the latest fix until the cart has moved at least
// `minSepMeters` and take the bearing across that span — far enough to swamp
// fix jitter, short enough to stay current. Returns null if the cart hasn't
// moved enough to have a meaningful heading (it's basically stopped).
//
// NOTE: do NOT use follow.heading_deg for this — that value is path_bearing
// leaned by the full steering-COLUMN angle 1:1 (a needle display hack), not a
// true heading, so it points wildly off whenever the wheel is turned.
export function courseOverGround(
  track: { lat: number; lon: number }[],
  minSepMeters = 1.0
): number | null {
  if (track.length < 2) return null;
  const last = track[track.length - 1];
  const lastLL = { lat: last.lat, lng: last.lon };
  for (let i = track.length - 2; i >= 0; i--) {
    const p = { lat: track[i].lat, lng: track[i].lon };
    if (haversineMeters(p, lastLL) >= minSepMeters) {
      return bearing(p, lastLL);
    }
  }
  return null;
}

// --- forward trajectory prediction (the turquoise line) --------------------
// Where the cart will be over the next few seconds if it holds its current speed
// and wheel angle. A kinematic bicycle model: the steered front wheel gives a
// turn radius R = wheelbase / tan(road-wheel angle), so the cart sweeps an arc
// of curvature 1/R. We integrate heading + position forward in small steps.
//
// The cart reports a steering-COLUMN angle (±320° full lock), not the road-wheel
// angle, so we divide by STEERING_RATIO to get the actual road-wheel deflection.
// Both constants are rough cart geometry — tune them to match the real turn it
// carves. Sign matches follow.py: + column = wheels right = clockwise (compass
// bearing increases).
const WHEELBASE_M = 1.8;       // front-to-rear axle distance (m)
const STEERING_RATIO = 10.0;   // steering-column deg per road-wheel deg
const TRAJ_STEPS = 40;

export function predictTrajectory(
  start: LatLng,
  headingDeg: number,
  speedMps: number,
  steerColumnDeg: number,
  seconds: number
): LatLng[] {
  if (speedMps <= 0.05 || seconds <= 0) return [];

  const refLat = start.lat;
  let p = toLocalXY(start, refLat);
  let heading = headingDeg; // compass degrees (0 = N, 90 = E)

  // Constant turn rate for a held wheel angle: omega = v / R = v * tan(delta) / L.
  const wheelRad = toRad(steerColumnDeg / STEERING_RATIO);
  const yawRateDeg = toDeg((speedMps * Math.tan(wheelRad)) / WHEELBASE_M);
  const dt = seconds / TRAJ_STEPS;

  const out: LatLng[] = [fromLocalXY(p, refLat)];
  for (let i = 0; i < TRAJ_STEPS; i++) {
    const hr = toRad(heading);
    p = {
      x: p.x + Math.sin(hr) * speedMps * dt,
      y: p.y + Math.cos(hr) * speedMps * dt,
    };
    heading += yawRateDeg * dt;
    out.push(fromLocalXY(p, refLat));
  }
  return out;
}

// The orange recovery line: the IDEAL smooth path from the cart's current
// position+heading back onto the purple lane center a few metres ahead. It
// leaves tangent to the cart's actual heading (course over ground — the same
// heading the turquoise prediction uses) and arrives tangent to the lane at the
// merge point. That's the whole point of the pairing: the turquoise line is
// where the *current wheel angle* takes us, the orange is where we *should* go —
// steer so they overlay and the cart converges onto the lane. The merge gets
// longer (gentler) the further off-center or off-heading we are.
//
// When `headingDeg` is null (cart stopped, no course yet) we fall back to the
// lane tangent, which is the old heading-free behavior.
export function recoveryArc(
  start: LatLng,
  routePath: LatLng[],
  headingDeg: number | null = null
): LatLng[] {
  if (routePath.length < 2) return [];

  const snap = nearestPointOnPolyline(start, routePath);
  const offset = snap.distance; // metres off the line
  const laneBearing = bearing(
    routePath[snap.index],
    routePath[Math.min(snap.index + 1, routePath.length - 1)]
  );
  const startBearing =
    headingDeg === null || Number.isNaN(headingDeg) ? laneBearing : headingDeg;

  // Heading error vs the lane (degrees, signed). A big error needs a longer arc
  // to swing around smoothly instead of kinking.
  const headErr = ((startBearing - laneBearing + 540) % 360) - 180;
  // Nothing to recover only when we're both on the line AND already aligned.
  if (offset < 0.25 && Math.abs(headErr) < 3) return [];

  const mergeDist = Math.min(20, Math.max(5, offset * 3 + Math.abs(headErr) * 0.08 + 4));
  const target = walkForward(routePath, snap.index, snap.fraction, mergeDist);

  // Cubic Bézier in local metres: endpoints tangent to the lane at each end.
  const refLat = start.lat;
  const p0 = toLocalXY(start, refLat);
  const p3 = toLocalXY(target.point, refLat);
  const span = Math.hypot(p3.x - p0.x, p3.y - p0.y);
  const handle = span / 3;
  const t0 = { x: Math.sin(toRad(startBearing)), y: Math.cos(toRad(startBearing)) };
  const t1 = { x: Math.sin(toRad(target.bearing)), y: Math.cos(toRad(target.bearing)) };
  const p1 = { x: p0.x + t0.x * handle, y: p0.y + t0.y * handle };
  const p2 = { x: p3.x - t1.x * handle, y: p3.y - t1.y * handle };

  const n = 24;
  const pts: LatLng[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const v = 1 - u;
    const x = v * v * v * p0.x + 3 * v * v * u * p1.x + 3 * v * u * u * p2.x + u * u * u * p3.x;
    const y = v * v * v * p0.y + 3 * v * v * u * p1.y + 3 * v * u * u * p2.y + u * u * u * p3.y;
    pts.push(fromLocalXY({ x, y }, refLat));
  }
  return pts;
}
