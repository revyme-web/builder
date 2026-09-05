// text-anim-gen.ts — Generate, update, and remove text animations in code.
//
// The split happens at RUNTIME, in `<RevymeSplitText>` from `@revyme/runtime`. This module
// only writes the spec: the `data-text-anim` attribute (the editor's source of truth) and a
// `<RevymeSplitText spec={{…}}>` wrapper around the node's existing children.
//
// It used to split at CODEGEN time — N `<motion.span>` elements written into the user's
// source, one per character, plus `useScroll`/`useTransform` hooks injected into the
// component body for scroll mode and `__mq` gates for per-viewport overrides. That could
// never support text resolved at render time: a CMS binding `{item.title}` was escaped
// per character into `&#123;item.title&#125;` and every row rendered the literal text
// (live find 2026-07-30). Moving the split behind a component deleted four span builders,
// the scroll-hook injection, the `querySelector`-by-data-id ref effect, and the whole
// canvas-dormancy dance (module scope can't hold hooks — but the wrapper emits none).
//
// LEGACY READERS ARE RETAINED: `collapseMotionSpans` / `stripMotionSpanWrappers` /
// `stripScrollTextHooks` still run on remove, so a page written by the old generator
// upgrades itself the moment its effect is edited. Nothing else reads them.
//
// All functions are pure: (code, …) → code.

import type { TextAnimConfig } from '@/editor/tools/AnimationTool/motion/text-anim-presets';
import { easeToMotion } from '@/shared/animation-utils';
import { trace } from '@/shared/debug-trace';
import { nodeIdToVarName } from '@/shared/id-utils';
import { parseJSX, traverse } from '@/code/parsing/ast-utils';
import { findJSXDataIdIndex, findTagClose, findMatchingCloseTagIndex, stripTagAttrBalanced, ensureNamedImport } from './generator-utils';

/** The runtime component every text effect wraps its content in. Prefixed because
 *  `syncImports` rebuilds the `@revyme/runtime` import from a bare-identifier scan of the
 *  body — a user component named `SplitText` would produce a duplicate binding and every
 *  mutation on that file would fail babel validation from then on. */
export const SPLIT_TEXT_TAG = 'RevymeSplitText';
const RUNTIME_MODULE = '@revyme/runtime';

// ─── Spec serialisation ──────────────────────────────────────────────────────

const RESTING: Record<string, number> = {
  opacity: 1, scale: 1, rotateX: 0, rotateY: 0, rotateZ: 0, skewX: 0, skewY: 0, x: 0, y: 0,
};
const VALUE_KEYS = ['opacity', 'scale', 'blur', 'rotateX', 'rotateY', 'rotateZ', 'skewX', 'skewY', 'x', 'y'] as const;

function scalarSrc(v: unknown): string {
  return typeof v === 'string' ? JSON.stringify(v) : String(v);
}

/** Serialise a transition, normalising `ease`.
 *
 *  The TransitionPanel's curve editor stores a custom cubic-bezier as the STRING
 *  "[0.22, 1, 0.36, 1]". Emitting that quoted gives framer a meaningless easing NAME, which
 *  it silently replaces with its default — the reveal keeps its duration but loses its shape
 *  (live find 2026-07-30). `easeToMotion` turns it into a real array. */
function transitionSrc(t: NonNullable<TextAnimConfig['transition']>): string {
  const parts: string[] = [];
  if (t.type) parts.push(`type: ${JSON.stringify(t.type)}`);
  if (t.stiffness !== undefined) parts.push(`stiffness: ${t.stiffness}`);
  if (t.damping !== undefined) parts.push(`damping: ${t.damping}`);
  if (t.mass !== undefined && t.mass !== 1) parts.push(`mass: ${t.mass}`);
  if (t.duration !== undefined) parts.push(`duration: ${t.duration}`);
  if (t.bounce !== undefined) parts.push(`bounce: ${t.bounce}`);
  if (t.ease !== undefined) {
    const e = easeToMotion(t.ease as string);
    if (e !== undefined) parts.push(`ease: ${Array.isArray(e) ? `[${e.join(', ')}]` : JSON.stringify(e)}`);
  }
  if (t.delay !== undefined && t.delay !== 0) parts.push(`delay: ${t.delay}`);
  return `{ ${parts.join(', ')} }`;
}

/** The `spec={{…}}` object literal. A projection of `data-text-anim`, regenerated atomically
 *  with it on every write, so the two cannot drift through any tool path. Resting values are
 *  omitted so a minimal config serialises small. */
export function buildSplitTextSpecSource(config: TextAnimConfig): string {
  const parts: string[] = [];
  if (config.animationType) parts.push(`animationType: ${JSON.stringify(config.animationType)}`);
  if (config.mask) parts.push('mask: true');
  // Per-scope existence: `disabled: true` on the base (effect added on a
  // replica → off everywhere else) or inside a scope's config (X on a tile).
  // `disabled: false` MUST also serialize — inside a scope it is the
  // re-enable override on a disabled base ("add only on mobile"); dropping
  // falsy values here silently killed that case.
  // The runtime renders a disabled scope static — identical DOM, no motion.
  if (config.disabled !== undefined) parts.push(`disabled: ${config.disabled}`);
  if (config.trigger && config.trigger !== 'view') parts.push(`trigger: ${JSON.stringify(config.trigger)}`);
  if (config.scrollStart !== undefined) parts.push(`scrollStart: ${config.scrollStart}`);
  if (config.scrollEnd !== undefined) parts.push(`scrollEnd: ${config.scrollEnd}`);
  for (const k of VALUE_KEYS) {
    const v = (config as unknown as Record<string, unknown>)[k];
    if (v === undefined) continue;
    if (k in RESTING && v === RESTING[k]) continue;   // resting → not animated
    if (k === 'blur' && v === 0) continue;
    parts.push(`${k}: ${scalarSrc(v)}`);
  }
  if (config.delay !== undefined) parts.push(`delay: ${config.delay}`);
  if (config.transition) parts.push(`transition: ${transitionSrc(config.transition)}`);
  if (config.responsive?.length) {
    const entries = config.responsive.map((r) => {
      const scope = 'query' in r.scope
        ? `{ query: ${JSON.stringify(r.scope.query)} }`
        : `{ variant: ${JSON.stringify((r.scope as { variant: string }).variant)} }`;
      return `{ scope: ${scope}, config: ${buildSplitTextSpecSource(r.config as TextAnimConfig)} }`;
    });
    parts.push(`responsive: [${entries.join(', ')}]`);
  }
  return `{ ${parts.join(', ')} }`;
}

/** True when any `responsive` scope is variant-based — those need the active variant passed in. */
function needsVariantProp(config: TextAnimConfig): boolean {
  return !!config.responsive?.some((r) => 'variant' in r.scope);
}

// ─── Lookups ─────────────────────────────────────────────────────────────────

/** A node's opening-tag SOURCE slice (`<motion.p … >`), or null when the node isn't in this file. */
function openingTagSlice(code: string, nodeId: string): string | null {
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx < 0) return null;
  const tagStart = code.lastIndexOf('<', idIdx);
  if (tagStart < 0) return null;
  const tagEnd = findTagClose(code, tagStart);
  if (tagEnd < 0) return null;
  return code.slice(tagStart, tagEnd + 1);
}

/** True when the node carries a `data-text-anim` attr AT ALL (parseable or not). The mutation-queue
 *  text-edit routing keys off this — a node with an unparseable spec still needs the span-collapse
 *  path (the generic text writers corrupt split-span children), it just skips the re-split. */
export function nodeHasTextAnim(code: string, nodeId: string): boolean {
  return /\sdata-text-anim=/.test(openingTagSlice(code, nodeId) ?? '');
}

/** Read a node's `data-text-anim` config (single- or double-quoted), or null if absent/unparseable.
 *  Exported for the mutation-queue text-edit branches — their old one-regex lookup
 *  (`data-id="X"[^>]*data-text-anim='…'`) broke on attr order, a double-quoted spec, and any `>`
 *  earlier in the tag (an arrow-fn handler), silently routing the edit down the corrupting
 *  generic-writer path. */
export function readTextAnimConfig(code: string, nodeId: string): TextAnimConfig | null {
  const openTag = openingTagSlice(code, nodeId);
  if (!openTag) return null;
  const sq = openTag.match(/data-text-anim='([^']+)'/);
  if (sq) { try { return JSON.parse(sq[1]); } catch { return null; } }
  const dq = openTag.match(/data-text-anim="([^"]+)"/);
  if (dq) { try { return JSON.parse(dq[1].replace(/&quot;/g, '"')); } catch { return null; } }
  return null;
}

/** Find the matching closing tag, handling nesting. Thin adapter over the
 *  shared findMatchingCloseTagIndex — `startIdx` is the OPENING tag's `<`
 *  position (the shared matcher wants a from-index past it). NOTE: named
 *  findClosingTag locally but this is NOT cms-gen's exported findClosingTag
 *  (different contract: that one returns a span object). */
function findClosingTag(code: string, startIdx: number, tagName: string): number {
  return findMatchingCloseTagIndex(code, tagName, startIdx + 1);
}

// ─── Text normalisation ──────────────────────────────────────────────────────

/** Normalize a node's RAW JSX inner source to the plain multi-line text the splitter expects.
 *  The splitter treats its input as literal characters, so every child shape a text node can carry
 *  by the time an effect is (re)applied must be folded to text FIRST:
 *    - literal-text form `{"line1\nline2"}` (text-paste output) — the string parsed verbatim
 *    - `{" "}` space preservers (babel formatting)
 *    - real line breaks: `<br />` elements AND `</p><p>` paragraph boundaries — a multi-line TipTap
 *      commit writes `<p>` children; splitting them raw was the literal `<P>DESIGN.</P>` live-site bug
 *    - any other inline markup (styled `<span>` marks, `<p>` wrappers): tags dropped, text kept
 *    - source-formatting whitespace (indentation newlines) collapsed per JSX rules
 *    - the JSX entities the splitter itself writes (`&lt;` …) decoded — decoded AFTER the tag strip so
 *      user-typed literal `<p>` (stored escaped) survives as text, and `&amp;` last to stay idempotent */
export function jsxInnerToPlainText(inner: string): string {
  const trimmed = inner.trim();
  const lit = trimmed.match(/^\{\s*("(?:[^"\\]|\\.)*")\s*\}$/);
  if (lit) { try { return String(JSON.parse(lit[1])); } catch { /* not a clean literal — markup path */ } }
  const BREAK = '\u0000';   // sentinel JSX source can't contain — survives the whitespace collapse
  let text = trimmed
    .replace(/\{\s*"( *)"\s*\}/g, '$1').replace(/\{\s*'( *)'\s*\}/g, '$1')
    .replace(/<br\s*\/?>/gi, BREAK)
    .replace(/<\/p>\s*<p[^>]*>/gi, BREAK)
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ');
  text = text.split(BREAK).map(s => s.trim()).join('\n');
  return text
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#123;/g, '{').replace(/&#125;/g, '}').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}

/** cleanName from a node id, matching the compose system's convention. Used only by the
 *  legacy `stripScrollTextHooks` sweep below. */
const teCleanName = nodeIdToVarName;

// ─── Legacy readers (build-time span form) ───────────────────────────────────
// Retained so a page written by the OLD generator upgrades itself when its effect is
// next edited. Nothing emits this form any more.

/** Strip the On Scroll body hooks for a node (Te-named — never touches element scroll/compose hooks).
 *  Exported so node-delete cleanup (`removeNodeInCode`) clears them before the JSX strip. */
export function stripScrollTextHooks(code: string, nodeId: string): string {
  // Cheap bail BEFORE the regex sweeps: every hook stripped below is named
  // `<teCleanName>Te…`. If that prefix isn't even in the source, there's nothing
  // to strip — skip the full-page regex passes. On a multi-delete this ran once
  // per deleted node, scanning 125KB each time for markers that weren't there.
  const tcn = teCleanName(nodeId);
  // Bail must also cover the `Ta*` hoisted view consts swept below — a pure
  // On-View responsive anim has NO `Te*` scroll hooks, and the old `Te`-only
  // check skipped the sweep, orphaning `<cn>TaOut/TaIn/TaTr` on view->scroll
  // switches (the dangling-refs regression this file's test locks).
  if (!code.includes(`${tcn}Te`) && !code.includes(`${tcn}Ta`)) return code;
  const cn = tcn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let r = code;
  // WHITESPACE-FLEXIBLE: a babel parse/generate reformat can collapse the emitted
  // spaced form (`{ x.current = … }`) into a compact one (`{x.current = …}`), and a
  // later re-apply then adds a fresh spaced copy → a DUPLICATE useEffect. The old
  // fixed-space regexes missed the compact copy, so a `removeTextAnim` left it
  // behind referencing the now-deleted `…TeRef` → "undefined identifier, would
  // crash at runtime" (the reported delete block). `\\s*` everywhere + the global
  // flag now sweeps every form/copy. Same class as the pagination-hook heal.
  r = r.replace(new RegExp(`\\s*const\\s+${cn}TeRef\\s*=\\s*useRef\\(null\\);`, 'g'), '');
  r = r.replace(new RegExp(`\\s*useEffect\\(\\(\\)\\s*=>\\s*\\{\\s*${cn}TeRef\\.current\\s*=\\s*[^;]*;\\s*\\}\\s*,\\s*\\[\\]\\);`, 'g'), '');
  r = r.replace(new RegExp(`\\s*const\\s+\\{\\s*scrollYProgress:\\s*${cn}TeSP\\s*\\}\\s*=\\s*useScroll\\([^;]*\\);`, 'g'), '');
  r = r.replace(new RegExp(`\\s*const\\s+${cn}Te\\d+[A-Za-z]+\\s*=\\s*useTransform\\([^;]*\\);`, 'g'), '');
  // Responsive (gated) hoisted consts — present only when config.responsive had entries.
  r = r.replace(new RegExp(`\\s*const\\s+${cn}Ta(?:Out|In|Tr)\\s*=\\s*\\{[^;]*\\};`, 'g'), '');
  // Hybrid (mixed view/scroll) gate boolean.
  r = r.replace(new RegExp(`\\s*const\\s+${cn}TaScroll\\s*=\\s*[^;]*;`, 'g'), '');
  return r;
}

/** Strip all <motion.span ...>X</motion.span> wrappers, keeping X.
 *  Uses brace-counting to find the tag-closing > in multi-line attributes. */
function stripMotionSpanWrappers(code: string): string {
  const OPEN = '<motion.span';
  const CLOSE = '</motion.span>';
  let result = '';
  let i = 0;

  while (i < code.length) {
    const nextOpen = code.indexOf(OPEN, i);
    if (nextOpen < 0) {
      result += code.slice(i);
      break;
    }
    // Copy everything before this <motion.span
    result += code.slice(i, nextOpen);

    // Find the closing > of the opening tag (skip nested {{ }})
    const tagClose = findTagClose(code, nextOpen);
    if (tagClose < 0) { result += code.slice(nextOpen); break; }

    // Find the matching </motion.span>
    const closeIdx = code.indexOf(CLOSE, tagClose + 1);
    if (closeIdx < 0) { result += code.slice(nextOpen); break; }

    // Extract content between opening tag close and </motion.span>
    result += code.slice(tagClose + 1, closeIdx);
    i = closeIdx + CLOSE.length;
  }

  return result;
}

/** Extract plain text from motion.span children in a code region.
 *  Handles multi-line reformatted code (Prettier expands attributes). */
export function collapseMotionSpans(innerContent: string): string {
  let text = innerContent;

  // Remove word wrapper spans (may be multi-line after formatting)
  // <span style={{ whiteSpace: "nowrap" }}>...</span>
  text = text.replace(/<span\s+style=\{\{[\s\S]*?whiteSpace:\s*"nowrap"[\s\S]*?\}\}>([\s\S]*?)<\/span>/g, '$1');

  // Remove motion.span wrappers — these have multi-line variants={{ ... }} and style={{ ... }}
  // Use brace-counting approach instead of regex since attributes contain nested {{ }}
  text = stripMotionSpanWrappers(text);

  // Decode JSX escapes
  text = text.replace(/\{" "\}/g, ' ');
  text = text.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  text = text.replace(/&#123;/g, '{').replace(/&#125;/g, '}');
  text = text.replace(/&amp;/g, '&');
  // Clean up excess whitespace from multi-line formatting
  text = text.replace(/\s+/g, ' ');
  return text.trim();
}

/** Heal the `indexOf`-matched-CSS corruption: a `<style>`/`<motion.style>` element that carries
 *  `data-text-anim` (text-effect spans baked into a style tag — never legitimate). Removes the whole
 *  corrupt element. The real `@media` CSS lives in a SEPARATE intact `<style>`, and the spans are
 *  duplicated on the real node, so removal is safe. Idempotent + cheap no-op when nothing is corrupt. */
function healCorruptedStyleTextAnim(code: string): string {
  if (!/<(?:motion\.)?style\b[^>]*\sdata-text-anim=/.test(code)) return code;
  let r = code;
  const re = /<(motion\.style|style)\b[^>]*\sdata-text-anim=/;
  let guard = 0;
  while (guard++ < 50) {
    const m = r.match(re);
    if (!m || m.index === undefined) break;
    const tagStart = m.index;
    const tagName = m[1];
    const openEnd = findTagClose(r, tagStart);
    const closeIdx = findClosingTag(r, tagStart, tagName);
    if (openEnd < 0 || closeIdx < 0) break;
    r = r.slice(0, tagStart) + r.slice(closeIdx + `</${tagName}>`.length);
    trace.action('text-anim-gen:heal-corrupt-style', { tagName });
  }
  return r;
}

// ─── Wrapper content resolution ──────────────────────────────────────────────

/** Inline mark tags a rich run may carry — mirror of the runtime splitter's
 *  INLINE_MARK_TAGS (`@revyme/runtime` split-text.tsx). The two lists MUST
 *  agree: a tag this passes through that the runtime doesn't recognise makes
 *  the whole node fall back to an unanimated verbatim render. */
const INLINE_MARK_TAGS = new Set(['span', 'strong', 'em', 'b', 'i', 'u', 's', 'small', 'sub', 'sup', 'mark', 'code', 'a']);

/** Normalize a marked-up inner to the rich form the runtime splitter accepts,
 *  or null when it isn't purely inline marks (then the caller plain-folds as
 *  before). Paragraph structure normalizes exactly like jsxInnerToPlainText
 *  (`</p><p>` boundaries → `<br />`, outer `<p>` unwrapped) but the MARK TAGS
 *  SURVIVE — applying a Text effect used to silently strip bold/color
 *  (live find 2026-09-05); the runtime now splits around them.
 */
export function normalizeInlineRichInner(inner: string): string | null {
  let cand = inner.trim()
    .replace(/<\/p>\s*<p[^>]*>/gi, '<br />')
    .replace(/^<p[^>]*>/i, '')
    .replace(/<\/p>$/i, '')
    .trim();
  if (!cand) return null;
  const ast = parseJSX(`<x>${cand}</x>`);
  if (!ast) return null;
  let hasMark = false;
  let ok = true;
  const walk = (node: any): void => {
    if (!ok || !node) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === 'JSXText') return;
    if (node.type === 'JSXExpressionContainer') {
      // `{" "}` space preservers are fine; any live expression means this
      // is not a simple rich run — let the caller's existing paths decide.
      if (node.expression?.type !== 'StringLiteral') ok = false;
      return;
    }
    if (node.type === 'JSXElement') {
      const tag = node.openingElement?.name?.name;
      if (tag === 'br') return;
      if (typeof tag !== 'string' || !INLINE_MARK_TAGS.has(tag)) { ok = false; return; }
      hasMark = true;
      walk(node.children);
      return;
    }
    if (node.type === 'JSXFragment') { walk(node.children); return; }
  };
  traverse(ast, {
    JSXElement(pp) {
      if (pp.parentPath?.parentPath?.isProgram()) { walk(pp.node.children); pp.stop(); }
    },
  });
  return ok && hasMark ? cand : null;
}

/** What goes INSIDE `<RevymeSplitText>`.
 *
 *  The critical branch is (c): a node whose children are a single expression container —
 *  `{item.title}`, `{t('key')}`, `{propName}`, `{variant === 'a' ? … : …}` — is returned
 *  VERBATIM. The old generator folded that to plain text and escaped it per character, which
 *  is what turned a CMS binding into the literal string `{item.title}` on every row. Keeping
 *  the raw slice is the whole fix; the runtime receives the resolved string instead.
 *
 *  Branch (b) is what upgrades a page written by the old generator, so no migration pass is
 *  needed: editing a legacy effect collapses its spans and rewrites it in the new form. */
function resolveWrapperContent(code: string, nodeId: string, inner: string): { content: string; code: string } {
  // (a) already wrapped → reuse the wrapper's own inner (idempotent re-apply)
  const wrapOpen = inner.indexOf(`<${SPLIT_TEXT_TAG}`);
  if (wrapOpen >= 0) {
    const gt = findTagClose(inner, wrapOpen);
    const close = inner.lastIndexOf(`</${SPLIT_TEXT_TAG}>`);
    if (gt >= 0 && close > gt) return { content: inner.slice(gt + 1, close), code };
  }

  // (b) LEGACY build-time spans → collapse to text and sweep the old body hooks
  if (inner.includes('<motion.span')) {
    trace.action('text-anim-gen:legacy-collapse', { nodeId });
    return { content: escapeText(collapseMotionSpans(inner)), code: stripScrollTextHooks(code, nodeId) };
  }

  // (c) a single expression child → VERBATIM (the CMS / i18n / variable / conditional case)
  const single = singleExpressionChild(inner);
  if (single) return { content: single, code };

  // (d) inline MARKS (`<strong>`, styled `<span>`) → preserved: the runtime
  // splitter walks them and animates the glyphs inside (bold/color used to be
  // silently stripped here). Paragraph wrappers normalize to `<br />`.
  if (/<(?!br\b)/.test(inner)) {
    const rich = normalizeInlineRichInner(inner);
    if (rich !== null) return { content: rich, code };
    // (d2) any other markup → fold to plain text + real <br /> (unchanged)
    return { content: escapeText(jsxInnerToPlainText(inner)), code };
  }

  // (e) plain text and/or <br /> — already correct
  return { content: inner, code };
}

/** The raw source of `inner` when it is exactly ONE JSXExpressionContainer holding something
 *  other than a plain string literal (ignoring whitespace). Returns null otherwise. */
function singleExpressionChild(inner: string): string | null {
  const trimmed = inner.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  const ast = parseJSX(`<x>${trimmed}</x>`);
  if (!ast) return null;
  let found: string | null = null;
  let bad = false;
  const walk = (n: any) => {
    if (!n || bad) return;
    if (n.type === 'JSXElement' && n.openingElement?.name?.name === 'x') {
      const kids = (n.children ?? []).filter((c: any) =>
        !(c.type === 'JSXText' && !c.value.trim()));
      if (kids.length !== 1 || kids[0].type !== 'JSXExpressionContainer') { bad = true; return; }
      if (kids[0].expression?.type === 'StringLiteral') { bad = true; return; }
      found = trimmed;
      return;
    }
    for (const key of Object.keys(n)) {
      const v = (n as any)[key];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object' && v.type) walk(v);
    }
  };
  walk(ast.program ?? ast);
  return bad ? null : found;
}

/** Escape text for JSX, turning `\n` boundaries into real `<br />` elements. */
function escapeText(text: string): string {
  return text.split('\n').map((line) => line
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\{/g, '&#123;').replace(/\}/g, '&#125;')).join('<br />');
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Strip the spec attribute and the legacy per-parent reveal attrs from an opening tag. */
function stripSpecAttrs(openingTag: string): string {
  let t = openingTag
    .replace(/\s*data-text-anim='[^']*'/g, '')
    .replace(/\s*data-text-anim="[^"]*"/g, '')
    .replace(/\s*initial="hidden"/g, '')
    .replace(/\s*whileInView="visible"/g, '');
  t = stripTagAttrBalanced(t, 'viewport');
  t = stripTagAttrBalanced(t, 'variants');
  return t;
}

/** Locate a node's opening tag, its tag name, and the span of its children. */
function locate(code: string, nodeId: string): { tagStart: number; openEnd: number; closeIdx: number; tagName: string } | null {
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx < 0) return null;
  const tagStart = code.lastIndexOf('<', idIdx);
  if (tagStart < 0) return null;
  const m = code.slice(tagStart).match(/^<(motion\.\w+|\w+)/);
  if (!m) return null;
  const openEnd = findTagClose(code, tagStart);
  if (openEnd < 0) return null;
  const closeIdx = findClosingTag(code, tagStart, m[1]);
  if (closeIdx < 0) return null;
  return { tagStart, openEnd, closeIdx, tagName: m[1] };
}

/**
 * Add (or re-apply) a text animation. Writes the spec attribute and wraps the node's children
 * in `<RevymeSplitText>`. Emits NO hooks, so it is identical for a node in a viewport and one
 * parked in the module-scope `canvasNodes` fragment — the old dormant/rehydrate split is gone.
 */
export function addTextAnimInCode(code: string, nodeId: string, config: TextAnimConfig): string {
  trace.fn('text-anim-gen:add', { nodeId, animationType: config.animationType });
  code = healCorruptedStyleTextAnim(code);

  const loc = locate(code, nodeId);
  if (!loc) { trace.error('text-anim-gen:add:not-found', { nodeId }); return code; }

  const inner = code.slice(loc.openEnd + 1, loc.closeIdx);
  const resolved = resolveWrapperContent(code, nodeId, inner);
  const working = resolved.code;

  // stripScrollTextHooks (legacy path) shifts indices — re-locate before splicing.
  const loc2 = working === code ? loc : locate(working, nodeId);
  if (!loc2) return code;

  const openingTag = working.slice(loc2.tagStart, loc2.openEnd + 1);
  const lastGt = openingTag.lastIndexOf('>');
  const attrs = stripSpecAttrs(openingTag.slice(0, lastGt));
  const newOpen = `${attrs} data-text-anim='${JSON.stringify(config)}'>`;

  // The active-variant prop for `{variant}` scopes. Connection-LESS components
  // have no `variant` useState — only the `initialVariant` prop — and emitting
  // `variant={variant}` there is an undefined identifier the oracle rightly
  // blocks ("X on a variant tile bounced every write", live find 2026-09-05).
  // Same detection updateVariantTextInCode uses for its ternary identifier.
  const variantId = /\bconst\s*\[\s*variant\b/.test(working) ? 'variant' : 'initialVariant';
  const variantAttr = needsVariantProp(config) ? ` variant={${variantId}}` : '';
  const wrapper = `<${SPLIT_TEXT_TAG} spec={${buildSplitTextSpecSource(config)}}${variantAttr}>`
    + resolved.content + `</${SPLIT_TEXT_TAG}>`;

  let result = working.slice(0, loc2.tagStart) + newOpen + wrapper
    + working.slice(loc2.closeIdx);
  result = ensureNamedImport(result, RUNTIME_MODULE, [SPLIT_TEXT_TAG]);

  trace.action('text-anim-gen:add:done', {
    nodeId, tagName: loc2.tagName, trigger: config.trigger ?? 'view',
    responsive: config.responsive?.length ?? 0, expression: !!singleExpressionChild(inner),
  });
  return result;
}

/** Update the spec — remove then re-add. Remove is what cleans up a legacy span form, so this
 *  doubles as the per-node upgrade path. */
export function updateTextAnimInCode(code: string, nodeId: string, config: TextAnimConfig): string {
  trace.fn('text-anim-gen:update', { nodeId, animationType: config.animationType });
  if (findJSXDataIdIndex(code, nodeId) < 0) return code;
  const collapsed = removeTextAnimFromCode(code, nodeId);
  return addTextAnimInCode(collapsed === code ? code : collapsed, nodeId, config);
}

/** Remove a text animation: unwrap the children and strip the spec attribute. Handles both the
 *  wrapper form and the legacy span form. The tag name is left alone — the parent no longer
 *  needs to be `motion.*` for a text effect, and stripping the prefix would break an element
 *  effect that also lives on it. */
export function removeTextAnimFromCode(code: string, nodeId: string): string {
  trace.fn('text-anim-gen:remove', { nodeId });
  code = healCorruptedStyleTextAnim(code);
  const loc = locate(code, nodeId);
  if (!loc) return code;

  const inner = code.slice(loc.openEnd + 1, loc.closeIdx);
  let content = inner;
  let working = code;

  const wrapOpen = inner.indexOf(`<${SPLIT_TEXT_TAG}`);
  if (wrapOpen >= 0) {
    const gt = findTagClose(inner, wrapOpen);
    const close = inner.lastIndexOf(`</${SPLIT_TEXT_TAG}>`);
    if (gt >= 0 && close > gt) content = inner.slice(gt + 1, close);
  } else if (inner.includes('<motion.span')) {
    content = escapeText(collapseMotionSpans(inner));
    working = stripScrollTextHooks(code, nodeId);
  }

  const loc2 = working === code ? loc : locate(working, nodeId);
  if (!loc2) return code;
  const openingTag = working.slice(loc2.tagStart, loc2.openEnd + 1);
  const lastGt = openingTag.lastIndexOf('>');
  const newOpen = `${stripSpecAttrs(openingTag.slice(0, lastGt))}>`;

  trace.action('text-anim-gen:remove:done', { nodeId });
  return working.slice(0, loc2.tagStart) + newOpen + content + working.slice(loc2.closeIdx);
}
