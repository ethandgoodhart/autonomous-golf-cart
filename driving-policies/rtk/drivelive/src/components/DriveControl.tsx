'use client';

import { useEffect, useRef, useState } from 'react';
import { RouteState, FollowState } from '@/lib/types';

interface Props {
  route: RouteState;
  follow: FollowState | null;
  speedMph: number;
  isConnected: boolean;
  sendCommand: (obj: object) => boolean;
  lockRoute: boolean;
  onToggleLockRoute: (value: boolean) => void;
  // Bumped by DriveApp when a remote client asks to drive. We hold the request
  // until the purple route has actually been planned, then fire the same drive
  // command the operator's "Drive Route" button sends.
  autoStartToken: number;
}

const PHASE_COLOR: Record<string, string> = {
  init: 'text-neutral-100',
  tracking: 'text-green-400',
  done: 'text-blue-400',
  abort: 'text-red-400',
};

const DEFAULT_MAX_SPEED_MPH = 3.5;
const MAX_SPEED_MPH = 20;

export default function DriveControl({ route, follow, speedMph, isConnected, sendCommand, lockRoute, onToggleLockRoute, autoStartToken }: Props) {
  const [maxSpeedMph, setMaxSpeedMph] = useState(DEFAULT_MAX_SPEED_MPH);
  const [tuning, setTuning] = useState({
    lookahead_m: 3.0,
    steer_gain: 5.4,
    xtrack_gain: 1.5,
    heading_gain: 3.0,
    max_steer_deg: 320,
    turn_slowdown: 0.0,
  });
  const hasRoute = route.path.length >= 2;
  const driving = follow?.active ?? false;
  const actualSteer = follow?.steering_actual_deg ?? null;
  const targetSteer = follow?.steering_target_deg ?? follow?.steer_cmd ?? null;
  const steerError = actualSteer != null && targetSteer != null ? targetSteer - actualSteer : null;

  const updateTune = (key: keyof typeof tuning, value: number) => {
    const next = { ...tuning, [key]: value };
    setTuning(next);
    if (driving) sendCommand({ type: 'tune', current_speed_mph: speedMph, ...next });
  };

  const onDrive = () => {
    if (!hasRoute) return;
    // path points are {lat,lng}; the bridge maps lng->lon.
    sendCommand({ type: 'drive', path: route.path, max_speed_mph: maxSpeedMph, current_speed_mph: speedMph, ...tuning });
  };
  const onStop = () => sendCommand({ type: 'stop' });

  // Remote autostart: a companion app pushed a destination and asked to drive.
  // We hold that request until the purple route is planned (hasRoute), the cart
  // is linked, and nothing else is driving — then fire the identical drive
  // command the operator's button sends, so the cart follows the purple line.
  const handledAutoStart = useRef(0);
  useEffect(() => {
    if (!autoStartToken || autoStartToken === handledAutoStart.current) return;
    if (!hasRoute || !isConnected || driving) return; // wait for the fresh route
    handledAutoStart.current = autoStartToken;
    onDrive();
    // onDrive closes over the current route.path; deps intentionally omit it so
    // we only fire when the route/connection is actually ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStartToken, hasRoute, isConnected, driving]);

  useEffect(() => {
    if (!driving || !isConnected) return;
    sendCommand({ type: 'tune', current_speed_mph: speedMph, ...tuning });
  }, [driving, isConnected, sendCommand, speedMph, tuning]);

  // Emergency stop hotkeys: Q or Esc halt the route from anywhere on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'q' || e.key === 'Q') {
        e.preventDefault();
        sendCommand({ type: 'stop' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sendCommand]);

  return (
    <div className="absolute top-3 bottom-3 right-3 z-10 w-96 overflow-y-auto rounded-xl bg-neutral-900 p-5 text-base text-white shadow-lg border border-neutral-700">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-base font-semibold uppercase tracking-wide text-neutral-200">Drive</h3>
        <span className={`text-sm ${isConnected ? 'text-green-400' : 'text-red-400'}`}>
          {isConnected ? '● cart linked' : '○ no cart'}
        </span>
      </div>

      <label className="block text-sm text-neutral-100 mb-1">
        Max speed <span className="text-neutral-200">(top target speed)</span>{' '}
        <span className="text-neutral-200 tabular-nums">{maxSpeedMph.toFixed(1)} mph</span>
      </label>
      <input
        type="range"
        min={1}
        max={MAX_SPEED_MPH}
        step={0.5}
        value={maxSpeedMph}
        disabled={driving}
        onChange={(e) => setMaxSpeedMph(parseFloat(e.target.value))}
        className="w-full accent-purple-500 mb-3"
      />

      <div className="mb-3 rounded-lg border border-neutral-800 bg-neutral-950/60 p-2">
        <div className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-200">Steering tune</div>
        <TuneSlider label="lookahead" description="how far ahead it aims — higher = smoother & wider, lower = sharper & twitchier" suffix="m" value={tuning.lookahead_m} min={0.3} max={4} step={0.1} digits={1} onChange={(v) => updateTune('lookahead_m', v)} />
        <TuneSlider label="steer gain" description="overall steering strength — higher turns the wheel harder for the same error" value={tuning.steer_gain} min={0.5} max={8} step={0.1} digits={1} onChange={(v) => updateTune('steer_gain', v)} />
        <TuneSlider label="centering" description="how hard it pulls back when off to one side of the route line" value={tuning.xtrack_gain} min={0} max={5} step={0.1} digits={1} onChange={(v) => updateTune('xtrack_gain', v)} />
        <TuneSlider label="straighten" description="damps the heading so it stops weaving — higher = steadier, lower = lets it turn sharper" value={tuning.heading_gain} min={0} max={5} step={0.1} digits={1} onChange={(v) => updateTune('heading_gain', v)} />
        <TuneSlider label="max steer" description="hard cap on how far the wheel can turn — above ~110° it carves too tight to recover from and tends to overshoot" suffix="deg" value={tuning.max_steer_deg} min={10} max={320} step={1} digits={0} onChange={(v) => updateTune('max_steer_deg', v)} />
        <TuneSlider label="turn slow" description="how much it eases off the gas through turns — 0 = hold speed" value={tuning.turn_slowdown} min={0} max={4} step={0.1} digits={1} onChange={(v) => updateTune('turn_slowdown', v)} />
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={lockRoute}
        onClick={() => onToggleLockRoute(!lockRoute)}
        className="mb-3 flex w-full items-center justify-between rounded-lg border border-neutral-800 bg-neutral-950/60 px-3 py-2 text-left"
      >
        <span className="text-sm text-neutral-100">
          Lock route while driving{' '}
          <span className="text-neutral-300">(freeze the purple line until Stop)</span>
        </span>
        <span className={`relative ml-3 h-5 w-9 shrink-0 rounded-full transition-colors ${lockRoute ? 'bg-purple-600' : 'bg-neutral-700'}`}>
          <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${lockRoute ? 'left-[18px]' : 'left-0.5'}`} />
        </span>
      </button>

      <div className="flex flex-col gap-2 mb-3">
        <button
          onClick={onDrive}
          disabled={!hasRoute || !isConnected || driving}
          className="w-full px-3 py-3 rounded-lg text-lg font-bold bg-green-600 text-white hover:bg-green-500 disabled:bg-neutral-800 disabled:text-neutral-300 transition-colors"
        >
          {driving ? 'Driving…' : 'Drive Route'}
        </button>
        <button
          onClick={onStop}
          disabled={!isConnected}
          className="w-full px-3 py-7 rounded-lg text-3xl font-bold bg-red-600 text-white hover:bg-red-500 disabled:bg-neutral-800 disabled:text-neutral-300 transition-colors"
        >
          STOP
          <span className="block text-sm font-normal opacity-70 mt-1">or press Q / Esc</span>
        </button>
      </div>

      {!hasRoute && (
        <p className="text-sm text-neutral-200">Set a start &amp; end to enable driving.</p>
      )}

      {follow && (
        <div className="mt-1 space-y-2">
          <div className="flex justify-between">
            <span className="text-neutral-200 text-sm">phase</span>
            <span className={`font-semibold text-base ${PHASE_COLOR[follow.phase] ?? 'text-neutral-200'}`}>
              {follow.phase}{follow.armed === false ? ' (preview)' : ''}
            </span>
          </div>
          <div className="rounded-lg border border-neutral-800 bg-neutral-950/70 p-3">
            <div className="flex items-center justify-between text-sm mb-1">
              <span className="text-neutral-200">wheel angle</span>
              <span className="text-neutral-100">
                err {fmt(steerError, 1)}°
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm tabular-nums">
              <div>
                <div className="text-neutral-200">actual</div>
                <div className="text-2xl leading-6 font-bold text-white">{fmt(actualSteer, 1)}°</div>
              </div>
              <div>
                <div className="text-neutral-200">desired</div>
                <div className="text-2xl leading-6 font-bold text-purple-300">{fmt(targetSteer, 1)}°</div>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm tabular-nums">
            <Row label="gas" value={fmt(follow.gas, 3)} />
            <Row label="brake" value={fmt(follow.brake, 3)} />
            <Row label="steer°" value={fmt(follow.steer_cmd, 1)} />
            <Row label="x-track" value={follow.xtrack_m != null ? `${fmt(follow.xtrack_m, 1)}m` : '–'} />
            <Row label="to goal" value={follow.dist_to_goal_m != null ? `${fmt(follow.dist_to_goal_m, 1)}m` : '–'} />
            <Row label="max" value={follow.max_speed_mph != null ? `${fmt(follow.max_speed_mph, 1)} mph` : '–'} />
            <Row label="gps mph" value={follow.live_speed_mph != null ? `${fmt(follow.live_speed_mph, 1)} mph` : `${fmt(speedMph, 1)} mph`} />
          </div>
          {follow.reason && (
            <p className="text-sm text-neutral-100 pt-1">{follow.reason}</p>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-neutral-200">{label}</span>
      <span className="text-neutral-200">{value}</span>
    </div>
  );
}

function TuneSlider({
  label,
  description,
  suffix,
  value,
  min,
  max,
  step,
  digits,
  onChange,
}: {
  label: string;
  description: string;
  suffix?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  digits: number;
  onChange: (value: number) => void;
}) {
  const formattedValue = `${value.toFixed(digits)}${suffix ? ` ${suffix}` : ''}`;

  return (
    <label className="block py-1.5">
      <div className="flex justify-between gap-3 text-sm">
        <span className="min-w-0 text-neutral-200">
          {label} <span className="text-neutral-300">({description})</span>
        </span>
        <span className="shrink-0 text-neutral-200 tabular-nums">{formattedValue}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-purple-500"
      />
    </label>
  );
}

function fmt(n: number | null | undefined, d: number): string {
  return n == null ? '–' : n.toFixed(d);
}
