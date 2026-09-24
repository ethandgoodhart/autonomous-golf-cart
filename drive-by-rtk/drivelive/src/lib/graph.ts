import { LatLng, CenterLine, GraphNode } from './types';
import { haversineMeters, bearing } from './geo';

// Weld vertices from different center lines that are within this distance into
// a single graph node. Closes sub-metre/few-metre gaps where a connector
// endpoint or an adjacent lane doesn't land on the exact same coordinate,
// which would otherwise leave the routing graph fragmented. Kept small so it
// only merges true near-misses (well under a lane width) and never invents
// shortcuts between distinct roads.
const WELD_TOLERANCE_M = 3;

function nodeId(p: LatLng): string {
  return `${p.lat.toFixed(8)},${p.lng.toFixed(8)}`;
}

function getOrCreateNode(graph: Map<string, GraphNode>, p: LatLng): GraphNode {
  const id = nodeId(p);
  const exact = graph.get(id);
  if (exact) return exact;

  // Proximity weld: reuse a nearby existing node (keeping its real coordinate
  // so the driven path follows true center-line geometry, not a snapped grid).
  for (const node of graph.values()) {
    if (haversineMeters(p, node) <= WELD_TOLERANCE_M) return node;
  }

  const node: GraphNode = { id, lat: p.lat, lng: p.lng, neighbors: [] };
  graph.set(id, node);
  return node;
}

function addEdge(a: GraphNode, b: GraphNode, distance: number) {
  if (!a.neighbors.some((e) => e.nodeId === b.id)) {
    a.neighbors.push({ nodeId: b.id, distance });
  }
  if (!b.neighbors.some((e) => e.nodeId === a.id)) {
    b.neighbors.push({ nodeId: a.id, distance });
  }
}

// A connector endpoint can legitimately sit a lane-width away from the nearest
// routable node: connectors were drawn touching lane BOUNDARIES, but the graph
// is built from derived CENTER LINES (≈half a lane inboard), and some target
// lanes have no center line at all (unpaired boundary). When that gap exceeds
// the 3 m weld, the connector dangles and the street it was meant to reach
// becomes an unreachable island — so routing between the two streets silently
// returns no path. We close that gap with an explicit stitch: bridge each
// connector endpoint to the nearest node in a DIFFERENT component within this
// radius. Cross-component + connector-endpoint-only keeps it from inventing
// shortcuts between roads that are merely close but already connected.
const STITCH_RADIUS_M = 16;

// Union-find over node ids for the stitch pass.
function makeUnionFind(ids: Iterable<string>) {
  const parent = new Map<string, string>();
  for (const id of ids) parent.set(id, id);
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) {
      const nxt = parent.get(x)!;
      parent.set(x, r);
      x = nxt;
    }
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  return { find, union };
}

// A connector endpoint carries the direction the connector is heading as it
// leaves that end, so the stitch can bridge it to a node that CONTINUES that
// heading rather than the geometrically-nearest one. The nearest node is often
// off to the side, which makes the route dart out to it and snap back — an
// out-and-back spike that smoothing turns into a visible wiggle through the
// intersection. Choosing the best forward continuation keeps the turn smooth.
interface ConnectorEnd { node: GraphNode; outBearing: number }

// Smallest absolute difference between two compass bearings, in degrees [0,180].
function bearingDelta(a: number, b: number): number {
  return Math.abs((((b - a + 180) % 360) + 360) % 360 - 180);
}

// Bridge dangling connector ends into the rest of the network (see above).
// Each endpoint is joined to the cross-component node that best continues the
// connector's exit heading (small angle), with a light distance tie-break so a
// far-but-aligned node never beats a close, well-aligned one.
function stitchAcrossComponents(graph: Map<string, GraphNode>, ends: ConnectorEnd[]) {
  if (ends.length === 0) return;
  const { find, union } = makeUnionFind(graph.keys());
  for (const node of graph.values()) {
    for (const e of node.neighbors) union(node.id, e.nodeId);
  }
  const allNodes = [...graph.values()];
  // ~2°/metre: heading alignment dominates, distance only breaks near-ties.
  const DIST_PENALTY = 2.0;
  // Two passes so a connector bridged in pass 1 can extend a chain in pass 2.
  for (let pass = 0; pass < 2; pass++) {
    let merged = false;
    for (const { node: ep, outBearing } of ends) {
      const epRoot = find(ep.id);
      let best: GraphNode | null = null;
      let bestScore = Infinity;
      let bestDist = 0;
      for (const n of allNodes) {
        if (find(n.id) === epRoot) continue; // already connected — skip
        const d = haversineMeters(ep, n);
        if (d >= STITCH_RADIUS_M) continue;
        const angle = bearingDelta(outBearing, bearing(ep, n));
        const score = angle + d * DIST_PENALTY;
        if (score < bestScore) {
          bestScore = score;
          best = n;
          bestDist = d;
        }
      }
      if (best) {
        addEdge(ep, best, bestDist);
        union(ep.id, best.id);
        merged = true;
      }
    }
    if (!merged) break;
  }
}

export function buildGraph(centerLines: CenterLine[]): Map<string, GraphNode> {
  const graph = new Map<string, GraphNode>();
  const connectorEnds: ConnectorEnd[] = [];

  for (const cl of centerLines) {
    let firstNode: GraphNode | null = null;
    let lastNode: GraphNode | null = null;
    for (let i = 0; i < cl.points.length - 1; i++) {
      const a = getOrCreateNode(graph, cl.points[i]);
      const b = getOrCreateNode(graph, cl.points[i + 1]);
      const dist = haversineMeters(cl.points[i], cl.points[i + 1]);
      addEdge(a, b, dist);
      if (i === 0) firstNode = a;
      lastNode = b;
    }
    // Remember both ends of every connector so the stitch pass can bridge any
    // that didn't weld into a lane — each tagged with the heading the connector
    // is travelling as it leaves that end (pointing OUT of the connector, the
    // way a bridge should continue).
    const pts = cl.points;
    if (cl.type === 'connector' && firstNode && lastNode && firstNode !== lastNode) {
      connectorEnds.push({ node: firstNode, outBearing: bearing(pts[1], pts[0]) });
      connectorEnds.push({ node: lastNode, outBearing: bearing(pts[pts.length - 2], pts[pts.length - 1]) });
    }
  }

  stitchAcrossComponents(graph, connectorEnds);

  return graph;
}

export function findNearestNode(point: LatLng, graph: Map<string, GraphNode>, maxDist = 50): string | null {
  let bestId: string | null = null;
  let bestDist = maxDist;

  for (const node of graph.values()) {
    const d = haversineMeters(point, { lat: node.lat, lng: node.lng });
    if (d < bestDist) {
      bestDist = d;
      bestId = node.id;
    }
  }

  return bestId;
}

export function dijkstra(
  graph: Map<string, GraphNode>,
  startId: string,
  endId: string
): LatLng[] {
  const dist = new Map<string, number>();
  const prev = new Map<string, string>();
  const visited = new Set<string>();

  for (const id of graph.keys()) {
    dist.set(id, Infinity);
  }
  dist.set(startId, 0);

  while (true) {
    let u: string | null = null;
    let uDist = Infinity;
    for (const [id, d] of dist) {
      if (!visited.has(id) && d < uDist) {
        u = id;
        uDist = d;
      }
    }
    if (u === null || u === endId) break;
    visited.add(u);

    const node = graph.get(u);
    if (!node) break;

    for (const edge of node.neighbors) {
      if (visited.has(edge.nodeId)) continue;
      const alt = uDist + edge.distance;
      if (alt < (dist.get(edge.nodeId) ?? Infinity)) {
        dist.set(edge.nodeId, alt);
        prev.set(edge.nodeId, u);
      }
    }
  }

  if (!prev.has(endId) && startId !== endId) return [];

  const path: LatLng[] = [];
  let current: string | undefined = endId;
  while (current) {
    const node = graph.get(current);
    if (node) path.unshift({ lat: node.lat, lng: node.lng });
    current = prev.get(current);
  }

  return path;
}
