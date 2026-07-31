// oracle/check-file.ts — the AI output oracle, tiers 1-3.
//
// checkFile(code) runs AI-generated code through the gate tiers and returns
// BATCHED teaching violations (all problems in one pass, so a retry costs one
// round-trip, not N). Keep the violation messages self-documenting — they ARE
// the rule catalog.
//
//   tier 1  SYNTAX   — babel parse
//   tier 2  DIALECT  — convention lint over the AST (this file's bulk)
//   tier 3  RESOLVE  — the real parser builds a non-empty node map
//   tier 4+ (runtime/visual/editability) — future
//
// Pure function — no DOM, no project FS. Safe for browser and node (headless).


import { parse } from '@babel/parser';
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { trace } from '@/shared/debug-trace';
import { isSvgTag } from '@/shared/constants';
import { parseJSXToNodes } from '@/code/parsing/parser';
import { parseComponentCursorCalls } from '@/code/parsing/cursor-parser';
import { parseCodeComponentDefaultSize } from '@/code/components/controls-parser';
import { validateGeneratedCode } from '@/code/mutation/mutation-queue';
import { traverse, TRANSPARENT_TAGS, jsxTagName, jsxAttrs, stringAttr, hasAttr, needsDataId, isAllowedTextExpression } from './checks/shared';
import type { FileKind, OracleViolation } from './checks/shared';
import { checkStyleObject, styleValueIncludes } from './checks/style-object';
import { checkVariantDialect, checkVariantTernaryPrimary } from './checks/variant-dialect';
import { checkScrollDialect } from './checks/scroll-dialect';
import { checkPageVariableTypes, checkEventVariables, checkComponentFluidWidth } from './checks/element-identity';
import { checkSlotComponentInlineChildren, checkUnresolvableTernary, checkGridNeedsTemplate, checkCanvasFillFeedback, checkPaddingNeedsLayout, checkFlexChildOrder, checkOrderIsString, checkFlexChildShrink, checkImageBackgroundFrame, checkNoLayoutParentRelativeChild, checkMediaColumnFlipRebase } from './checks/layout-rules';
import { checkCanvasConfig } from './checks/canvas-config';
import { checkOverlayDialect } from './checks/overlay-dialect';
import { checkSvgShapeDialect } from './checks/svg-shape-dialect';
import { checkMotionAppearHidden, checkMotionTransformDrift } from './checks/motion-appear';
import { checkTranslationDialect } from './checks/translation-dialect';
import { checkMediaBandDialect } from './checks/media-band-dialect';
import { checkComponentLinks, checkPageLinks } from './checks/link-rules';
import { checkCmsRowNavMarker, checkCmsCollectionDialect, checkCmsNavDialect } from './checks/cms-dialect';

// Re-exports — the oracle's public surface stays on check-file.ts (external
// importers and the test suites are unchanged by the split).
export type { FileKind, OracleViolation } from './checks/shared';
export { ensureNodeDimensions } from './checks/node-dimensions';

/** Imports that resolve in the canvas sandbox. Everything else bounces. */
// @/icons/* are builder-written (icon-set instances
// inserted from the panel) — the prime rule says builder output always passes
// (live false positive 2026-06-10: user-inserted SeYuSe icon set bounced).
const IMPORT_ALLOWLIST = [
  /^react$/, /^react-dom$/, /^framer-motion$/,
  /^next\//, /^@revyme\/runtime$/, /^@\/components\//,
  /^@\/icons\//,
  // next-intl — the localization dialect MANDATES `import { useTranslations }
  // from 'next-intl'` for every t() page (TRANSLATION_HOOK_MISSING), so the
  // import must pass or a translated page can never be resubmitted.
  /^next-intl$/,
  // Marketplace share bundles (the Copy-URL pipeline's CDN). The MCP's
  // marketplace browse tool hands the model these URLs so it can compose
  // FREE community components/vector sets straight into a design — the
  // canvas sandbox loads them natively, exactly like pasting the URL.
  /^https:\/\/assets\.revyme\.app\/(components|vectors)\/[A-Za-z0-9_-]+@[a-f0-9]+\.js$/,
  // CMS collection data — builder-written index/detail pages import it
  // (`import blogPosts from '@/cms/blog.json'`); existence is verified by the
  // gate (CMS_IMPORT_MISSING), same split as @/components.
  /^@\/cms\/[a-z0-9-]+\.json$/,
  // The generated Page-Effects controller: the editor writes `import { PageTransitions } from
  // './page-transitions'` into a route-group LayoutClient (a sibling module it also generates).
  /^\.\/page-transitions$/,
];

/** Comment blocks that are FEATURE ANNOTATIONS, not prose — always allowed.
 *  @propMeta + @pageVariables are the page-variables feature's blocks (live
 *  prime-rule find 2026-06-10: a builder-written page bounced NO_COMMENTS). */
const ANNOTATION_RE = /@name|@controls|@label|@comment|@canvas|@propMeta|@pageVariables|@cmsPage|@useResponsiveText/;

/** Internal paint/typography props that never belong on a component INSTANCE
 *  tag — the wrapper carries placement only; these either double-apply or
 *  silently do nothing (the builder's own instance writes redirect them
 *  inside the component). */
const INSTANCE_INTERNAL_STYLE_PROPS = new Set([
  'background', 'backgroundColor', 'backgroundImage', 'color',
  'fontSize', 'fontFamily', 'fontWeight', 'lineHeight', 'letterSpacing',
  'textAlign', 'textTransform', 'textShadow',
  'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'gap', 'rowGap', 'columnGap', 'flexDirection', 'justifyContent', 'alignItems',
  'border', 'borderRadius', 'boxShadow',
]);

/** True when a `<style>` element carries ONLY the EDITOR'S OWN generated CSS:
 *  - `@media (…) { … }` blocks whose every selector is `[data-id="…"]` — the
 *    exact shape `updateContainerQueryStyle` emits (typography preset tiers /
 *    replica overrides); parseContainerRules round-trips it.
 *  - TOP-LEVEL pseudo rules `[data-id="…"]::after { … }` (or ::before /
 *    :hover…) — the border-overlay (`updateBorderOverlayStyle`) and
 *    pseudo/hover codegens write these into component masters too (e.g. the
 *    SiteHeader Login pill's ::after border). They're editor-owned and
 *    round-trip, so a component carrying one must not bounce RAW_STYLE_TAG.
 *  Anything else (element selectors, classes, keyframes) stays forbidden on
 *  components. */
function isEditorMediaStyleBlock(el: t.JSXElement): boolean {
  const real = el.children.filter((c) => !(t.isJSXText(c) && c.value.trim() === ''));
  if (real.length !== 1) return false;
  const child = real[0];
  if (!t.isJSXExpressionContainer(child) || !t.isTemplateLiteral(child.expression)) return false;
  const css = child.expression.quasis.map((q) => q.value.raw).join('');
  const skipBlock = (open: number): number => {
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    return depth === 0 ? j : -1;
  };
  let i = 0;
  let sawEditorRule = false;
  while (i < css.length) {
    while (i < css.length && /\s/.test(css[i])) i++;
    if (i >= css.length) break;
    const open = css.indexOf('{', i);
    if (open === -1) return false;
    if (css.startsWith('@media', i)) {
      const j = skipBlock(open);
      if (j === -1) return false;
      // Every selector inside the @media block must be a [data-id="…"] selector.
      const inner = css.slice(open + 1, j - 1);
      const selectors = inner
        .split('{')
        .slice(0, -1)
        .map((s) => s.split('}').pop()!.trim())
        .filter(Boolean);
      if (selectors.length === 0 || selectors.some((sel) => !/^\[data-id=/.test(sel))) return false;
      sawEditorRule = true;
      i = j;
    } else {
      // Top-level rule: allowed ONLY as a data-id + pseudo selector (the
      // border-overlay / pseudo-element / hover codegen shapes).
      const sel = css.slice(i, open).trim();
      if (!/^\[data-id="[^"]+"\](?:::?[a-z-]+(?:\([^)]*\))?)+$/.test(sel)) return false;
      const j = skipBlock(open);
      if (j === -1) return false;
      sawEditorRule = true;
      i = j;
    }
  }
  return sawEditorRule;
}

export function checkFile(
  code: string,
  opts: { kind: FileKind; path?: string; existingDataIds?: Set<string> },
): OracleViolation[] {
  // A template (LayoutClient.tsx — Next.js layout semantics) is page dialect
  // plus one extra invariant: the {children} slot. Normalize to 'page' for
  // every shared check and keep the flag for the slot rules below.
  const isTemplate = opts.kind === 'template';
  const kind = isTemplate ? 'page' : opts.kind;
  // Data-ids that already existed in the PREVIOUS version of this file (passed
  // by the gate). Lets new-node-only rules (PIN_ABSOLUTE_NODE) flag only nodes
  // the model is ADDING this turn, never pre-existing builder content. Undefined
  // for direct/standalone checks → those new-node rules stay silent.
  const existingDataIds = opts.existingDataIds;
  const v: OracleViolation[] = [];

  // ── tier 1 — SYNTAX ────────────────────────────────────────────────────────
  let ast: t.File;
  try {
    ast = parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
  } catch (err) {
    const e = err as { message?: string; loc?: { line: number } };
    trace.action('oracle:syntax-fail', { message: e.message });
    return [{
      code: 'SYNTAX_ERROR',
      tier: 1,
      line: e.loc?.line,
      message: `The file does not parse: ${e.message ?? 'unknown parse error'}. Return the complete corrected file.`,
    }];
  }

  // ── tier 2 — DIALECT ───────────────────────────────────────────────────────

  // NO_COMMENTS — prose comments break the fast-path generators' string tracking
  // (they splice JSX by character position, so an unexpected comment shifts every
  // offset). That risk exists ONLY for the surfaces the generators rewrite: pages
  // and DESIGN components (data-id nodes). A CODE COMPONENT is a black box — the
  // builder never string-transforms its internals (it is edited solely through its
  // @controls panel), so it legitimately carries @label/@comment/@controls AND free
  // documentation comments. Exempt it entirely; everywhere else, parser-annotation
  // comments (ANNOTATION_RE — @propMeta/@pageVariables/@canvas/etc.) stay allowed and
  // only prose is rejected.
  const isCodeComponent = kind === 'code-component' || /@controls\s*\{/.test(code);
  if (!isCodeComponent) {
    // EDITOR-INJECTED RUNTIME HELPERS are builder output, not model prose — they
    // ship with their own documentation comments and the generators never
    // string-splice inside them (they're marker-fenced / whole-function blocks):
    //   • the @useResponsiveText fence (per-viewport text overrides)
    //   • the injected useMediaQuery hook (responsive __mq gates)
    // Without this exemption a page that ever used those features bounced EVERY
    // MCP submit with NO_COMMENTS (live find 2026-07-03).
    const exemptRanges: Array<[number, number]> = [];
    const fence = code.match(/\/\/ @useResponsiveText-begin[\s\S]*?\/\/ @useResponsiveText-end/);
    if (fence && fence.index !== undefined) exemptRanges.push([fence.index, fence.index + fence[0].length]);
    // …and the same MARKER-INDEPENDENT fallback the generator already keeps:
    // babel's `generate` drops leading comments when it regenerates the node they
    // sit on, so the `-begin` line goes missing while the FunctionDeclaration
    // stays (documented in text-override-gen's `hasDef`, added after the
    // "Identifier 'useResponsiveText' has already been declared" report). With a
    // half-fence the pair regex above matches NOTHING and every comment inside
    // the builder's own helper is flagged — a live page carried 13 (2026-07-26).
    // Exempting the declaration itself makes the check independent of whether
    // the marker survived.
    const hookFn = code.match(/function useResponsiveText\([\s\S]*?\n\}/);
    if (hookFn && hookFn.index !== undefined) exemptRanges.push([hookFn.index, hookFn.index + hookFn[0].length]);
    const mqHook = code.match(/function useMediaQuery\([\s\S]*?\n\}/);
    if (mqHook && mqHook.index !== undefined) exemptRanges.push([mqHook.index, mqHook.index + mqHook[0].length]);
    for (const c of ast.comments ?? []) {
      if (ANNOTATION_RE.test(c.value)) continue;
      const cs = c.start ?? -1;
      if (exemptRanges.some(([s, e]) => cs >= s && cs < e)) continue;
      v.push({
        code: 'NO_COMMENTS_IN_GENERATED_CODE',
        tier: 2,
        line: c.loc?.start.line,
        message: `Remove the comment at line ${c.loc?.start.line} ("${c.value.trim().slice(0, 40)}…"). Comments on a page/design component break the builder's code transforms (the generators splice JSX by position). Only feature annotations (@name, @controls, @label, @comment, @propMeta, @pageVariables, @canvas…) are allowed. (Code components are EXEMPT — they are black boxes the generators never rewrite, so document them freely.)`,
      });
    }
  }

  // CODE_COMPONENT_MISSING_DEFAULT_SIZE — every code component MUST declare its
  // canvas insert size: `/** @defaultWidth <n> */` + `/** @defaultHeight <n> */`
  // (bare numbers = px) in the JSDoc header before the imports. Code components
  // are FIXED-size on the canvas (their internals are a black box, so an `auto`
  // wrapper collapses whenever the root draws via absolute/100% children — the
  // user sees a placeholder-sized selection overlay with content overflowing
  // it). Every insert path (URL paste, library drag) seeds instances at exactly
  // this size, and the Size panel greys out `auto` for them.
  if (isCodeComponent) {
    const declaredSize = parseCodeComponentDefaultSize(code);
    if (declaredSize.width == null || declaredSize.height == null) {
      const missing = [
        ...(declaredSize.width == null ? ['@defaultWidth'] : []),
        ...(declaredSize.height == null ? ['@defaultHeight'] : []),
      ].join(' and ');
      v.push({
        code: 'CODE_COMPONENT_MISSING_DEFAULT_SIZE',
        tier: 2,
        line: 1,
        message: `Code component is missing ${missing}. Every code component must declare the px size instances are inserted at on the canvas — add JSDoc annotations before the imports, e.g. /** @defaultWidth 600 */ and /** @defaultHeight 400 */ (bare numbers = px, match the size the component is designed to look best at). Code components are fixed-size on the canvas: instances always carry explicit width/height and never auto-size.`,
      });
    }
  }

  // CMS_IMAGE_SRC_WRAP — an <img>/media `src`/`poster` takes a PLAIN URL, never
  // a CSS `url(...)` wrapper. A CMS image field stores a plain URL; ONLY a
  // `backgroundImage` style wraps it (`url(${item.image})`). A url()-wrapped
  // src (`src="url('…')"` / `src={`url(${item.image})`}`) is the broken
  // double-wrap — the image never loads. (The data side is enforced by
  // normalizeImageFieldValues in cms-ops; this catches it in hand-written JSX.)
  if (/\b(?:src|poster)=\{?\s*[`"']?\s*url\(/.test(code)) {
    v.push({
      code: 'CMS_IMAGE_SRC_WRAP', tier: 3,
      message: `A media src/poster must be a PLAIN URL, not a CSS url(...) wrapper. Bind an image field as src={item.image} (plain); only a backgroundImage STYLE wraps it as url(...). A url()-wrapped src never loads.`,
    });
  }

  // ── PAGE TRANSITIONS (View Transitions API) ────────────────────────────────
  // Revyme's Page Effects are SPA same-document transitions driven by the
  // generated `<PageTransitions>` controller (it wraps each route change in
  // `document.startViewTransition` and injects the keyframe CSS at runtime). The
  // correct way to add one is the editor: Animation → + → Page Transition, which
  // writes `app/<group>/page-effects.ts` (the PAGE_EFFECTS map), scaffolds
  // `page-transitions.tsx` + `page-effects-runtime.ts`, and wraps {children} in
  // the LayoutClient. Hand-writing the View Transition CSS / MPA opt-in is wrong.

  // PAGE_TRANSITION_MPA_FORBIDDEN — `@view-transition { navigation: auto }` is
  // the CROSS-DOCUMENT (MPA) path. Revyme sites are Next App Router SPA
  // (same-document soft nav), so that rule does nothing on deploy AND fights the
  // controller. Always use the `<PageTransitions>` controller instead.
  if (/@view-transition\b/.test(code) || /\bnavigation:\s*auto\b/.test(code)) {
    v.push({
      code: 'PAGE_TRANSITION_MPA_FORBIDDEN', tier: 2,
      message: `Remove the @view-transition { navigation: auto } rule. Revyme sites are Next App Router SPA (same-document), so the cross-document MPA path does nothing. Page transitions are added via the editor (Animation → + → Page Transition): it generates the <PageTransitions> controller (wraps {children} in LayoutClient, calls document.startViewTransition on nav) + an app/<group>/page-effects.ts data module. Configure effects there, never with @view-transition.`,
    });
  }

  // PAGE_TRANSITION_RAW_VT_CSS — hand-written `::view-transition-old/new(root)`
  // keyframes don't round-trip in the editor and won't be driven correctly. The
  // controller's buildViewTransitionCSS injects these at runtime from the
  // PAGE_EFFECTS map. (Only flag in HAND-AUTHORED files, never the generated
  // runtime helper which legitimately emits these strings.)
  if (/::view-transition-(?:old|new|group|image-pair)\(/.test(code)
      && !/@generated by Revyme — Page Effects/.test(code)) {
    v.push({
      code: 'PAGE_TRANSITION_RAW_VT_CSS', tier: 2,
      message: `Don't hand-write ::view-transition-* keyframes. Page transitions are configured in the editor (Animation → + → Page Transition) and stored in app/<group>/page-effects.ts as a PAGE_EFFECTS map ({ __default?, pages }); the generated runtime injects the CSS. Remove the raw view-transition CSS and express the effect as a PageEffect ({ preset, target, exit?, enter? }) instead.`,
    });
  }

  // PAGE_TRANSITION_NEEDS_GUARD — `document.startViewTransition(...)` must be
  // feature-detected (Chrome 116+); unsupported browsers throw. The generated
  // controller guards it. A bare call (no `startViewTransition)` truthiness
  // check anywhere) would crash older browsers — fall back to a normal nav.
  if (/\.startViewTransition\s*\(/.test(code) && !/startViewTransition\s*\)/.test(code)) {
    v.push({
      code: 'PAGE_TRANSITION_NEEDS_GUARD', tier: 3,
      message: `Guard document.startViewTransition with a feature check, e.g. \`if (!document.startViewTransition) { router.push(href); return; }\` before calling it — unsupported browsers (no View Transitions API) throw. Prefer letting the editor generate the <PageTransitions> controller, which already guards + degrades to instant navigation.`,
    });
  }

  // EXPORT_SHAPE (components + code components)
  if (kind !== 'page') {
    if (/export\s+default\s+function/.test(code)) {
      v.push({
        code: 'EXPORT_SHAPE', tier: 2,
        message: `Never use "export default function". Declare "function Name(...) { ... }" and end the file with "export default withResponsiveProps(Name);" — the builder locates the component through that exact shape.`,
      });
    } else if (!/export\s+default\s+withResponsiveProps\(\s*\w+\s*\)/.test(code)) {
      v.push({
        code: 'EXPORT_SHAPE', tier: 2,
        message: `The file must end with "export default withResponsiveProps(Name);" (imported from '@revyme/runtime'). This wrapper is required for multi-viewport rendering.`,
      });
    }
  }

  // MISSING_NAME_ANNOTATION — components carry their display name in @name;
  // without it the panel shows the random internal function name.
  if (kind === 'component' && !/\/\*\*\s*@name\s+"/.test(code)) {
    v.push({
      code: 'MISSING_NAME_ANNOTATION', tier: 2,
      message: `Missing /** @name "Display Name" */ — components carry their human name in this annotation (the function name is a random internal id). Add it above the variantConfig.`,
    });
  }

  // COMPONENT_NAME_MATCHES_FILE — the component registry keys by the EXPORTED
  // function name, not the file path. A name that differs from the basename
  // resolves instances to an EMPTY wrapper (the same bug class the CDN unlink
  // flow fixes with renameExportedComponent).
  if (kind !== 'page' && opts.path) {
    const base = opts.path.match(/^components\/([A-Za-z0-9_]+)\.tsx$/)?.[1];
    const exported = code.match(/export\s+default\s+withResponsiveProps\(\s*(\w+)\s*\)/)?.[1];
    if (base && exported && exported !== base) {
      v.push({
        code: 'COMPONENT_NAME_MATCHES_FILE', tier: 2,
        message: `The exported function is "${exported}" but the file is components/${base}.tsx — the builder's component registry keys by the exported function name, so a mismatch renders every instance as an EMPTY wrapper. Rename the function to ${base} (declaration AND the withResponsiveProps argument).`,
      });
    }
  }

  // USE_CLIENT — pages, templates and code components ship as Next.js CLIENT files;
  // without the directive the published App Router build treats them as server
  // components and every hook/motion prop crashes. Design components are
  // exempt: they are imported BY client files.
  if ((kind === 'page' || kind === 'code-component') && !/^\s*['"]use client['"]/.test(code)) {
    v.push({
      code: 'USE_CLIENT_REQUIRED', tier: 2,
      message: kind === 'code-component'
        ? `Code components must start with 'use client'; — add it as the first line.`
        : `Pages and templates must start with 'use client'; as the very first line — the published Next.js build treats the file as a server component without it and every hook/motion prop crashes.`,
    });
  }

  // Code-component-only annotations + static-canvas fallback
  if (kind === 'code-component') {
    if (!/@controls\s*\{/.test(code)) {
      v.push({
        code: 'CODE_COMPONENT_ANNOTATIONS_REQUIRED', tier: 2,
        message: `Missing /** @controls {…} */ annotation. Code components declare their editable props as a @controls JSON block (types: slider, color, text, number, toggle, select) plus /** @label "…" */.`,
      });
    }
    // CODE_COMPONENT_STATIC_FALLBACK — the editor canvas renders code components statically; an
    // unguarded rAF loop runs in every canvas replica (or paints nothing).
    if (/requestAnimationFrame\s*\(/.test(code) && !/useStaticCanvas/.test(code)) {
      v.push({
        code: 'CODE_COMPONENT_STATIC_FALLBACK', tier: 2,
        message: `This code component runs a requestAnimationFrame loop but never calls useStaticCanvas() (from '@revyme/runtime'). The editor canvas needs ONE static frame: const isStatic = useStaticCanvas(); when it is true draw a single frame and skip the loop — the live preview and published site run the full animation.`,
      });
    }
    // SLOT_CHILDREN_NOT_NEUTRALIZED — a slot component's connected canvas nodes
    // arrive with CANVAS-WORKSPACE positioning (position:absolute + the node's
    // workspace left/top). The EDITOR strips those on the canvas ghost, so the
    // component LOOKS fine while editing — but the live site renders slot
    // children verbatim: un-neutralised children position against the component
    // at their workspace coords (thousands of px away) and it publishes EMPTY
    // (live find 2026-07-30: a hand-rolled marquee rendered nothing on preview).
    // Every default slot template resets each rendered child imperatively;
    // a cloneElement pass writing position:'relative' into child styles is
    // equally safe.
    if (/"type":\s*"slot"/.test(code)) {
      const imperativeNeutralise = /\.position\s*=\s*['"]relative['"]/.test(code);
      const cloneNeutralise = /cloneElement\s*\(/.test(code) && /position:\s*['"]relative['"]/.test(code);
      if (!imperativeNeutralise && !cloneNeutralise) {
        v.push({
          code: 'SLOT_CHILDREN_NOT_NEUTRALIZED', tier: 2,
          message: `This code component declares a slot control but never neutralises the connected canvas nodes' workspace positioning. Slot children arrive with position:absolute + their canvas left/top; the editor strips these on the CANVAS ghost so it looks right while editing, but the LIVE site renders them verbatim — the children land thousands of px outside the component and it publishes empty. Reset every rendered child the way the built-in templates do (for each direct child of each rendered set: style.position = 'relative'; left/top/right/bottom = 'auto'; margin = '0'), or better, reuse the default slot components (Marquee, Carousel, LensBox, …) from the insert panel instead of hand-rolling one.`,
        });
      }
    }
    checkCanvasFillFeedback(code, ast, v);
  }

  const dataIds = new Map<string, number>(); // id → first line
  const dupIds = new Set<string>();
  // Local names imported from @/components|@/icons — these tags are
  // component INSTANCES (imports precede JSX, so the set is complete before
  // any JSXElement is visited).
  const componentLocalNames = new Set<string>();

  traverse(ast, {
    ImportDeclaration(path: NodePath<t.ImportDeclaration>) {
      const src = path.node.source.value;
      if (/^@\/(components|icons)\//.test(src)) {
        for (const spec of path.node.specifiers) {
          if (t.isImportDefaultSpecifier(spec)) componentLocalNames.add(spec.local.name);
        }
      }
      if (/gsap/i.test(src)) {
        v.push({
          code: 'GSAP_FORBIDDEN', tier: 2, line: path.node.loc?.start.line,
          message: `GSAP is not part of this builder (no runtime is loaded). Express the motion with framer-motion instead: variants/connections for states, whileHover for hover, useScroll/useTransform for scroll effects.`,
        });
        return;
      }
      if (!IMPORT_ALLOWLIST.some((re) => re.test(src))) {
        v.push({
          code: 'FORBIDDEN_IMPORT', tier: 2, line: path.node.loc?.start.line,
          message: `Cannot import "${src}" — it does not resolve in this builder. Allowed imports: react, react-dom, framer-motion, next/*, @revyme/runtime, @/components/*, @/icons/*, and marketplace share bundles (https://assets.revyme.app/components|vectors/<name>@<hash>.js — discover free ones via the marketplace browse tool). CSS imports are forbidden: all styling is inline style objects (that is what the properties panel edits).`,
        });
      }
    },

    CallExpression(path: NodePath<t.CallExpression>) {
      const callee = path.node.callee;
      if (t.isMemberExpression(callee) && t.isIdentifier(callee.object) && callee.object.name === 'gsap') {
        v.push({
          code: 'GSAP_FORBIDDEN', tier: 2, line: path.node.loc?.start.line,
          message: `gsap.${t.isIdentifier(callee.property) ? callee.property.name : '*'}() — GSAP is not part of this builder (no runtime is loaded). Use framer-motion: useScroll/useTransform for scroll, whileHover/whileTap for gestures, variants for states.`,
        });
      }
    },

    JSXElement(path: NodePath<t.JSXElement>) {
      const opening = path.node.openingElement;
      const tag = jsxTagName(opening.name);
      const line = opening.loc?.start.line;

      // RAW_STYLE_TAG — components/code components never carry a FREEFORM <style>;
      // pages own one block. EXCEPTION: the editor's own responsive block — a
      // typography preset applied to a node inside a component master writes
      // `@media (max-width…) { [data-id="…"] { … !important } }` tiers into the
      // master via updateContainerQueryStyle (the Renderer carries them onto
      // instances; preview/deploy match by the master-local data-id). That exact
      // shape is fully editor-visible (parseContainerRules round-trips it), so
      // it must pass. Anything else (element selectors, classes, keyframes)
      // stays forbidden on components.
      if (tag === 'style' && kind !== 'page' && !isEditorMediaStyleBlock(path.node)) {
        v.push({
          code: 'RAW_STYLE_TAG', tier: 2, line,
          message: `<style> tags are invisible to the editor (the CSS renders but nothing can edit it). Move the styling into inline style objects on the elements; responsive differences come from viewport replicas, not media queries. (The ONLY <style> a component may carry is the editor's own responsive block: @media (max-width: …px) rules whose selectors are all [data-id="…"].)`,
        });
        return;
      }
      if (tag === 'style') {
        // page style block: the pin-unit law applies to responsive overrides too
        for (const child of path.node.children) {
          if (!t.isJSXExpressionContainer(child) || !t.isTemplateLiteral(child.expression)) continue;
          const css = child.expression.quasis.map((q) => q.value.raw).join('');
          const bad = css.match(/(right|bottom)\s*:\s*-?[\d.]+%/);
          if (bad) {
            v.push({
              code: 'PIN_PERCENT_RIGHT_BOTTOM', tier: 2, line: child.loc?.start.line,
              message: `"${bad[0]}" in the responsive style block — right/bottom only resolve in px in this builder (the Position tool's pins are px-only). Use a px value, or anchor with left/top instead.`,
            });
          }
        }
        return;
      }

      const attrs = jsxAttrs(opening);
      const dataId = stringAttr(attrs, 'data-id');

      // data-id bookkeeping
      if (dataId != null) {
        if (dataIds.has(dataId) && !dupIds.has(dataId)) {
          dupIds.add(dataId);
          v.push({
            code: 'DUP_DATA_ID', tier: 2, line, elementId: dataId,
            message: `data-id "${dataId}" is used more than once (lines ${dataIds.get(dataId)} and ${line}). Every element's data-id must be unique — it is the element's identity for selection, styling and animation.`,
          });
        } else {
          dataIds.set(dataId, line ?? 0);
        }
      } else if (needsDataId(tag, path) && kind !== 'code-component'
        && !hasAttr(attrs, 'data-glide-item') && !hasAttr(attrs, 'data-bg-video')) {
        // `<video data-bg-video>` is the Fill tool's background-video child. The
        // builder writes it and DELIBERATELY leaves the data-id off so
        // `getElementIdsAtPoint` skips it — the video must not be selectable in
        // front of the frame that owns it (Renderer.syncBgVideoChild). Flagging it
        // asks the model to break a builder invariant.
        // Glide ("Flow") wrappers (`<motion.div data-glide-item>`) are
        // editor-invisible layout-animation members — the parser treats them
        // transparent (no node), so they legitimately carry no data-id. Same
        // exemption as TRANSPARENT_TAGS, but keyed on the attribute.
        // Code components are a black box: the root passes through props['data-id'],
        // internals are edited via @controls, not canvas selection — the
        // builder's own code component templates have id-less internals (prime-rule
        // probe 2026-06-10: AuroraBackground bounced MISSING_DATA_ID ×2).
        v.push({
          code: 'MISSING_DATA_ID', tier: 2, line,
          message: `<${tag}> at line ${line} has no data-id. Every element needs a unique kebab-case data-id or it cannot be selected or edited on the canvas.`,
        });
      }

      // ── FORMS ────────────────────────────────────────────────────────────
      // Revyme forms submit through the same-origin relay: a <form> needs an
      // onSubmit that preventDefaults and POSTs to /api/form (the relay →
      // Forms Worker). Without it the submit button does a NATIVE page
      // navigation (the "clicking Send goes to a blank page" bug). Inputs need
      // a `name` or FormData silently drops the field. The relay endpoint is a
      // fixed literal here so the oracle has no cross-module dependency.
      const FORM_ENDPOINT = '/api/form';
      if (tag === 'form' || tag === 'motion.form') {
        const formId = dataId ?? 'form-id';
        const canonicalHandler =
          `onSubmit={async (e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); ` +
          `const _hp = fd.get("_hp"); fd.delete("_hp"); const fields = Object.fromEntries(fd.entries()); ` +
          `try { const res = await fetch("${FORM_ENDPOINT}", { method: "POST", headers: { "Content-Type": "application/json" }, ` +
          `body: JSON.stringify({ formId: "${formId}", fields, _hp }) }); const data = await res.json().catch(() => ({})); ` +
          `if (data && data.redirect) { window.location.href = data.redirect; return; } e.currentTarget.reset(); } catch (err) {} }}`;
        const onSubmitAttr = attrs.find((a) => a.name.name === 'onSubmit');
        if (!onSubmitAttr) {
          v.push({
            code: 'FORM_MISSING_ONSUBMIT', tier: 2, line, elementId: dataId ?? undefined,
            message: `<form> "${formId}" has no onSubmit — its submit button would do a native page navigation instead of a Revyme submit. Add the standard handler that POSTs to ${FORM_ENDPOINT}: ${canonicalHandler}`,
          });
        } else {
          const src = opening.start != null && opening.end != null ? code.slice(opening.start, opening.end) : '';
          if (!src.includes(FORM_ENDPOINT)) {
            v.push({
              code: 'FORM_WRONG_ENDPOINT', tier: 2, line, elementId: dataId ?? undefined,
              message: `<form> "${formId}" onSubmit must POST to ${FORM_ENDPOINT} (the Revyme relay → Forms Worker), not a custom URL. Use the standard handler: ${canonicalHandler}`,
            });
          }
        }
        if (!hasAttr(attrs, 'data-form')) {
          v.push({
            code: 'FORM_NO_DESTINATION', tier: 3, line, elementId: dataId ?? undefined,
            message: `<form> "${formId}" has no data-form config, so submissions have no destination. Add e.g. data-form='{"sendTo":[{"id":"d1","type":"email","recipient":"you@example.com","subject":"New submission"}]}' (or set Send To in the Form tool).`,
          });
        }
      }
      // Inputs inside a form must carry a `name` — FormData keys by name, so an
      // unnamed field is never submitted (the form collects nothing).
      if (tag === 'input' || tag === 'textarea' || tag === 'select' ||
          tag === 'motion.input' || tag === 'motion.textarea' || tag === 'motion.select') {
        const inputType = (stringAttr(attrs, 'type') || '').toLowerCase();
        const isButtonish = inputType === 'submit' || inputType === 'button' || inputType === 'reset' || inputType === 'image';
        const insideForm = !!path.findParent((p) => {
          if (!t.isJSXElement(p.node)) return false;
          const n = jsxTagName(p.node.openingElement.name);
          return n === 'form' || n === 'motion.form';
        });
        if (insideForm && !isButtonish && !hasAttr(attrs, 'name')) {
          v.push({
            code: 'FORM_INPUT_MISSING_NAME', tier: 2, line, elementId: dataId ?? undefined,
            message: `<${tag}>${dataId ? ` "${dataId}"` : ''} inside a form has no name attribute. FormData collects fields by name, so an unnamed field is never sent. Add a name (e.g. name="email").`,
          });
        }
      }

      // ATTR_ORDER_DATA_ID_FIRST — the editor's code scanners (scroll-parser
      // binding scan, generator fast paths) match `data-id … style` IN ORDER
      // within the tag. style-before-data-id renders identically but scroll
      // bindings and fast-path style edits silently stop resolving (live find
      // 2026-06-10: parallax page with style={{ x: featLeftX }} written before
      // data-id — none of the scroll transforms appeared in the panel).
      if (dataId != null) {
        const idIdx = attrs.findIndex((a) => a.name.name === 'data-id');
        const styleIdx = attrs.findIndex((a) => a.name.name === 'style');
        if (styleIdx !== -1 && styleIdx < idIdx) {
          v.push({
            code: 'ATTR_ORDER_DATA_ID_FIRST', tier: 2, line, elementId: dataId,
            message: `<${dataId}> (line ${line}) declares style BEFORE data-id — the editor's scanners read attributes in order, so style edits and motion-value bindings on this element won't resolve. Put data-id and data-name FIRST on every tag, before style and motion props.`,
          });
        }
      }

      // className styling
      const classAttr = attrs.find((a) => a.name.name === 'className');
      if (classAttr) {
        v.push({
          code: 'CLASSNAME_STYLING', tier: 2, line, elementId: dataId,
          message: `className styling (line ${line}) is invisible to the editor — no Tailwind, no CSS classes. Rewrite the classes as an inline style object, e.g. className="p-6 rounded-xl" → style={{ padding: '24px', borderRadius: '12px' }}.`,
        });
      }

      // dangerouslySetInnerHTML does NOT resolve in the builder — the editor
      // renders nothing for it and the content is uneditable (no node to select,
      // no "Bind to Field"). The ONLY way to surface dynamic/CMS content is a
      // TEXT NODE with the field bound as its child — <p data-id="…">{item.body}</p>
      // — which the editor renders (a richtext field bound this way renders as
      // formatted HTML on the canvas, the preview, and the deploy). This came up
      // when a CMS detail page used dangerouslySetInnerHTML for the body and it
      // showed blank in the builder.
      const dangerHtmlAttr = attrs.find((a) => a.name.name === 'dangerouslySetInnerHTML');
      if (dangerHtmlAttr) {
        const idForMsg = dataId ?? 'field-body';
        v.push({
          code: 'DANGEROUS_INNER_HTML', tier: 2, line, elementId: dataId,
          message: `dangerouslySetInnerHTML (line ${line}) does not resolve in the builder — it renders blank and the content can't be selected or bound. Put the content in a TEXT NODE and bind the field as its child instead, e.g. <p data-id="${idForMsg}" data-name="Body" style={{ fontSize: '17px', lineHeight: '1.75', color: 'var(--color-white-82)' }}>{item.body}</p>. The builder renders a richtext field bound this way as formatted HTML.`,
        });
      }

      // style object inspection. Position pins: the PositionTool detects pins
      // with /^-?[\d.]+px$/ — right/bottom percentages are invisible to it and
      // get overwritten by the first drag. fixed only resolves on direct
      // children of the page root.
      const parentNode = path.parentPath?.node;
      const parentDataId = parentNode && t.isJSXElement(parentNode)
        ? stringAttr(jsxAttrs(parentNode.openingElement), 'data-id')
        : undefined;
      const styleAttr = attrs.find((a) => a.name.name === 'style');
      if (styleAttr && t.isJSXExpressionContainer(styleAttr.value) && t.isObjectExpression(styleAttr.value.expression)) {
        // POSITION_OFFSET_REQUIRES_ABSOLUTE — left/top/right/bottom only PLACE
        // an element when its position is absolute/fixed (or sticky). On a
        // relative/static element the offsets are ignored (static) or applied
        // as a confusing shift (relative) — and the canvas may position the
        // element by its coordinates while the live build does not, a
        // source≠deploy drift. The classic case: a frame dropped into a
        // non-layout (no flex/grid) parent, or a flex child given left/top by a
        // drag, that stayed position:'relative' → centered in the editor but
        // bottom-right on the published site. Coordinate placement means
        // position:'absolute' in this builder.
        {
          const so = styleAttr.value.expression;
          const findProp = (name: string) =>
            so.properties.find((p): p is t.ObjectProperty =>
              t.isObjectProperty(p) && (t.isIdentifier(p.key, { name }) || t.isStringLiteral(p.key, { value: name })));
          const hasOffset = ['left', 'top', 'right', 'bottom'].some((k) => !!findProp(k));
          const hasSpread = so.properties.some((p) => t.isSpreadElement(p));
          const posProp = findProp('position');
          // Resolve position to a known literal, or null when it is bound to an
          // expression (variable) — in which case we can't judge it, so skip.
          const posLiteral = !posProp ? 'static' : t.isStringLiteral(posProp.value) ? posProp.value.value : null;
          if (hasOffset && !hasSpread && posLiteral !== null && !/^(absolute|fixed|sticky)$/.test(posLiteral)) {
            v.push({
              code: 'POSITION_OFFSET_REQUIRES_ABSOLUTE', tier: 2, line, elementId: dataId ?? undefined,
              message: `<${dataId ?? tag}> (line ${line}) sets left/top/right/bottom but position is ${posProp ? `'${posLiteral}'` : 'not set (static)'} — coordinate offsets only place an element when position is 'absolute' or 'fixed'. On a flex/normal child they are ignored or cause a canvas-vs-live drift (centered in the editor, off-position on the published site). Set position:'absolute' to place it by coordinates, or remove left/top and let the parent's layout (flex/grid) position it.`,
            });
          }
        }
        // Overlay elements (data-overlay — the overlay portal system) are
        // builder-written with position: fixed inside a conditional block;
        // their "parent" is a JSXExpressionContainer so the root-direct test
        // can't see them (live prime-rule find 2026-06-11: a user-created
        // click overlay bounced FIXED_DEPTH on resubmit).
        const isOverlay = attrs.some((a) => a.name.name === 'data-overlay');
        // CODE COMPONENTS are FREE CODE: their internals are a black box the
        // panels never open (no Fill/Position/Size/Animation tool ever reads
        // an internal element), so every panel-representability rule in
        // checkStyleObject — transitions, keyframes/willChange, transform
        // strings, pin units, min/max units — is a false positive there. The
        // canvas stays still regardless (it disables CSS animations and rAF
        // loops gate on useStaticCanvas). Pages + design components keep the
        // full check.
        if (!isCodeComponent) {
          checkStyleObject(styleAttr.value.expression, dataId, v, {
            fixedAllowed: kind !== 'page' || parentDataId === 'root' || isOverlay,
            // The bg-video child is builder-authored and not a canvas node, so the
            // Position tool never edits its pins — `inset: '0'` is the correct
            // spelling for "fill my parent" there (Renderer.syncBgVideoChild).
            builderOwned: hasAttr(attrs, 'data-bg-video'),
          });
        }

        // INSTANCE_INTERNAL_STYLE — instance tags carry PLACEMENT only
        // (position/size/margin/order/transform/visibility); paint and
        // typography live INSIDE the component or bind through a variable.
        // The builder's own instance writes redirect these into the component
        // file, so internal props on the wrapper are always a hand-written
        // mistake: they double-apply or silently do nothing.
        if (kind !== 'code-component' && componentLocalNames.has(tag)) {
          const offenders: string[] = [];
          for (const p of styleAttr.value.expression.properties) {
            if (!t.isObjectProperty(p)) continue;
            const k = t.isIdentifier(p.key) ? p.key.name : t.isStringLiteral(p.key) ? p.key.value : null;
            if (k && INSTANCE_INTERNAL_STYLE_PROPS.has(k)) offenders.push(k);
          }
          if (offenders.length > 0) {
            v.push({
              code: 'INSTANCE_INTERNAL_STYLE', tier: 2, line, elementId: dataId,
              message: `<${tag}> (line ${line}) styles ${offenders.join(', ')} on the INSTANCE tag — instance wrappers carry placement only (position/left/top/width/height/margin/order/transform). Move these inside the component file, or expose them as component variables and pass values as attributes (<${tag} accentColor="#ff4524" />).`,
            });
          }
        }

        // PIN_ABSOLUTE_NODE — a NEWLY-INSERTED absolute element on a PAGE must
        // carry data-pinned="true". The Position panel writes data-pinned="true"
        // when a user pins a node — that LOCKS its exact insets. WITHOUT the flag
        // the drag engine applies dynamic 3-band re-pinning (dynamic-pin.ts), so
        // an MCP-authored absolute node silently re-anchors the first time it's
        // nudged. When the model INSERTS an absolute node the intent IS to pin it
        // exactly there, so require the attribute. Scope:
        //   • PAGES/templates only — design-component masters position their
        //     absolute children through the variant system (the canonical
        //     component dialect uses unpinned absolute children), so components
        //     are exempt.
        //   • NEW nodes only (data-id not in existingDataIds) — pre-existing
        //     builder content may use dynamic pinning and must NOT be rewritten.
        //   • Skip overlay nodes (the portal owns their position) and
        //     canvas-workspace nodes (a separate coordinate system).
        const stObjPin = styleAttr.value.expression;
        const posPropPin = stObjPin.properties.find((p): p is t.ObjectProperty =>
          t.isObjectProperty(p) && (t.isIdentifier(p.key, { name: 'position' }) || t.isStringLiteral(p.key, { value: 'position' })));
        const isAbsolutePin = !!posPropPin && styleValueIncludes(posPropPin.value, 'absolute');
        const isNewNode = !!existingDataIds && dataId != null && !existingDataIds.has(dataId);
        const isPinnedNode = hasAttr(attrs, 'data-pinned') && stringAttr(attrs, 'data-pinned') !== 'false';
        // A ...style spread = a passthrough/instance node whose placement comes
        // from elsewhere — don't force a pin on it.
        const hasStyleSpreadPin = stObjPin.properties.some((p) => t.isSpreadElement(p));
        const inCanvasNodesFrag = !!path.findParent((pp) =>
          t.isVariableDeclarator(pp.node) && t.isIdentifier(pp.node.id, { name: 'canvasNodes' }));
        if (kind === 'page' && isAbsolutePin && isNewNode && !isPinnedNode && !isOverlay
            && !hasStyleSpreadPin && !inCanvasNodesFrag && !hasAttr(attrs, 'data-canvas-node')) {
          v.push({
            code: 'PIN_ABSOLUTE_NODE', tier: 2, line, elementId: dataId,
            message: `<${dataId ?? tag}> (line ${line}) is position:'absolute' but is missing data-pinned="true". Every absolute node you insert must be pinned — otherwise the canvas applies dynamic re-pinning and the element re-anchors the first time it's dragged. Add the attribute right after data-name: <${tag} data-id="${dataId ?? 'x'}" data-name="…" data-pinned="true" style={{ position: 'absolute', … }}>.`,
          });
        }

        // NODE_MISSING_POSITION — every NEWLY-INSERTED styled node must carry an
        // explicit `position` (relative/absolute/fixed/sticky). Without one the
        // element is CSS `static`: the Position tool shows nothing, coordinate
        // math breaks, and — the live find 2026-07-06 — when the user runs Make
        // Component on it there is NO position to transfer onto the instance
        // tag, so the master root's `position:'absolute'` (every design
        // component's root is absolute for its artboard) leaks through the
        // `...style` spread onto the page instance → the instance drops out of
        // flow and stacks over its siblings. Default flow nodes are
        // position:'relative' in this builder, always explicitly.
        // Scope mirrors PIN_ABSOLUTE_NODE: NEW nodes only (pre-existing builder
        // content untouched), pages + design components, skip SVG internals
        // (their positioning model is the SVG coordinate system) and nodes with
        // a `...spread` (placement may arrive through it).
        if (kind !== 'code-component' && isNewNode && dataId != null
            && !posPropPin && !hasStyleSpreadPin
            && !isSvgTag(tag.replace(/^motion\./, '')) && tag !== 'foreignObject') {
          const isInstanceTag = componentLocalNames.has(tag);
          v.push({
            code: 'NODE_MISSING_POSITION', tier: 2, line, elementId: dataId,
            message: isInstanceTag
              ? `Component instance <${tag}> (data-id "${dataId}", line ${line}) has NO position in its style prop. An instance must ALWAYS carry explicit positioning (usually position: 'relative', plus flex/order for layout children) — the component master's root is position:'absolute' (its artboard placement), and without an instance override that absolute leaks through the ...style spread onto the page: the instance drops out of flow and overlaps its siblings. Add position: 'relative' to the instance style.`
              : `<${dataId}> (line ${line}) has no \`position\` in its style — every node must declare one explicitly ('relative' for normal flow, 'absolute'/'fixed'/'sticky' when intended). A position-less node is CSS static: the Position tool reads it as unset, and if it is later extracted into a component there is no position to transfer to the instance (the master root's absolute then leaks through and breaks the layout). Add position: 'relative'.`,
          });
        }
      }

      // A component INSTANCE with no style prop AT ALL is the same hazard as a
      // position-less style (see NODE_MISSING_POSITION): nothing overrides the
      // master root's absolute. Flag new ones.
      if (kind !== 'code-component'
          && (!styleAttr || !t.isJSXExpressionContainer(styleAttr.value) || !t.isObjectExpression(styleAttr.value.expression))
          && componentLocalNames.has(tag) && dataId != null
          && !!existingDataIds && !existingDataIds.has(dataId)) {
        v.push({
          code: 'NODE_MISSING_POSITION', tier: 2, line, elementId: dataId,
          message: `Component instance <${tag}> (data-id "${dataId}", line ${line}) has no style prop. An instance must always carry explicit positioning — add style={{ position: 'relative', flex: '0 0 auto', order: '…' }} (the master root is position:'absolute' and leaks through without an instance override).`,
        });
      }


      // MOTION DIALECT — the AnimationTool classifies by exact prop shape:
      //   Appear = initial + whileInView + viewport={{once:true}}
      //   Loop   = animate={{...}} + transition with repeat
      //   Hover/Tap = whileHover/whileTap
      // Bare animate={{...}} (an object, no repeat, no whileInView) renders as a
      // one-shot entrance but the tool reads it as a broken Loop — bounce it.
      const animateAttr = attrs.find((a) => a.name.name === 'animate');
      if (animateAttr && t.isJSXExpressionContainer(animateAttr.value) && t.isObjectExpression(animateAttr.value.expression)) {
        // LOOP_KEYFRAME_ARRAY — the Loop editor speaks SINGLE numeric targets;
        // keyframe arrays render (motion feature) but the parser drops array
        // values (parser.ts readObj has no ArrayExpression branch) → the
        // animation is invisible to the panel. Live find 2026-06-10: a marquee
        // hand-written as animate={{ x: [0, -1200] }}.
        const arrayProp = animateAttr.value.expression.properties.find((p): p is t.ObjectProperty =>
          t.isObjectProperty(p) && t.isArrayExpression(p.value));
        if (arrayProp) {
          const keyName = t.isIdentifier(arrayProp.key) ? arrayProp.key.name : 'prop';
          v.push({
            code: 'LOOP_KEYFRAME_ARRAY', tier: 2, line, elementId: dataId,
            message: `animate={{ ${keyName}: [...] }} (line ${line}) — keyframe ARRAYS don't resolve in the Animation panel; loops are SINGLE numeric targets. For an A→B→A pulse use the single target + repeatType: 'mirror' (animate={{ scale: 1.2 }} transition={{ duration: 1, repeat: Infinity, repeatType: 'mirror' }}). For a scrolling marquee/ticker, do NOT hand-write it — the builder has a Marquee component (speed/direction/gap) the user inserts; leave a simple static row instead.`,
          });
        }
        const hasWhileInView = attrs.some((a) => a.name.name === 'whileInView');
        const transitionAttr = attrs.find((a) => a.name.name === 'transition');
        const hasRepeat = !!(transitionAttr && t.isJSXExpressionContainer(transitionAttr.value)
          && t.isObjectExpression(transitionAttr.value.expression)
          && transitionAttr.value.expression.properties.some((p) =>
            t.isObjectProperty(p) && t.isIdentifier(p.key) && p.key.name === 'repeat'));
        // AnimatePresence ENTER/EXIT pair — `initial` + `animate` + `exit` is
        // the builder's OWN overlay scaffold (overlay-gen.ts) and the canonical
        // presence transition; it is neither a Loop nor an entrance-on-scroll.
        // (Live prime-rule find 2026-06-12: an overlay inside a component
        // bounced every later submit of its file.)
        const hasExit = attrs.some((a) => a.name.name === 'exit');
        if (!hasWhileInView && !hasRepeat && !hasExit) {
          v.push({
            code: 'BARE_ANIMATE_OBJECT', tier: 2, line, elementId: dataId,
            message: `animate={{…}} without repeat (line ${line}) reads as a broken Loop in the Animation panel. For an ENTRANCE animation write: initial={{…from…}} whileInView={{…to…}} viewport={{ once: true }} transition={{…}}. Keep animate={{…}} only for continuous loops (transition must include repeat: Infinity).`,
          });
        }
      }

      // Appear must be one-shot: whileInView without viewport={{ once: true }}
      // replays on every scroll-past and the tool can't round-trip it.
      const wivAttr = attrs.find((a) => a.name.name === 'whileInView');
      if (wivAttr && t.isJSXExpressionContainer(wivAttr.value) && t.isObjectExpression(wivAttr.value.expression)) {
        const viewportAttr = attrs.find((a) => a.name.name === 'viewport');
        const hasOnce = !!(viewportAttr && t.isJSXExpressionContainer(viewportAttr.value)
          && t.isObjectExpression(viewportAttr.value.expression)
          && viewportAttr.value.expression.properties.some((p) =>
            t.isObjectProperty(p) && t.isIdentifier(p.key) && p.key.name === 'once' && t.isBooleanLiteral(p.value, { value: true })));
        if (!hasOnce) {
          v.push({
            code: 'APPEAR_MISSING_VIEWPORT_ONCE', tier: 2, line, elementId: dataId,
            message: `whileInView at line ${line} needs viewport={{ once: true }} on the same element — without it the entrance replays on every scroll and the Animation panel can't edit it as an Appear.`,
          });
        }
      }

      // TEXT_ANIM_WRAPPER — a text effect is `data-text-anim` on the node PLUS a
      // `<RevymeSplitText>` wrapping its children. The split happens at RUNTIME (the wrapper
      // reads the resolved string), so hand-written per-character motion.spans are the OLD
      // build-time form: they cannot animate a CMS binding, and the panel regenerates over
      // them. Either half alone is broken — the attr without the wrapper renders unanimated
      // text while the panel still shows an effect; the wrapper without the attr animates
      // text the panel can't see or edit.
      {
        const animAttr = attrs.find((a) => a.name.name === 'data-text-anim');
        const elementChildren = path.node.children.filter((c): c is t.JSXElement => t.isJSXElement(c));
        const firstChildName = elementChildren.length
          ? jsxTagName(elementChildren[0].openingElement.name) : null;
        const hasWrapper = firstChildName === 'RevymeSplitText';
        const line = path.node.openingElement.loc?.start.line;

        if (animAttr && !hasWrapper) {
          v.push({
            code: 'TEXT_ANIM_WRAPPER', tier: 2, line, elementId: dataId,
            message: `<${tag}> at line ${line} has data-text-anim but its children are not wrapped in <RevymeSplitText>. A text effect is BOTH: data-text-anim='{…spec…}' on this tag, and <RevymeSplitText spec={{…}}>{children}</RevymeSplitText> around its content (import RevymeSplitText from '@revyme/runtime'). Per-character motion.spans are the retired build-time form — never hand-write them.`,
          });
        }
        if (!animAttr && hasWrapper) {
          v.push({
            code: 'TEXT_ANIM_WRAPPER', tier: 2, line, elementId: dataId,
            message: `<${tag}> at line ${line} wraps its text in <RevymeSplitText> but carries no data-text-anim attribute, so the Animation panel cannot see or edit the effect. Add data-text-anim='{"animationType":"character",…}' to this tag with the same spec.`,
          });
        }
      }

      // TEXT_EXPRESSION — children expressions outside the accepted binding forms
      for (const child of path.node.children) {
        if (!t.isJSXExpressionContainer(child)) continue;
        const expr = child.expression;
        if (t.isJSXEmptyExpression(expr)) continue;
        if (isAllowedTextExpression(expr)) continue;
        v.push({
          code: 'TEXT_EXPRESSION', tier: 2, line: child.loc?.start.line, elementId: dataId,
          message: `Text content at line ${child.loc?.start.line} is a computed expression — the text tool cannot edit it. Write the final text as a literal ("$29/mo", not {\`$\${price}/mo\`}). Allowed expressions: {item.field} bindings inside .map(), {propName}, {variant === 'x' ? 'a' : 'b'}, {useResponsiveText(...)}.`,
        });
      }
    },
  });

  // ── CODE COMPONENT ROOT STYLE SPREAD ORDER — ...props.style LAST, so the instance's
  //    page placement (position/size) overrides the code component's defaults. Spread-
  //    first renders fine on the EDITOR canvas (expandComponent merges instance
  //    styles over the root at parse time) but the PUBLISHED site runs the raw
  //    React, where the code component's own values win — live find 2026-06-10: an
  //    absolute background code component published in-flow and shoved the hero content
  //    down. Canvas/publish divergence; the old component-chat canon already
  //    said "at the END".
  if (kind === 'code-component') {
    traverse(ast, {
      JSXAttribute(path: NodePath<t.JSXAttribute>) {
        if (!t.isJSXIdentifier(path.node.name, { name: 'style' })) return;
        const val = path.node.value;
        if (!t.isJSXExpressionContainer(val) || !t.isObjectExpression(val.expression)) return;
        const entries = val.expression.properties;
        const spreadIdx = entries.findIndex((p) =>
          t.isSpreadElement(p) && t.isMemberExpression(p.argument)
          && t.isIdentifier(p.argument.property, { name: 'style' }));
        if (spreadIdx !== -1 && spreadIdx !== entries.length - 1) {
          v.push({
            code: 'CODE_COMPONENT_STYLE_SPREAD_ORDER', tier: 2, line: entries[spreadIdx].loc?.start.line,
            message: `...props.style must be the LAST entry of the style object (line ${entries[spreadIdx].loc?.start.line}) — the instance's page placement (position/width/height) must override the code component's defaults. Spread-first looks right on the canvas but the PUBLISHED site renders the code component's own values and the layout diverges. Move the spread to the end: style={{ <defaults>, ...props.style }}.`,
          });
        }
      },
    });
  }

  // ── TEMPLATE SLOT (LayoutClient.tsx) — exactly one plain {children} must
  //    survive every edit: it is where each assigned page's content mounts
  //    (Next.js layout semantics). Everything else is shared chrome. ──────────
  if (isTemplate) {
    let plain = 0;
    let buried = 0;
    let wrapTag: string | null = null;
    let wrapLine: number | undefined;
    traverse(ast, {
      JSXExpressionContainer(path: NodePath<t.JSXExpressionContainer>) {
        const expr = path.node.expression;
        if (t.isIdentifier(expr, { name: 'children' })) {
          plain++;
          // The slot must sit DIRECTLY under the root element — the canvas
          // renders the slot itself as the page placeholder, so a wrapper
          // shows up as a stray empty box next to it (live find 2026-06-10:
          // a <main> around {children} doubled the content area).
          if (t.isJSXElement(path.parent)) {
            const attrs = path.parent.openingElement.attributes;
            const idAttr = attrs.find((a): a is t.JSXAttribute =>
              t.isJSXAttribute(a) && t.isJSXIdentifier(a.name, { name: 'data-id' }) && t.isStringLiteral(a.value));
            const parentId = idAttr && t.isStringLiteral(idAttr.value) ? idAttr.value.value : null;
            if (parentId !== 'root') {
              const opening = path.parent.openingElement.name;
              const wrapName = t.isJSXIdentifier(opening) ? opening.name : 'element';
              // A TRANSPARENT wrapper (the generated <PageTransitions> controller, MotionConfig, …) renders
              // the slot through unchanged — it's not a layout box, so {children} inside it is legitimate.
              if (!TRANSPARENT_TAGS.has(wrapName)) {
                wrapTag = wrapName;
                wrapLine = path.node.loc?.start.line;
              }
            }
          }
          return;
        }
        let found = false;
        path.traverse({ Identifier(ip) { if (ip.node.name === 'children') found = true; } });
        if (found) buried++;
      },
    });
    if (plain === 0 && buried > 0) {
      v.push({
        code: 'TEMPLATE_CHILDREN_CONDITIONAL', tier: 2,
        message: `{children} is wrapped in a conditional/expression — the content slot must be a PLAIN {children} expression, always rendered. Pages assigned to this template mount their content there; gating it means pages can disappear. Unwrap it back to exactly {children}.`,
      });
    } else if (plain === 0) {
      v.push({
        code: 'TEMPLATE_CHILDREN_MISSING', tier: 2,
        message: `The {children} content slot was removed. A template is shared chrome AROUND one {children} expression — that is where every assigned page's content mounts (like a Next.js layout). Put {children} back exactly once, and build the header/footer/background around it.`,
      });
    } else if (plain + buried > 1) {
      v.push({
        code: 'TEMPLATE_CHILDREN_DUPLICATED', tier: 2,
        message: `{children} appears ${plain + buried} times — a template has EXACTLY ONE content slot. Each assigned page mounts there once; duplicating the slot renders the page content multiple times. Keep one plain {children} and delete the rest.`,
      });
    } else if (wrapTag) {
      v.push({
        code: 'TEMPLATE_CHILDREN_WRAPPED', tier: 2, line: wrapLine,
        message: `{children} (line ${wrapLine}) is wrapped inside a <${wrapTag}> — the slot must be a DIRECT child of the root element. The canvas renders the slot itself as the page placeholder, so a wrapper appears as a stray empty box, and the slot's layout belongs to each assigned page. Delete the wrapper and place {children} directly between the root's other children.`,
      });
    }
  }

  // ── CURSOR DIALECT — the cursor-parser matches EXACTLY `{...withCursor(` and
  //    SILENTLY SKIPS anything else (no opts object, whitespace after the
  //    brace, no enclosing data-id) — the cursor renders but the Cursor panel
  //    shows nothing and can never edit or remove it. ────────────────────────
  if (kind !== 'code-component' && /withCursor\s*\(/.test(code)) {
    const totalCalls = [...code.matchAll(/withCursor\s*\(/g)].length;
    const spreadCalls = [...code.matchAll(/\{\.\.\.withCursor\s*\(/g)].length;
    if (totalCalls > spreadCalls) {
      v.push({
        code: 'CURSOR_NOT_SPREAD', tier: 2,
        message: `withCursor() is used outside the spread form. The ONLY shape the builder resolves is the literal spread {...withCursor(Name, { …opts })} inside an element's opening tag (no space after the brace, options object required) — never onMouseEnter={withCursor(…)}, never a variable holding the result.`,
      });
    }
    const parsed = parseComponentCursorCalls(code).length;
    if (parsed < spreadCalls) {
      v.push({
        code: 'CURSOR_UNRESOLVED', tier: 2,
        message: `${spreadCalls - parsed} withCursor spread(s) don't resolve in the Cursor panel. The parser matches EXACTLY: {...withCursor(Name, { mode: 'follow' })} — no whitespace after {, a second argument that is an inline OBJECT LITERAL (required, even if empty {}), placed AFTER data-id/data-name on an element that HAS a data-id. Valid opts: mode ('follow'|'replace'), side ('top'|'bottom'|'left'|'right'), align ('start'|'center'|'end'), offsetX/offsetY (numbers), width/height, transition ({ type: 'spring'|'tween'|'instant', stiffness, damping, mass, duration }), enterExit (boolean).`,
      });
    }
  }

  // ── SCROLL DIALECT (pages) — the scroll-parser's regexes are strict; any
  //    deviation renders but is invisible to the Animation panel. ─────────────
  if (kind === 'page' && /useScroll|useTransform|useSpring|useMotionTemplate/.test(code)) {
    checkScrollDialect(ast, v);
  }

  // ── VARIANT DIALECT (design components) ────────────────────────────────────
  if (kind === 'component' && /\bconst\s+variantConfig\s*=/.test(code)) {
    checkVariantDialect(code, ast, v);
    checkComponentFluidWidth(code, ast, v);
    checkVariantTernaryPrimary(code, ast, v);
  }
  // ── EVENT VARIABLES (component callbacks) — a @propMeta type 'event' prop is
  //    a standard component event: a BARE callback prop (no default) a
  //    child fires (onClick={eventName}) and a page instance wires to open an
  //    overlay. Detect across pages + components (events fire in masters). ────
  if (kind === 'component' && /@propMeta/.test(code) && /"type"\s*:\s*"event"/.test(code)) {
    checkEventVariables(code, ast, v);
  }
  // ── PAGE VARIABLES (@pageVariables on a page/template) — the page-variable
  //    parser accepts ONLY number/text/boolean/color/image/componentCursor; any
  //    other `type` is silently DROPPED (the variable vanishes). Rich variable
  //    types (transition/shadow/border/radius) are @propMeta types, NOT
  //    @pageVariables types — the @pageVariables type stays the valid base. ────
  if (/@pageVariables/.test(code)) {
    checkPageVariableTypes(code, v);
  }
  // ── COMPONENT LINKS (design components) — every element is motion.* for the
  //    FLIP/variant system, so a navigating link must be MotionLink =
  //    motion.create(Link): a plain <Link> won't animate, and <motion.a href>/
  //    <a href> is a raw anchor (full reload, route may not resolve on canvas). ─
  if (kind === 'component' && (/href[=:]/.test(code) || /MotionLink/.test(code))) {
    checkComponentLinks(code, ast, v);
  }
  // ── PAGE LINKS — on a page/template a navigating link must be the Next.js
  //    <Link> (next/link), never a raw <a>/<motion.a> (full reload + canvas
  //    route may not resolve). Components use MotionLink (above) instead. ──
  if ((kind === 'page' || kind === 'template') && (/href[=:]/.test(code) || /<Link[\s/>]/.test(code))) {
    checkPageLinks(code, ast, v);
  }
  // ── APPEAR ANIMATION STUCK HIDDEN (pages + components) — initial={{opacity:0}}
  //    with no animate/whileInView that restores opacity leaves the element
  //    invisible on the LIVE site (the canvas ignores enter animations, so it
  //    looks fine there). The classic "links render on canvas but not live". ──
  if ((kind === 'page' || kind === 'component') && /\binitial\s*=\s*\{\{/.test(code)) {
    checkMotionAppearHidden(ast, v);
  }
  // Static-transform × animated-transform composer. Own gate — the drift rule
  // must also see whileInView-only elements and ORPHANED templates, neither of
  // which implies an `initial={{`.
  if ((kind === 'page' || kind === 'component') &&
      (code.includes('transformTemplate') ||
        (/transform\s*:\s*'/.test(code) && /\b(?:initial|whileInView|animate)\s*=\s*\{/.test(code)))) {
    checkMotionTransformDrift(ast, v);
  }

  // ── TRANSLATION DIALECT (pages + components) — next-intl t() calls must
  //    carry the import + hook (live crash otherwise) and use data-id-derived
  //    keys + the page-slug namespace, or the editor's localization panels
  //    can never edit that copy again. ─────────────────────────────────────
  if ((kind === 'page' || kind === 'component') && /useTranslations|[^\w]t\(['"]/.test(code)) {
    checkTranslationDialect(code, ast, opts.path, v);
  }

  // ── MEDIA BAND DIALECT (pages + components) — ranged @media heads need the
  //    fractional `<smaller-bp>.02px` lower bound (integer bounds leak onto
  //    the exact smaller tile or gap fractional phones), and global :lang
  //    rules must precede banded blocks or per-replica locale values never
  //    paint (equal specificity — later wins). ─────────────────────────────
  if ((kind === 'page' || kind === 'component') && /min-width|:lang\(/.test(code)) {
    checkMediaBandDialect(code, ast, v);
  }

  // ── SVG SHAPE DIALECT (pages + components) — the shape/stroke controls,
  //    per-variant geometry, and the resize/rotate engines all run on ONE
  //    exact structure; shapes written any other way render but don't
  //    RESOLVE (panel shows nothing, gestures mis-route). ────────────────────
  if ((kind === 'page' || kind === 'component') && /<(?:motion\.)?svg[\s/>]/.test(code)) {
    checkSvgShapeDialect(ast, v);
  }

  // ── OVERLAY DIALECT (dropdowns / popovers / modals) — the overlay panel,
  //    the portal renderer and the live runtime all key on the data-overlay /
  //    data-overlay-trigger pair + the generated state/effect wiring. ────────
  if ((kind === 'page' || kind === 'component') && /data-overlay/.test(code)) {
    checkOverlayDialect(code, ast, v);
  }

  // ── FLEX/GRID CHILD ORDER (pages + components) — the drag-to-reorder
  //    system manipulates CSS `order`; a flow child without an explicit one
  //    defaults to 0, collapses to the front of the order:0 group, and
  //    reordering jumps. Every reorderable flex/grid child needs a baked
  //    sequential order so D&D is stable from creation. ────────────────────
  if (kind === 'page' || kind === 'component') {
    checkFlexChildOrder(ast, v);
    checkOrderIsString(ast, v);
    checkFlexChildShrink(ast, v);
    checkPaddingNeedsLayout(ast, v, existingDataIds);
    checkGridNeedsTemplate(ast, v, existingDataIds);
    checkNoLayoutParentRelativeChild(ast, v, existingDataIds);
    checkMediaColumnFlipRebase(ast, v);
    checkSlotComponentInlineChildren(ast, v);
    if (/<(?:motion\.)?img[\s/>]/.test(code)) checkImageBackgroundFrame(ast, v);
  }

  // ── UNRESOLVABLE TERNARY (pages only) — a `x ? a : b` value ternary in text or
  //    a style value renders on the live site but the builder can't resolve or
  //    toggle it on a page; state-driven values MUST be page variables switched by
  //    a Set-Variable interaction. (Design components use variant ternaries, which
  //    DO resolve — so this never runs for them.) ─────────────────────────────────
  if (kind === 'page') checkUnresolvableTernary(ast, v);

  // ── @canvas VIEWPORT CONFIG (pages) — the canvas renders one tile per
  //    viewport entry; a malformed block silently collapses the page to a
  //    single default tile and the responsive system has nothing to key on. ──
  if (kind === 'page' && !isTemplate) {
    checkCanvasConfig(code, v);
  }

  // ── CMS SLUG NAVIGATION (detail prev/next/current + map row links) — the
  //    Link tool's "Slug" control round-trips on a data-cms-nav marker paired
  //    with a resolved href template literal. Marker drives the panel chip;
  //    href drives the actual route. They must stay in lockstep with the
  //    generator (cmsNavHrefExpr) or the panel lies / the link breaks. ───────
  if ((kind === 'page' || kind === 'component')
      && (/data-cms-nav/.test(code) || /\.findIndex\(\s*\([^)]*\)\s*=>\s*[A-Za-z_$][\w$]*\._slug\s*===\s*params\?\.slug\)/.test(code))) {
    checkCmsNavDialect(code, ast, v, kind);
  }

  // ── CMS COLLECTION LIST dialect — the `.map()` repeater + filters/sort/
  //    pagination/responsive/visibility/copy-paste rules. Catches the wrong
  //    formats that PARSE but crash / render empty / can't be edited, and DIRECTS
  //    to the canonical shape. Gated to pages/components (internally no-ops when
  //    there's no collection-list signal). ─────────────────────────────────────
  if (kind === 'page' || kind === 'component') {
    checkCmsCollectionDialect(code, ast, v, kind);
    checkCmsRowNavMarker(code, ast, v);
  }

  // ── tier 3 — RESOLVE ───────────────────────────────────────────────────────
  if (v.every((x) => x.tier !== 1)) {
    try {
      const nodes = parseJSXToNodes(code);
      if (nodes.size === 0) {
        v.push({
          code: 'RESOLVE_EMPTY', tier: 3,
          message: `The builder's parser found no editable elements in this file. The component must return a JSX tree of elements carrying data-id attributes.`,
        });
      } else if (kind === 'page' && !nodes.has('root')) {
        // The sandbox renderer mounts the page AT nodes.get('root') and paints
        // NOTHING without it (the icon-set master bug, same mechanism).
        v.push({
          code: 'PAGE_ROOT_REQUIRED', tier: 3,
          message: `The page has no element with data-id="root". The canvas mounts the page AT the root element — without it nothing renders. The outermost element must be <div data-id="root" data-name="…" style={{ position: 'relative', width: '100%' }}> wrapping everything else.`,
        });
      }

      // A page INSIDE a template route group (path like app/(Group)/…/page.client.tsx)
      // must NOT style its data-id="root": that id COLLIDES with the template's own
      // root in the canvas node map, so padding/background on it is DROPPED on the
      // canvas (it renders on the live site → editor/production mismatch — the
      // "padding shows live but not on canvas" bug). Keep the root bare; move
      // padding/background onto an inner wrapper with its own data-id. Excludes the
      // template LayoutClient itself (isTemplate), which legitimately owns the root.
      if (kind === 'page' && !isTemplate && opts.path && /\([^)]+\)/.test(opts.path) && nodes.has('root')) {
        const rootStyles = nodes.get('root')!.styles ?? {};
        // overflow/minHeight are flagged alongside padding/background: `overflowX: 'hidden'`
        // on a templated page root is dropped on the canvas but LIVE it computes
        // `overflow-y: auto` (one axis hidden forces the other from visible to auto) — the
        // root becomes a nested scroll container and any 1px of transform overflow (a
        // below-fold appear animation's initial y-offset) grows a second scrollbar that
        // traps wheel input (double-scrollbar, 2026-07-28). The template root owns
        // clipping and viewport sizing.
        const BAD_ROOT_PROPS = ['padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'backgroundColor', 'background', 'backgroundImage', 'overflow', 'overflowX', 'overflowY', 'minHeight'];
        const offenders = BAD_ROOT_PROPS.filter((k) => rootStyles[k] != null && rootStyles[k] !== '');
        if (offenders.length > 0) {
          v.push({
            code: 'TEMPLATED_PAGE_ROOT_STYLED', tier: 2,
            message: `This page is inside a template route group, so its data-id="root" COLLIDES with the template's own root in the canvas node map — the ${offenders.join(', ')} you set on it is DROPPED on the canvas (it still renders on the live site, so the page looks inconsistent between the editor and production). Move ${offenders.join(', ')} (and any background / padding / centering) onto an INNER wrapper that has its OWN data-id — e.g. a "Document" frame: { position: 'relative', width: '100%', maxWidth: '860px', margin: '0 auto', boxSizing: 'border-box', padding: '140px 24px 120px', display: 'flex', flexDirection: 'column' } — and keep the root BARE: { position: 'relative', width: '100%', height: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center' }.`,
          });
        }
      }
    } catch (err) {
      v.push({
        code: 'RESOLVE_THROW', tier: 3,
        message: `The builder's parser failed on this file: ${(err as Error).message}. The structure is outside the supported dialect — simplify to plain nested JSX elements with data-id + inline style objects.`,
      });
    }

    // Crash prediction — the mutation queue's pre-flush validator (scope
    // analysis for dangling identifiers + known AI crash patterns). The gate's
    // direct file writes bypass the queue, so without this an MCP/freeform
    // submit can commit a file that parses but ReferenceError-crashes the
    // preview (the validator caught exactly this for the 'transparent' bug;
    // the oracle didn't have it — closed 2026-06-10).
    const crash = validateGeneratedCode(code);
    if (crash) {
      v.push({
        code: 'WOULD_CRASH', tier: 3,
        message: `This file would crash at runtime: ${crash}. Every referenced identifier must be declared in the file or imported; remove or declare the offender and return the complete corrected file.`,
      });
    }
  }

  trace.action('oracle:check-file', { kind, violations: v.length, codes: v.map((x) => x.code) });
  return v;
}
