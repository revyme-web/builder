// import-detection.mjs — Shared framework-import detection for JSX bodies.
//
// Single source of truth used by:
//   - src/code/mutation/mutation-queue.ts → `buildAutoImports`, called per
//     flush so the active page always has the React/framer-motion
//     imports it needs.
//   - scripts/add-template-imports.mjs → one-shot pre-baking the same
//     import shape into debug-templates/*.jsx so the live preview iframe
//     can compile them without missing-import-style
//     interop crashes.
//
// .mjs (not .ts) so Node's plain ESM loader can require it from
// scripts/, while Vite still resolves it from TS via its native .mjs
// import support. Kept dependency-free for the same reason — nothing
// here pulls in projectFS, parser, or any browser API.
//
// Detection is intentionally generous: identifier matches (even inside
// a string literal) wins. False positives only emit an unused import;
// false negatives crash the preview at runtime.

/**
 * Inspect a JSX body string and return the import lines that should appear
 * at the top of the file. Caller decides where to slot them in (after
 * `'use client'`, after a JSDoc block, etc.) — this helper just emits
 * the lines themselves.
 *
 * @param {string} body — JSX/TS source code (without the leading import block)
 * @returns {string[]} lines, one import per entry, no trailing newlines
 */
export function buildAutoImports(body) {
  // React hooks — bare identifier match (no leading dot).
  const hooks = [];
  if (/\buseState\b/.test(body)) hooks.push('useState');
  if (/\buseEffect\b/.test(body)) hooks.push('useEffect');
  if (/\buseRef\b/.test(body)) hooks.push('useRef');
  if (/\buseCallback\b/.test(body)) hooks.push('useCallback');
  if (/\buseMemo\b/.test(body)) hooks.push('useMemo');
  if (/\buseLayoutEffect\b/.test(body)) hooks.push('useLayoutEffect');

  // Motion. `motion.` is matched as member-access (everything else
  // is a bare named import).
  const motion = [];
  if (/\bmotion\./.test(body)) motion.push('motion');
  if (/\bAnimatePresence\b/.test(body)) motion.push('AnimatePresence');
  if (/\buseScroll\b/.test(body)) motion.push('useScroll');
  if (/\buseTransform\b/.test(body)) motion.push('useTransform');
  if (/\buseSpring\b/.test(body)) motion.push('useSpring');
  if (/\buseMotionTemplate\b/.test(body)) motion.push('useMotionTemplate');
  if (/\buseInView\b/.test(body)) motion.push('useInView');
  if (/\buseMotionValueEvent\b/.test(body)) motion.push('useMotionValueEvent');
  // useMotionValue + imperative animate() drive the COMPOSED scroll-effect form
  // (Appear×Transform stacked into one element). Without these two detectors,
  // syncImports regenerates the framer-motion import without them and the
  // composed body throws `useMotionValue is not defined` at runtime.
  // `\buseMotionValue\b` does NOT match inside `useMotionValueEvent` (no word
  // boundary between 'e' and 'E'). For `animate`, match the CALL form
  // `animate(` so the JSX `animate=` motion PROP doesn't trigger a false import.
  if (/\buseMotionValue\b/.test(body)) motion.push('useMotionValue');
  if (/\banimate\s*\(/.test(body)) motion.push('animate');
  // Component-instance Hover/Press: motion's imperative gesture fns wired at the
  // page level (`hover(ref.current, …)` / `press(ref.current, …)`). Match the
  // CALL form so a stray identifier can't trigger a false import.
  if (/\bhover\s*\(/.test(body)) motion.push('hover');
  if (/\bpress\s*\(/.test(body)) motion.push('press');
  // LayoutGroup wraps the design-component master render to enable
  // framer-motion FLIP layout animations between variants. Emitted by
  // `buildComponentFile` in component-ops.ts; without this detector
  // every syncImports pass after addVariant / addInteractionState
  // strips `LayoutGroup` from the framer-motion import line, breaking
  // the JSX (`<LayoutGroup>` becomes an undefined identifier).
  if (/<LayoutGroup\b/.test(body) || /\bLayoutGroup\b/.test(body)) motion.push('LayoutGroup');
  // MotionConfig is the per-component default-transition wrapper that
  // `addVariant` / `updateMotionConfigTransition` emit when the user
  // configures a root-level transition. Same drop-on-syncImports issue
  // as LayoutGroup if not detected here.
  if (/<MotionConfig\b/.test(body) || /\bMotionConfig\b/.test(body)) motion.push('MotionConfig');


  const lines = [];
  if (hooks.length > 0) {
    lines.push(`import React, { ${hooks.join(', ')} } from 'react';`);
  } else {
    lines.push(`import React from 'react';`);
  }
  if (motion.length > 0) {
    lines.push(`import { ${motion.join(', ')} } from 'framer-motion';`);
  }
  // `MotionLink` (the `motion.create(Link)` wrapper on component masters)
  // references `Link` in its declaration even though the body has no literal
  // `<Link>` tag — detect it so the next/link import survives the rebuild.
  if (/<Link[\s/>]/.test(body) || /\bMotionLink\b/.test(body)) lines.push(`import Link from 'next/link';`);
  if (/<Image[\s/>]/.test(body)) lines.push(`import Image from 'next/image';`);

  // @revyme/runtime — exports plugin authors / generated Spark components
  // commonly use. Detected as bare identifiers in the body. Currently:
  //   - withResponsiveProps (HOC wrapper on the default export)
  //   - useStaticCanvas (cheap "is this rendering on the static canvas?"
  //     hook used inside Spark code components to skip heavy effects)
  //   - playSketchDraw (drives the canvas sketch-stroke animation)
  //   - withCursor (component-cursor spread: `{...withCursor(C, {…})}`)
  //   - CursorPortal (mounts the cursor portal in layout files)
  // Adding this detector means plugins (and AI-generated Spark files)
  // can omit the import line — `syncImports` will inject it at flush
  // time. Without it, files lose `withResponsiveProps` whenever the
  // page re-flushes, breaking responsive prop overrides on canvas.
  //
  // withCursor / CursorPortal MUST be here too: `buildAutoImports` OWNS the
  // `@revyme/runtime` import line (the dedup pass in syncImports drops any
  // pre-existing one and lets this rebuild it). On a component master — which
  // already imports `withResponsiveProps` — that rebuild would otherwise strip
  // the `withCursor` that cursor-gen just added, crashing the preview with
  // "withCursor is not defined". (Pages without `withResponsiveProps` never
  // hit the rebuild, so the bug only showed up for cursor-as-variable inside
  // a master.)
  const revymeRuntime = [];
  if (/\bwithResponsiveProps\b/.test(body)) revymeRuntime.push('withResponsiveProps');
  if (/\buseStaticCanvas\b/.test(body)) revymeRuntime.push('useStaticCanvas');
  if (/\bplaySketchDraw\b/.test(body)) revymeRuntime.push('playSketchDraw');
  if (/\bwithCursor\b/.test(body)) revymeRuntime.push('withCursor');
  if (/\bCursorPortal\b/.test(body)) revymeRuntime.push('CursorPortal');
  if (/\bRevymeSplitText\b/.test(body)) revymeRuntime.push('RevymeSplitText');
  // localizeRows — a translated CMS collection list resolves its own locale at
  // the head of the chain. Missing here, the dedup pass above dropped the
  // import line and nothing rebuilt it, so the FIRST edit after the list was
  // localized crashed the page with "localizeRows is not defined" (live find
  // 2026-08-10). Every runtime callable a generated page can reference belongs
  // in this list — see runtime-exports-covered.test.ts, which fails when one
  // is missing.
  if (/\blocalizeRows\b/.test(body)) revymeRuntime.push('localizeRows');
  if (revymeRuntime.length > 0) {
    lines.push(`import { ${revymeRuntime.join(', ')} } from '@revyme/runtime';`);
  }

  return lines;
}
