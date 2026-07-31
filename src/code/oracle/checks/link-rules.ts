// oracle/checks/link-rules.ts — navigating-link rules (components + pages).
// All code moved VERBATIM from check-file.ts (Phase 7.1 god-file split).

import * as t from '@babel/types';
import { traverse, jsxTagName, jsxAttrs, stringAttr } from './shared';
import type { OracleViolation } from './shared';

/**
 * COMPONENT LINKS — inside a design component every element is motion.* (the
 * FLIP/variant engine drives them), so a NAVIGATING link must be
 * `MotionLink = motion.create(Link)`: a plain <Link> isn't a motion element
 * (no layout/variant animation), and <motion.a href>/<a href> is a raw anchor
 * (full page reload, and the route may not resolve when rendered on the
 * canvas). MotionLink is also the shape the editor's make-component flow emits.
 */

function checkComponentLinks(code: string, ast: t.File, v: OracleViolation[]): void {
  let usesMotionLink = false;
  const offenders: Array<{ tag: string; line?: number; id?: string }> = [];
  traverse(ast, {
    JSXElement(path) {
      const opening = path.node.openingElement;
      const tag = jsxTagName(opening.name);
      if (tag === 'MotionLink') { usesMotionLink = true; return; }
      const attrs = jsxAttrs(opening);
      if (!attrs.some((a) => a.name.name === 'href')) return; // not a link
      offenders.push({ tag, line: opening.loc?.start.line, id: stringAttr(attrs, 'data-id') });
    },
  });
  for (const o of offenders) {
    v.push({
      code: 'COMPONENT_LINK_NOT_MOTIONLINK', tier: 2, line: o.line, elementId: o.id,
      message: `<${o.tag}> at line ${o.line}${o.id ? ` (data-id="${o.id}")` : ''} is a navigating link (has href) inside a design component — links here MUST be a MotionLink, not <${o.tag}>. A plain <Link> won't participate in the layout/variant animation and a <motion.a>/<a> is a raw anchor (full page reload + the route may not resolve on the canvas). Declare ONCE at module scope: import Link from 'next/link'; const MotionLink = motion.create(Link); then write <MotionLink data-id="${o.id ?? '…'}" data-name="a" href="/path" layout style={{ … }}>Label</MotionLink>.`,
    });
  }
  if (usesMotionLink || offenders.length > 0) {
    const hasImport = /import\s+Link\s+from\s+['"]next\/link['"]/.test(code);
    const hasCreate = /const\s+MotionLink\s*=\s*motion\.create\(\s*Link\s*\)/.test(code);
    if (usesMotionLink && (!hasImport || !hasCreate)) {
      v.push({
        code: 'MOTIONLINK_SETUP_MISSING', tier: 2,
        message: `<MotionLink> is used but its setup is incomplete${!hasImport ? " — missing `import Link from 'next/link';`" : ''}${!hasCreate ? " — missing `const MotionLink = motion.create(Link);`" : ''}. Without BOTH, MotionLink is undefined and the component crashes. Add them at module scope (after the framer-motion/Link imports, before variantConfig).`,
      });
    }
  }
}

/** PAGE LINKS — on a page (or template), a navigating link MUST be the Next.js
 *  `<Link>` (import Link from 'next/link'), never a raw `<a>`/`<motion.a>`: a
 *  plain anchor does a FULL-PAGE reload and the route may not resolve on the
 *  canvas. (Design COMPONENTS use MotionLink — checkComponentLinks above.) CMS
 *  field-bound anchors (data-cms-bind-target / data-cms-field) are tool-owned
 *  and emitted as `<a>` by the bind generator — exempt so editor output passes. */
function checkPageLinks(code: string, ast: t.File, v: OracleViolation[]): void {
  let usesLink = false;
  let usesMotionLink = false;
  const offenders: Array<{ tag: string; line?: number; id?: string }> = [];
  traverse(ast, {
    JSXElement(path) {
      const opening = path.node.openingElement;
      const tag = jsxTagName(opening.name);
      // A navigating link on a page may be the Next.js <Link> OR <MotionLink>
      // (`motion.create(Link)`) — both route client-side; MotionLink just adds
      // framer-motion props so a page link can carry whileHover/whileTap/etc.
      // (the editor converts a <Link> → <MotionLink> when you add an animation
      // to it). Only raw <a>/<motion.a> are forbidden.
      if (tag === 'Link') { usesLink = true; return; }
      if (tag === 'MotionLink') { usesLink = true; usesMotionLink = true; return; }
      const attrs = jsxAttrs(opening);
      if (!attrs.some((a) => a.name.name === 'href')) return; // not a link
      // CMS field-bound anchors are tool-owned <a> — leave them.
      if (attrs.some((a) => a.name.name === 'data-cms-bind-target' || a.name.name === 'data-cms-field')) return;
      offenders.push({ tag, line: opening.loc?.start.line, id: stringAttr(attrs, 'data-id') });
    },
  });
  for (const o of offenders) {
    v.push({
      code: 'PAGE_LINK_NOT_NEXTLINK', tier: 2, line: o.line, elementId: o.id,
      message: `<${o.tag}> at line ${o.line}${o.id ? ` (data-id="${o.id}")` : ''} has an href — a navigating link on a PAGE MUST be the Next.js <Link> (from 'next/link') or a <MotionLink> (motion.create(Link), to animate it), never a raw <${o.tag}>. A plain <a> does a FULL-PAGE reload and the route may not resolve on the canvas. Replace it: add \`import Link from 'next/link';\` at the top, then <Link data-id="${o.id ?? '…'}" data-name="a" href="/path" style={{ … }}>Label</Link>.`,
    });
  }
  if (usesLink || offenders.length > 0) {
    if (!/import\s+Link\s+from\s+['"]next\/link['"]/.test(code)) {
      v.push({
        code: 'NEXTLINK_IMPORT_MISSING', tier: 2,
        message: `A page <Link> needs its import — add \`import Link from 'next/link';\` at the top of the file (after the React import). Without it Link is undefined and the page crashes.`,
      });
    }
  }
  // A page <MotionLink> needs `const MotionLink = motion.create(Link);` at module
  // scope or it's undefined at runtime — same setup check as design components.
  if (usesMotionLink && !/const\s+MotionLink\s*=\s*motion\.create\(\s*Link\s*\)/.test(code)) {
    v.push({
      code: 'MOTIONLINK_SETUP_MISSING', tier: 2,
      message: `<MotionLink> is used on this page but \`const MotionLink = motion.create(Link);\` is missing — without it MotionLink is undefined and the page crashes. Add it at module scope (after \`import Link from 'next/link';\`).`,
    });
  }
}

export { checkComponentLinks, checkPageLinks };
