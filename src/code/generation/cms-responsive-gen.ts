// cms-responsive-gen.ts — Responsive Collection List CONFIG (per-viewport + per-variant).
//
// The list config (Filters / Sorting — pagination/limit/offset stay in the chain
// tail for now) is RUNTIME JS, not CSS, so it can't use @media. We mirror the
// proven `useResponsiveText` system (text-override-gen.ts):
//   • Resolution: a per-page hook reads `window.innerWidth` (deploy / live preview)
//     and buckets it to a breakpoint (max-width: smallest vpWidth >= w wins). On the
//     CANVAS the Renderer resolves the config itself (it knows each replica's vpWidth)
//     so the hook's window path is deploy-only.
//   • Per-variant: `variant`/`initialVariant` is already in scope inside a design
//     component — passed as the resolver's `variant` arg (like per-variant CMS bindings).
//   • Sync: the `vpWidths` array (3rd arg) is re-keyed by the SAME machinery that syncs
//     useResponsiveText on breakpoint-resize / viewport add+remove.
//
// Shape (UPGRADE pattern, like CMS `data-responsive`): a list with NO overrides keeps
// today's inline chain BYTE-IDENTICAL. The first per-viewport/variant override upgrades
// it to a config-as-DATA shape — overrides are PARTIAL (override filter on mobile,
// inherit sort) so they travel as data and a tiny per-page interpreter applies them:
//
//   const listCfg<Id> = useResponsiveListConfig(BASE, VP, [bps], variant, VARIANTS);
//   {__applyListConfig(<slug>, listCfg<Id>).slice(0, visX).map((item, idx) => <Link/>)}
//
// All config objects are plain JSON (FilterGroup / SortConfig[]) → trivially
// (de)serialized. The interpreter mirrors Renderer.evalFilter EXACTLY (date-aware day
// compare + case-insensitive contains) so canvas and deploy agree.

import { trace } from '@/shared/debug-trace';
import { findMatchingParen } from '../parsing/parse-utils';
import type { FilterGroup, SortConfig } from '@/shared/types';
import {
  findJSXElementByDataId,
  findClosingTag,
  COLLECTION_MAP_CALL_RE,
  findCollectionChainHead,
  buildFilterExpression,
  buildSortKeyExpr,
} from './cms-gen';

// ─── Config model ─────────────────────────────────────────────────────────────

/** The responsive-capable config dimensions (v1: filter + sort). */
interface ListConfigDims {
  filterGroup?: FilterGroup | null;
  sort?: SortConfig[] | null;
}

/** Full responsive config for one list: a base + per-viewport + per-variant
 *  PARTIAL overrides (each merges onto base via Object.assign at resolve time). */
export interface ResponsiveListConfig {
  base: ListConfigDims;
  viewport: Record<string, ListConfigDims>;  // breakpoint width → partial
  variants: Record<string, ListConfigDims>;  // variant name → partial
}

/** True when the config has any NON-EMPTY per-viewport or per-variant override
 *  (→ upgraded shape). An empty partial (e.g. `viewport[768] = {}`) does NOT count
 *  — it would otherwise leave a useless `__applyListConfig` wrapper. No real
 *  overrides → the list stays the plain inline chain. */
export function hasResponsiveOverrides(cfg: ResponsiveListConfig): boolean {
  return Object.keys(serializeMap(cfg.viewport)).length > 0
    || Object.keys(serializeMap(cfg.variants)).length > 0;
}

/** Deterministic per-list config variable name (mirrors paginationStateVar). */
export function listConfigVar(listId: string): string {
  const s = listId.replace(/[^a-zA-Z0-9]/g, '');
  return 'listCfg' + s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── Runtime serialization (config dims → JSON object literal) ─────────────────

/** Serialize one config dim set to the runtime shape `{filter, sort}` — omitting
 *  empty dims so an all-empty partial round-trips to `{}`. JSON is a valid JS
 *  object literal, so this doubles as the emitted source. */
function serializeDims(dims: ListConfigDims): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (dims.filterGroup && dims.filterGroup.filters.length > 0) out.filter = dims.filterGroup;
  if (dims.sort && dims.sort.length > 0) out.sort = dims.sort;
  return out;
}

function serializeMap(map: Record<string, ListConfigDims>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(map)) {
    const s = serializeDims(v);
    if (Object.keys(s).length > 0) out[k] = s;
  }
  return out;
}

// ─── Per-page hook block (resolver + interpreter) ─────────────────────────────

const HOOK_BEGIN = '// @responsiveList-begin';
const HOOK_END = '// @responsiveList-end';

/** The injected-once-per-page block: the resolver hook + the config interpreter.
 *  `__matchListFilter` / `__cmpListSort` mirror Renderer.evalFilter + the sort
 *  comparator so deploy === canvas. Self-contained (no shared/versioned runtime). */
const HOOK_DEFINITION = `
function useResponsiveListConfig(base, vpOverrides, vpWidths, variant, variantOverrides) {
  const [w, setW] = useState(() => typeof window !== 'undefined' ? window.innerWidth : Infinity);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => setW(window.innerWidth);
    setW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  let cfg = Object.assign({}, base);
  const widths = (vpWidths || Object.keys(vpOverrides || {}).map(Number))
    .filter(function (n) { return typeof n === 'number' && isFinite(n) && n > 0; })
    .slice().sort(function (a, b) { return a - b; });
  let bucket = null;
  for (let i = 0; i < widths.length; i++) { if (w <= widths[i]) { bucket = widths[i]; break; } }
  if (bucket !== null && vpOverrides && vpOverrides[bucket]) cfg = Object.assign({}, cfg, vpOverrides[bucket]);
  if (variant != null && variantOverrides && variantOverrides[variant]) cfg = Object.assign({}, cfg, variantOverrides[variant]);
  return cfg;
}
function __matchListFilter(item, fg) {
  if (!fg || !fg.filters || !fg.filters.length) return true;
  const DATE = /^\\d{4}-\\d{2}-\\d{2}$/;
  const test = function (f) {
    const rhs = f.value;
    const dateCmp = (typeof rhs === 'string' && DATE.test(rhs)) || (Array.isArray(rhs) && ((typeof rhs[0] === 'string' && DATE.test(rhs[0])) || (typeof rhs[1] === 'string' && DATE.test(rhs[1]))));
    const raw = item[f.field];
    const lhs = dateCmp ? String(raw == null ? '' : raw).slice(0, 10) : raw;
    switch (f.operator) {
      case 'equals': return lhs === rhs;
      case 'not_equals': return lhs !== rhs;
      case 'contains': return (typeof lhs === 'string' && typeof rhs === 'string') ? lhs.toLowerCase().includes(rhs.toLowerCase()) : (Array.isArray(lhs) ? lhs.includes(rhs) : false);
      case 'not_contains': return (typeof lhs === 'string' && typeof rhs === 'string') ? !lhs.toLowerCase().includes(rhs.toLowerCase()) : (Array.isArray(lhs) ? !lhs.includes(rhs) : true);
      case 'gt': return dateCmp ? String(lhs) > String(rhs) : Number(lhs) > Number(rhs);
      case 'gte': return dateCmp ? String(lhs) >= String(rhs) : Number(lhs) >= Number(rhs);
      case 'lt': return dateCmp ? String(lhs) < String(rhs) : Number(lhs) < Number(rhs);
      case 'lte': return dateCmp ? String(lhs) <= String(rhs) : Number(lhs) <= Number(rhs);
      case 'between': { const lo = Array.isArray(rhs) ? rhs[0] : rhs, hi = Array.isArray(rhs) ? rhs[1] : rhs; return dateCmp ? (lhs >= String(lo) && lhs <= String(hi)) : (Number(lhs) >= Number(lo) && Number(lhs) <= Number(hi)); }
      case 'in': return Array.isArray(rhs) && rhs.includes(lhs);
      case 'not_in': return !(Array.isArray(rhs) && rhs.includes(lhs));
      case 'exists': { const p = lhs !== undefined && lhs !== null && lhs !== ''; return rhs === false ? !p : p; }
      default: return true;
    }
  };
  return fg.combinator === 'or' ? fg.filters.some(test) : fg.filters.every(test);
}
function __cmpListSort(a, b, keys) {
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i], av = a[k.field], bv = b[k.field];
    if (av > bv) return k.direction === 'desc' ? -1 : 1;
    if (av < bv) return k.direction === 'desc' ? 1 : -1;
  }
  return 0;
}
function __applyListConfig(arr, cfg) {
  let out = arr;
  if (cfg && cfg.filter) out = out.filter(function (it) { return __matchListFilter(it, cfg.filter); });
  if (cfg && cfg.sort && cfg.sort.length) out = out.slice().sort(function (a, b) { return __cmpListSort(a, b, cfg.sort); });
  return out;
}
`.trim();

const CALL_RE = /\buseResponsiveListConfig\s*\(/;
const APPLY_RE = /\b__applyListConfig\s*\(/;

/** Inject the hook block (before `export default`) if any list uses it; prune when
 *  none do. Mirrors text-override-gen.ensureHookFunction. `useState`/`useEffect`
 *  imports are managed by the mutation flush's syncImports. */
export function ensureResponsiveListHooks(code: string): string {
  const stripped = code.replace(new RegExp(`${HOOK_BEGIN}[\\s\\S]*?${HOOK_END}`), '');
  const used = APPLY_RE.test(stripped) || CALL_RE.test(stripped);
  const hasDef = code.includes(HOOK_BEGIN) || /function\s+useResponsiveListConfig\s*\(/.test(code);

  if (used && !hasDef) {
    const block = `\n${HOOK_BEGIN}\n${HOOK_DEFINITION}\n${HOOK_END}\n`;
    const exportIdx = code.search(/\nexport\s+default\b/);
    const out = exportIdx >= 0 ? code.slice(0, exportIdx) + block + code.slice(exportIdx) : code + block;
    trace.action('cms-responsive:hooks-inserted', {});
    return out;
  }
  if (!used && hasDef) {
    const out = code.replace(new RegExp(`\\n?${HOOK_BEGIN}[\\s\\S]*?${HOOK_END}\\n?`), '\n');
    trace.action('cms-responsive:hooks-pruned', {});
    return out;
  }
  return code;
}

// ─── Writer ───────────────────────────────────────────────────────────────────

export interface WriteListConfigOpts {
  /** Static limit slice (mutually exclusive with paginationVar) — kept in the chain tail. */
  limit?: number | null;
  /** Start offset — kept in the chain tail. */
  offset?: number | null;
  /** When paginated, the `.slice(0, <var>)` visibleCount identifier — kept in the tail. */
  paginationVar?: string | null;
  /** The in-scope variant discriminator identifier (e.g. `initialVariant`) inside a
   *  design component, or undefined on a plain page (→ literal `undefined`). */
  variantArg?: string;
  /** All current viewport breakpoint widths (synced like useResponsiveText's vpWidths). */
  vpWidths?: number[];
}

/** Build the pagination/limit/offset slice that rides AFTER the filter/sort (both
 *  in the inline chain and the upgraded `__applyListConfig(...)` expr). Mirrors
 *  buildChainCode's slice rules so round-trips stay stable. */
function buildSliceSuffix(opts: WriteListConfigOpts): string {
  const off = opts.offset && opts.offset > 0 ? opts.offset : 0;
  const hasLimit = opts.limit != null && opts.limit > 0;
  if (opts.paginationVar) return `.slice(0, ${opts.paginationVar})`;
  if (off > 0 && hasLimit) return `.slice(${off}, ${off + opts.limit!})`;
  if (off > 0) return `.slice(${off})`;
  if (hasLimit) return `.slice(0, ${opts.limit})`;
  return '';
}

/** Inline `.filter(...).sort(...)` for the DOWNGRADE path (no overrides → plain chain). */
function buildInlineFilterSort(base: ListConfigDims): string {
  let s = '';
  if (base.filterGroup && base.filterGroup.filters.length > 0) {
    s += `.filter(item => ${buildFilterExpression(base.filterGroup)})`;
  }
  const keys = base.sort ?? [];
  if (keys.length > 0) {
    s += `.sort((a, b) => ${keys.map(k => buildSortKeyExpr(k.field, k.direction)).join(' || ')})`;
  }
  return s;
}

/** Insert a `const`/hook line at the top of the function body that ENCLOSES the
 *  list container (page OR design-component function) — handles both `export default
 *  function Page()` and a plain `function Name()` master (with a `export default
 *  withResponsiveProps(Name)` elsewhere), and tolerates a TS param type annotation
 *  (`}: {style?: …})`) since it has no `)` inside. Picks the LAST `function …()` whose
 *  body brace precedes the element, so helper fns (incl. the @responsiveList block
 *  below the component) are never matched. Exported so cms-pagination-gen reuses it
 *  for `useState`/`useRef`/`useEffect` injection (a design component has NO `export
 *  default function`, which is why a naive `export default function` match failed).
 *  NOTE: `insertBeforeRenderReturn` (generator-utils, RENDER_RETURN_RE anchor) is the
 *  OTHER deliberate hook-injection strategy — anchored on the render `return (` rather
 *  than the enclosing function's opening brace. Intentionally separate; do not merge. */
export function insertConstIntoEnclosingFn(code: string, parentId: string, decl: string): string {
  const elStart = findJSXElementByDataId(code, parentId);
  if (elStart === -1) return code;
  const re = /function\s+\w+\s*\([^)]*\)\s*\{/g;
  let m: RegExpExecArray | null;
  let braceAt = -1;
  while ((m = re.exec(code))) {
    const b = m.index + m[0].length;
    if (b <= elStart) braceAt = b; else break;
  }
  if (braceAt === -1) return code;
  return code.slice(0, braceAt) + `\n  ${decl}` + code.slice(braceAt);
}

/** Replace OR insert the `const listCfg<Id> = useResponsiveListConfig(...)` declaration. */
function upsertConfigConst(
  code: string, parentId: string, cfgVar: string, slug: string,
  cfg: ResponsiveListConfig, opts: WriteListConfigOpts,
): string {
  // Variant discriminator (4th arg). Inside a design component it's normally the
  // `initialVariant` PROP — but once variant CONNECTIONS exist the LIVE variant
  // lives in a `const [variant, setVariant]` state that framer-motion animates on,
  // so the list must read THAT to re-filter as the component switches variants
  // (else variant-2's filter never applies during an animate preview — it keeps
  // showing variant-1's rows). connection add/remove also swaps this token on any
  // already-emitted call, so both creation orders stay correct.
  const variantTok = !opts.variantArg
    ? 'undefined'
    : (/const \[variant, setVariant\]/.test(code) ? 'variant' : opts.variantArg);
  const init = `useResponsiveListConfig(${JSON.stringify(serializeDims(cfg.base))}, `
    + `${JSON.stringify(serializeMap(cfg.viewport))}, `
    + `${JSON.stringify(opts.vpWidths ?? [])}, `
    + `${variantTok}, `
    + `${JSON.stringify(serializeMap(cfg.variants))})`;
  const decl = `const ${cfgVar} = ${init};`;
  const existing = new RegExp(`const ${cfgVar} = useResponsiveListConfig\\([\\s\\S]*?\\);`);
  if (existing.test(code)) return code.replace(existing, decl);
  return insertConstIntoEnclosingFn(code, parentId, decl);
}

/** Remove the per-list config const (downgrade / list deleted). */
function removeConfigConst(code: string, cfgVar: string): string {
  return code.replace(new RegExp(`\\n?\\s*const ${cfgVar} = useResponsiveListConfig\\([\\s\\S]*?\\);`), '');
}

/**
 * Re-emit a collection list's array expression from the responsive config MODEL.
 * UPGRADE (any per-viewport/variant override) → `__applyListConfig(slug, cfgVar)`
 * + the const + the per-page hooks. DOWNGRADE (no overrides) → today's inline
 * `slug.filter(...).sort(...)` chain (byte-identical to a never-responsive list)
 * + const/hooks pruned. Preserves the `.map(<cb> => <template>)` verbatim and the
 * pagination/limit/offset slice tail. The caller (mutation) passes the merged
 * model after applying one axis edit.
 */
export function writeResponsiveListConfigInCode(
  code: string,
  parentId: string,
  slug: string,
  cfg: ResponsiveListConfig,
  opts: WriteListConfigOpts = {},
): string {
  trace.fn('cms-responsive:write', { parentId, slug, upgraded: hasResponsiveOverrides(cfg) });

  const elStart = findJSXElementByDataId(code, parentId);
  if (elStart === -1) { trace.error('cms-responsive:write', { message: 'container not found', parentId }); return code; }
  const closing = findClosingTag(code, elStart);
  if (!closing) { trace.error('cms-responsive:write', { message: 'no closing tag', parentId }); return code; }

  const content = code.slice(closing.contentStart, closing.closeTagStart);
  const mapRe = new RegExp(COLLECTION_MAP_CALL_RE.source, 'g');
  const mapMatch = mapRe.exec(content);
  if (!mapMatch) { trace.error('cms-responsive:write', { message: 'no .map()', parentId }); return code; }
  const callbackParam = mapMatch[1];
  const mapDotIdx = mapMatch.index;
  const mapEnd = mapMatch.index + mapMatch[0].length;

  // Array-expr start: an already-upgraded list begins `__applyListConfig(`; an
  // inline list begins at the slug chain head (findCollectionChainHead returns
  // null on the upgraded shape, so detect __applyListConfig first).
  const applyIdx = content.lastIndexOf('__applyListConfig(', mapDotIdx);
  let arrayExprStart: number;
  if (applyIdx >= 0) {
    arrayExprStart = applyIdx;
  } else {
    const head = findCollectionChainHead(content, mapDotIdx);
    if (!head) { trace.error('cms-responsive:write', { message: 'no chain head', parentId }); return code; }
    arrayExprStart = head.slugStart;
  }

  const cfgVar = listConfigVar(parentId);
  const sliceSuffix = buildSliceSuffix(opts);
  const upgraded = hasResponsiveOverrides(cfg);
  const newArrayExpr = upgraded
    ? `__applyListConfig(${slug}, ${cfgVar})${sliceSuffix}`
    : `${slug}${buildInlineFilterSort(cfg.base)}${sliceSuffix}`;

  const absStart = closing.contentStart + arrayExprStart;
  const absEnd = closing.contentStart + mapEnd;
  let result = code.slice(0, absStart) + `${newArrayExpr}.map(${callbackParam} =>` + code.slice(absEnd);

  result = upgraded
    ? upsertConfigConst(result, parentId, cfgVar, slug, cfg, opts)
    : removeConfigConst(result, cfgVar);
  result = ensureResponsiveListHooks(result);

  trace.action('cms-responsive:write:done', { parentId, slug, upgraded });
  return result;
}

// ─── Breakpoint sync (resize / add / remove viewport) ─────────────────────────
// Re-key the per-viewport overrides + the `vpWidths` arg in every
// `useResponsiveListConfig(...)` CALL, mirroring syncVpWidthsArg for useResponsiveText
// and transformAllResponsiveAttrs for data-responsive. Wired into the generator-styles
// breakpoint rewriters so list configs stay in sync when a breakpoint width changes
// or a viewport is added/removed.

const RESP_CALL = 'useResponsiveListConfig(';

/** Split a call's argument list on TOP-LEVEL commas (respecting (), [], {}, strings). */
function splitTopLevelArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0, inStr: string | null = null, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { cur += c; if (c === inStr && s[i - 1] !== '\\') inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; cur += c; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; cur += c; continue; }
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim() !== '' || out.length > 0) out.push(cur);
  return out;
}

/** Walk every `useResponsiveListConfig(...)` CALL (skipping the function DEFINITION),
 *  parse its vpOverrides (arg 2) + vpWidths (arg 3), let `mutate` edit them, re-serialize. */
function transformResponsiveListCalls(
  code: string,
  mutate: (parts: { vpOverrides: Record<string, unknown>; vpWidths: number[] }) => void,
): string {
  let result = code;
  let from = 0;
  while (true) {
    const at = result.indexOf(RESP_CALL, from);
    if (at === -1) break;
    // Skip the hook declaration `function useResponsiveListConfig(`.
    if (/function\s+$/.test(result.slice(Math.max(0, at - 12), at))) { from = at + RESP_CALL.length; continue; }
    const open = at + RESP_CALL.length - 1;
    const close = findMatchingParen(result, open);
    if (close === -1) { from = at + RESP_CALL.length; continue; }
    const args = splitTopLevelArgs(result.slice(open + 1, close));
    if (args.length < 5) { from = close + 1; continue; }
    let vpOverrides: Record<string, unknown> = {};
    let vpWidths: number[] = [];
    try { vpOverrides = JSON.parse(args[1].trim()); } catch { /* leave {} */ }
    try { vpWidths = JSON.parse(args[2].trim()); } catch { /* leave [] */ }
    const parts = { vpOverrides, vpWidths };
    mutate(parts);
    args[1] = ' ' + JSON.stringify(parts.vpOverrides);
    args[2] = ' ' + JSON.stringify(parts.vpWidths);
    const newCall = RESP_CALL + args.join(',') + ')';
    result = result.slice(0, at) + newCall + result.slice(close + 1);
    from = at + newCall.length;
  }
  return result;
}

/** A breakpoint width changed (resize) — move its override + re-key vpWidths. */
export function rewriteListConfigBreakpoints(code: string, oldWidth: number, newWidth: number): string {
  if (oldWidth === newWidth) return code;
  return transformResponsiveListCalls(code, (p) => {
    const k = String(oldWidth);
    if (p.vpOverrides[k] !== undefined) { p.vpOverrides[String(newWidth)] = p.vpOverrides[k]; delete p.vpOverrides[k]; }
    p.vpWidths = p.vpWidths.map((w) => (w === oldWidth ? newWidth : w));
  });
}

/** A viewport was added — make its width selectable (new bucket inherits base). */
export function addListConfigBreakpoint(code: string, newWidth: number): string {
  return transformResponsiveListCalls(code, (p) => {
    if (!p.vpWidths.includes(newWidth)) { p.vpWidths.push(newWidth); p.vpWidths.sort((a, b) => a - b); }
  });
}

/** A viewport was removed — drop its override + width. */
export function removeListConfigBreakpoint(code: string, width: number): string {
  return transformResponsiveListCalls(code, (p) => {
    delete p.vpOverrides[String(width)];
    p.vpWidths = p.vpWidths.filter((w) => w !== width);
  });
}
