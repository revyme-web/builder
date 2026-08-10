// scoped-expr.ts — Scope-gated expression helpers (LEAF module for the
// generation package). The `__mqN = useMediaQuery(...)` gate system, the
// `test ? value : base` scoped-scalar ternary builder/parser, scope↔test
// mapping, and `detectVariantVar`. Extracted from generator-motion.ts /
// generator-styles.ts so scroll-variant-gen, instance-fx-gen, text-anim-gen,
// presence and template-route-gen can share them WITHOUT importing
// generator-motion (which imports those modules back — cycles). Both
// generator-motion and generator-styles re-export these for existing callers.

import { escapeRegExp } from '@/shared/regex-utils';
import { trace } from '@/shared/debug-trace';
import { insertBeforeRenderReturn, insertAfterLastImportLine } from './generator-utils';
import type { ResolvedScope } from '@/code/animations/animation-scope';

/** Which variant variable a conditional ternary should key off: `variant`
 *  (useState, present when the component has connections) or `initialVariant`
 *  (the prop, when it has none). Using `variant` when it doesn't exist would
 *  throw at runtime. */
export function detectVariantVar(code: string): 'variant' | 'initialVariant' {
  return /\bconst\s*\[\s*variant\s*,/.test(code)
    || /animate=\{variant\}/.test(code)
    || /animate=\{\['default',\s*variant\]\}/.test(code)
    ? 'variant'
    : 'initialVariant';
}

// ─── Scope-gated SCALAR expressions (scroll-value effects: Speed, Transform range) ──
// the reference props carry responsive as a `{override}`/`{base}` ternary on the whole prop.
// Scroll-VALUE effects instead embed a gated value deep inside a hook expression
// (`v * (1 - (__mq0 ? 80 : 110) / 100)`). These helpers build/parse that inner
// `test0 ? v0 : … : base` expression, reusing the SAME useMediaQuery gates so a
// viewport drives BOTH a hover ternary and a scroll-value ternary off one const.

export type SerScope = { query: string } | { variant: string } | { locale: string; query?: string };
/** Stable string key for a scope (dedup + reset matching). */
export function scopeKey(s: SerScope): string {
  if ('locale' in s) return s.query ? `l:${s.locale}|q:${s.query}` : `l:${s.locale}`;
  return 'query' in s ? `q:${s.query}` : `v:${s.variant}`;
}

/** Build `(test0 ? v0 : test1 ? v1 : base)` for a gated scalar, ensuring each gate's
 *  useMediaQuery const. Bare `base` (no parens) when there are no overrides.
 *  Exported so instance-fx-gen reuses the SAME gating (one `__mqN` const can drive
 *  both a normal-node hover ternary and an instance-fx transform-range ternary). */
/** Ternary-precedence key for a WIDTH-scoped override. max-width chains must
 *  test the NARROWEST query first (outermost): at 375px BOTH `(max-width:
 *  768px)` and `(max-width: 375px)` match, so array-order building let the
 *  tablet branch shadow mobile — the Nav rendered its tablet variant on a
 *  phone while the canvas (per-tile resolution) was correct (user report
 *  2026-08-06). min-width is the inverse: widest first. Returns null for
 *  non-width scopes (variant/locale), which keep their authored positions. */
function scopeSpecificityKey(scope: SerScope): number | null {
  const q = (scope as unknown as { query?: string })?.query;
  if (!q) return null;
  const mx = q.match(/max-width:\s*([\d.]+)px/);
  if (mx) return parseFloat(mx[1]);
  const mn = q.match(/min-width:\s*([\d.]+)px/);
  if (mn) return -parseFloat(mn[1]); // widest min-width = most specific
  return null;
}

export function buildScopedScalarExpr(
  code: string, base: string, responsive: Array<{ scope: SerScope; value: string }>,
): { code: string; expr: string } {
  // Order width-scoped overrides most-specific-first among themselves (their
  // slots in the array), leaving non-width scopes untouched. The reversed
  // loop below makes the FIRST array entry the OUTERMOST ternary test.
  const decorated = responsive.map((ov, i) => ({ ov, i, key: scopeSpecificityKey(ov.scope) }));
  const widthSorted = decorated.filter(d => d.key != null).sort((a, b) => a.key! - b.key! || a.i - b.i);
  let w = 0;
  const ordered = decorated.map(d => (d.key != null ? widthSorted[w++].ov : d.ov));
  let expr = base;
  for (const ov of [...ordered].reverse()) {
    const t = scopeTest(code, ov.scope as ResolvedScope); code = t.code;
    if (t.test) expr = `${t.test} ? ${ov.value} : ${expr}`;
  }
  return { code, expr: responsive.length ? `(${expr})` : expr };
}

/** Inverse of buildScopedScalarExpr: peel `test ? value :` segments (value has no
 *  `?`/`:`) off the front, mapping each test back to a scope. Tail = base. */
export function parseScopedScalarExpr(
  code: string, expr: string,
): { base: string; responsive: Array<{ scope: SerScope; value: string }> } {
  let rest = expr.trim().replace(/^\((.*)\)$/s, '$1').trim();
  const responsive: Array<{ scope: SerScope; value: string }> = [];
  while (true) {
    const m = rest.match(/^(.+?)\s*\?\s*([^?:]+?)\s*:\s*([\s\S]+)$/);
    if (!m) break;
    const scope = testToScope(code, m[1].trim());
    if (scope) responsive.push({ scope, value: m[2].trim() });
    rest = m[3].trim();
  }
  return { base: rest, responsive };
}

/** The boolean TEST for a resolved scope (gate var for viewport, `variant ===`
 *  for a variant). Ensures the useMediaQuery hook + const for viewport scopes. */
export function scopeTest(code: string, scope: ResolvedScope | SerScope, variantVar?: string): { code: string; test: string | null } {
  if (!scope) return { code, test: null };
  // LOCALE scope (per-locale instance-prop values, optionally width-banded
  // for per-replica locale values): `__activeLocale === 'fr'` /
  // `__activeLocale === 'fr' && __mqN`. `__activeLocale` = one shared
  // `useLocale()` const (next-intl — the same provider t() resolves through,
  // so locale switches re-render the value live).
  if ('locale' in scope) {
    // ResolvedScope predates the locale shape — narrow through SerScope.
    const ls = scope as unknown as { locale: string; query?: string };
    code = ensureLocaleHook(code);
    if (ls.query) {
      code = ensureMediaQueryHook(code);
      const g = ensureMediaGate(code, ls.query);
      return { code: g.code, test: `__activeLocale === '${ls.locale}' && ${g.gateVar}` };
    }
    return { code, test: `__activeLocale === '${ls.locale}'` };
  }
  // The component's current-variant variable is `variant` (connections useState)
  // or `initialVariant` (the prop) — gate on the RIGHT one or the page throws
  // `variant is not defined`. detectVariantVar reads which the component uses.
  if ('variant' in scope) return { code, test: `${variantVar ?? detectVariantVar(code)} === '${scope.variant}'` };
  code = ensureMediaQueryHook(code);
  const g = ensureMediaGate(code, scope.query);
  return { code: g.code, test: g.gateVar };
}

/** Ensure `import { useLocale } from 'next-intl'` + a single
 *  `const __activeLocale = useLocale();` in the component body. */
export function ensureLocaleHook(code: string): string {
  if (!/import\s*\{[^}]*useLocale[^}]*\}\s*from\s*'next-intl'/.test(code)) {
    const intl = code.match(/import\s*\{([^}]*)\}\s*from\s*'next-intl'/);
    if (intl && intl.index !== undefined) {
      code = code.slice(0, intl.index)
        + intl[0].replace(`{${intl[1]}}`, `{ ${intl[1].trim()}, useLocale }`)
        + code.slice(intl.index + intl[0].length);
    } else {
      const firstImport = code.match(/^import[^\n]*\n/m);
      const at = firstImport && firstImport.index !== undefined ? firstImport.index : 0;
      code = code.slice(0, at) + "import { useLocale } from 'next-intl';\n" + code.slice(at);
    }
  }
  code = repairMisplacedLocaleHook(code);

  if (!code.includes('const __activeLocale')) {
    // Anchor BEFORE the component's render `return <jsx>` (RENDER_RETURN_RE) —
    // IDENTICAL to ensureMediaGate. The old "first function declaration in the
    // file" heuristic put the hook inside whichever module-scope helper came
    // first (useResponsiveText / useMediaQuery), leaving `__activeLocale`
    // undefined at the JSX reference — the same trap ensureMediaGate was fixed
    // for on 2026-07-03, which this function did not inherit. It surfaced when
    // the CMS locale heal started calling this on load: every page with an
    // injected helper above the component threw "__activeLocale is not defined"
    // (live find 2026-08-10).
    const inserted = insertBeforeRenderReturn(code, `  const __activeLocale = useLocale();`);
    if (inserted !== null) return inserted;
    // Fallback (no render return found): the EXPORTED component's body — never
    // a bare `function \w+`, which is what caused the bug above.
    const fn = code.match(/export default function\s+\w+\s*\([^)]*\)\s*\{/);
    if (fn && fn.index !== undefined) {
      const at = fn.index + fn[0].length;
      code = code.slice(0, at) + `\n  const __activeLocale = useLocale();` + code.slice(at);
    }
  }
  return code;
}

/**
 * SELF-HEAL: declare `__activeLocale` when something REFERENCES it but nothing
 * declares it.
 *
 * `__activeLocale` arrives in a file by more routes than the one that creates
 * it. Paste a localized collection list onto another page and the JSX comes
 * across — `{localizeRows(programme, __activeLocale).map(…)}` — while the hook
 * declaration and the `next-intl` import stay behind, so the new page throws
 * "__activeLocale is not defined" on first render (user report 2026-08-11).
 * Copy/paste, cross-project paste, Make Component and an AI submit can all do
 * the same thing.
 *
 * The REMOVAL side of this already existed (`sweepOrphanMediaGates` drops a
 * declaration whose only reference is itself); this is the missing half, and it
 * mirrors `healMissingFormStateDeclarations` exactly. Run from the flush heal
 * chain, so it doesn't matter HOW the reference got there.
 *
 * No-op when nothing references it, and `ensureLocaleHook` is itself idempotent
 * (import present → untouched, declaration present → untouched, declaration in
 * the wrong scope → re-anchored), so a healthy file comes back unchanged.
 */
export function healMissingLocaleHook(code: string): string {
  if (!/\b__activeLocale\b/.test(code)) return code;
  const healed = ensureLocaleHook(code);
  if (healed !== code) trace.action('scoped-expr:healed-missing-locale-hook', {});
  return healed;
}

/**
 * Move a `const __activeLocale = useLocale();` that landed in a module-scope
 * HELPER back into the component.
 *
 * Files written by the broken anchor above are ALREADY on disk, and they can't
 * self-heal: the declaration exists, so the `!code.includes(...)` guard skips
 * re-insertion, and the CMS heal returns early once a list is already wrapped.
 * The page throws `__activeLocale is not defined` on every render until this
 * runs. Strip the misplaced declaration and let the caller re-anchor it.
 *
 * A declaration ABOVE `export default function` is outside the component by
 * definition — that's the precise test, and it's a no-op for every correctly
 * placed file (identity-preserving, so callers can run it unconditionally).
 */
export function repairMisplacedLocaleHook(code: string): string {
  const declRe = /\n[ \t]*const __activeLocale = useLocale\(\);/;
  const decl = code.match(declRe);
  if (!decl || decl.index === undefined) return code;
  const comp = code.search(/export default function\s+\w+/);
  if (comp === -1 || decl.index > comp) return code;   // correctly placed
  trace.action('scoped-expr:repair-misplaced-locale-hook', { declAt: decl.index, componentAt: comp });
  return code.slice(0, decl.index) + code.slice(decl.index + decl[0].length);
}

/** Resolve a ternary TEST string back to a serializable scope (the inverse of
 *  `scopeTest`): a `__mqN` gate → its `useMediaQuery('<query>')`, a `X === 'v'` →
 *  `{ variant: v }`. Returns null for an unrecognized test (kept as base then). */
export function testToScope(code: string, test: string): SerScope | null {
  const t = test.trim();
  const mq = t.match(/^(__mq\w+)$/);
  if (mq) {
    const g = code.match(new RegExp(`const\\s+${mq[1]}\\s*=\\s*useMediaQuery\\('([^']+)'\\)`));
    return g ? { query: g[1] } : null;
  }
  // Locale scopes (see scopeTest): plain or width-banded.
  const lcq = t.match(/^__activeLocale\s*===\s*'([^']+)'\s*&&\s*(__mq\w+)$/);
  if (lcq) {
    const g = code.match(new RegExp(`const\\s+${lcq[2]}\\s*=\\s*useMediaQuery\\('([^']+)'\\)`));
    return g ? { locale: lcq[1], query: g[1] } : { locale: lcq[1] };
  }
  const lc = t.match(/^__activeLocale\s*===\s*'([^']+)'$/);
  if (lc) return { locale: lc[1] };
  const v = t.match(/===\s*'([^']+)'/);
  if (v) return { variant: v[1] };
  return null;
}

const USE_MEDIA_QUERY_HOOK = `function useMediaQuery(query: string): boolean {
  // Lazy initializer reads the REAL match on the first client render (not just
  // after a post-mount effect). Critical for framer-motion's \`initial\` (Appear),
  // which is captured ONCE at mount — a useState(false) start would make the
  // responsive branch lose to the base on every page load. (On the server there's
  // no window → false; the client corrects on mount.)
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const on = () => setMatches(mql.matches);
    mql.addEventListener('change', on);
    return () => mql.removeEventListener('change', on);
  }, [query]);
  return matches;
}

`;

/** Inject the SSR-safe useMediaQuery hook at module scope (once). syncImports
 *  adds the React useState/useEffect imports the hook uses. */
/** Extend the file's react import with any missing named hooks the injected
 *  useMediaQuery body needs (useState/useEffect). Handles both
 *  `import React, { a } from 'react'` and `import { a } from 'react'`;
 *  no-ops when the names are already there or no react import exists. */
function ensureReactHookImports(code: string, names: string[]): string {
  const m = code.match(/import\s+(React\s*,\s*)?\{([^}]*)\}\s+from\s+['"]react['"]/);
  if (m && m.index !== undefined) {
    const existing = m[2].split(',').map((s) => s.trim()).filter(Boolean);
    const missing = names.filter((n) => !existing.includes(n));
    if (missing.length === 0) return code;
    const replaced = m[0].replace(`{${m[2]}}`, `{ ${[...existing, ...missing].join(', ')} }`);
    return code.slice(0, m.index) + replaced + code.slice(m.index + m[0].length);
  }
  // `import React from 'react'` with no named braces → add them.
  const plain = code.match(/import\s+React\s+from\s+['"]react['"]/);
  if (plain && plain.index !== undefined) {
    return code.slice(0, plain.index) + `import React, { ${names.join(', ')} } from 'react'` + code.slice(plain.index + plain[0].length);
  }
  return code;
}

export function ensureMediaQueryHook(code: string): string {
  if (/function\s+useMediaQuery\b/.test(code)) {
    // Upgrade an OUTDATED hook (the old SSR-only `useState(false)` form) to the
    // lazy-init form so motion's mount-time `initial` (Appear) reads the real
    // match instead of losing to the base. Idempotent — no-op if already lazy.
    return code.replace(
      /const \[matches, setMatches\] = useState\(false\);/,
      "const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);",
    );
  }
  // Insert AFTER THE LAST IMPORT — module-scope hoisting makes placement
  // functionally irrelevant, but the old "before the first function" anchor
  // landed INSIDE the useResponsiveText marker fence when that injected helper
  // was the file's first function; the fence prune (text override reset) then
  // deleted useMediaQuery along with it while __mq gates still referenced it
  // (live find 2026-07-03: "removeTextOverride — undefined useMediaQuery").
  const afterImports = insertAfterLastImportLine(code, USE_MEDIA_QUERY_HOOK.trimEnd() + '\n');
  if (afterImports !== null) return ensureReactHookImports(afterImports, ['useState', 'useEffect']);
  const m = code.match(/export default function\s+\w+|(?:^|\n)function\s+\w+\s*\(/);
  if (!m || m.index === undefined) return code;
  const idx = m.index + (m[0].startsWith('\n') ? 1 : 0);
  // The hook body uses useState + useEffect — make sure the react import has them
  // (a page that only ever imported useRef/useLayoutEffect crashed at runtime).
  return ensureReactHookImports(code.slice(0, idx) + USE_MEDIA_QUERY_HOOK + code.slice(idx), ['useState', 'useEffect']);
}

/** Ensure a `const __mqN = useMediaQuery('<query>')` exists in the component
 *  body; reuse one for the same query. Returns the gate var name. */
export function ensureMediaGate(code: string, query: string): { code: string; gateVar: string } {
  const esc = escapeRegExp(query);
  const existing = code.match(new RegExp(`const\\s+(__mq\\w+)\\s*=\\s*useMediaQuery\\('${esc}'\\)`));
  if (existing) return { code, gateVar: existing[1] };
  // Next index = MAX existing + 1 (not count), so a numbering HOLE left by
  // sweepOrphanMediaGates can never collide with a surviving gate. Identical to
  // count for the no-hole case, so fresh generation is unaffected.
  const nums = [...code.matchAll(/const\s+__mq(\d+)\s*=\s*useMediaQuery/g)].map((m) => parseInt(m[1], 10));
  const gateVar = `__mq${nums.length ? Math.max(...nums) + 1 : 0}`;
  // Anchor BEFORE the component's render `return <jsx>` (RENDER_RETURN_RE) —
  // the gate then lands in the JSX-returning component regardless of how many
  // module-scope helper functions precede it. The old "start of the FIRST
  // function body" heuristic put the gate inside an injected helper
  // (useResponsiveText / the useMediaQuery hook itself) once one existed above
  // the component → `__mqN` undefined at the JSX reference (live find
  // 2026-07-03: replica FIT commit blocked by the validator).
  const inserted = insertBeforeRenderReturn(code, `  const ${gateVar} = useMediaQuery('${query}');`);
  if (inserted !== null) return { code: inserted, gateVar };
  // Fallback (no render return found): first function body, as before.
  const fn = code.match(/(?:export default function\s+\w+|function\s+\w+)\s*\([^)]*\)\s*\{/);
  if (!fn || fn.index === undefined) return { code, gateVar };
  const bodyStart = fn.index + fn[0].length;
  return { code: code.slice(0, bodyStart) + `\n  const ${gateVar} = useMediaQuery('${query}');` + code.slice(bodyStart), gateVar };
}

/** Remove any `const __mqN = useMediaQuery('…')` gate whose variable is no longer
 *  referenced anywhere else — an orphan left after a spec regen swapped queries (e.g.
 *  resting moving from `min-width` to capped `max-width`). Generic + feature-agnostic:
 *  a gate in use is referenced ≥1 time as a bare `__mqN` identifier (ternary/useState/
 *  deps); a declaration-only gate is provably dead. The query lives in a string literal,
 *  never matching `\b__mqN\b`, so the count is exact. Run AFTER all ensureMediaGate calls
 *  for a generation (the sweep + max+1 numbering are co-safe — holes never collide). */
export function sweepOrphanMediaGates(code: string): string {
  const decl = /\n[ \t]*const (__mq\d+) = useMediaQuery\('[^']*'\);/g;
  const dead: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = decl.exec(code))) {
    const refs = code.match(new RegExp(`\\b${m[1]}\\b`, 'g'))?.length ?? 0;
    if (refs <= 1) dead.push(m[0]); // only its own declaration → orphan
  }
  for (const line of dead) code = code.replace(line, '');
  // Locale hook: same orphan rule (declaration-only reference → remove).
  const lcRefs = code.match(/\b__activeLocale\b/g)?.length ?? 0;
  if (lcRefs === 1) {
    code = code.replace(/\n[ \t]*const __activeLocale = useLocale\(\);/, '');
  }
  return code;
}
