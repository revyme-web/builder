// generator-attrs.ts — HTML / SVG attribute writes against the JSX source.
// HTML attribute updates, tag-name changes, SVG attribute updates (with fast +
// AST paths), and SVG child add / remove. Self-contained — does not depend on
// other generator-* modules.

import * as t from '@babel/types';
import { parseJSX, findFirstElementByDataId, findAttribute, traverse } from '../parsing/ast-utils';
import { SVG_SHAPE_TAGS } from '@/shared/constants';
import { trace } from '@/shared/debug-trace';
import { translateShapeGeometry, translatePathD } from '@/shared/svg-geometry';
import { generate, findTagClose, findJSXDataIdIndex, findMatchingCloseTagIndex } from './generator-utils';

// ─── Variant Style Update ───────────────────────────────────────────────────

/**
 * Update styles in a framer-motion variant object.
 * Finds the variant object that contains the target nodeId's data-id,
 * locates the variant entry by name, and updates/adds properties.
 *
 * The node's `variants` prop references a const like `navVariants`.
 * We find that const's object and update the specific variant key.
 *
 * Strategy: find `const xxxVariants = { ..., variantName: { ...props... }, ... }`
 * and update/add properties in the variant's object.
 */
// ─── HTML Attribute Update ───────────────────────────────────────────────────

/**
 * Update arbitrary HTML attributes directly on the element with the given data-id.
 * Empty string value removes the attribute.
 * Uses findTagClose for brace-safe tag boundary detection.
 */
export function updateHtmlAttrsInCode(
  code: string,
  nodeId: string,
  attrs: Record<string, string>,
): string {
  trace.fn('generator.updateHtmlAttrsInCode', { nodeId, attrs });

  const idPattern = `data-id="${nodeId}"`;
  const idIndex = findJSXDataIdIndex(code, nodeId);
  if (idIndex === -1) return code;

  const tagStart = code.lastIndexOf('<', idIndex);
  if (tagStart === -1) return code;

  const tagEnd = findTagClose(code, idIndex);
  if (tagEnd === -1) return code;

  let tagStr = code.slice(tagStart, tagEnd + 1);

  for (const [key, value] of Object.entries(attrs)) {
    if (value === '') {
      // Require a whitespace prefix so we don't strip `data-id="..."`
      // when removing `id`. `data-id` has `-` before `id`, not whitespace,
      // so this regex won't accidentally match it. Match BOTH quote styles
      // (a JSON attr like data-overlay-trigger is single-quoted).
      tagStr = tagStr.replace(new RegExp(`\\s+${key}=(?:"[^"]*"|'[^']*')`, 'g'), '');
    } else {
      // Same whitespace-prefix guard. The previous regex `(${key}=)"…"`
      // matched substring positions inside other attribute names — most
      // notably `data-id="…"` when updating `id`, which silently
      // overwrote the node's data-id and made it disappear from the
      // parser/selection. The whitespace anchor pins the match to the
      // start of an attribute name.
      //
      // CRITICAL: match BOTH single- AND double-quoted existing values. An
      // attr whose value is JSON (e.g. `data-overlay-trigger='{"targetId":…}'`)
      // is emitted SINGLE-quoted; the old double-quote-only regex missed it and
      // fell through to the append branch, producing a SECOND attr written as
      // `key="{"targetId":…}"` — double quotes wrapping double-quote JSON, which
      // is invalid JSX and crashed the page on paste (the overlay-trigger remap).
      // The written value is single-quoted when it contains `"` (JSON), else
      // double-quoted (normal attrs).
      const q = value.includes('"') ? "'" : '"';
      const lit = `${q}${value}${q}`;
      const attrRegex = new RegExp(`(\\s)(${key}=)(?:"[^"]*"|'[^']*')`);
      if (attrRegex.test(tagStr)) {
        tagStr = tagStr.replace(attrRegex, `$1$2${lit}`);
      } else if (tagStr.endsWith('/>')) {
        tagStr = tagStr.slice(0, -2) + ` ${key}=${lit} />`;
      } else {
        tagStr = tagStr.slice(0, -1) + ` ${key}=${lit}>`;
      }
    }
  }

  return code.slice(0, tagStart) + tagStr + code.slice(tagEnd + 1);
}

/**
 * Strip `data-responsive` from a node AND every descendant in its JSX subtree.
 *
 * The attribute keys per-breakpoint instance-prop overrides to the SOURCE
 * page's viewport widths (`{"375":{…},"768":{…},"_bp":[375,768,1440]}`).
 * On the canvas there are no viewports to key against, and re-entering a page
 * whose breakpoint set differs applies stale widths' overrides (user report
 * 2026-07-27) — so every exit-to-canvas sheds it, for the dragged node and for
 * any instance nested inside a dragged section alike.
 */
export function stripDataResponsiveInSubtree(code: string, nodeId: string): string {
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx === -1) return code;
  const tagStart = code.lastIndexOf('<', idIdx);
  const tagEnd = findTagClose(code, idIdx);
  if (tagStart === -1 || tagEnd === -1) return code;

  // Subtree end: the matching close tag for a normal element, the tag close
  // itself when self-closing.
  let subtreeEnd = tagEnd + 1;
  if (code[tagEnd - 1] !== '/') {
    const tagName = code.slice(tagStart + 1).match(/^[\w.]+/)?.[0];
    if (tagName) {
      const closeIdx = findMatchingCloseTagIndex(code, tagName, tagEnd + 1);
      if (closeIdx !== -1) subtreeEnd = closeIdx + `</${tagName}>`.length;
    }
  }

  const before = code.slice(tagStart, subtreeEnd);
  // Both quote styles: the value is JSON, emitted single-quoted; hand-written
  // double-quoted variants are matched too.
  const after = before.replace(/\s+data-responsive=(?:'[^']*'|"[^"]*")/g, '');
  if (after === before) return code;
  trace.action('generator:strip-data-responsive-subtree', {
    nodeId, removed: (before.match(/data-responsive=/g) ?? []).length,
  });
  return code.slice(0, tagStart) + after + code.slice(subtreeEnd);
}

/**
 * Rename the HTML tag of the element with the given data-id.
 * Replaces both opening and closing tags. No-op for self-closing elements.
 */
export function changeTagInCode(
  code: string,
  nodeId: string,
  newTag: string,
): string {
  trace.fn('generator.changeTagInCode', { nodeId, newTag });

  const idPattern = `data-id="${nodeId}"`;
  const idIndex = findJSXDataIdIndex(code, nodeId);
  if (idIndex === -1) return code;

  const tagStart = code.lastIndexOf('<', idIndex);
  if (tagStart === -1) return code;

  const tagNameMatch = code.slice(tagStart + 1, tagStart + 60).match(/^(\w[\w.-]*)/);
  if (!tagNameMatch) return code;
  const oldTag = tagNameMatch[1];
  if (oldTag === newTag) return code;

  const tagEnd = findTagClose(code, tagStart);
  if (tagEnd === -1) return code;

  // Replace opening tag name
  let result = code.slice(0, tagStart + 1) + newTag + code.slice(tagStart + 1 + oldTag.length);

  const adjustedTagEnd = tagEnd + (newTag.length - oldTag.length);

  // Self-closing — no closing tag to fix
  if (result.slice(adjustedTagEnd - 1, adjustedTagEnd + 1) === '/>') return result;

  // Find matching </oldTag> via the shared depth matcher (skips self-closing
  // same-tag children — the bug class findMatchingCloseTagIndex documents).
  const closeTagToken = `</${oldTag}>`;
  const closeIdx = findMatchingCloseTagIndex(result, oldTag, adjustedTagEnd + 1);
  if (closeIdx !== -1) {
    result = result.slice(0, closeIdx) + `</${newTag}>` + result.slice(closeIdx + closeTagToken.length);
  }

  return result;
}


// ─── Convert element → MotionLink (motion.create(Link)) ──────────────────────

/**
 * Convert an element on a component MASTER into a `<MotionLink>` — the
 * `motion.create(Link)` wrapper that gives client-side Next.js navigation
 * AND keeps framer-motion props (variants / layout / animate). Renames the
 * tag (the canvas renderer maps `MotionLink → a`, the runtime resolves the
 * real `motion.create(Link)` component) and injects the module-level
 * `const MotionLink = motion.create(Link);` declaration once.
 *
 * Why a wrapper and not `<Link>` or `<motion.Link>`:
 *   - plain `<Link>` isn't a motion component → drops the element's layout
 *     animation and leaks `variants`/`initial` props onto the DOM <a>.
 *   - `<motion.Link>` is invalid — framer-motion's `motion` proxy only knows
 *     HTML tag names, so `motion.Link` evaluates to a broken custom element
 *     (which is why mutation-queue self-heals `motion.<Upper>` → `<Upper>`).
 * `motion.create(Link)` is the documented way to animate a custom component.
 *
 * `Link` is imported by `buildAutoImports` (it detects `MotionLink` in the
 * body). The styles reset (textDecoration/color) is intentionally NOT applied
 * here — a link-wrapped frame carries its own background and no text, so the
 * default anchor styling never shows.
 */
export function convertToMotionLinkInCode(code: string, nodeId: string): string {
  trace.fn('generator.convertToMotionLinkInCode', { nodeId });
  const ast = parseJSX(code);
  if (!ast) return code;

  let touched = false;
  findFirstElementByDataId(ast, nodeId, (path: any) => {
    path.node.openingElement.name = t.jsxIdentifier('MotionLink');
    if (path.node.closingElement) path.node.closingElement.name = t.jsxIdentifier('MotionLink');
    touched = true;
  });
  if (!touched) return code;

  let out: string;
  try {
    out = generate(ast, { retainLines: true }, code).code;
  } catch (err) {
    trace.error('generator.convertToMotionLink-failed', { nodeId, error: err instanceof Error ? err.message : String(err) });
    return code;
  }

  // Inject the declaration via a STRING op on its own line — NOT a babel
  // splice. With `retainLines`, a spliced top-level node has no source line so
  // babel squishes it onto the preceding import (`…'@revyme/runtime';const
  // MotionLink = …`). syncImports would then treat that whole line as the
  // framework import and drop it — taking the const with it.
  if (!/\bconst\s+MotionLink\s*=/.test(out)) {
    out = injectMotionLinkConst(out);
  }
  trace.action('generator.convert-to-motion-link', { nodeId });
  return out;
}

/** Insert `const MotionLink = motion.create(Link);` on its own line, after the
 *  last import (or after a leading `'use client'` when there are no imports). */
function injectMotionLinkConst(code: string): string {
  const lines = code.split('\n');
  const decl = 'const MotionLink = motion.create(Link);';
  let lastImportIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*import\b/.test(lines[i])) lastImportIdx = i;
  }
  if (lastImportIdx !== -1) {
    lines.splice(lastImportIdx + 1, 0, decl);
  } else {
    const insertAt = /^\s*['"]use client['"]/.test(lines[0] || '') ? 1 : 0;
    lines.splice(insertAt, 0, decl);
  }
  return lines.join('\n');
}

// ─── SVG Attribute Update ────────────────────────────────────────────────────

/**
 * Update SVG presentation attributes on the inner shape child of an <svg> element.
 * Finds `data-id="${nodeId}"` → locates the first inner shape child (rect, path, etc.)
 * → updates/adds/removes the specified attributes.
 *
 * FAST PATH: regex-based string replacement when attrs already exist.
 * SLOW PATH: full AST when adding new attributes.
 */
export function updateSvgAttrsInCode(
  code: string,
  nodeId: string,
  attrs: Record<string, string>,
  childIndex?: number,
): string {
  trace.fn('generator.updateSvgAttrsInCode', { nodeId, attrs, childIndex });

  const fast = updateSvgAttrsFast(code, nodeId, attrs, childIndex);
  if (fast !== null) return fast;
  return updateSvgAttrsAST(code, nodeId, attrs, childIndex);
}

/**
 * FAST PATH: Find the inner shape element after `data-id="${nodeId}"` and replace attr values.
 * Returns null if any attr doesn't already exist on the element (fall back to AST).
 * When childIndex > 0, falls through to AST path (regex can't reliably skip shape children).
 */
function updateSvgAttrsFast(
  code: string,
  nodeId: string,
  attrs: Record<string, string>,
  childIndex?: number,
): string | null {
  // childIndex > 0: regex can't reliably skip multiple shape children → fall through to AST
  if (childIndex != null && childIndex > 0) return null;

  // Find the SVG wrapper by data-id
  const idPattern = `data-id="${nodeId}"`;
  const idIndex = findJSXDataIdIndex(code, nodeId);
  if (idIndex === -1) return null;

  // Find the closing > of the SVG opening tag
  const svgTagEnd = code.indexOf('>', idIndex);
  if (svgTagEnd === -1) return null;

  // Find the next < after the SVG opening tag — this is the inner shape element
  const innerStart = code.indexOf('<', svgTagEnd + 1);
  if (innerStart === -1) return null;

  // Verify it's a shape tag (rect, circle, ellipse, polygon, path, line, polyline, g)
  // Accept the motion-ized form too (`motion.path` — e.g. an inner carrying
  // per-variant `d` geometry). Matching bare \w+ only made every svg-attr
  // write (rotation attr clear, bake geometry) a SILENT no-op once the inner
  // gained a variants prop (live find 2026-06-12).
  const innerTagMatch = code.slice(innerStart + 1, innerStart + 40).match(/^(?:motion\.)?(\w+)/);
  if (!innerTagMatch) return null;
  const innerTag = innerTagMatch[1];
  if (!SVG_SHAPE_TAGS.has(innerTag)) return null;

  // Find the end of the inner element's opening tag (either /> or >)
  const innerTagEnd = code.indexOf('>', innerStart);
  if (innerTagEnd === -1) return null;

  // Get the full inner tag string
  const innerTagStr = code.substring(innerStart, innerTagEnd + 1);

  let newInnerTag = innerTagStr;
  for (const [key, value] of Object.entries(attrs)) {
    // Convert camelCase to kebab for SVG attributes
    const svgKey = key.replace(/([A-Z])/g, '-$1').toLowerCase();
    // Also derive the camelCase variant. Some source paths have legacy
    // camelCase SVG attrs (`strokeWidth`, `dataPoints`) that need to be
    // updated even when the caller passes kebab — without this, the
    // regex misses the existing attr, the fast path bails to AST, and
    // the AST path may also miss → silent disconnect. Trying all three
    // forms keeps both fast + AST paths in sync.
    const camelKey = svgKey.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    const keysToTry = Array.from(new Set([key, svgKey, camelKey]));

    if (value === '') {
      // Remove attribute
      let removed = false;
      for (const k of keysToTry) {
        const removeRegex = new RegExp(`\\s+${k}="[^"]*"`, 'g');
        if (removeRegex.test(newInnerTag)) {
          newInnerTag = newInnerTag.replace(removeRegex, '');
          removed = true;
          break;
        }
      }
      // If attr doesn't exist, nothing to remove — that's fine
      if (!removed) continue;
    } else {
      // Update existing or fail to AST. REQUIRE a whitespace boundary before the
      // attr name (`\s`), like the remove regex above. Without it, writing `d`
      // matched the `d=` INSIDE `data-id="…"` (the `d` in `-id`) — which on a
      // STAMPED child (`<path data-id="…-g0" d="…">`, data-id before d) overwrote
      // the data-id's VALUE with the path, corrupting the node id and cascading
      // into x10 geometry / viewBox doubling. The boundary makes `\sd=` match only
      // the real ` d=` attribute, never `data-id`.
      let found = false;
      for (const k of keysToTry) {
        const attrRegex = new RegExp(`(\\s${k}=)"[^"]*"`);
        if (attrRegex.test(newInnerTag)) {
          newInnerTag = newInnerTag.replace(attrRegex, `$1"${value}"`);
          found = true;
          break;
        }
      }
      if (!found) return null; // Attr doesn't exist — fall back to AST
    }
  }

  return code.substring(0, innerStart) + newInnerTag + code.substring(innerTagEnd + 1);
}

/**
 * SLOW PATH: Full AST parse. Find the SVG element by data-id, then the Nth
 * shape JSXElement child, and update/add/remove attributes.
 * When childIndex is provided, collects all shape children and targets the Nth one.
 */
function updateSvgAttrsAST(
  code: string,
  nodeId: string,
  attrs: Record<string, string>,
  childIndex?: number,
): string {
  const ast = parseJSX(code);
  if (!ast) return code;

  findFirstElementByDataId(ast, nodeId, (path) => {
    // Collect shape JSXElement children (skip <defs>, <g> wrappers without shape tag, etc.)
    const shapeChildren: t.JSXElement[] = [];
    for (const child of path.node.children) {
      if (child.type === 'JSXElement') {
        const name = child.openingElement.name;
        const tagName = t.isJSXIdentifier(name) ? name.name : null;
        if (tagName && SVG_SHAPE_TAGS.has(tagName)) {
          shapeChildren.push(child);
        }
      }
    }

    // Target the Nth shape child (default: first)
    const targetIdx = childIndex ?? 0;
    const innerEl = shapeChildren[targetIdx] ?? null;
    if (!innerEl) return;

    const opening = innerEl.openingElement;

    for (const [key, value] of Object.entries(attrs)) {
      // Convert camelCase to kebab for SVG
      const svgKey = key.replace(/([A-Z])/g, '-$1').toLowerCase();
      // Also build the camelCase form so we can find legacy attrs that
      // got serialized that way at some point. Kebab `stroke-width`
      // ↔ camel `strokeWidth`. This lets a single mutation update an
      // attribute regardless of the case form already in source —
      // important because old sketches wrote `strokeWidth` /
      // `dataPoints` while new ones use kebab. Without this fallback
      // the matcher missed the existing attribute, fell into the
      // "add new" branch, and produced duplicates that the user saw
      // as "the live-sync stopped touching old strokes".
      const camelKey = svgKey.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

      // Find existing attribute (try kebab, original key, AND camelCase)
      const existingIdx = opening.attributes.findIndex(
        (a): a is t.JSXAttribute =>
          t.isJSXAttribute(a) &&
          t.isJSXIdentifier(a.name) &&
          (a.name.name === key || a.name.name === svgKey || a.name.name === camelKey)
      );

      if (value === '') {
        // Remove attribute
        if (existingIdx !== -1) {
          opening.attributes.splice(existingIdx, 1);
        }
      } else if (existingIdx !== -1) {
        // Update existing
        (opening.attributes[existingIdx] as t.JSXAttribute).value = t.stringLiteral(value);
      } else {
        // Add new attribute (use kebab-case for SVG)
        opening.attributes.push(
          t.jsxAttribute(t.jsxIdentifier(svgKey), t.stringLiteral(value))
        );
      }
    }

    path.stop();
  });

  try {
    return generate(ast, { retainLines: false, concise: false }, code).code;
  } catch (err) {
    trace.error('generator:updateSvgAttrsAST-generate-failed', { nodeId, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}


// ─── SVG Child Add / Remove ─────────────────────────────────────────────────

/**
 * Append a new SVG shape child element inside an SVG wrapper.
 * The childJSX should be a self-closing or simple JSX element string
 * (e.g. `<line x1="0" y1="0" x2="100" y2="100" stroke="black" />`).
 */
export function addSvgChildInCode(
  code: string,
  nodeId: string,
  childJSX: string,
): string {
  trace.fn('generator.addSvgChildInCode', { nodeId, childJSX });

  // Find the SVG wrapper by data-id
  const idPattern = `data-id="${nodeId}"`;
  const idIndex = findJSXDataIdIndex(code, nodeId);
  if (idIndex === -1) return code;

  // Find the closing </svg> tag for this element
  // First find the opening > of the SVG tag
  const svgTagEnd = code.indexOf('>', idIndex);
  if (svgTagEnd === -1) return code;

  // Check if self-closing <svg ... /> — need to convert to <svg ...>childJSX</svg>
  if (code[svgTagEnd - 1] === '/') {
    // Self-closing SVG: <svg ... /> → <svg ...>\n  childJSX\n</svg>
    const beforeSlash = code.substring(0, svgTagEnd - 1).trimEnd();
    // Detect indent from the SVG line
    const lineStart = code.lastIndexOf('\n', idIndex);
    const indent = lineStart >= 0 ? code.slice(lineStart + 1, code.indexOf('<', lineStart + 1)) : '      ';
    return beforeSlash + '>\n' + indent + '  ' + childJSX.trim() + '\n' + indent + '</svg>' + code.substring(svgTagEnd + 1);
  }

  // Find </svg> closing tag (nesting handled by the shared depth matcher).
  const nextClose = findMatchingCloseTagIndex(code, 'svg', svgTagEnd + 1);
  if (nextClose !== -1) {
    // Insert childJSX before </svg>
    const lineStart = code.lastIndexOf('\n', nextClose);
    const indent = lineStart >= 0 ? code.slice(lineStart + 1, nextClose).replace(/\S.*/, '') : '      ';
    return code.substring(0, nextClose) + indent + childJSX.trim() + '\n' + code.substring(nextClose);
  }

  return code;
}

/**
 * Remove the Nth shape child from an SVG wrapper.
 * Uses SVG_SHAPE_TAGS to identify shape children (skips <defs>, text nodes, etc.).
 */
export function removeSvgChildInCode(
  code: string,
  nodeId: string,
  childIndex: number,
): string {
  trace.fn('generator.removeSvgChildInCode', { nodeId, childIndex });

  const ast = parseJSX(code);
  if (!ast) return code;

  findFirstElementByDataId(ast, nodeId, (path) => {
    // Collect shape JSXElement children
    let shapeCount = 0;
    for (let i = 0; i < path.node.children.length; i++) {
      const child = path.node.children[i];
      if (child.type === 'JSXElement') {
        const name = child.openingElement.name;
        const tagName = t.isJSXIdentifier(name) ? name.name : null;
        if (tagName && SVG_SHAPE_TAGS.has(tagName)) {
          if (shapeCount === childIndex) {
            // Remove this child and any preceding whitespace JSXText
            if (i > 0 && path.node.children[i - 1].type === 'JSXText') {
              path.node.children.splice(i - 1, 2);
            } else {
              path.node.children.splice(i, 1);
            }
            break;
          }
          shapeCount++;
        }
      }
    }
    path.stop();
  });

  try {
    return generate(ast, { retainLines: false, concise: false }, code).code;
  } catch (err) {
    trace.error('generator:removeSvgChildInCode-generate-failed', { nodeId, childIndex, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

/**
 * Replace ALL inner JSX between `<svg ...>` and `</svg>` of the SVG with the given markup.
 * Used by the in-tree SVG shape editor (src/svg-editor/) which round-trips full SVG content per edit.
 *
 * The library outputs HTML/XML SVG (kebab-case attributes like `stroke-width`); this
 * function converts them to JSX camelCase (`strokeWidth`) before insertion. Self-closing
 * <svg/> wrappers are converted to <svg>...</svg> form.
 */
export function replaceSvgInnerInCode(
  code: string,
  nodeId: string,
  innerJSX: string,
): string {
  trace.fn('generator.replaceSvgInnerInCode', { nodeId, innerLen: innerJSX.length });

  const idIndex = findJSXDataIdIndex(code, nodeId);
  if (idIndex === -1) {
    trace.error('generator.replaceSvgInnerInCode:no-data-id', { nodeId });
    return code;
  }

  // Derive the ACTUAL tag name (`svg`, `motion.svg`, …) from the opening tag so
  // the closing-tag search matches framer-motion-wrapped shapes too. A
  // `<motion.svg>` closes with `</motion.svg>`, not `</svg>` — hardcoding `</svg>`
  // made the geometry replace silently fail (no-closing-tag) for motion shapes,
  // so a reshape committed the new viewBox but reverted the path → offset.
  const tagStart = code.lastIndexOf('<', idIndex);
  const tagNameMatch = tagStart >= 0 ? code.slice(tagStart + 1, tagStart + 60).match(/^([\w.]+)/) : null;
  const tagName = tagNameMatch ? tagNameMatch[1] : 'svg';
  const closeToken = `</${tagName}>`;

  // Find the opening > of the SVG tag containing this data-id
  const svgTagEnd = code.indexOf('>', idIndex);
  if (svgTagEnd === -1) return code;

  // Convert kebab-case attribute names to camelCase, BUT skip
  // `data-*` and `aria-*` — those are valid JSX as-is and camelCasing
  // them produces invalid DOM attribute names (React warns "does not
  // recognize the dataPoints prop"). Sketch animation strokes carry a
  // `data-points` attribute we need to preserve verbatim; previously
  // it was getting flipped to `dataPoints` here, which broke the
  // animation runtime + caused React DOM warnings.
  const camelInner = innerJSX.replace(/(\s)([a-z]+(?:-[a-z]+)+)=/g,
    (_, space, attr) => {
      if (attr.startsWith('data-') || attr.startsWith('aria-')) return space + attr + '=';
      return space + attr.replace(/-([a-z])/g, (_m: string, c: string) => c.toUpperCase()) + '=';
    }
  );

  // Detect indent from the SVG tag's line for nice formatting
  const lineStart = code.lastIndexOf('\n', idIndex);
  const indent = lineStart >= 0
    ? code.slice(lineStart + 1).match(/^\s*/)?.[0] ?? '      '
    : '      ';

  // Self-closing <svg ... /> → expand to <svg ...>...</svg> (tag-aware).
  if (code[svgTagEnd - 1] === '/') {
    const beforeSlash = code.substring(0, svgTagEnd - 1).trimEnd();
    return beforeSlash + '>\n' + indent + '  ' + camelInner.trim() + '\n' + indent + closeToken + code.substring(svgTagEnd + 1);
  }

  // Find matching close (nesting handled by the shared depth matcher).
  const nextClose = findMatchingCloseTagIndex(code, tagName, svgTagEnd + 1);
  if (nextClose !== -1) {
    return code.substring(0, svgTagEnd + 1)
      + '\n' + indent + '  ' + camelInner.trim() + '\n' + indent
      + code.substring(nextClose);
  }

  trace.error('generator.replaceSvgInnerInCode:no-closing-tag', { nodeId });
  return code;
}

// ─── Per-tile geometry: make inner shapes addressable ────────────────────────

// Only the DRAWABLE geometry shapes (not `g` / `foreignObject` / `svg` containers).
const GEOMETRY_TAGS = new Set(['path', 'polygon', 'polyline', 'line', 'rect', 'circle', 'ellipse']);

function pointsToPathD(points: string, closed: boolean): string {
  const pts = points.trim().split(/[\s,]+/).filter(Boolean);
  if (pts.length < 4) return '';
  let d = `M${pts[0]},${pts[1]}`;
  for (let i = 2; i + 1 < pts.length; i += 2) d += ` L${pts[i]},${pts[i + 1]}`;
  return closed ? d + ' Z' : d;
}

/**
 * Stamp STABLE `data-id`s onto a shape wrapper's geometry children (path/polygon/…)
 * and convert polygons/polylines to `<path d>` — so each becomes an addressable child
 * node that can carry a PER-TILE `d` override (the live site resolves per-tile geometry
 * on the PATH element via a CSS `d` style / variant). Geometry is PRESERVED; ids are
 * deterministic (`${wrapperId}-g${i}` in document order) so the sandbox's per-shape
 * report aligns by index. Idempotent. Returns the ordered geometry ids.
 */
export function ensureShapeChildIds(code: string, wrapperId: string): { code: string; ids: string[] } {
  let ast: ReturnType<typeof parseJSX> | null = null;
  try { ast = parseJSX(code); } catch { return { code, ids: [] }; }
  if (!ast) return { code, ids: [] };
  const ids: string[] = [];
  let changed = false;
  findFirstElementByDataId(ast, wrapperId, (wrapperPath: any) => {
    let i = 0;
    wrapperPath.traverse({
      JSXElement(p: any) {
        const opening = p.node.openingElement;
        const nameNode = opening.name;
        const tag = t.isJSXIdentifier(nameNode) ? nameNode.name
          : (t.isJSXMemberExpression(nameNode) && t.isJSXIdentifier(nameNode.property) ? nameNode.property.name : '');
        if (!GEOMETRY_TAGS.has(tag)) return;
        // polygon / polyline → path (so it can carry a CSS `d`).
        if (tag === 'polygon' || tag === 'polyline') {
          const ptsAttr = findAttribute(opening, 'points');
          const pts = ptsAttr && ptsAttr.value?.type === 'StringLiteral' ? ptsAttr.value.value : '';
          const d = pointsToPathD(pts, tag === 'polygon');
          const pathName = t.isJSXMemberExpression(nameNode)
            ? t.jsxMemberExpression(nameNode.object, t.jsxIdentifier('path'))
            : t.jsxIdentifier('path');
          opening.name = pathName;
          if (p.node.closingElement) p.node.closingElement.name = pathName;
          opening.attributes = opening.attributes.filter((a: any) => !(t.isJSXAttribute(a) && a.name?.name === 'points'));
          opening.attributes.push(t.jsxAttribute(t.jsxIdentifier('d'), t.stringLiteral(d)));
          changed = true;
        }
        // Ensure a stable data-id.
        const existing = findAttribute(opening, 'data-id');
        if (existing && existing.value?.type === 'StringLiteral') {
          ids.push(existing.value.value);
        } else {
          const id = `${wrapperId}-g${i}`;
          opening.attributes.unshift(t.jsxAttribute(t.jsxIdentifier('data-id'), t.stringLiteral(id)));
          ids.push(id);
          changed = true;
        }
        i++;
      },
    });
  });
  if (!changed) return { code, ids };
  return { code: generate(ast, { retainLines: false, concise: false }, code).code, ids };
}

// ─── Shape-wrapper viewBox normalization (zero origin) ──────────────────────

const r3n = (n: number): number => Math.round(n * 1000) / 1000;

/** Translate a `d` value that may be either a raw path string or the CSS
 *  `path('…')` form (per-tile variant overrides use the CSS form). */
function translateAnyD(value: string, dx: number, dy: number): string {
  const css = value.match(/^path\(\s*(['"])([\s\S]*)\1\s*\)$/);
  if (css) return `path('${translatePathD(css[2], dx, dy)}')`;
  return translatePathD(value, dx, dy);
}

function setStringAttr(opening: t.JSXOpeningElement, name: string, value: string): void {
  const existing = findAttribute(opening, name);
  if (existing) existing.value = t.stringLiteral(value);
  else opening.attributes.push(t.jsxAttribute(t.jsxIdentifier(name), t.stringLiteral(value)));
}

function jsxTagName(opening: t.JSXOpeningElement): string {
  const nameNode = opening.name;
  return t.isJSXIdentifier(nameNode) ? nameNode.name
    : (t.isJSXMemberExpression(nameNode) && t.isJSXIdentifier(nameNode.property) ? nameNode.property.name : '');
}

/**
 * Normalize a SHAPE WRAPPER's viewBox to a ZERO origin: shift every geometry
 * child's coordinates (d / points / x / y / cx / cy / x1… via
 * `translateShapeGeometry`), any `transform="rotate(θ cx cy)"` pivot, and any
 * per-tile variant `d` overrides by (−ox, −oy), then set `viewBox="0 0 w h"`.
 * The painting is IDENTICAL (the viewBox→viewport map shifts together with the
 * content) — but a zero origin makes CSS `transform-box: fill-box` resolve its
 * reference box at the actual painted box, which the per-variant rotation
 * carrier depends on. A non-zero origin (pen tool / boolean-op artifacts) made
 * the browser compute the fill-box origin in pre-shift local units → the
 * rotated painting ORBITED away from its selection overlay.
 *
 * Bails (returns code unchanged) on GROUPS (nested `<svg>` children — their
 * children live in their own viewport) and on `transform`ed `<g>` wrappers
 * (the shift would compose with the transform). Idempotent: zero-origin
 * wrappers return unchanged.
 */
export function normalizeShapeWrapperViewBoxInCode(code: string, wrapperId: string): string {
  let ast: ReturnType<typeof parseJSX> | null = null;
  try { ast = parseJSX(code); } catch { return code; }
  if (!ast) return code;

  let changed = false;
  let bailed = false;
  let ox = 0; let oy = 0;
  const variantConstNames: string[] = [];

  findFirstElementByDataId(ast, wrapperId, (wrapperPath: any) => {
    const opening = wrapperPath.node.openingElement;
    const vbAttr = findAttribute(opening, 'viewBox');
    if (!vbAttr || vbAttr.value?.type !== 'StringLiteral') return;
    const parts = vbAttr.value.value.trim().split(/[\s,]+/).map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) return;
    [ox, oy] = [parts[0], parts[1]];
    if (Math.abs(ox) < 1e-6 && Math.abs(oy) < 1e-6) return; // already zero-origin

    wrapperPath.traverse({
      JSXElement(p: any) {
        const tag = jsxTagName(p.node.openingElement);
        if (tag === 'svg') bailed = true;
        if (tag === 'g' && findAttribute(p.node.openingElement, 'transform')) bailed = true;
      },
    });
    if (bailed) {
      trace.action('generator.normalizeShapeWrapperViewBox:bail', { wrapperId, ox, oy });
      return;
    }

    wrapperPath.traverse({
      JSXElement(p: any) {
        const op = p.node.openingElement;
        const tag = jsxTagName(op);
        if (!GEOMETRY_TAGS.has(tag)) return;
        const current: Record<string, string> = {};
        for (const a of op.attributes) {
          if (t.isJSXAttribute(a) && typeof a.name.name === 'string' && a.value?.type === 'StringLiteral') {
            current[a.name.name] = a.value.value;
          }
        }
        const shifted = translateShapeGeometry(tag, current, -ox, -oy);
        for (const [k, v] of Object.entries(shifted)) {
          if (current[k] === v) continue;
          setStringAttr(op, k, v);
          changed = true;
        }
        // Inner-shape rotation pivot is stored in the same user units.
        const tr = current.transform;
        const rot = tr?.match(/rotate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)/);
        if (tr && rot) {
          const next = tr.replace(rot[0], `rotate(${rot[1]} ${r3n(parseFloat(rot[2]) - ox)} ${r3n(parseFloat(rot[3]) - oy)})`);
          setStringAttr(op, 'transform', next);
          changed = true;
        }
        const vAttr = findAttribute(op, 'variants');
        if (vAttr?.value?.type === 'JSXExpressionContainer' && vAttr.value.expression.type === 'Identifier') {
          variantConstNames.push(vAttr.value.expression.name);
        }
      },
    });

    vbAttr.value = t.stringLiteral(`0 0 ${parts[2]} ${parts[3]}`);
    changed = true;
  });

  if (bailed || !changed) return code;

  // Per-tile variant `d` overrides live in module-scope consts — same units.
  if (variantConstNames.length > 0) {
    traverse(ast, {
      VariableDeclarator(p: any) {
        if (p.node.id?.type !== 'Identifier' || !variantConstNames.includes(p.node.id.name)) return;
        if (p.node.init?.type !== 'ObjectExpression') return;
        for (const entry of p.node.init.properties) {
          if (entry.type !== 'ObjectProperty' || entry.value?.type !== 'ObjectExpression') continue;
          for (const prop of entry.value.properties) {
            const keyName = prop.type === 'ObjectProperty'
              ? (prop.key?.type === 'Identifier' ? prop.key.name : (prop.key?.type === 'StringLiteral' ? prop.key.value : ''))
              : '';
            if (keyName === 'd' && prop.value?.type === 'StringLiteral') {
              prop.value = t.stringLiteral(translateAnyD(prop.value.value, -ox, -oy));
            }
          }
        }
      },
    });
  }

  trace.action('generator.normalizeShapeWrapperViewBox', { wrapperId, ox, oy, variantConsts: variantConstNames });
  return generate(ast, { retainLines: false, concise: false }, code).code;
}

