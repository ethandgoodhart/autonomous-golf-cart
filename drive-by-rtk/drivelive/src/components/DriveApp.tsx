'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import { RawAnnotations, LatLng } from '@/lib/types';
import { courseOverGround } from '@/lib/geo';
import { useAnnotations } from '@/hooks/useAnnotations';
import { useGps } from '@/hooks/useGps';
import { useSpeed } from '@/hooks/useSpeed';
import { useRoute } from '@/hooks/useRoute';
import MapView from './MapView';
import AnnotationLayers from './AnnotationLayers';
import GpsMarker from './GpsMarker';
import RouteLayer from './RouteLayer';
import RecoveryLayer from './RecoveryLayer';
import TrajectoryLayer from './TrajectoryLayer';
import RouteSelector from './RouteSelector';
import GpsInfoPanel from './GpsInfoPanel';
import NtripToggle from './NtripToggle';
import RoutePanel from './RoutePanel';
import DriveControl from './DriveControl';

interface Props {
  rawAnnotations: RawAnnotations;
}

export default function DriveApp({ rawAnnotations }: Props) {
  const [map, setMap] = useState<mapboxgl.Map | null>(null);
  // Curve smoothing: meters of corner rounded off at each turn. Tweakable live
  // from the Route panel so you can dial turns from elbow-sharp to wide-and-smooth.
  const [cornerCut, setCornerCut] = useState(3.5);
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!;
  const wsUrl = process.env.NEXT_PUBLIC_GPS_WS_URL || 'ws://localhost:8765';

  // Yellow overlay = lane center lines ONLY (the lane dividers), matching the
  // `live` editor. The snapped connector center-lines live only inside `graph`
  // for routing; drawing them yellow would double-draw every connector (raw
  // blue + distorted yellow) — that was the visual regression vs live.
  const { laneBoundaries, connectorBoundaries, laneCenterLines, connCenterLines, graph } = useAnnotations(rawAnnotations);
  const { position, isConnected, getHistory, historyVersion, follow, ntrip, sendCommand, remoteRoute } = useGps(wsUrl);
  const { speedMph, speed } = useSpeed(getHistory, historyVersion);
  const route = useRoute(graph, position, speed, laneCenterLines, connCenterLines, cornerCut);

  // Lock-route toggle: when on, the purple line is frozen the moment a drive
  // starts and held until Stop, so the displayed route matches the fixed path
  // the cart was actually given (instead of re-planning under it every fix).
  const [lockRoute, setLockRoute] = useState(true);
  const [frozenPath, setFrozenPath] = useState<LatLng[] | null>(null);
  const driving = follow?.active ?? false;

  // Remote destination: when a companion app pushes a target coordinate over
  // the tunnel, drop the pin here and let useRoute plan the same purple route a
  // map click would. If the remote asked to start, bump autoStartToken so
  // DriveControl fires "Drive Route" once that purple route is ready — the cart
  // drives the exact line shown on screen, not a raw straight shot.
  const [autoStartToken, setAutoStartToken] = useState(0);
  const lastRemoteSeq = useRef(0);
  useEffect(() => {
    if (!remoteRoute || remoteRoute.seq === lastRemoteSeq.current) return;
    lastRemoteSeq.current = remoteRoute.seq;
    // Clear first so hasRoute drops to false until the fresh route computes;
    // that's what gates the autostart below onto the NEW purple line.
    route.clearRoute();
    route.setEnd({ lat: remoteRoute.lat, lng: remoteRoute.lng });
    if (remoteRoute.autostart) setAutoStartToken((n) => n + 1);
    // route identity changes every render; we only want to run on a new seq.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteRoute]);
  useEffect(() => {
    // Snapshot once when (locked & driving) begins; clear when either drops.
    if (lockRoute && driving) setFrozenPath((prev) => prev ?? route.path);
    else setFrozenPath(null);
  }, [lockRoute, driving, route.path]);
  const displayPath = lockRoute && driving && frozenPath ? frozenPath : route.path;

  // Panic stop: 'q' or Esc slams the brake to full immediately, anytime.
  // Ignored while typing in a field so it can't fire by accident.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'q' && e.key !== 'Q') return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
      e.preventDefault();
      sendCommand({ type: 'stop', emergency: true });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sendCommand]);

  // Heading for the turquoise prediction = real course over ground from the GPS
  // track (NOT follow.heading_deg, which is the needle's path+wheel-lean hack).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const heading = useMemo(() => courseOverGround(getHistory()), [historyVersion]);

  return (
    <div className="w-screen h-screen relative">
      <MapView token={token} onMapReady={setMap}>
        {map && (
          <>
            <AnnotationLayers map={map} lanes={laneBoundaries} connectors={connectorBoundaries} centerLines={laneCenterLines} />
            <GpsMarker map={map} position={position} heading={follow?.active ? follow.heading_deg : null} />
            <RouteLayer map={map} path={displayPath} startPoint={route.startPoint} endPoint={route.endPoint} />
            <RecoveryLayer map={map} position={position} path={displayPath} heading={heading} />
            <TrajectoryLayer
              map={map}
              position={position}
              speed={speed}
              heading={heading}
              steerDeg={follow?.active ? follow.steering_actual_deg ?? 0 : 0}
            />
            <RouteSelector map={map} selecting={route.selecting} onMapClick={route.handleMapClick} />
          </>
        )}
      </MapView>

      <div className="absolute top-3 left-3 z-10 flex flex-col gap-2">
        <NtripToggle ntrip={ntrip} onSwitch={(provider) => sendCommand({ type: 'ntrip', provider })} />
        <GpsInfoPanel position={position} speed={speedMph} isConnected={isConnected} />
      </div>
      <RoutePanel
        route={route}
        onSelectEnd={route.selectEnd}
        onClear={route.clearRoute}
        cornerCut={cornerCut}
        onCornerCutChange={setCornerCut}
      />
      <DriveControl route={route} follow={follow} speedMph={speedMph} isConnected={isConnected} sendCommand={sendCommand} lockRoute={lockRoute} onToggleLockRoute={setLockRoute} autoStartToken={autoStartToken} />
    </div>
  );
}
