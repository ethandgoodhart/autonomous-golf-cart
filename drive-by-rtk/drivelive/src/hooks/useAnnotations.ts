'use client';

import { useMemo } from 'react';
import { RawAnnotations, CenterLine, LatLng } from '@/lib/types';
import { computeCenterLine, pairMetrics, centerlineAsymmetry } from '@/lib/geo';
import { buildGraph } from '@/lib/graph';

interface Boundary { id: string; name: string; points: LatLng[] }

// Mirrors the `live` editor: a suppressed auto center line is keyed by its two
// lane ids sorted and joined with '__'. When a pair's id is suppressed the user
// has replaced it with a hand-drawn manual center line, so we must NOT draw the
// auto pair for it.
function autoCenterLineId(a: Boundary, b: Boundary): string {
  return [a.id, b.id].sort().join('__');
}

// A center line must bisect its two boundaries to within this fraction,
// otherwise the pairing is wrong (e.g. two non-adjacent edges) and the line
// would hug one side instead of running down the middle of the lane.
const MAX_CENTERLINE_ASYMMETRY = 0.4;

// Geometric pairing (ported from the `live` branch): pair lane boundaries by
// mutual proximity + similar length rather than by shared name, so it works no
// matter how the lanes were named. Greedy lowest-score-first, each used once.
const PAIR_OPTS = { maxAvgDistance: 24, maxPointDistance: 45, maxLengthRatio: 2.75 };

function findGeometricPairs(items: Boundary[]) {
  const usable = items.filter((it) => it.points.length >= 2);
  const candidates: { a: Boundary; b: Boundary; score: number; name: string }[] = [];
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const m = pairMetrics(usable[i].points, usable[j].points);
      if (!m) continue;
      if (
        m.avgDistance <= PAIR_OPTS.maxAvgDistance &&
        m.maxDistance <= PAIR_OPTS.maxPointDistance &&
        m.lengthRatio <= PAIR_OPTS.maxLengthRatio
      ) {
        const name =
          usable[i].name === usable[j].name
            ? usable[i].name
            : `${usable[i].name} / ${usable[j].name}`;
        candidates.push({ a: usable[i], b: usable[j], score: m.score, name });
      }
    }
  }
  candidates.sort((l, r) => l.score - r.score);

  const used = new Set<Boundary>();
  const pairs: { name: string; a: Boundary; b: Boundary }[] = [];
  for (const c of candidates) {
    if (used.has(c.a) || used.has(c.b)) continue;
    used.add(c.a);
    used.add(c.b);
    pairs.push({ name: c.name, a: c.a, b: c.b });
  }
  return pairs;
}

export function useAnnotations(raw: RawAnnotations) {
  return useMemo(() => {
    const suppressed = new Set(raw.suppressedAutoCenterLineIds ?? []);

    // Lanes: geometric pairing -> center lines.
    const lanePairs = findGeometricPairs(
      raw.annotations.filter((a) => a.type === 'lane')
    );

    const laneCenterLines: CenterLine[] = [];

    // Manual center lines first: the user hand-drew these to replace a
    // suppressed auto pair, so they are the source of truth — drawn as-is,
    // never filtered by the asymmetry guard, and welded into the route graph.
    for (const manual of raw.manualCenterLines ?? []) {
      if (!manual.points || manual.points.length < 2) continue;
      const points = manual.points.map((p) => ({ lat: p.lat, lng: p.lng }));
      laneCenterLines.push({ name: manual.name, type: 'lane', points });
    }

    for (const pair of lanePairs) {
      // Skip pairs the editor suppressed (replaced by a manual center line).
      if (suppressed.has(autoCenterLineId(pair.a, pair.b))) continue;
      const points = computeCenterLine(pair.a.points, pair.b.points);
      // Reject pairs whose center line doesn't bisect the two boundaries — it
      // would draw a yellow line hugging one edge instead of down the middle.
      if (centerlineAsymmetry(points, pair.a.points, pair.b.points) > MAX_CENTERLINE_ASYMMETRY) {
        continue;
      }
      // Full lane width (boundary-to-boundary), so the route can offset into the
      // right lane — this center line is the divider, not the drive line.
      const width = pairMetrics(pair.a.points, pair.b.points)?.avgDistance;
      laneCenterLines.push({ name: pair.name, type: 'lane', points, width });
    }

    // Connectors are drawn as boundary polylines — the two SIDES of a connector
    // corridor (often several strokes per side, sharing a name). Pair them
    // geometrically and run the route down the bisecting center line, exactly
    // like lanes, so the purple route sits in the MIDDLE of the blue connector
    // boundaries instead of hugging one edge. Strokes with no geometric partner
    // fall back to being used as-is.
    //
    // We deliberately DON'T snap connector endpoints onto lane center lines.
    // That used to be how connectors welded into the graph, but on a short
    // connector (a few metres) yanking BOTH ends several metres onto the
    // nearest center line distorts the whole stroke into a sharp kink — the
    // "dent" seen at tight intersections. Connectivity is instead handled
    // purely in the graph: the 3 m vertex weld plus the direction-aware stitch
    // pass in buildGraph() bridge each connector end into the network while
    // leaving its drawn geometry untouched, so the turn stays a smooth arc.
    const connBoundaries: Boundary[] = raw.connectors
      .filter((c) => c.points && c.points.length >= 2)
      .map((c) => ({ id: c.id, name: c.name, points: c.points.map((p) => ({ lat: p.lat, lng: p.lng })) }));

    const connCenterLines: CenterLine[] = [];
    const pairedConn = new Set<Boundary>();
    for (const pair of findGeometricPairs(connBoundaries)) {
      const points = computeCenterLine(pair.a.points, pair.b.points);
      // Same guard as lanes: a center line that hugs one boundary means the two
      // strokes weren't really opposite sides of a corridor — leave them unpaired.
      if (centerlineAsymmetry(points, pair.a.points, pair.b.points) > MAX_CENTERLINE_ASYMMETRY) continue;
      pairedConn.add(pair.a);
      pairedConn.add(pair.b);
      // Corridor width (boundary-to-boundary) so the containment clamp knows how
      // far off the connector spine still counts as on-road.
      const width = pairMetrics(pair.a.points, pair.b.points)?.avgDistance;
      connCenterLines.push({ name: pair.name, type: 'connector', points, width });
    }

    // Lone connector strokes with no geometric partner: use the polyline as-is.
    for (const b of connBoundaries) {
      if (pairedConn.has(b)) continue;
      connCenterLines.push({ name: b.name, type: 'connector', points: b.points.map((p) => ({ ...p })) });
    }

    const allCenterLines = [...laneCenterLines, ...connCenterLines];
    const graph = buildGraph(allCenterLines);

    return {
      laneBoundaries: raw.annotations,
      connectorBoundaries: raw.connectors,
      laneCenterLines,
      connCenterLines,
      allCenterLines,
      graph,
    };
  }, [raw]);
}
