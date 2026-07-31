// icon-set-template.ts — Icon-set file scaffolding.
//
// An icon set is a `.tsx` file under `icons/` whose default export is
// a single React component. The component holds **one master-view JSX
// tree** as the sole source of truth for the icons it contains, and
// uses runtime branching (no second JSX tree) to render either:
//   - the full grid of icons (when called without a `name` prop) — the
//     "master page" the reference shows when you double-click into the set;
//   - just one icon (when called with `name="icon-id"`) — the per-page
//     instance render, picked by data-id from the master's children.
//
// Generated file shape:
//
//   /** @name "User-given Name" */
//   /** @iconSet */
//   import React from 'react';
//
//   export default function Naxoba({ name, style }) {
//     // Master JSX — the only JSX in the file. parseJSXToNodes walks
//     // this once, so the layers panel sees `iconset-master > svg > path`
//     // without phantom duplicates from per-icon helper functions.
//     const master = (
//       <div data-id="iconset-master" style={{ position: 'relative', width: '100%', height: '100%' }}>
//         <svg data-id="icon-1" data-name="Vector"
//              viewBox="0 0 100 100"
//              style={{ position: 'absolute', left: 0, top: 0, width: 240, height: 240 }}>
//           <path d="..." />
//         </svg>
//         <svg data-id="icon-2" data-name="Vector" viewBox="0 0 50 50"
//              style={{ position: 'absolute', left: 280, top: 0, width: 240, height: 240 }}>
//           <rect />
//         </svg>
//       </div>
//     );
//     if (!name) return master;
//     // Instance: pluck the matching <svg> from master and clone it with
//     // the caller's style (which replaces the master-grid positioning).
//     const child = React.Children.toArray(master.props.children).find(
//       (c) => React.isValidElement(c) && c.props['data-id'] === name
//     );
//     if (!child) return null;
//     return React.cloneElement(child, { style });
//   }
//
// Why no per-icon function or ICONS map: the natural alternative was
// `function IconAlpha() { return <svg>... }` + `const ICONS = { 'icon-1':
// IconAlpha }`. parseJSXToNodes walks the whole module's AST; that
// alternative has TWO JSX trees per icon (the function body + the
// master-view's `<IconAlpha />` call) so each shape would land in the
// node map twice. Single-source-of-truth eliminates that whole class
// of bugs and makes the master file's contents read straight off in
// the layers panel.
//
// Why React.cloneElement with `{ style }`: `style` is shallow-replaced
// (not merged), so the master-grid positioning (`position: 'absolute',
// left: i * 280, ...`) doesn't bleed into the instance render — the
// instance gets exactly the style passed by the page's instance tag.
//
// File identifier strategy: same PascalCase syllable generator as
// `component-ops.ts` (3 syllables, ~64k entropy, 50 retries for
// uniqueness) so the path is `icons/{Pascal}.tsx` and the export tag
// matches.

import { projectFS } from '../project/project-fs';
import { generateSyllableName } from '@/code/project/name-gen';
import { trace } from '@/shared/debug-trace';

// ─── Identifier generator (syllable-based, shared with component-ops) ─────

/** Generate a unique 3-syllable PascalCase name for a new icon-set file. */
export function generateIconSetName(): string {
  return generateSyllableName('icons', 'IconSet');
}

// ─── Annotations ──────────────────────────────────────────────────────────

const NAME_REGEX = /\/\*\*?\s*@name\s+"([^"]*)"\s*\*\//;
const ICONSET_REGEX = /\/\*\*?\s*@iconSet\s*\*\//;

/** Read the @name annotation from an icon-set file's code. */
export function parseIconSetDisplayName(code: string): string | null {
  const m = code.match(NAME_REGEX);
  return m ? m[1] : null;
}

/** Detect whether a file is flagged as an icon set via the @iconSet annotation. */
export function isIconSetCode(code: string): boolean {
  return ICONSET_REGEX.test(code);
}

/** Convenience: read a file path and check both. */
export function isIconSetFile(filePath: string): boolean {
  if (!filePath.startsWith('icons/')) return false;
  const code = projectFS.readFile(filePath);
  return !!code && isIconSetCode(code);
}

// ─── Master-view layout constants ─────────────────────────────────────────

export const ICON_CARD_W = 240;
export const ICON_CARD_H = 240;
export const ICON_CARD_GAP = 40;

// ─── Per-icon JSX block builder ───────────────────────────────────────────

export interface IconEntryInput {
  /** Canonical id used both as the data-id AND as the lookup key during
   *  per-instance render. e.g. 'icon-1'. */
  id: string;
  /** Display name shown in the layers panel + master-view label.
   *  Carried via the SVG's `data-name` attribute. */
  displayName: string;
  /** The SVG JSX subtree as text, e.g. `<svg viewBox="0 0 100 100">...</svg>`.
   *  Must already be a `<svg>` root element — children alone won't work
   *  because the master view positions the wrapper. */
  svgJSX: string;
  /** Master-grid x-offset. The build-time positioning the icon takes when
   *  shown in the master page; replaced by the instance's caller-style
   *  via cloneElement at instance render time. */
  leftPx: number;
  /** Master-grid y-offset (defaults to 0 — same row as siblings). */
  topPx?: number;
  /** Per-entry override for the variant card's intrinsic width / height
   *  on the master canvas. When omitted, falls back to `ICON_CARD_W` /
   *  `ICON_CARD_H` (240×240). The "Make Icon Set" flow passes the
   *  source SVG's width/height here so the variant card on the master
   *  matches the original element's dimensions — without this, a
   *  600×400 vector lands inside a 240×240 card and overflows. */
  widthPx?: number;
  heightPx?: number;
}

/**
 * Build the master-view JSX block for one icon. The OUTER element is a
 * `<div>` (selectable as a Vector, no shape-edit on click). White
 * background rides with the icon's identity. Position/width/height
 * for the master canvas come from iconConfig at parse-merge time; on
 * page instances they come from the instance's own style.
 *
 * The svgJSX is emitted as a DIRECT CHILD of the div — meaning each
 * shape (the default + any subsequently drawn) is its own positioned
 * `<svg>` wrapper. That matches the structure the canvas shape tools
 * produce when the user draws a new rect/path/etc inside a vector,
 * so all shapes inside a vector are uniformly drag-able / select-able
 * via the standard CSS-position drag system. Without this consistency
 * the template's default shape (sitting inside a viewBox-scaled inner
 * svg with x/y attributes) can't be dragged — drag writes CSS
 * left/top, the SVG attrs ignore them, visual reverts on mouseup.
 *
 * leftPx / topPx params are kept on the type for backward compat but
 * IGNORED by this function — the canvas reads positions from iconConfig.
 */
export function buildIconJSXBlock(entry: IconEntryInput): string {
  // Pass the svgJSX through verbatim. Defaults (LibraryPanel.createIconSet
  // and addIconToSet) supply a positioned wrapper-SVG matching what shape
  // creators produce; legacy inputs (a bare `<svg viewBox="...">...`) end
  // up as a direct child of the div anyway and still render — they just
  // won't be drag-able until the user replaces them with a positioned
  // wrapper.
  const containerStyle = `style={{ backgroundColor: '#ffffff' }}`;
  return `<div data-id="${entry.id}" data-name="${entry.displayName}" ${containerStyle}>` +
    entry.svgJSX.trim() +
    `</div>`;
}

// ─── Instance render: a forwardRef motion.div, vector scaled to its card ──────
// The instance is a `React.forwardRef` whose root is a `motion.div`. This lets
// the editor's page-level effects attach: a forwarded `ref` (hover / in-view
// hooks read `ref.current`) + motion VALUES bound to `style` (scale / rotate /
// opacity animate because the root is a motion element). A plain function /
// plain `<div>` silently dropped both — the effect code ran but never bound.
// Each inner vector is scaled to its SHARE of the card (svgPx / iconConfig) so
// the in-card layout (incl. whitespace) is preserved. `!name` returns the plain
// master for the icon-set canvas.

/** The full instance branch (everything after `const master = (…)`), shared by
 *  the builder and the migration so new + upgraded files are byte-identical. */
const VECTOR_SET_INSTANCE_BODY =
  '  if (!name) return master;\n' +
  '  const child = React.Children.toArray(master.props.children).find(\n' +
  "    (c) => React.isValidElement(c) && c.props['data-id'] === name,\n" +
  '  );\n' +
  '  if (!React.isValidElement(child)) return null;\n' +
  '  const config = iconConfig.find((c) => c.name === name);\n' +
  '  const userStyle = style ?? {};\n' +
  '  const cleanedUserStyle = {};\n' +
  '  for (const [k, v] of Object.entries(userStyle)) {\n' +
  "    if (v === '' || v == null) continue;\n" +
  '    cleanedUserStyle[k] = v;\n' +
  '  }\n' +
  '  const mergedStyle = {\n' +
  '    ...(config ? { width: `${config.width}px`, height: `${config.height}px` } : {}),\n' +
  '    ...cleanedUserStyle,\n' +
  '  };\n' +
  '  const filledKids = React.Children.map(child.props.children, (gc) => {\n' +
  "    if (!React.isValidElement(gc) || gc.type !== 'svg') return gc;\n" +
  '    const gs = gc.props.style || {};\n' +
  '    const sw = parseFloat(gs.width), sh = parseFloat(gs.height);\n' +
  "    const wPct = config && config.width > 0 && sw > 0 ? `${(sw / config.width) * 100}%` : '100%';\n" +
  "    const hPct = config && config.height > 0 && sh > 0 ? `${(sh / config.height) * 100}%` : '100%';\n" +
  '    return React.cloneElement(gc, { style: { ...gs, width: wPct, height: hPct } });\n' +
  '  });\n' +
  '  // In the canvas, unresolved page bindings arrive as \'var:…\' strings — a\n' +
  '  // STRING ref crashes motion ref-attach (`ref.current` on a string) and string\n' +
  '  // motion-value styles are meaningless. Drop them so the canvas renders the\n' +
  '  // static vector; the live page passes real refs / motion values, untouched.\n' +
  "  const safeRef = ref && typeof ref !== 'string' ? ref : undefined;\n" +
  '  // Motion TRANSFORM props (rotate/scale/x/y/skew) ride on `animate`, not inline\n' +
  '  // style: motion SPRINGS to an `animate` change but applies an inline style\n' +
  '  // change INSTANTLY, so without this a per-variant rotation jumps on the live\n' +
  '  // site instead of animating. On the canvas the NO_ANIMATION MotionConfig\n' +
  '  // wrapper makes them instant. Everything else (position/size) stays inline.\n' +
  "  const MOTION_ANIM = { rotate: 1, rotateX: 1, rotateY: 1, rotateZ: 1, scale: 1, scaleX: 1, scaleY: 1, skewX: 1, skewY: 1, x: 1, y: 1, z: 1 };\n" +
  '  const safeStyle = {};\n' +
  '  const animateProps = {};\n' +
  '  for (const [k, v] of Object.entries(mergedStyle)) {\n' +
  "    if (typeof v === 'string' && v.slice(0, 4) === 'var:') continue;\n" +
  '    if (MOTION_ANIM[k]) {\n' +
  '      // The canvas resolves a conditional motion prop to a numeric STRING\n' +
  "      // ('-200.7'); framer-motion won't apply a bare string to `rotate`, so\n" +
  '      // coerce to a number. On the live site it is already a number (no-op).\n' +
  "      animateProps[k] = (typeof v === 'string' && /^-?\\d+(\\.\\d+)?$/.test(v)) ? parseFloat(v) : v;\n" +
  '    } else safeStyle[k] = v;\n' +
  '  }\n' +
  '  const { style: _cs, children: _cc, ...childRest } = child.props;\n' +
  '  const animExtra = Object.keys(animateProps).length > 0 ? { animate: animateProps } : {};\n' +
  '  // `layout` so position changes FLIP-animate (the inner has absolute left/top),\n' +
  '  // matching how a normal motion group animates between variants; the tag may\n' +
  '  // already set it, in which case its value wins.\n' +
  '  return React.createElement(motion.div, { layout: true, ...childRest, ...rest, ...animExtra, ref: safeRef, style: safeStyle }, filledKids);';

/** Remove a JSX attribute `name={…}` (balanced-brace value) from markup. */
function removeJsxAttrBalanced(jsx: string, attr: string): string {
  const token = ' ' + attr + '={';
  let out = jsx, idx: number;
  while ((idx = out.indexOf(token)) !== -1) {
    let depth = 1, pos = idx + token.length;
    while (pos < out.length && depth > 0) {
      const ch = out[pos];
      if (ch === '{') depth++; else if (ch === '}') depth--;
      pos++;
    }
    out = out.slice(0, idx) + out.slice(pos);
  }
  return out;
}

/** An icon VECTOR must be plain `<svg>`. If the source SVG was dragged into a
 *  component/variant it gets promoted to `<motion.svg variants=… initial=…
 *  animate=…>` — but those bindings reference PAGE vars (the variants object,
 *  `initialVariant`) that don't exist in an icon-set file, so the icon throws
 *  `ReferenceError: …Variants is not defined` and renders nothing. Strip the
 *  motion promotion + variant/effect props back to a plain `<svg>`. (Only touches
 *  `motion.svg`, never the instance branch's intentional `motion.div`.) Idempotent. */
export function stripMotionFromIconSvgMarkup(jsx: string): string {
  let out = jsx.replace(/<motion\.svg\b/g, '<svg').replace(/<\/motion\.svg>/g, '</svg>');
  for (const attr of ['variants', 'initial', 'animate', 'layout', 'whileHover', 'whileTap', 'whileFocus', 'whileDrag', 'whileInView', 'viewport', 'transition', 'exit', 'drag']) {
    out = removeJsxAttrBalanced(out, attr);
  }
  return out;
}

/** Ensure the file imports `withResponsiveProps` and wraps its default export in
 *  it. This is what lets an icon-set's `name` (and any prop) be overridden
 *  per-replica-viewport via `data-responsive` — the HOC reads the viewport width
 *  and merges the matching breakpoint's overrides at render, exactly like design
 *  components. Idempotent: no-op when the import + wrap are already present. */
function ensureResponsivePropsWrapper(code: string): string {
  let out = code;
  // Add the import after framer-motion (else after the React import).
  if (!/from ['"]@revyme\/runtime['"]/.test(out)) {
    const fm = out.match(/import \{[^}]*\} from ['"]framer-motion['"];?\n/);
    if (fm) {
      const idx = out.indexOf(fm[0]) + fm[0].length;
      out = out.slice(0, idx) + "import { withResponsiveProps } from '@revyme/runtime';\n" + out.slice(idx);
    } else {
      out = out.replace(/(import React[^\n]*\n)/, "$1import { withResponsiveProps } from '@revyme/runtime';\n");
    }
  }
  // Wrap the bare default export. `export default withResponsiveProps(Foo);`
  // never matches `export default (\w+);` (a `(` follows the name), so this is a
  // no-op once wrapped.
  out = out.replace(/export default (\w+);/, 'export default withResponsiveProps($1);');
  return out;
}

/** Upgrade an existing icon-set/vector-set file: normalise the master vector to a
 *  plain `<svg>` (strip stray motion/variant promotion → fixes the "…Variants is
 *  not defined" crash), make its INSTANCES animatable (forwardRef + motion.div
 *  root + guarded proportional render), AND wrap the export in withResponsiveProps
 *  so per-viewport `name` overrides resolve. Idempotent and safe on ANY code — a
 *  no-op unless this is an icon-set file. Applied at compile time (canvas render). */
export function upgradeVectorSetInstanceBranch(code: string): string {
  // Only an icon-set/vector-set instance branch carries this exact line.
  if (!code.includes('  if (!name) return master;')) return code;
  // ALWAYS normalise the master vector first (even when the instance branch is
  // already current) — a file can have a clean instance branch but a stray
  // motion.svg master from a drag-into-variant before it became an icon set.
  let out = stripMotionFromIconSvgMarkup(code);
  // Instance branch already the current guarded forwardRef+motion version — still
  // ensure the responsive wrapper (an older guarded file may pre-date it).
  if (out.includes('const safeRef =')) return ensureResponsivePropsWrapper(out);
  // forwardRef the default export so the instance can receive a ref + extra props
  // (no-op if a prior migration already did it).
  out = out.replace(
    /export default function (\w+)\(\{ name, style \}\) \{/,
    'const $1 = React.forwardRef(function $1({ name, style, children, ...rest }, ref) {',
  );
  const nm = out.match(/const (\w+) = React\.forwardRef\(function/)?.[1];
  if (!nm) return code; // unexpected signature shape — bail safely
  // Replace the instance branch (ANY prior version, plain-function OR an earlier
  // forwardRef one) through end-of-file with the current motion render + close.
  out = out.replace(
    / {2}if \(!name\) return master;[\s\S]*$/,
    VECTOR_SET_INSTANCE_BODY + '\n});\n\nexport default ' + nm + ';\n',
  );
  return ensureResponsivePropsWrapper(out);
}

// ─── Full file builder ────────────────────────────────────────────────────

/**
 * Build the complete .tsx source for a new icon set with the given entries.
 * `defaultExportName` becomes both the JSX tag for instances and (by
 * convention) the file basename. `displayName` is the user-facing label
 * surfaced via the @name annotation.
 *
 * The generated file has exactly ONE JSX expression — the master view —
 * which serves both as the master page (returned when `name` is undefined)
 * and as the source for per-instance render (`React.cloneElement` of the
 * matching child).
 */
export function buildIconSetFile(
  defaultExportName: string,
  displayName: string,
  entries: IconEntryInput[],
): string {
  if (entries.length === 0) {
    trace.error('icon-set-template:no-entries', { defaultExportName, displayName });
    throw new Error('Icon set must contain at least one entry');
  }

  // Build the iconConfig array — positions live HERE (mirrors variantConfig
  // for components). The master JSX below has content-only vectors; the
  // canvas reads iconConfig and applies x/y/width/height at render time.
  const iconConfigEntries = entries.map((e, i) => {
    const x = e.leftPx ?? i * (ICON_CARD_W + ICON_CARD_GAP);
    const y = e.topPx ?? 0;
    const w = e.widthPx ?? ICON_CARD_W;
    const h = e.heightPx ?? ICON_CARD_H;
    const parts = [
      `name: '${e.id}'`,
      `label: '${e.displayName}'`,
      `x: ${x}`,
      `y: ${y}`,
      `width: ${w}`,
      `height: ${h}`,
    ];
    if (i === 0) parts.push('isPrimary: true');
    return `  { ${parts.join(', ')} }`;
  }).join(',\n');

  const iconBlocks = entries.map(buildIconJSXBlock)
    .map(block => '      ' + block.replace(/\n/g, '\n      '))
    .join('\n');

  return `'use client';
import React from 'react';
import { motion } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

/** @name "${displayName}" */
/** @iconSet */

const iconConfig = [
${iconConfigEntries},
];

const ${defaultExportName} = React.forwardRef(function ${defaultExportName}({ name, style, children, ...rest }, ref) {
  // Master JSX — parseJSXToNodes walks this once for the icon-set canvas; the
  // canvas merges iconConfig positions onto the parsed vector nodes. When \`name\`
  // is set this is an INSTANCE: the matching variant renders as a motion.div so
  // the editor's page-level effects bind (forwarded ref for hover/in-view +
  // motion-value styles for scale/rotate/opacity), each inner vector scaled to
  // its share of the card so the in-card layout is preserved.
  const master = (
    <div data-id="root" data-name="Icons" style={{ position: 'relative', width: '100%', height: '100%' }}>
${iconBlocks}
    </div>
  );
${VECTOR_SET_INSTANCE_BODY}
});

export default withResponsiveProps(${defaultExportName});
`;
}

// ─── Slug helpers ─────────────────────────────────────────────────────────

/** Sanitize a user-supplied display name into a PascalCase function suffix. */
export function toPascalCase(input: string): string {
  return input
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('') || 'Icon';
}

/** Build a unique icon id (kebab-case lookup key), starting at 'icon-1'. */
export function makeIconId(existing: Set<string>): string {
  for (let i = 1; i < 10000; i++) {
    const id = `icon-${i}`;
    if (!existing.has(id)) return id;
  }
  return 'icon-' + Date.now().toString(36).slice(-4);
}
