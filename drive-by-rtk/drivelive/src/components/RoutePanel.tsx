'use client';

import { RouteState } from '@/lib/types';

function formatEta(seconds: number | null): string {
  if (seconds === null) return '--:--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatDist(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)}m`;
  return `${(meters / 1000).toFixed(2)}km`;
}

interface Props {
  route: RouteState;
  onSelectEnd: () => void;
  onClear: () => void;
  cornerCut: number;
  onCornerCutChange: (value: number) => void;
}

export default function RoutePanel({ route, onSelectEnd, onClear, cornerCut, onCornerCutChange }: Props) {
  const hasRoute = route.path.length >= 2;

  return (
    <div className="absolute bottom-3 left-3 z-10 w-64 rounded-xl bg-neutral-900/90 backdrop-blur-md p-4 text-sm text-neutral-200 shadow-lg border border-neutral-800">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-3">Route</h3>

      <div className="flex items-center gap-2 mb-3 text-xs">
        <span className={`inline-block w-2.5 h-2.5 rounded-full ${route.startPoint ? 'bg-green-500' : 'bg-neutral-600'}`} />
        <span className={route.startPoint ? 'text-neutral-300' : 'text-neutral-500'}>
          Start: {route.startPoint ? 'live GPS (auto)' : 'waiting for GPS…'}
        </span>
      </div>

      <div className="flex gap-2 mb-3">
        <button
          onClick={onSelectEnd}
          className={`flex-1 px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${
            route.selecting === 'end'
              ? 'bg-red-600 text-white ring-2 ring-red-400'
              : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
          }`}
        >
          {route.endPoint ? '✓ Destination' : 'Set Destination'}
        </button>
        <button
          onClick={onClear}
          className="px-3 py-2 rounded-lg text-xs font-semibold bg-neutral-800 text-neutral-400 hover:bg-neutral-700 transition-colors"
        >
          Clear
        </button>
      </div>

      <div className="mb-3">
        <div className="flex items-center justify-between text-[11px] mb-1">
          <span className="font-semibold uppercase tracking-wide text-neutral-500">Curve smoothing</span>
          <span className="tabular-nums text-neutral-300">{cornerCut.toFixed(1)}m</span>
        </div>
        <input
          type="range"
          min={0}
          max={10}
          step={0.5}
          value={cornerCut}
          onChange={(e) => onCornerCutChange(Number(e.target.value))}
          className="w-full accent-purple-500"
        />
        <div className="flex justify-between text-[9px] text-neutral-600 mt-0.5">
          <span>sharp / elbow</span>
          <span>wide / smooth</span>
        </div>
      </div>

      {route.selecting === 'end' && (
        <p className="text-xs text-purple-400 mb-2">
          Click on the map to set your destination…
        </p>
      )}

      {/* TEMP debug readout — destination coords for route verification */}
      {route.endPoint && (
        <p className="text-[11px] text-amber-400 mb-2 font-mono select-all">
          dest: {route.endPoint.lat.toFixed(6)}, {route.endPoint.lng.toFixed(6)}
        </p>
      )}

      {hasRoute && (
        <>
          <div className="w-full h-2 bg-neutral-800 rounded-full overflow-hidden mb-2">
            <div
              className="h-full bg-purple-500 rounded-full transition-all duration-300"
              style={{ width: `${Math.min(100, route.progress * 100)}%` }}
            />
          </div>

          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <div className="text-lg font-bold text-white tabular-nums">{formatDist(route.totalDistance)}</div>
              <div className="text-[10px] text-neutral-500">Total</div>
            </div>
            <div>
              <div className="text-lg font-bold text-white tabular-nums">{formatDist(route.distanceRemaining)}</div>
              <div className="text-[10px] text-neutral-500">Remaining</div>
            </div>
            <div>
              <div className="text-lg font-bold text-white tabular-nums">{formatEta(route.eta)}</div>
              <div className="text-[10px] text-neutral-500">ETA</div>
            </div>
          </div>

          <div className="mt-2 text-xs text-neutral-500 text-center">
            {Math.round(route.progress * 100)}% complete
          </div>
        </>
      )}

      {!hasRoute && !route.selecting && (
        <p className="text-xs text-neutral-500">Set start and end points to compute a route along the lane center lines.</p>
      )}
    </div>
  );
}
