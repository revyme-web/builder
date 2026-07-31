// generator-video.ts — Background-video JSX child injection.
//
// A "video fill" on a host element is implemented as a real `<video data-bg-video>`
// JSX element inserted as the host's first child, plus auto-applied styles on the
// host (position/overflow/isolation) so the video stays scoped behind sibling
// content via z-index: -1.
//
// Why a real child (not a CSS prop): `backgroundVideo` doesn't exist in CSS, so
// the browser can't render anything from it. A real <video> element is the only
// thing that actually plays, and it works the same way in canvas + export.
//
// API:
//   setVideoFillInCode(code, nodeId, opts)   — partial update (creates with
//                                              defaults if missing AND opts.src
//                                              is provided; otherwise no-op)
//   removeVideoFillInCode(code, nodeId)      — remove the bg-video child
//
// The matching parser-side change peels the bg-video child out of the regular
// children list and exposes it as `node.bgVideo`, so other tools never see it
// as a normal selectable node.

import * as t from '@babel/types';
import { parseJSX, findFirstElementByDataId } from '../parsing/ast-utils';
import { trace } from '@/shared/debug-trace';
import { generate } from './generator-utils';

/** Marker attribute on the injected <video> child. Parser uses this to detect it. */
const BG_VIDEO_ATTR = 'data-bg-video';

/** Boolean HTML attributes the user can toggle on the bg-video element.
 *  In JSX these are written as bare names (e.g. `<video autoPlay muted />`),
 *  with absence meaning false. */
const BG_VIDEO_BOOLEAN_ATTRS = ['autoPlay', 'muted', 'loop', 'playsInline', 'controls'] as const;
type BgVideoBoolAttr = typeof BG_VIDEO_BOOLEAN_ATTRS[number];

/** Allowed object-fit values (subset that makes sense for a background). */
const BG_VIDEO_OBJECT_FIT_VALUES = ['cover', 'contain', 'fill', 'none', 'scale-down'] as const;
type BgVideoObjectFit = typeof BG_VIDEO_OBJECT_FIT_VALUES[number];

/** Full opts surface for the bg-video element. All fields optional in the
 *  setter — caller passes only the fields it wants to change. */
export interface BgVideoOpts {
  src?: string;
  autoPlay?: boolean;
  muted?: boolean;
  loop?: boolean;
  playsInline?: boolean;
  controls?: boolean;
  /** CSS object-fit on the video element (default 'cover'). */
  objectFit?: BgVideoObjectFit;
  /** Optional poster image URL — empty string clears it. */
  poster?: string;
}

/** Defaults applied when a fresh bg-video is inserted. autoplay+muted+loop
 *  +playsInline are the standard "background video" combo (autoplay requires
 *  muted in most browsers, playsInline avoids fullscreen on iOS). */
const DEFAULT_BG_VIDEO_OPTS: Required<Omit<BgVideoOpts, 'src' | 'poster'>> = {
  autoPlay: true,
  muted: true,
  loop: true,
  playsInline: true,
  controls: false,
  objectFit: 'cover',
};

/** Inline style keys that live on the bg-video element. objectFit is the
 *  only one the user controls; the rest pin the element to the host. */
const VIDEO_INLINE_STYLES_FIXED: Record<string, string> = {
  position: 'absolute',
  inset: '0',
  width: '100%',
  height: '100%',
  // pointerEvents is conditional — set when controls are off (so clicks pass
  // through to the host); cleared when controls are on (so the user can
  // actually interact with the native player UI).
  zIndex: '-1',
};

/** Host styles auto-applied so z-index: -1 stays scoped inside the host. */
const HOST_STYLES: Record<string, string> = {
  position: 'relative',
  overflow: 'hidden',
  isolation: 'isolate',
};

/**
 * Insert or update the `<video data-bg-video>` first child on the host node.
 * Idempotent. Behavior:
 *   - bg-video missing + opts.src provided  → insert with defaults + opts
 *   - bg-video missing + no src             → no-op (need a URL to create)
 *   - bg-video present                      → patch each provided field
 *
 * Also applies position/overflow/isolation to the host (only when missing —
 * does NOT clobber explicit user values).
 */
export function setVideoFillInCode(code: string, nodeId: string, opts: BgVideoOpts): string {
  trace.fn('generator.setVideoFillInCode', { nodeId, opts: summarizeOpts(opts) });

  const ast = parseJSX(code);
  if (!ast) {
    trace.error('generator.setVideoFillInCode', 'failed to parse');
    return code;
  }

  let touched = false;

  findFirstElementByDataId(ast, nodeId, (path) => {
    const element = path.node as t.JSXElement;
    const opening = element.openingElement;

    applyHostStylesIfMissing(opening, HOST_STYLES);

    const existing = findExistingBgVideo(element);

    if (existing) {
      patchBgVideo(existing.openingElement, opts);
      touched = true;
      trace.action('generator.setVideoFillInCode:patched', { nodeId });
    } else {
      if (!opts.src) {
        trace.action('generator.setVideoFillInCode:no-src-cant-create', { nodeId });
        return;
      }
      const merged: Required<Omit<BgVideoOpts, 'poster'>> & { poster?: string } = {
        src: opts.src,
        ...DEFAULT_BG_VIDEO_OPTS,
        ...opts,
      };
      const videoEl = buildBgVideoElement(merged);

      // Self-closing host needs to become open/close so we can add children.
      if (element.closingElement === null) {
        opening.selfClosing = false;
        element.closingElement = t.jsxClosingElement(t.jsxIdentifier(getTagName(opening)));
      }

      element.children.unshift(videoEl);
      touched = true;
      trace.action('generator.setVideoFillInCode:inserted', { nodeId });
    }

    path.stop();
  });

  if (!touched) return code;

  try {
    return generate(ast, { retainLines: false, concise: false }, code).code;
  } catch (err) {
    trace.error('generator.setVideoFillInCode:generate-failed', err instanceof Error ? err.message : String(err));
    return code;
  }
}

/** Remove the bg-video first child. Host styles are intentionally left alone. */
export function removeVideoFillInCode(code: string, nodeId: string): string {
  trace.fn('generator.removeVideoFillInCode', { nodeId });

  const ast = parseJSX(code);
  if (!ast) return code;

  let touched = false;

  findFirstElementByDataId(ast, nodeId, (path) => {
    const element = path.node as t.JSXElement;
    const idx = element.children.findIndex(child =>
      child.type === 'JSXElement' && hasBgVideoMarker(child)
    );
    if (idx !== -1) {
      element.children.splice(idx, 1);
      touched = true;
      trace.action('generator.removeVideoFillInCode:removed', { nodeId });
    }
    path.stop();
  });

  if (!touched) return code;

  try {
    return generate(ast, { retainLines: false, concise: false }, code).code;
  } catch (err) {
    trace.error('generator.removeVideoFillInCode:generate-failed', err instanceof Error ? err.message : String(err));
    return code;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function summarizeOpts(opts: BgVideoOpts): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (opts.src !== undefined) out.srcLength = opts.src.length;
  for (const k of BG_VIDEO_BOOLEAN_ATTRS) if (opts[k] !== undefined) out[k] = opts[k];
  if (opts.objectFit !== undefined) out.objectFit = opts.objectFit;
  if (opts.poster !== undefined) out.posterLength = opts.poster.length;
  return out;
}

function getTagName(opening: t.JSXOpeningElement): string {
  if (opening.name.type === 'JSXIdentifier') return opening.name.name;
  return 'div';
}

function hasBgVideoMarker(el: t.JSXElement): boolean {
  return el.openingElement.attributes.some(attr =>
    attr.type === 'JSXAttribute' &&
    attr.name.type === 'JSXIdentifier' &&
    attr.name.name === BG_VIDEO_ATTR
  );
}

function findExistingBgVideo(host: t.JSXElement): t.JSXElement | null {
  for (const child of host.children) {
    if (child.type === 'JSXText' && /^\s*$/.test(child.value)) continue;
    if (child.type === 'JSXElement') {
      return hasBgVideoMarker(child) ? child : null;
    }
    return null;
  }
  return null;
}

function findAttrIndex(opening: t.JSXOpeningElement, name: string): number {
  for (let i = 0; i < opening.attributes.length; i++) {
    const attr = opening.attributes[i];
    if (attr.type === 'JSXAttribute' && attr.name.type === 'JSXIdentifier' && attr.name.name === name) {
      return i;
    }
  }
  return -1;
}

/**
 * Apply a partial opts patch to an existing bg-video opening element.
 * - boolean fields: present-name = true, missing = false
 * - src/poster: string attribute (empty string removes)
 * - objectFit: written into the inline style object
 */
function patchBgVideo(opening: t.JSXOpeningElement, opts: BgVideoOpts): void {
  if (opts.src !== undefined) {
    setStringAttr(opening, 'src', opts.src);
  }
  if (opts.poster !== undefined) {
    setStringAttr(opening, 'poster', opts.poster);
  }
  for (const k of BG_VIDEO_BOOLEAN_ATTRS) {
    if (opts[k] !== undefined) setBooleanAttr(opening, k, opts[k] as boolean);
  }
  if (opts.objectFit !== undefined) {
    setVideoStyleKey(opening, 'objectFit', opts.objectFit);
  }
  // Ensure pointerEvents matches the controls state — we want clicks to pass
  // through ONLY when controls are off (so the host stays selectable). When
  // controls flip, sync this even if controls itself wasn't in opts (it
  // might have already been set by a prior call).
  if (opts.controls !== undefined) {
    if (opts.controls) {
      // Leave pointerEvents off (delete the style key).
      setVideoStyleKey(opening, 'pointerEvents', '');
    } else {
      setVideoStyleKey(opening, 'pointerEvents', 'none');
    }
  }
}

function setStringAttr(opening: t.JSXOpeningElement, name: string, value: string): void {
  const idx = findAttrIndex(opening, name);
  if (value === '') {
    if (idx !== -1) opening.attributes.splice(idx, 1);
    return;
  }
  if (idx !== -1) {
    (opening.attributes[idx] as t.JSXAttribute).value = t.stringLiteral(value);
  } else {
    opening.attributes.push(t.jsxAttribute(t.jsxIdentifier(name), t.stringLiteral(value)));
  }
}

function setBooleanAttr(opening: t.JSXOpeningElement, name: string, value: boolean): void {
  const idx = findAttrIndex(opening, name);
  if (value) {
    if (idx === -1) {
      opening.attributes.push(t.jsxAttribute(t.jsxIdentifier(name), null));
    }
    // Already present — nothing to do.
  } else {
    if (idx !== -1) opening.attributes.splice(idx, 1);
  }
}

function setVideoStyleKey(opening: t.JSXOpeningElement, key: string, value: string): void {
  const styleAttrIdx = findAttrIndex(opening, 'style');
  if (styleAttrIdx === -1) {
    if (value === '') return;
    opening.attributes.push(
      t.jsxAttribute(
        t.jsxIdentifier('style'),
        t.jsxExpressionContainer(t.objectExpression([
          t.objectProperty(t.identifier(key), t.stringLiteral(value)),
        ])),
      ),
    );
    return;
  }
  const styleAttr = opening.attributes[styleAttrIdx] as t.JSXAttribute;
  if (styleAttr.value?.type !== 'JSXExpressionContainer') return;
  const expr = styleAttr.value.expression;
  if (expr.type !== 'ObjectExpression') return;

  const propIdx = expr.properties.findIndex(p =>
    p.type === 'ObjectProperty' && !p.computed && (
      (p.key.type === 'Identifier' && p.key.name === key) ||
      (p.key.type === 'StringLiteral' && p.key.value === key)
    )
  );

  if (value === '') {
    if (propIdx !== -1) expr.properties.splice(propIdx, 1);
    return;
  }

  if (propIdx !== -1) {
    (expr.properties[propIdx] as t.ObjectProperty).value = t.stringLiteral(value);
  } else {
    expr.properties.push(t.objectProperty(t.identifier(key), t.stringLiteral(value)));
  }
}

function applyHostStylesIfMissing(opening: t.JSXOpeningElement, styles: Record<string, string>): void {
  const styleAttrIdx = findAttrIndex(opening, 'style');

  if (styleAttrIdx === -1) {
    const obj = t.objectExpression(
      Object.entries(styles).map(([k, v]) =>
        t.objectProperty(t.identifier(k), t.stringLiteral(v))
      )
    );
    opening.attributes.push(
      t.jsxAttribute(t.jsxIdentifier('style'), t.jsxExpressionContainer(obj))
    );
    return;
  }

  const styleAttr = opening.attributes[styleAttrIdx] as t.JSXAttribute;
  if (styleAttr.value?.type !== 'JSXExpressionContainer') return;
  const expr = styleAttr.value.expression;
  if (expr.type !== 'ObjectExpression') return;

  const existingKeys = new Set<string>();
  for (const prop of expr.properties) {
    if (prop.type === 'ObjectProperty' && !prop.computed) {
      if (prop.key.type === 'Identifier') existingKeys.add(prop.key.name);
      else if (prop.key.type === 'StringLiteral') existingKeys.add(prop.key.value);
    }
  }

  for (const [k, v] of Object.entries(styles)) {
    if (existingKeys.has(k)) continue;
    expr.properties.push(t.objectProperty(t.identifier(k), t.stringLiteral(v)));
  }
}

function buildBgVideoElement(opts: Required<Omit<BgVideoOpts, 'poster'>> & { poster?: string }): t.JSXElement {
  // Compose inline style: fixed positioning + objectFit + pointerEvents (only
  // when controls are off — see patchBgVideo).
  const inlineStyle: Record<string, string> = {
    ...VIDEO_INLINE_STYLES_FIXED,
    objectFit: opts.objectFit,
  };
  if (!opts.controls) inlineStyle.pointerEvents = 'none';

  const styleObj = t.objectExpression(
    Object.entries(inlineStyle).map(([k, v]) =>
      t.objectProperty(t.identifier(k), t.stringLiteral(v))
    )
  );

  const attrs: (t.JSXAttribute)[] = [
    t.jsxAttribute(t.jsxIdentifier(BG_VIDEO_ATTR), null),
    t.jsxAttribute(t.jsxIdentifier('src'), t.stringLiteral(opts.src)),
  ];
  if (opts.autoPlay)    attrs.push(t.jsxAttribute(t.jsxIdentifier('autoPlay'), null));
  if (opts.muted)       attrs.push(t.jsxAttribute(t.jsxIdentifier('muted'), null));
  if (opts.loop)        attrs.push(t.jsxAttribute(t.jsxIdentifier('loop'), null));
  if (opts.playsInline) attrs.push(t.jsxAttribute(t.jsxIdentifier('playsInline'), null));
  if (opts.controls)    attrs.push(t.jsxAttribute(t.jsxIdentifier('controls'), null));
  if (opts.poster)      attrs.push(t.jsxAttribute(t.jsxIdentifier('poster'), t.stringLiteral(opts.poster)));
  attrs.push(t.jsxAttribute(t.jsxIdentifier('style'), t.jsxExpressionContainer(styleObj)));

  return t.jsxElement(
    t.jsxOpeningElement(t.jsxIdentifier('video'), attrs, /* selfClosing */ true),
    null,
    [],
    /* selfClosing */ true,
  );
}
