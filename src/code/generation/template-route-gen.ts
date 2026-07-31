// template-route-gen.ts — NATIVE per-page resolution of a template's variables.
//
// A template (route-group `LayoutClient.tsx`) is a design-component master; its
// variables are function params with defaults. To let each PAGE under the
// template override them, the LayoutClient resolves a route→props map at RUNTIME
// via `usePathname()` and reassigns the params. This is REAL code in the
// ProjectFS — no build transform, no comment — so it resolves identically in:
//   • the deployed Next.js site (native usePathname),
//   • the pure-React preview (next-shims.tsx shims usePathname → location.pathname),
//   • the canvas (store.ts reads the SAME map and bakes values onto the merged
//     layout nodes, since the canvas Renderer doesn't run Next.js).
//
// Generated shape inside LayoutClient.tsx:
//   import { usePathname } from 'next/navigation';
//   const __templateProps = {"/":{"content":"hhhiu","joijoijoi":"#39CB2B"}};
//   export default function LayoutClient({ children, content = "Ready to change", joijoijoi = "#1e3c1b" }) {
//     const __tp = __templateProps[usePathname()] ?? {};
//     content = __tp.content ?? content;       // ← per-route override, else the param default
//     joijoijoi = __tp.joijoijoi ?? joijoijoi;
//     return ( … {content} … backgroundColor: joijoijoi … );
//   }
// The JSX usage of `content`/`joijoijoi` is UNCHANGED — only their value is
// route-resolved. Params stay params so @propMeta + the Template-tool reader
// (parseComponentInfoFromSource) keep working.

import { trace } from '@/shared/debug-trace';
import { ensureMediaGate, ensureMediaQueryHook, sweepOrphanMediaGates } from './scoped-expr';

import { MAP_RE, parseTemplateRouteMap, getTemplateRouteValues, substituteTemplateVarAttrsForCanvas, type RouteMap } from './template-route-parse';
export { parseTemplateRouteMap, getTemplateRouteValues, substituteTemplateVarAttrsForCanvas };

// Per-viewport template variables are stored in the SAME route map with a
// `@<width>` suffix on the key: `headerVariant` is the BASE (primary/desktop)
// value, `headerVariant@768` / `headerVariant@375` are per-breakpoint overrides
// (keyed by the replica viewport width, exactly like the responsive-attrs system
// keys per breakpoint). The deploy LayoutClient resolves them per-viewport via
// the shared `__mq` media-query gates (smallest-width-first, max-width cascade),
// the SAME mechanism responsive-attrs-gen uses. Splits a key into its base name
// and override width (or null width for a base key).
const VP_KEY_RE = /^(.+)@(\d+)$/;
export function splitViewportKey(key: string): { base: string; width: number | null } {
  const m = key.match(VP_KEY_RE);
  return m ? { base: m[1], width: parseInt(m[2], 10) } : { base: key, width: null };
}
/** Build a route-map key for a variable at a viewport: base key for the primary,
 *  `name@<width>` for a replica. */
export function viewportVarKey(varName: string, vpWidth: number | null): string {
  return vpWidth == null ? varName : `${varName}@${vpWidth}`;
}

// The resolve block's first line accepts BOTH the legacy exact-lookup form and the
// dynamic-aware matcher form, so regenerating an older LayoutClient UPGRADES it in place.
// The reassignment lines match BOTH the plain form (`v = __tp.v ?? v;`) AND the
// per-viewport `__mq`-gated form (`v = (__mq1 ? __tp['v@375'] : … : undefined) ?? __tp.v ?? v;`)
// — any single line that assigns an identifier and references `__tp` — so toggling a
// variable's responsiveness regenerates the whole block in place without leaving a stale line.
const RESOLVE_BLOCK_RE = /[ \t]*const __tp = (?:__templateProps\[usePathname\(\)\] \?\? \{\}|__matchTemplateRoute\(usePathname\(\)\));(?:[ \t]*\r?\n[ \t]*[A-Za-z_$][\w$]* = [^\n]*__tp[^\n]*;)*[ \t]*\r?\n?/;

// Runtime route matcher. `usePathname()` returns the RESOLVED path (`/blog/my-post`),
// which never string-equals a DYNAMIC map key (`/blog/[slug]`) — so a plain
// `__templateProps[usePathname()]` lookup leaves dynamic detail pages on their param
// defaults (their per-page template values never apply). This tries the exact path
// first (static pages + literal preview paths), then the first dynamic key whose
// pattern matches (each `[segment]` → one non-slash path segment). Emitted verbatim
// (stable text) at module scope right after the map. NOTE: `[...catchAll]` collapses
// to a single-segment match — fine for the common one-level dynamic route.
const MATCHER_SRC =
`const __matchTemplateRoute = (__p) => {
  if (__templateProps[__p]) return __templateProps[__p];
  for (const __k in __templateProps) {
    if (__k.indexOf('[') === -1) continue;
    if (new RegExp('^' + __k.replace(/\\[[^\\]]+\\]/g, '[^/]+') + '$').test(__p)) return __templateProps[__k];
  }
  return {};
};
`;
// Parens-TOLERANT + whitespace-flexible. The emitted `(__p) =>` (MATCHER_SRC)
// gets reformatted to `__p =>` by ANY babel round-trip of the LayoutClient
// (@babel/generator drops the single-param parens). A parens-REQUIRED regex
// then fails to recognise the existing matcher, so `ensureMatcher` re-injects
// it — piling up `const __matchTemplateRoute` decls → babel "already declared"
// crash. Matching BOTH forms keeps the idempotency + self-heal correct.
const MATCHER_RE = /const __matchTemplateRoute = \(?__p\)?\s*=>\s*\{[\s\S]*?\n\};\n?/;

function ensureUsePathnameImport(code: string): string {
  if (/import\s*\{[^}]*\busePathname\b[^}]*\}\s*from\s*['"]next\/navigation['"]/.test(code)) return code;
  // Add after the next/link import if present, else after 'use client', else top.
  const nextLink = code.match(/import\s+\w+\s+from\s+['"]next\/link['"];?\n/);
  const line = `import { usePathname } from 'next/navigation';\n`;
  if (nextLink && nextLink.index !== undefined) {
    const at = nextLink.index + nextLink[0].length;
    return code.slice(0, at) + line + code.slice(at);
  }
  const uc = code.match(/^['"]use client['"];?\s*\n/m);
  if (uc && uc.index !== undefined) {
    const at = uc.index + uc[0].length;
    return code.slice(0, at) + '\n' + line + code.slice(at);
  }
  return line + code;
}

function ensureMapConst(code: string, map: RouteMap): string {
  const decl = `const __templateProps = ${JSON.stringify(map)};\n`;
  if (MAP_RE.test(code)) return code.replace(MAP_RE, decl);
  // Insert just before `export default function` (module scope).
  const exp = code.match(/\n(export default function )/);
  if (exp && exp.index !== undefined) {
    const at = exp.index + 1;
    return code.slice(0, at) + decl + code.slice(at);
  }
  return code + '\n' + decl;
}

/** Find the index just AFTER the LayoutClient function body's opening `{`.
 *  String-aware paren-balance to the params' close `)` (param defaults can hold
 *  strings with parens), then the next `{` is the body. -1 if not found. */
/** Ensure EXACTLY ONE module-scope `__matchTemplateRoute` helper, inserted right
 *  after the `__templateProps` map const.
 *  - 1 present  → leave it (no churn).
 *  - 0 present  → insert one.
 *  - 2+ present → strip ALL, insert one (SELF-HEAL a LayoutClient already
 *    corrupted by the old parens-required check, which duplicated the matcher
 *    on every template-var write after a babel reformat → "already declared").
 *  Counting via the parens-tolerant MATCHER_RE is what makes both the
 *  idempotency (don't add a 2nd) and the heal (collapse N→1) work. */
function ensureMatcher(code: string): string {
  const count = (code.match(new RegExp(MATCHER_RE.source, 'g')) || []).length;
  if (count === 1) return code;
  const stripped = count >= 2 ? code.replace(new RegExp(MATCHER_RE.source, 'g'), '') : code;
  const m = stripped.match(MAP_RE);
  if (m && m.index !== undefined) {
    const at = m.index + m[0].length;
    return stripped.slice(0, at) + MATCHER_SRC + stripped.slice(at);
  }
  return stripped;
}

function findBodyOpenIndex(code: string): number {
  const fn = code.match(/export default function\s+\w+\s*\(/);
  if (!fn || fn.index === undefined) return -1;
  let i = fn.index + fn[0].length - 1; // at the '('
  let depth = 0, inStr = '';
  for (; i < code.length; i++) {
    const ch = code[i];
    if (inStr) { if (ch === inStr) inStr = ''; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) { i++; break; } }
  }
  // i = just after params ')'. The next '{' is the body open.
  const bodyOpen = code.indexOf('{', i);
  return bodyOpen === -1 ? -1 : bodyOpen + 1;
}

/** Insert/replace the runtime resolution block (the `__tp` lookup + one
 *  reassignment per template var) at the TOP of the LayoutClient body.
 *  TOP — not before `return` — because section vars are read inside scroll
 *  `getElementById(sectionVar)` useEffects that live EARLIER in the body; a
 *  before-return reassignment would run too late (they'd read the param
 *  default). usePathname() must also be the first hook anyway. */
function ensureResolveBlock(code: string, varNames: string[], map: RouteMap): string {
  // Per-variable override widths, collected across ALL routes (one `__mq`-gated
  // reassignment line is shared by every route — `__tp` already scopes to the
  // active route, so an absent `@<width>` key for a given route falls through to
  // the base value). Sorted SMALLEST-first so the ternary checks the most
  // specific breakpoint first (mobile before tablet) — the responsive-attrs rule.
  const widthsByVar = new Map<string, number[]>();
  for (const route of Object.keys(map)) {
    for (const key of Object.keys(map[route])) {
      const { base, width } = splitViewportKey(key);
      if (width == null) continue;
      const arr = widthsByVar.get(base) ?? [];
      if (!arr.includes(width)) arr.push(width);
      widthsByVar.set(base, arr);
    }
  }

  let out = code;
  const anyResponsive = [...widthsByVar.values()].some((a) => a.length > 0);
  // The gated reassignments reference `__mqN` (and the `useMediaQuery` hook).
  // Ensure both exist BEFORE we build the lines so we know the gate var names.
  if (anyResponsive) out = ensureMediaQueryHook(out);

  const reassign: string[] = [];
  for (const v of varNames) {
    const widths = (widthsByVar.get(v) ?? []).slice().sort((a, b) => a - b);
    if (widths.length === 0) {
      reassign.push(`  ${v} = __tp.${v} ?? ${v};`);
      continue;
    }
    const parts: string[] = [];
    for (const w of widths) {
      const g = ensureMediaGate(out, `(max-width: ${w}px)`);
      out = g.code;
      parts.push(`${g.gateVar} ? __tp['${v}@${w}']`);
    }
    // `(__mq1 ? __tp['v@375'] : __mq0 ? __tp['v@768'] : undefined) ?? __tp.v ?? v`
    reassign.push(`  ${v} = (${parts.join(' : ')} : undefined) ?? __tp.${v} ?? ${v};`);
  }

  const lines = '\n' + [`  const __tp = __matchTemplateRoute(usePathname());`, ...reassign].join('\n') + '\n';

  if (RESOLVE_BLOCK_RE.test(out)) {
    out = out.replace(RESOLVE_BLOCK_RE, varNames.length ? lines.replace(/^\n/, '') : '');
  } else if (varNames.length) {
    // Fresh insert. Place the block AFTER the last `__mq` gate so the gated
    // reassignments see the declarations (gates are injected at the body top by
    // ensureMediaGate); otherwise at the body open.
    let insertAt = findBodyOpenIndex(out);
    const gates = [...out.matchAll(/\n[ \t]*const __mq\d+ = useMediaQuery\([^)]*\);/g)];
    if (gates.length > 0) {
      const last = gates[gates.length - 1];
      insertAt = (last.index ?? 0) + last[0].length;
    }
    if (insertAt !== -1) out = out.slice(0, insertAt) + lines + out.slice(insertAt);
  }
  // Drop any `__mq` gate this regeneration left unreferenced (e.g. a per-viewport
  // override was reset back to base, removing its only consumer).
  return sweepOrphanMediaGates(out);
}

/**
 * Set one template variable's value for `route` in the LayoutClient's route map
 * (empty value clears it; an empty route entry is removed), and ensure the
 * native resolution wiring (usePathname import + map const + reassignment block
 * covering all `varNames`) is present. `varNames` is the full list of BASE
 * template variables so the reassignment block stays complete.
 *
 * `varName` may be a BASE key (`headerVariant`, primary/desktop value) OR a
 * per-viewport `@<width>` key (`headerVariant@768`, replica override). The map
 * stores either verbatim; `ensureResolveBlock` derives the `__mq`-gated
 * resolution from the `@<width>` keys present across the map. Use
 * `viewportVarKey(name, vpWidth)` to build the key from the active viewport.
 */
// Numeric transition fields — framer-motion needs these as NUMBERS, not strings.
const TRANSITION_NUM_KEYS = new Set(['duration', 'delay', 'stiffness', 'damping', 'mass', 'bounce']);

/**
 * A transition variable's value arrives as a JSON OBJECT string (`{"type":"spring","stiffness":"300"}`). Stored
 * VERBATIM as a string it reaches the component as a string — framer-motion silently ignores a string transition
 * (every variant then animates with the DEFAULT). Detect an object-JSON value, parse it, and coerce the numeric
 * physics fields to real numbers, so it round-trips through the map as a real OBJECT: the runtime reassignment
 * (`v = __tp.v ?? v`) and the canvas attr-substitution (`={JSON.stringify(value)}` → `={{…}}`) both then pass an
 * OBJECT (with numeric fields) to the component. Non-object values (colors, text, numbers) stay strings.
 */
function coerceRouteValue(value: string): any {
  const t = (value ?? '').trim();
  if (t[0] !== '{') return value;
  try {
    const obj = JSON.parse(t);
    if (!obj || typeof obj !== 'object') return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = (TRANSITION_NUM_KEYS.has(k) && typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) ? Number(v) : v;
    }
    return out;
  } catch {
    return value;
  }
}

export function setTemplateRouteValueInCode(
  code: string, route: string, varName: string, value: string, varNames: string[],
): string {
  const map = parseTemplateRouteMap(code);
  if (value === '' || value == null) {
    if (map[route]) { delete map[route][varName]; if (Object.keys(map[route]).length === 0) delete map[route]; }
  } else {
    map[route] = { ...(map[route] ?? {}), [varName]: coerceRouteValue(value) };
  }
  let out = ensureUsePathnameImport(code);
  out = ensureMapConst(out, map);
  out = ensureMatcher(out);
  out = ensureResolveBlock(out, varNames, map);
  trace.action('template-route:set', { route, varName, hasValue: value !== '' && value != null });
  return out;
}

/** Resolve the EFFECTIVE value of a template variable for a viewport: the
 *  per-viewport override (`name@<width>`) if present, else the base value, else
 *  ''. `vpWidth` null = the primary/base value. Mirrors the deploy ternary's
 *  fall-through so the Template tool's input shows what the page will render. */
export function getTemplateRouteValueForViewport(
  code: string, route: string, varName: string, vpWidth: number | null,
): string {
  const entry = parseTemplateRouteMap(code)[route] ?? {};
  if (vpWidth != null) {
    const override = entry[`${varName}@${vpWidth}`];
    if (override !== undefined) return override;
  }
  return entry[varName] ?? '';
}

/** Whether a template variable has an explicit per-viewport override for
 *  `vpWidth` on this route (drives the blue "overridden" label + reset action,
 *  exactly like a responsive style override). False for the primary (no width). */
export function hasViewportOverride(
  code: string, route: string, varName: string, vpWidth: number | null,
): boolean {
  if (vpWidth == null) return false;
  const entry = parseTemplateRouteMap(code)[route] ?? {};
  return entry[`${varName}@${vpWidth}`] !== undefined;
}

/**
 * Drop a template variable from EVERY route in the `__templateProps` map (used
 * when the variable is deleted). JSON-based so it's robust to value type
 * (string/number/bool). Empties become removed routes; an empty map collapses to
 * `{}`. The variable's reassignment line in the resolve block is removed
 * separately by `deleteComponentVariableInCode`. No-op when there's no map
 * (non-template files / nothing to clean).
 */
export function removeTemplateVarFromCode(code: string, varName: string): string {
  const map = parseTemplateRouteMap(code);
  const routes = Object.keys(map);
  if (!routes.length) return code;
  let touched = false;
  for (const route of routes) {
    // Drop the base key AND every per-viewport override (`varName@<width>`) so a
    // deleted variable leaves no orphan responsive entry behind.
    for (const key of Object.keys(map[route])) {
      if (splitViewportKey(key).base === varName) {
        delete map[route][key];
        touched = true;
      }
    }
    if (Object.keys(map[route]).length === 0) delete map[route];
  }
  if (!touched) return code;
  trace.action('template-route:remove-var', { varName });
  // The deleted var's reassignment line went with `deleteComponentVariableInCode`;
  // sweep any `__mq` gate it was the last consumer of.
  return sweepOrphanMediaGates(ensureMapConst(code, map));
}
