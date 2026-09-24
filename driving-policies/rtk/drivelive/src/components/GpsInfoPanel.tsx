'use client';

import { GpsPosition } from '@/lib/types';
import { estimateAccuracyM, formatAccuracy } from '@/lib/geo';

const FIX_LABELS: Record<number, { label: string; color: string }> = {
  4: { label: 'RTK FIX', color: 'bg-green-700 text-green-300' },
  5: { label: 'RTK FLOAT', color: 'bg-yellow-800 text-yellow-300' },
  2: { label: 'DGPS', color: 'bg-orange-800 text-orange-300' },
  1: { label: 'GPS', color: 'bg-red-900 text-red-400' },
  0: { label: 'NO FIX', color: 'bg-neutral-700 text-neutral-400' },
};

// Colour the accuracy readout by how tight the fix is.
function accuracyColor(meters: number | null): string {
  if (meters === null) return 'text-neutral-500';
  if (meters <= 0.05) return 'text-green-400';   // centimetre RTK
  if (meters <= 0.5) return 'text-yellow-400';   // decimetre (float)
  if (meters <= 1.5) return 'text-orange-400';
  return 'text-red-400';                          // metre-level
}

interface Props {
  position: GpsPosition | null;
  speed: number;
  isConnected: boolean;
}

export default function GpsInfoPanel({ position, speed, isConnected }: Props) {
  const fix = FIX_LABELS[position?.fix_code ?? 0] ?? FIX_LABELS[0];
  const accuracyM = position ? estimateAccuracyM(position.fix_code, position.hdop) : null;

  return (
    <div className="w-64 rounded-xl bg-neutral-900/90 backdrop-blur-md p-4 text-sm text-neutral-200 shadow-lg border border-neutral-800">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-bold text-white">DriveLive</h2>
        <div className={`w-2.5 h-2.5 rounded-full ${isConnected ? 'bg-green-400 shadow-[0_0_6px_#4f4]' : 'bg-red-500 shadow-[0_0_6px_#f44]'}`} />
      </div>

      <div className="flex items-center justify-between mb-2">
        <span className={`px-2 py-0.5 rounded text-xs font-bold uppercase tracking-wide ${fix.color}`}>
          {fix.label}
        </span>
        <span className="text-3xl font-bold text-white tabular-nums">
          {speed.toFixed(1)} <span className="text-sm text-neutral-400 font-normal">mph</span>
        </span>
      </div>

      {position && (
        <>
          <div className="flex items-baseline justify-between mb-2">
            <span className="text-[10px] uppercase tracking-wide text-neutral-500">Accuracy</span>
            <span className={`text-xl font-bold tabular-nums ${accuracyColor(accuracyM)}`}>
              {formatAccuracy(accuracyM)}
            </span>
          </div>
          <div className="font-mono text-xs text-neutral-400 mb-2">
            {position.lat.toFixed(8)}, {position.lon.toFixed(8)}
          </div>
          <div className="grid grid-cols-3 gap-2 text-xs text-neutral-500">
            <div>
              Sats <span className="text-neutral-300 font-semibold">{position.sats}</span>
            </div>
            <div>
              HDOP <span className="text-neutral-300 font-semibold">{position.hdop.toFixed(1)}</span>
            </div>
            <div>
              Alt <span className="text-neutral-300 font-semibold">{position.alt.toFixed(0)}m</span>
            </div>
          </div>
        </>
      )}

      {!position && (
        <div className="text-neutral-500 text-xs mt-1">Waiting for GPS...</div>
      )}
    </div>
  );
}
