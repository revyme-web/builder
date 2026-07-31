// oracle/checks/cms-dialect.ts — CMS collection-list + slug-navigation dialect.
// All code moved VERBATIM from check-file.ts (Phase 7.1 god-file split).

import * as t from '@babel/types';
import { cmsNavHrefExpr } from '@/code/generation/map-gen';
import { traverse, jsxTagName, jsxAttrs, stringAttr } from './shared';
import type { OracleViolation, FileKind } from './shared';

/** CMS COLLECTION-LIST ROW LINK — a Link/MotionLink/anchor whose `href` template
 *  literal navigates to a detail route via an item's `_slug` (e.g.
 *  `/works/${w._slug}`) MUST carry the `data-cms-nav="row"` marker. That marker
 *  is what the Link tool's "Slug" control reads back to show the "This Row" blue
 *  pill AND what makes the route resolve as a bound slug. Without it the link is
 *  a raw href — no pill, and it won't round-trip in the panel. The generator
 *  (cmsNavHrefExpr) always emits the marker + the SAFE `${item?._slug ?? ''}`
 *  form; MCP-authored collection lists must match. */
function checkCmsRowNavMarker(code: string, ast: t.File, v: OracleViolation[]): void {
  const offenders: Array<{ tag: string; line?: number; id?: string }> = [];
  traverse(ast, {
    JSXElement(path) {
      const opening = path.node.openingElement;
      const tag = jsxTagName(opening.name);
      if (tag !== 'Link' && tag !== 'MotionLink' && tag !== 'a' && tag !== 'motion.a') return;
      const attrs = jsxAttrs(opening);
      const hrefAttr = attrs.find((a) => a.name.name === 'href');
      if (!hrefAttr || !t.isJSXExpressionContainer(hrefAttr.value)) return;
      const expr = hrefAttr.value.expression;
      if (!t.isTemplateLiteral(expr)) return;
      const src = code.slice(expr.start ?? 0, expr.end ?? 0);
      if (!/\._slug\b/.test(src)) return;                              // not an item-slug route
      if (attrs.some((a) => a.name.name === 'data-cms-nav')) return;  // already marked → ok
      offenders.push({ tag, line: opening.loc?.start.line, id: stringAttr(attrs, 'data-id') });
    },
  });
  for (const o of offenders) {
    v.push({
      code: 'CMS_NAV_LINK_MISSING_MARKER', tier: 2, line: o.line, elementId: o.id,
      message: `<${o.tag}>${o.id ? ` (data-id="${o.id}")` : ''} navigates to a detail route via an item's _slug but is MISSING the data-cms-nav marker. A row link inside a collection .map() MUST have data-cms-nav="row" — that is what the Link tool binds as the "This Row" slug variable (the blue pill) and what makes the route resolve; without it it is a raw href with no slug binding. Fix: add data-cms-nav="row" to this tag AND write the href as a template literal of "/<collection>/" plus the item's optional slug in the SAFE form item?._slug ?? '' (never plain item._slug) — matching the generator cmsNavHrefExpr.`,
    });
  }
}

// ─── CMS COLLECTION LIST dialect ─────────────────────────────────────────────
//
// Encodes the load-bearing rules of the collection-list system (the `.map()`
// repeater + Filters / Sorting / Pagination / responsive config / per-row
// visibility / cross-context paste) so an MCP/freeform submit can't commit a list
// that PARSES but crashes, renders empty, or can't be edited. Each rule's message
// TEACHES the canonical shape. The editor's tools emit all of these correctly; this
// gate catches hand/AI-authored deviations and directs to the right form.
//
// Canonical shapes (what the editor writes):
//   Plain:       {slug.filter(item => <pred>).sort((a,b) => <cmp>).slice(0, N).map((item, idx) => <Row/>)}
//   Paginated:   const [visX, setVisX] = useState(N);   {slug.slice(0, visX).map(…)}
//                {visX < slug.length && <LoadMore data-id="loadmore-X" onLoadMore={() => setVisX(c => c + N)} />}
//   Responsive:  const listCfgX = useResponsiveListConfig(BASE, VP, [bps], <variantArg>, VARIANTS);
//                {__applyListConfig(slug, listCfgX).map(…)}   + the // @responsiveList block (auto-injected)
//   Per-row/variant HIDE: inline `display: <variant> === 'v' ? 'none' : '<base>'` ternary (NOT AnimatePresence inside .map()).
//   CMS bindings: {item.field} in a TEXT NODE child; `url(${item.image})` in a backgroundImage STYLE; src={item.x} plain.
function checkCmsCollectionDialect(code: string, ast: t.File, v: OracleViolation[], kind: FileKind): void {
  const lineOf = (idx: number): number => code.slice(0, idx).split('\n').length;

  // CMS collection variable names (`import advisors from '@/cms/advisors.json'`).
  // Rules that key off a `.map()` use this to fire ONLY on a CMS-rooted repeater,
  // so a legitimate non-CMS framer-motion `.map()` (e.g. AnimatePresence around an
  // animated list) is never touched.
  const cmsVars = new Set<string>();
  for (const m of code.matchAll(/import\s+(\w+)\s+from\s+['"]@\/cms\/[^'"]+\.json['"]/g)) cmsVars.add(m[1]);
  // Is the object being `.map()`-ped a CMS collection chain? (`advisors`,
  // `advisors.filter(…).slice(…)`, or `__applyListConfig(advisors, cfg)`.)
  const isCmsMapObject = (obj: t.Node | null | undefined): boolean => {
    if (!obj || obj.start == null || obj.end == null) return false;
    const src = code.slice(obj.start, obj.end);
    if (/\b__applyListConfig\b/.test(src)) return true;
    for (const cv of cmsVars) if (new RegExp(`\\b${cv}\\b`).test(src)) return true;
    return false;
  };
  const mapObjectOf = (call: t.CallExpression): t.Node | null =>
    (t.isMemberExpression(call.callee) && t.isIdentifier(call.callee.property) && call.callee.property.name === 'map')
      ? call.callee.object : null;

  // 1. Responsive interpreter block missing. `__applyListConfig(` is the upgraded
  //    (per-viewport/variant) form; it's meaningless without its definition.
  const applyIdx = code.search(/\b__applyListConfig\s*\(/);
  if (applyIdx !== -1 && !/function\s+__applyListConfig\s*\(/.test(code)) {
    v.push({
      code: 'CMS_RESPONSIVE_BLOCK_MISSING', tier: 3, line: lineOf(applyIdx),
      message: `This list calls __applyListConfig(slug, listCfg…) but the @responsiveList interpreter block is missing — __applyListConfig is undefined, so the page crashes. That block (functions useResponsiveListConfig / __applyListConfig / __matchListFilter / __cmpListSort between "// @responsiveList-begin" and "// @responsiveList-end") is INJECTED AUTOMATICALLY by the editor the moment you add a per-viewport or per-variant Filter/Sort. Do NOT hand-write __applyListConfig: a plain list is an inline chain "{slug.filter(item => <pred>).sort((a,b) => <cmp>).slice(0, N).map((item, idx) => <Row/>)}" — only the editor's responsive feature emits the __applyListConfig form, and it always ships the block with it.`,
    });
  }

  // 2. Responsive listCfg const undeclared — `__applyListConfig(slug, <cfgVar>)`
  //    without `const <cfgVar> = useResponsiveListConfig(...)` → ReferenceError.
  //    (Skip the interpreter block's own `function __applyListConfig(arr, cfg)`
  //    definition — that's the declaration, not a call.)
  for (const m of code.matchAll(/__applyListConfig\s*\(\s*[\w$]+\s*,\s*([\w$]+)\s*\)/g)) {
    const before = code.slice(Math.max(0, (m.index ?? 0) - 12), m.index ?? 0);
    if (/function\s+$/.test(before)) continue;
    const cfgVar = m[1];
    if (!new RegExp(`const\\s+${cfgVar}\\s*=\\s*useResponsiveListConfig\\s*\\(`).test(code)) {
      v.push({
        code: 'CMS_LISTCFG_UNDECLARED', tier: 3, line: lineOf(m.index ?? 0),
        message: `__applyListConfig(slug, ${cfgVar}) references the responsive config "${cfgVar}" but it's never declared → ReferenceError. Declare it at the TOP of the function body: const ${cfgVar} = useResponsiveListConfig(BASE_DIMS, VP_OVERRIDES, [breakpoints], <variantArg>, VARIANT_OVERRIDES); — <variantArg> is "initialVariant" inside a design component, or "undefined" on a page (a page has no variants). The editor writes this whenever you set a per-viewport/variant Filter or Sort.`,
      });
    }
  }

  // 3. Pagination visibleCount undeclared — `.slice(0, visX)` / `visX < …` without
  //    `const [visX, setVisX] = useState(N)` → ReferenceError.
  const seenVis = new Set<string>();
  for (const m of code.matchAll(/\.slice\(\s*0\s*,\s*(vis[\w$]+)\s*\)/g)) {
    const visVar = m[1];
    if (seenVis.has(visVar)) continue;
    seenVis.add(visVar);
    if (!new RegExp(`const\\s*\\[\\s*${visVar}\\s*,`).test(code)) {
      const setter = 'set' + visVar.charAt(0).toUpperCase() + visVar.slice(1);
      v.push({
        code: 'CMS_PAGINATION_VAR_UNDECLARED', tier: 3, line: lineOf(m.index ?? 0),
        message: `Pagination slices by "${visVar}" but it's never declared → ReferenceError. A Load More / Infinite Scroll list needs THREE things together: (1) const [${visVar}, ${setter}] = useState(<perPage>); in the function body, (2) the chain "…slice(0, ${visVar}).map(…)", and (3) the guard {${visVar} < <slug>.length && <LoadMore data-id="loadmore-<containerId>" onLoadMore={() => ${setter}(c => c + <perPage>)} />} as the last child. The editor's Pagination control emits all three; don't add one without the others.`,
      });
    }
  }

  // 4. Component-only `initialVariant` referenced on a PAGE — the cross-context
  //    copy/paste trap. `initialVariant` is a design-component fn param; on a page
  //    it's an undefined reference → ReferenceError. AST-precise (an UNBOUND,
  //    REFERENCED identifier) so a component-instance prop `initialVariant="x"` or a
  //    `"initialVariant"` JSON key in data-responsive doesn't false-positive.
  if (kind === 'page') {
    let flagged = false;
    traverse(ast, {
      Identifier(path) {
        if (flagged || path.node.name !== 'initialVariant') return;
        if (!path.isReferencedIdentifier() || path.scope.hasBinding('initialVariant')) return;
        flagged = true;
        v.push({
          code: 'CMS_VARIANT_REF_ON_PAGE', tier: 3, line: path.node.loc?.start.line,
          message: `"initialVariant" is referenced on a PAGE (line ${path.node.loc?.start.line}) but it's a design-COMPONENT function parameter — a page has none, so this is a ReferenceError. This happens when a collection list is copied from a component onto a page; it must be DEMOTED to plain page form: replace initialVariant with "undefined" in the useResponsiveListConfig(…) 4th arg, and strip the component-only props "variants={…}", "layout={true}", and "initial={['default', …]}" / "animate={['default', …]}" from the rows. A page list keeps only base + per-viewport responsive (no per-variant axis).`,
        });
        path.stop();
      },
    });
  }

  // 5. CMS `.map(() => null)` — the row template was detached, leaving an empty
  //    repeater that renders NOTHING (parses + doesn't crash, so the crash check
  //    misses it). Scoped to CMS-rooted maps so a non-CMS `.map(() => null)` isn't
  //    given a collection-specific message.
  // 6. Per-row/variant HIDE via <AnimatePresence> INSIDE a CMS .map() — broken (you
  //    can't conditionally unmount one repeated row that way; the editor writes an
  //    inline display ternary on the row instead). Scoped to CMS maps so a
  //    legitimate framer-motion AnimatePresence-in-map list animation isn't flagged.
  traverse(ast, {
    CallExpression(path) {
      const obj = mapObjectOf(path.node);
      if (!obj || !isCmsMapObject(obj)) return;
      const cb = path.node.arguments[0];
      if ((t.isArrowFunctionExpression(cb) || t.isFunctionExpression(cb))
          && t.isNullLiteral(cb.body)) {
        v.push({
          code: 'CMS_MAP_EMPTY_TEMPLATE', tier: 2, line: path.node.loc?.start.line,
          message: `A collection .map() callback returns null → the list renders ZERO rows (its template was removed/detached). Restore a row template element, e.g. "…map((item, idx) => <Link data-cms-nav="row" data-id="…" key={idx} style={{…}}><div data-id="…" style={{ backgroundImage: \`url(\${item.image})\` }} /><h3 data-id="…">{item.name}</h3></Link>)", or remove the empty collection list entirely.`,
        });
      }
    },
    JSXElement(path) {
      if (jsxTagName(path.node.openingElement.name) !== 'AnimatePresence') return;
      const inMap = path.findParent((p) =>
        p.isCallExpression() && isCmsMapObject(mapObjectOf(p.node)));
      if (inMap) {
        v.push({
          code: 'CMS_ROW_HIDE_ANIMATEPRESENCE', tier: 2,
          line: path.node.openingElement.loc?.start.line,
          message: `An <AnimatePresence> wraps an element INSIDE a collection .map() callback (line ${path.node.openingElement.loc?.start.line}). You can't conditionally unmount a single repeated row that way — per-row / per-variant visibility in a collection list is an inline display TERNARY on the row, NOT an AnimatePresence wrapper. Write: style={{ display: <variant|initialVariant> === 'variant-1' ? 'none' : '<base>', … }}. (The Hide control and the layers eye write exactly this for collection rows; the AnimatePresence/hiddenOnVariants path is only for normal, non-repeated elements.)`,
        });
      }
    },
  });
}

const CMS_NAV_MODES = new Set(['self', 'prev', 'next', 'row']);
const CMS_NAV_LABEL: Record<string, string> = { self: 'Current', prev: 'Previous', next: 'Next', row: 'This Row' };

/**
 * CMS SLUG NAVIGATION — the Link tool's "Slug" control (Current / Previous /
 * Next / This Row). It round-trips on a `data-cms-nav` marker paired with a
 * resolved `href` template literal: the MARKER drives the panel chip, the HREF
 * drives the actual route. They must stay in lockstep with the generator
 * (`cmsNavHrefExpr`, imported so this rule can never drift) — a marker without
 * the matching href makes the panel lie and the link break; the right href
 * without the marker is invisible to the panel (reads as an unbound literal).
 *
 * Modes: self (Current, → params.slug) · prev/next (adjacent item via
 * `<col>.findIndex((i) => i._slug === params?.slug) ∓ 1`) · row (This Row,
 * → the map iterator's `?._slug` for links inside a `.map()`).
 */
function checkCmsNavDialect(code: string, ast: t.File, v: OracleViolation[], kind: 'page' | 'component' = 'page'): void {
  const norm = (s: string) => s.replace(/\s+/g, '');
  // cms import: `import products from '@/cms/products.json'` → var + slug.
  const importMatch = code.match(/import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]@\/cms\/([A-Za-z0-9_-]+)\.json['"]/);
  // `const MotionLink = motion.create(Link)` (Link from next/link) IS a client-side
  // <Link> — the editor's own LinkTool/Make Component output (convertToMotionLinkInCode
  // emits it so the row link can carry framer-motion props). Accept it wherever a
  // bare <Link> is required.
  const hasMotionLink = /const\s+MotionLink\s*=\s*motion\.create\(\s*Link\s*\)/.test(code)
    && /import\s+Link\s+from\s+['"]next\/link['"]/.test(code);
  // authoritative collection slug — @cmsPage annotation wins, else the import.
  const cmsPageColl = code.match(/@cmsPage[\s\S]*?"collection"\s*:\s*"([A-Za-z0-9_-]+)"/);
  const authCollection = cmsPageColl?.[1] || importMatch?.[2] || '';
  // detail resolver: `const item = <colVar>.find((i) => i._slug === params?.slug)`.
  const colVarMatch = code.match(/\bconst\s+\w+\s*=\s*([A-Za-z_$][\w$]*)\.find\(\s*\(\s*[A-Za-z_$][\w$]*\s*\)\s*=>\s*[A-Za-z_$][\w$]*\._slug\s*===\s*params\?\.slug/);
  const detailColVar = colVarMatch?.[1] || importMatch?.[1] || '';
  const hasParams = /\buseParams\s*\(\s*\)/.test(code);

  const readHref = (attr: t.JSXAttribute | undefined): { expr: string; isString: boolean } | null => {
    if (!attr) return null;
    if (t.isStringLiteral(attr.value)) return { expr: attr.value.value, isString: true };
    const val = attr.value;
    if (val && val.type === 'JSXExpressionContainer'
        && typeof val.expression.start === 'number' && typeof val.expression.end === 'number') {
      return { expr: code.slice(val.expression.start, val.expression.end), isString: false };
    }
    return null;
  };
  const NAV_SIG = /\.findIndex\(\s*\([^)]*\)\s*=>\s*[A-Za-z_$][\w$]*\._slug\s*===\s*params\?\.slug\)/;

  traverse(ast, {
    JSXElement(path) {
      const opening = path.node.openingElement;
      const attrs = jsxAttrs(opening);
      const tag = jsxTagName(opening.name);
      const line = opening.loc?.start.line;
      const navMode = stringAttr(attrs, 'data-cms-nav');
      const href = readHref(attrs.find((a) => a.name.name === 'href'));
      const hrefExpr = href && !href.isString ? href.expr : null;

      // Reverse — a prev/next findIndex href MUST carry the matching marker,
      // or the panel shows it as an unbound literal and can't manage it.
      if (hrefExpr && NAV_SIG.test(hrefExpr)) {
        const dir = /\)\s*\+\s*1\s*\]/.test(hrefExpr) ? 'next'
          : /\)\s*-\s*1\s*\]/.test(hrefExpr) ? 'prev' : null;
        if (dir && navMode !== dir) {
          v.push({
            code: 'CMS_NAV_MARKER_MISSING', tier: 2, line,
            message: `[CMS nav] The href at line ${line} is a ${CMS_NAV_LABEL[dir]}-item slug navigation but ${navMode ? `is marked data-cms-nav="${navMode}"` : 'has no data-cms-nav marker'}. Add data-cms-nav="${dir}" so the Link tool's Slug control reads it back as a bound "${CMS_NAV_LABEL[dir]}" variable.`,
          });
        }
      }

      if (navMode == null) return; // not a CMS nav link

      if (!CMS_NAV_MODES.has(navMode)) {
        v.push({
          code: 'CMS_NAV_INVALID_MODE', tier: 2, line,
          message: `[CMS nav] data-cms-nav="${navMode}" at line ${line} is not a valid mode. Use "self" (Current), "prev" (Previous), "next" (Next), or "row" (This Row, inside a .map()).`,
        });
        return;
      }
      const mode = navMode as 'self' | 'prev' | 'next' | 'row';

      if (tag !== 'Link' && !(tag === 'MotionLink' && hasMotionLink)) {
        v.push({
          code: 'CMS_NAV_NOT_LINK', tier: 2, line,
          message: `[CMS nav] The data-cms-nav element at line ${line} is <${tag}>. CMS navigation must be a <Link> (import Link from 'next/link') — or <MotionLink> declared as motion.create(Link) — so routing is client-side and the Link tool recognises it.`,
        });
      }

      // COMPONENT MASTER row-link: Make Component extracts a collection-row card
      // whose nav href became a `linkHref` link-variable PROP (bare identifier);
      // the `.map()` — and the canonical per-row href — live on the PAGE at the
      // instance (`linkHref={\`/<col>/${item?._slug ?? ''}\`}`). The map-context
      // and canonical-href checks don't apply inside the master.
      if (kind === 'component' && mode === 'row' && hrefExpr && /^[A-Za-z_$][\w$]*$/.test(hrefExpr)) {
        return;
      }

      // Context — these modes need the detail-page slug param / collection var.
      if ((mode === 'self' || mode === 'prev' || mode === 'next') && !hasParams) {
        v.push({
          code: 'CMS_NAV_CONTEXT_MISSING', tier: 2, line,
          message: `[CMS nav] data-cms-nav="${mode}" resolves against the detail-page slug. Add "const params = useParams();" (import { useParams } from 'next/navigation').`,
        });
        return;
      }
      if ((mode === 'prev' || mode === 'next') && !colVarMatch) {
        v.push({
          code: 'CMS_NAV_CONTEXT_MISSING', tier: 2, line,
          message: `[CMS nav] data-cms-nav="${mode}" walks the collection array for the adjacent item, but the page has no "const item = <collection>.find((i) => i._slug === params?.slug)" line to read the collection variable from. Add the standard detail-page lookup.`,
        });
        return;
      }
      const itemVar = hrefExpr?.match(/\$\{\s*([A-Za-z_$][\w$]*)\s*\?\._slug/)?.[1] || importMatch?.[1] || 'item';
      if (mode === 'row' && !new RegExp(`\\.map\\(\\s*\\(\\s*${itemVar}\\b`).test(code)) {
        v.push({
          code: 'CMS_NAV_CONTEXT_MISSING', tier: 2, line,
          message: `[CMS nav] data-cms-nav="row" links each rendered row to its own detail page, so it must live inside a ".map((${itemVar}) => …)" over the collection. No such map iterator was found.`,
        });
        return;
      }

      // href must equal the canonical generator output for this mode.
      const expected = cmsNavHrefExpr(authCollection || 'COLLECTION', detailColVar || 'COLLECTION_VAR', mode, itemVar);
      if (!hrefExpr) {
        v.push({
          code: 'CMS_NAV_HREF_MISMATCH', tier: 2, line,
          message: `[CMS nav] data-cms-nav="${mode}" at line ${line} has ${href?.isString ? 'a static string href' : 'no href expression'} — it must resolve the slug dynamically. Expected exactly: href={${expected}}`,
        });
        return;
      }
      if (norm(hrefExpr) !== norm(expected)) {
        v.push({
          code: 'CMS_NAV_HREF_MISMATCH', tier: 2, line,
          message: `[CMS nav] the data-cms-nav="${mode}" href at line ${line} does not match the resolver the Link tool generates and reads back. Expected exactly: href={${expected}}`,
        });
      }
    },
  });
}

export { checkCmsRowNavMarker, checkCmsCollectionDialect, checkCmsNavDialect };
