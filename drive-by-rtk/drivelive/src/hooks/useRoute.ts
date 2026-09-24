'use client';

import { useReducer, useCallback, useMemo, useEffect } from 'react';
import { LatLng, GpsPosition, GraphNode, RouteState, CenterLine } from '@/lib/types';
import { smoothRouteTurns, totalPolylineLength, offsetToRightLane, straightenThroughConnectors, clampToCorridors } from '@/lib/geo';
import { findNearestNode, dijkstra } from '@/lib/graph';
import { snapToRoute, computeRouteProgress, computeEta } from '@/lib/route-tracking';

type Action =
  | { type: 'SET_SELECTING'; selecting: 'start' | 'end' | 'none' }
  | { type: 'SET_START_AUTO'; point: LatLng }
  | { type: 'SET_END'; point: LatLng }
  | { type: 'SET_PATH'; path: LatLng[]; totalDistance: number }
  | { type: 'UPDATE_PROGRESS'; distanceRemaining: number; progress: number; eta: number | null; nearestRoutePoint: LatLng }
  | { type: 'CLEAR' };

const initialState: RouteState = {
  startPoint: null,
  endPoint: null,
  path: [],
  totalDistance: 0,
  distanceRemaining: 0,
  progress: 0,
  eta: null,
  nearestRoutePoint: null,
  selecting: 'none',
};

function reducer(state: RouteState, action: Action): RouteState {
  switch (action.type) {
    case 'SET_SELECTING':
      return { ...state, selecting: action.selecting };
    case 'SET_START_AUTO':
      // Start always tracks our live position; never clears the chosen end.
      return { ...state, startPoint: action.point };
    case 'SET_END':
      return { ...state, endPoint: action.point, selecting: 'none' };
    case 'SET_PATH':
      return { ...state, path: action.path, totalDistance: action.totalDistance, distanceRemaining: action.totalDistance, progress: 0 };
    case 'UPDATE_PROGRESS':
      return { ...state, distanceRemaining: action.distanceRemaining, progress: action.progress, eta: action.eta, nearestRoutePoint: action.nearestRoutePoint };
    case 'CLEAR':
      // Clearing drops the destination/route but keeps the live start.
      return { ...initialState, startPoint: state.startPoint };
    default:
      return state;
  }
}

export function useRoute(
  graph: Map<string, GraphNode>,
  gpsPosition: GpsPosition | null,
  speed: number,
  laneCenterLines: CenterLine[] = [],
  connCenterLines: CenterLine[] = [],
  // Curve smoothing knob: how many meters of corner to round off at each turn.
  // Higher = smoother/rounder turns; lower = sharper, more elbow-shaped corners.
  cornerCut = 3.5
) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const selectEnd = useCallback(() => dispatch({ type: 'SET_SELECTING', selecting: 'end' }), []);
  const clearRoute = useCallback(() => dispatch({ type: 'CLEAR' }), []);

  // Set the destination directly (no map click) — used when a remote client
  // pushes in a target coordinate. Snaps to the nearest lane node just like a
  // click would, so the same purple route planning runs.
  const setEnd = useCallback(
    (latlng: LatLng) => {
      const nodeId = findNearestNode(latlng, graph);
      if (!nodeId) return;
      const node = graph.get(nodeId);
      if (!node) return;
      dispatch({ type: 'SET_END', point: { lat: node.lat, lng: node.lng } });
    },
    [graph]
  );

  // Start point IS our precise live GPS position (not snapped to the road).
  // Updates every fix; it's the exact origin the route is drawn/driven from.
  useEffect(() => {
    if (!gpsPosition) return;
    dispatch({ type: 'SET_START_AUTO', point: { lat: gpsPosition.lat, lng: gpsPosition.lon } });
  }, [gpsPosition?.lat, gpsPosition?.lon]);

  // Clicking the map sets the DESTINATION (start is automatic).
  const handleMapClick = useCallback(
    (latlng: LatLng) => {
      if (state.selecting !== 'end') return;
      const nodeId = findNearestNode(latlng, graph);
      if (!nodeId) return;
      const node = graph.get(nodeId);
      if (!node) return;
      dispatch({ type: 'SET_END', point: { lat: node.lat, lng: node.lng } });
    },
    [state.selecting, graph]
  );

  // The lane-network entry/exit nodes. These only change when the cart crosses
  // to a new nearest vertex, so Dijkstra below isn't re-run on every GPS fix.
  const startEntryId = useMemo(
    () => (state.startPoint ? findNearestNode(state.startPoint, graph) : null),
    [state.startPoint, graph]
  );
  const endId = useMemo(
    () => (state.endPoint ? findNearestNode(state.endPoint, graph) : null),
    [state.endPoint, graph]
  );

  // Core route along the lane network (entry node -> destination node).
  const corePath = useMemo(() => {
    if (!startEntryId || !endId) return null;
    return dijkstra(graph, startEntryId, endId);
  }, [startEntryId, endId, graph]);

  useEffect(() => {
    if (corePath && corePath.length >= 1) {
      dispatch({ type: 'SET_PATH', path: corePath, totalDistance: totalPolylineLength(corePath) });
    }
  }, [corePath]);

  // Track progress along the route (snap the live position onto it).
  useEffect(() => {
    if (!gpsPosition || state.path.length < 2) return;
    const pos = { lat: gpsPosition.lat, lng: gpsPosition.lon };
    const snap = snapToRoute(pos, state.path);
    if (!snap) return;
    const { distRemaining, progress } = computeRouteProgress(snap.segmentIndex, snap.fraction, state.path);
    const eta = computeEta(distRemaining, speed);
    dispatch({
      type: 'UPDATE_PROGRESS',
      distanceRemaining: distRemaining,
      progress,
      eta,
      nearestRoutePoint: snap.nearestPoint,
    });
  }, [gpsPosition, state.path, speed]);

  // Path exposed to the map + cart: the PURE lane centerline (the ideal line to
  // sit on), NOT prefixed with the live off-center GPS position. The cart's job
  // is to drive onto and hold this line; the orange recovery curve shows how it
  // gets there from wherever it currently is.
  const path = useMemo(() => {
    if (state.path.length < 2) return state.path;
    // 1) Through intersections, drop the noisy connector geometry: run each
    //    street straight to the junction and connect directly to the next
    //    street, leaving the turn itself for smoothing to round.
    // 2) Shift lane portions into the right lane (the yellow center lines are
    //    dividers, so we drive to the right of them); the direct intersection
    //    links stay un-offset.
    // 3) Smooth: round the direct joins (and every other corner) into arcs.
    // 4) Clamp back inside the lane/connector corridors: the offset, corner
    //    rounding and intersection apex above can each nudge a point past the
    //    green boundary — this is the hard guarantee the purple line (and so the
    //    cart) never leaves the drivable road.
    const straight = straightenThroughConnectors(state.path, laneCenterLines, connCenterLines);
    const smoothed = smoothRouteTurns(offsetToRightLane(straight, laneCenterLines), cornerCut);
    return clampToCorridors(smoothed, [...laneCenterLines, ...connCenterLines]);
  }, [state.path, laneCenterLines, connCenterLines, cornerCut]);

  const totalDistance = useMemo(() => {
    if (path.length < 2) return state.totalDistance;
    return totalPolylineLength(path);
  }, [path, state.totalDistance]);

  return {
    ...state,
    path,
    totalDistance,
    selectEnd,
    setEnd,
    handleMapClick,
    clearRoute,
  };
}
