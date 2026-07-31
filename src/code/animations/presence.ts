// presence.ts — SHARED per-viewport PRESENCE logic (the reference 3-state: base /
// added-here / hidden-here), used by EVERY effect system (Scroll Variant,
// component instance-fx, and — as it converges — normal `motion.*` nodes).
//
// This is the single source of truth for "which viewports does this effect run
// on": previously the same logic was copy-pasted as scrollVariant*/instanceFx*
// helpers. The per-system files now hold only a THIN wrapper that says WHERE the
// PresenceState lives (a top-level `scope`/`hiddenOn` for a single-effect spec, or
// `presence[key]` for a multi-effect spec) — the semantics live here.
//
// A PresenceState is `{ scope?, hiddenOn? }`:
//   - empty/absent          → runs everywhere (base; byte-identical legacy output)
//   - scope: [vp…]          → present ONLY on those viewports (added on a replica)
//   - hiddenOn: [vp…]       → a base effect turned OFF on those viewports (deleted there)
//
// The codegen GATE for these (`buildScopedScalarExpr` in generator-motion.ts, or
// `buildPresenceBind` for a whole binding) is separate — this module is pure
// spec→spec state logic with no code generation.
import type { SerScope } from '@/code/generation/scoped-expr';

export interface PresenceState {
  scope?: SerScope[];
  hiddenOn?: SerScope[];
}

/** Two scopes name the same viewport band or variant. */
export function scopeEq(a: SerScope, b: SerScope): boolean {
  return ('query' in a && 'query' in b && a.query === b.query)
    || ('variant' in a && 'variant' in b && a.variant === b.variant);
}

/** Is the effect present on the given tile? `scope=null` = the primary/base tile. */
export function presentOn(p: PresenceState | undefined, scope: SerScope | null): boolean {
  const scoped = p?.scope ?? [];
  const hidden = p?.hiddenOn ?? [];
  if (!scope) return scoped.length === 0;                          // primary: only if base
  if (hidden.some((s) => scopeEq(s, scope))) return false;          // hidden here
  return scoped.length === 0 || scoped.some((s) => scopeEq(s, scope));
}

/** Does this tile carry a presence customization (added-here or hidden-here)? */
export function isPresenceOverride(p: PresenceState | undefined, scope: SerScope | null): boolean {
  if (!scope) return false;
  return !!p && ((p.scope ?? []).some((s) => scopeEq(s, scope)) || (p.hiddenOn ?? []).some((s) => scopeEq(s, scope)));
}

/** Adding on a replica scopes the effect to that tile only (absent on primary).
 *  scope=null (Desktop/primary) = base effect → no presence state. */
export function addPresenceScope(p: PresenceState | undefined, scope: SerScope | null): PresenceState | undefined {
  if (!scope) return p;
  return { ...(p ?? {}), scope: [scope] };
}

/** The result of a delete/reset: the next presence state, or `remove` meaning the
 *  effect itself should be dropped (a scoped-only effect lost its last tile / its base). */
export type PresenceResult = { remove: true } | { remove: false; state: PresenceState | undefined };

// Drop empty arrays so the serialized spec never carries `scope: []` / `hiddenOn: []`,
// and collapse a fully-empty state to undefined (= base).
const clean = (state: PresenceState): PresenceState | undefined => {
  const out: PresenceState = {};
  if (state.scope?.length) out.scope = state.scope;
  if (state.hiddenOn?.length) out.hiddenOn = state.hiddenOn;
  return out.scope || out.hiddenOn ? out : undefined;
};

/** Delete on a replica (the reference "remove here"): a base effect → hidden there; a
 *  scoped-only effect → drop the tile, removing the effect when it was its last. */
export function hidePresenceOn(p: PresenceState | undefined, scope: SerScope): PresenceResult {
  const scoped = p?.scope ?? [];
  if (scoped.length) {
    const left = scoped.filter((s) => !scopeEq(s, scope));
    return left.length ? { remove: false, state: clean({ ...p, scope: left }) } : { remove: true };
  }
  const hidden = [...(p?.hiddenOn ?? [])];
  if (!hidden.some((s) => scopeEq(s, scope))) hidden.push(scope);
  return { remove: false, state: clean({ ...p, hiddenOn: hidden }) };
}

// ── Responsive VALUE-override array helpers (shared by transform from/to overrides on
//    BOTH instance-fx and normal-node specs — the entry shape is the same, value type
//    differs: number vs string). Generic over the entry `E` so callers keep their types.
/** Find the override entry for `scope`, if any. */
export function findResponsive<E extends { scope: SerScope }>(arr: E[] | undefined, scope: SerScope): E | undefined {
  return (arr ?? []).find((e) => scopeEq(e.scope, scope));
}
/** Upsert `patch` into the entry for `scope` (merging onto an existing one), keeping siblings. */
export function upsertResponsive<E extends { scope: SerScope }>(arr: E[] | undefined, scope: SerScope, patch: Omit<Partial<E>, 'scope'>): E[] {
  const out = [...(arr ?? [])];
  const i = out.findIndex((e) => scopeEq(e.scope, scope));
  if (i >= 0) out[i] = { ...out[i], ...patch };
  else out.push({ scope, ...patch } as E);
  return out;
}
/** Drop the entry for `scope` (Reset Override). Returns undefined when none remain. */
export function dropResponsive<E extends { scope: SerScope }>(arr: E[] | undefined, scope: SerScope): E[] | undefined {
  const out = (arr ?? []).filter((e) => !scopeEq(e.scope, scope));
  return out.length ? out : undefined;
}

/** Reset Override on a replica: drop this tile's presence customization → back to base,
 *  or remove the effect if it was scoped-only to this tile. */
export function resetPresenceScope(p: PresenceState | undefined, scope: SerScope): PresenceResult {
  const scoped = (p?.scope ?? []).filter((s) => !scopeEq(s, scope));
  const hidden = (p?.hiddenOn ?? []).filter((s) => !scopeEq(s, scope));
  if ((p?.scope?.length ?? 0) > 0 && scoped.length === 0) return { remove: true };  // scoped-only → gone
  return { remove: false, state: clean({ scope: scoped, hiddenOn: hidden }) };
}
