// ticker-config.ts — the Ticker effect's settings, shared by the parser
// (node.ticker), the generator (ticker-gen.ts), the panel and the canvas.
// Leaf module: the runtime component (`RevymeTicker` in @revyme/runtime)
// takes the same props with the same defaults.
//
// PER BREAKPOINT / PER VARIANT: `responsive` holds overrides for one scope
// each — `{ query }` (a page viewport's media band, the same string
// getActiveAnimationScope gives) or `{ variant }` (a component variant) —
// same model as the Text Effect (RevymeSplitText). An override carries only
// the fields set on that tile; direction is global (Framer has no breakpoint
// override on it either). `disabled` is the per-scope existence switch: X on
// a tablet tile turns the ticker off THERE, and a ticker added on a tablet
// tile is `disabled` on the base and on for that tile only.

export type TickerDirection = 'left' | 'right' | 'up' | 'down';

export type TickerScope = { query: string } | { variant: string };

/** The settings that can differ per breakpoint / variant. */
export type TickerValueKey = 'speed' | 'hoverSpeed' | 'draggable' | 'fade';
export const TICKER_VALUE_KEYS: readonly TickerValueKey[] = ['speed', 'hoverSpeed', 'draggable', 'fade'];

export interface TickerOverride {
  scope: TickerScope;
  speed?: number;
  hoverSpeed?: number;
  draggable?: boolean;
  fade?: number;
  /** false = on here although the base is off; true = off here. */
  disabled?: boolean;
}

export interface TickerConfig {
  /** px per second. */
  speed: number;
  /** Speed multiplier while hovered (1 = unchanged, 0 = pause). */
  hoverSpeed: number;
  /** Left/right on a row frame, up/down on a column frame (the runtime moves
   *  along the frame's own axis; this picks the sign). */
  direction: TickerDirection;
  draggable: boolean;
  /** Edge fade width in px (0 = none). */
  fade: number;
  /** Off on the base (on only where a `responsive` entry turns it on). */
  disabled?: boolean;
  responsive?: TickerOverride[];
}

export const TICKER_DEFAULTS: TickerConfig = { speed: 80, hoverSpeed: 1, direction: 'left', draggable: false, fade: 0 };

const DIRECTIONS: readonly TickerDirection[] = ['left', 'right', 'up', 'down'];

/** The ranges every value clamps to (the oracle checks literals against them). */
export const TICKER_RANGES: Record<'speed' | 'hoverSpeed' | 'fade', { min: number; max: number }> = {
  speed: { min: 0, max: 2000 },
  hoverSpeed: { min: 0, max: 4 },
  fade: { min: 0, max: 1000 },
};

const clampNum = (v: unknown, key: keyof typeof TICKER_RANGES): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(TICKER_RANGES[key].max, Math.max(TICKER_RANGES[key].min, v)) : undefined;

function normalizeScope(s: unknown): TickerScope | null {
  if (!s || typeof s !== 'object') return null;
  const o = s as Record<string, unknown>;
  if (typeof o.query === 'string' && o.query.trim()) return { query: o.query };
  if (typeof o.variant === 'string' && o.variant) return { variant: o.variant };
  return null;
}

function normalizeOverride(input: unknown): TickerOverride | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const scope = normalizeScope(o.scope);
  if (!scope) return null;
  const out: TickerOverride = { scope };
  const speed = clampNum(o.speed, 'speed');
  const hoverSpeed = clampNum(o.hoverSpeed, 'hoverSpeed');
  const fade = clampNum(o.fade, 'fade');
  if (speed !== undefined) out.speed = speed;
  if (hoverSpeed !== undefined) out.hoverSpeed = hoverSpeed;
  if (typeof o.draggable === 'boolean') out.draggable = o.draggable;
  if (fade !== undefined) out.fade = fade;
  if (typeof o.disabled === 'boolean') out.disabled = o.disabled;
  return Object.keys(out).length > 1 ? out : null;
}

/** Clamp / default a partial config into a valid one. */
export function normalizeTicker(input: Partial<TickerConfig>): TickerConfig {
  const out: TickerConfig = {
    speed: clampNum(input.speed, 'speed') ?? TICKER_DEFAULTS.speed,
    hoverSpeed: clampNum(input.hoverSpeed, 'hoverSpeed') ?? TICKER_DEFAULTS.hoverSpeed,
    direction: DIRECTIONS.includes(input.direction as TickerDirection) ? (input.direction as TickerDirection) : TICKER_DEFAULTS.direction,
    draggable: input.draggable === true,
    fade: clampNum(input.fade, 'fade') ?? TICKER_DEFAULTS.fade,
  };
  if (input.disabled === true) out.disabled = true;
  if (Array.isArray(input.responsive)) {
    // One entry per scope (the last write for a scope wins).
    const byScope = new Map<string, TickerOverride>();
    for (const r of input.responsive) {
      const n = normalizeOverride(r);
      if (n) byScope.set(tickerScopeKey(n.scope), n);
    }
    if (byScope.size) out.responsive = [...byScope.values()];
  }
  return out;
}

/** Whether the direction moves along the vertical axis. */
export function isVerticalTickerDirection(d: TickerDirection): boolean {
  return d === 'up' || d === 'down';
}

/** The canvas's fade mask for a resolved config (null = no fade) — the same
 *  gradient the runtime paints. The Renderer stamps it; the Fade slider
 *  previews it live with it. */
export function tickerCanvasMask(t: Pick<TickerConfig, 'fade' | 'direction'>): string | null {
  if (!(t.fade > 0)) return null;
  const f = `min(${t.fade}px, calc(50% - 1px))`;
  return `linear-gradient(${isVerticalTickerDirection(t.direction) ? 'to bottom' : 'to right'}, transparent, #000 ${f}, #000 calc(100% - ${f}), transparent)`;
}

// ─── Scopes ──────────────────────────────────────────────────────────────────

export function tickerScopeKey(s: TickerScope): string {
  return 'query' in s ? `q:${s.query}` : `v:${s.variant}`;
}

export function tickerScopesEqual(a: TickerScope, b: TickerScope): boolean {
  return tickerScopeKey(a) === tickerScopeKey(b);
}

/** The override stored for exactly this scope. */
export function tickerOverrideFor(config: TickerConfig, scope: TickerScope | null): TickerOverride | undefined {
  if (!scope) return undefined;
  return config.responsive?.find((r) => tickerScopesEqual(r.scope, scope));
}

function applyOverride(config: TickerConfig, ov: TickerOverride | undefined): TickerConfig {
  if (!ov) return config;
  const out: TickerConfig = { ...config };
  for (const k of TICKER_VALUE_KEYS) if (ov[k] !== undefined) (out as any)[k] = ov[k];
  if (ov.disabled !== undefined) {
    if (ov.disabled) out.disabled = true;
    else delete out.disabled;
  }
  return out;
}

/** The values that run on one scope (base ⊕ that scope's override). The
 *  result keeps `responsive`; read the value fields and `disabled`. */
export function resolveTickerForScope(config: TickerConfig, scope: TickerScope | null): TickerConfig {
  return applyOverride(config, tickerOverrideFor(config, scope));
}

/** Same, with the first override whose scope `applies` (the canvas resolves a
 *  tile by its width / variant; the runtime by matchMedia — first match wins). */
export function resolveTickerWhere(config: TickerConfig, applies: (scope: TickerScope) => boolean): TickerConfig {
  return applyOverride(config, config.responsive?.find((r) => applies(r.scope)));
}

/** Does the ticker run on this scope? */
export function tickerPresentOn(config: TickerConfig, scope: TickerScope | null): boolean {
  return !resolveTickerForScope(config, scope).disabled;
}

/** True when this scope has an override (any field) — the accent + Reset. */
export function hasTickerScope(config: TickerConfig, scope: TickerScope | null): boolean {
  return !!tickerOverrideFor(config, scope);
}

/**
 * Write a patch for a scope. scope null (the primary tile / default variant)
 * → the base, keeping every override. A scope → that scope's override gets
 * the value fields (and `disabled`); `direction` always goes to the base.
 */
export function setTickerScoped(config: TickerConfig, patch: Partial<TickerConfig>, scope: TickerScope | null): TickerConfig {
  if (!scope) return normalizeTicker({ ...config, ...patch, responsive: patch.responsive ?? config.responsive });
  const base: TickerConfig = { ...config };
  if (patch.direction) base.direction = patch.direction;
  const ov: TickerOverride = { ...(tickerOverrideFor(config, scope) ?? { scope }) };
  for (const k of TICKER_VALUE_KEYS) if (patch[k] !== undefined) (ov as any)[k] = patch[k];
  if ('disabled' in patch) ov.disabled = !!patch.disabled;
  const others = (config.responsive ?? []).filter((r) => !tickerScopesEqual(r.scope, scope));
  return normalizeTicker({ ...base, responsive: [...others, ov] });
}

/** Drop one field of a scope's override, or the whole override (Reset Override). */
export function resetTickerScope(config: TickerConfig, scope: TickerScope, key?: TickerValueKey | 'disabled'): TickerConfig {
  const next: TickerOverride[] = [];
  for (const r of config.responsive ?? []) {
    if (!tickerScopesEqual(r.scope, scope)) { next.push(r); continue; }
    if (!key) continue;
    const kept: TickerOverride = { ...r };
    delete kept[key];
    if (Object.keys(kept).length > 1) next.push(kept);
  }
  const out: TickerConfig = { ...config };
  if (next.length) out.responsive = next;
  else delete out.responsive;
  return out;
}

/** True when any override is variant-scoped — the wrapper then needs the active variant. */
export function tickerNeedsVariant(config: TickerConfig): boolean {
  return !!config.responsive?.some((r) => 'variant' in r.scope);
}

// ─── Reading the JSX ────────────────────────────────────────────────────────

/** A Babel literal node → its value (numbers, strings, booleans, `-n`). */
function literalValue(node: any): unknown {
  if (!node) return undefined;
  if (node.type === 'NumericLiteral' || node.type === 'StringLiteral' || node.type === 'BooleanLiteral') return node.value;
  if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument?.type === 'NumericLiteral') return -node.argument.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0]?.value?.cooked;
  return undefined;
}

/** A Babel ObjectExpression of literals → a plain object (nested objects too). */
function literalObject(node: any): Record<string, unknown> | undefined {
  if (node?.type !== 'ObjectExpression') return undefined;
  const out: Record<string, unknown> = {};
  for (const p of node.properties) {
    if (p.type !== 'ObjectProperty' || p.computed) continue;
    const key = p.key.type === 'Identifier' ? p.key.name : p.key.type === 'StringLiteral' ? p.key.value : null;
    if (key === null) continue;
    out[key] = p.value.type === 'ObjectExpression' ? literalObject(p.value) : literalValue(p.value);
  }
  return out;
}

/**
 * The config a `<RevymeTicker …>` opening element spells (Babel JSX attribute
 * nodes). Missing / unreadable props read as defaults — the oracle flags the
 * ones the panel can't read back.
 */
export function tickerFromJsxAttributes(attributes: any[]): TickerConfig {
  const attr = (name: string) => attributes.find((a) => a.type === 'JSXAttribute' && a.name?.name === name);
  const read = (name: string): unknown => {
    const a = attr(name);
    if (!a) return undefined;
    if (a.value == null) return true; // bare `draggable` / `disabled`
    if (a.value.type === 'StringLiteral') return a.value.value;
    return a.value.type === 'JSXExpressionContainer' ? literalValue(a.value.expression) : undefined;
  };
  const resp = attr('responsive');
  const arr = resp?.value?.type === 'JSXExpressionContainer' && resp.value.expression.type === 'ArrayExpression'
    ? resp.value.expression.elements
    : null;
  return normalizeTicker({
    speed: read('speed') as number | undefined,
    hoverSpeed: read('hoverSpeed') as number | undefined,
    direction: read('direction') as TickerDirection | undefined,
    draggable: read('draggable') === true,
    fade: read('fade') as number | undefined,
    disabled: read('disabled') === true,
    responsive: arr ? (arr.map(literalObject).filter(Boolean) as unknown as TickerOverride[]) : undefined,
  });
}
