'use client';

import { NtripStatus } from '@/lib/types';

// Must match the keys in cart_api/cartlib/ntrip.py PROVIDERS.
const PROVIDERS: { key: string; label: string }[] = [
  { key: 'pointone', label: 'Point One' },
  { key: 'rtkdata', label: 'RTKData' },
  { key: 'crtn', label: 'CRTN' },
];

interface Props {
  ntrip: NtripStatus | null;
  onSwitch: (provider: string) => void;
}

function describeNtripError(error?: string | null): string | null {
  if (!error) return null;
  const e = error.toLowerCase();
  if (e.includes('input/output error') || e.includes('write failed')) {
    return 'GPS serial write failed';
  }
  if (e.includes('timed out') || e.includes('timeout')) {
    return 'Caster timed out';
  }
  if (e.includes('401') || e.includes('unauthorized')) {
    return 'Login rejected';
  }
  if (e.includes('404') || e.includes('sourcetable')) {
    return 'Mountpoint rejected';
  }
  if (e.includes('connection refused')) {
    return 'Caster refused connection';
  }
  if (e.includes('name or service') || e.includes('temporary failure')) {
    return 'Caster DNS failed';
  }
  return error.length > 42 ? `${error.slice(0, 39)}...` : error;
}

export default function NtripToggle({ ntrip, onSwitch }: Props) {
  const active = ntrip?.provider ?? null;
  const errorDescription = describeNtripError(ntrip?.last_error);
  const statusText = ntrip
    ? (ntrip.connected ? 'live' : (errorDescription ? 'error' : 'connecting...'))
    : 'off';

  return (
    <div className="w-64 rounded-xl bg-neutral-900/90 backdrop-blur-md p-2.5 text-sm shadow-lg border border-neutral-800">
      <div className="flex items-center justify-between mb-2 px-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
          RTK Correction Source
        </span>
        <span className="flex items-center gap-1">
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              ntrip?.connected ? 'bg-green-400 shadow-[0_0_6px_#4f4]' : 'bg-red-500 shadow-[0_0_6px_#f44]'
            }`}
          />
          <span
            className={`text-[10px] ${ntrip?.connected ? 'text-green-400' : 'text-red-400'}`}
            title={ntrip?.last_error ?? undefined}
          >
            {statusText}
          </span>
        </span>
      </div>

      <div className="flex gap-1 rounded-lg bg-neutral-800 p-1">
        {PROVIDERS.map((p) => {
          const isActive = active === p.key;
          return (
            <button
              key={p.key}
              onClick={() => onSwitch(p.key)}
              disabled={!ntrip}
              className={`flex-1 px-3 py-1.5 rounded-md text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                isActive
                  ? 'bg-purple-600 text-white shadow'
                  : 'text-neutral-400 hover:bg-neutral-700 hover:text-neutral-200'
              }`}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      {errorDescription && !ntrip?.connected && (
        <div
          className="mt-2 truncate px-1 text-[11px] text-red-300"
          title={ntrip?.last_error ?? undefined}
        >
          {errorDescription}
        </div>
      )}
    </div>
  );
}
