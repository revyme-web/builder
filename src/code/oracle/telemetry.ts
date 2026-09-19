// oracle/telemetry.ts — P6 (vi): publiable oracle telemetry for the 2-temps gate.
//
// The oracle now has TWO outcomes: BOUNCE (blocking — the write is refused)
// and SHADOW (non-blocking — the write lands, a soft warning is emitted).
// Before P6 only traces existed (non publiable); this module is the single
// published counter surface both outcomes record into:
//
//   recordOracleBounce()  — a write refused by the gate (agent + human sync)
//   recordOracleShadow()  — a write committed DESPITE violations (human
//                           scheduled flush, agent import-shape at flush):
//                           counter + trace.warn + ONE soft non-blocking
//                           warning (toast, never a banner — the banner is
//                           the run's, not the oracle's).
//   getOracleTelemetry()  — published snapshot { shadows, bounces, lastShadow }
//   resetOracleTelemetry()— tests.
//
// The warning goes through an injectable notifier (default: sonner toast,
// the same precedent canvas/commands.ts and paste-engine use outside
// components) so drains stay testable without UI. Never throws: telemetry
// must not break the write path it observes.

import { toast } from 'sonner';
import { trace } from '@/shared/debug-trace';

export interface OracleShadowSample {
  codes: string[];
  /** true = sync drain, false = scheduled drain. */
  sync: boolean;
  at: number;
}

export interface OracleTelemetrySnapshot {
  shadows: number;
  bounces: number;
  lastShadow: OracleShadowSample | null;
}

export type OracleShadowNotifier = (message: string) => void;

let _shadows = 0;
let _bounces = 0;
let _lastShadow: OracleShadowSample | null = null;
let _notifier: OracleShadowNotifier | null = null;

/** Override the shadow warning sink (tests). Null restores the default. */
export function setOracleShadowNotifier(fn: OracleShadowNotifier | null): void {
  _notifier = fn;
}

function defaultNotify(message: string): void {
  try {
    if (typeof window !== 'undefined') toast.warning(message, { duration: 6000 });
  } catch {
    /* headless — the counter + trace carry the signal */
  }
}

/** A write refused by the gate. Call sites keep their own bounce traces. */
export function recordOracleBounce(): void {
  _bounces += 1;
}

/** A write committed despite violations: count + warn softly, never block. */
export function recordOracleShadow(codes: string[], opts: { sync: boolean }): void {
  _shadows += 1;
  _lastShadow = { codes: [...codes], sync: opts.sync, at: Date.now() };
  trace.warn('oracle:shadow', { codes, sync: opts.sync });
  try {
    (_notifier ?? defaultNotify)(
      `Oracle (shadow, non-blocking): ${codes.join(', ')} — committed anyway; fix when convenient.`,
    );
  } catch {
    /* the sink must never break the write path */
  }
}

/** Published snapshot — what Revyme has actually measured, honestly. */
export function getOracleTelemetry(): OracleTelemetrySnapshot {
  return {
    shadows: _shadows,
    bounces: _bounces,
    lastShadow: _lastShadow ? { ..._lastShadow, codes: [..._lastShadow.codes] } : null,
  };
}

/** Tests only — reset the published counters. */
export function resetOracleTelemetry(): void {
  _shadows = 0;
  _bounces = 0;
  _lastShadow = null;
}
