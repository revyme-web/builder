// code-component-runtime.ts — Compile Code component TSX code to executable React components.
// Uses @babel/standalone for TSX → JS, then new Function for execution.

import { transform } from '@babel/standalone';
import { simpleHash } from '@/shared/hash-utils';
import React, { useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect, useReducer, useContext, createContext, forwardRef, memo, lazy, Suspense, Fragment } from 'react';
import * as motionRuntime from 'framer-motion';
import * as revymeRuntime from '@revyme/runtime';
import { trace } from '@/shared/debug-trace';
import { upgradeVectorSetInstanceBranch } from '@/code/icons/icon-set-template';

// ─── Unified withResponsiveProps HOC ────────────────────────────────────────
// Single implementation used by both canvas (via MODULE_MAP) and production
// (via lib/withResponsiveProps.tsx — same logic). Reads `data-responsive` JSON
// and merges per-viewport overrides. On canvas, CodeComponentHost injects
// `__canvasViewportWidth`; in production, uses `window.innerWidth`.

function withResponsiveProps(Component: any) {
  // forwardRef so a `forwardRef` inner (icon-set / vector-set instances, which
  // need the ref for hover/in-view effects + motion-value styles) still receives
  // it. The ref is passed through ONLY when one is actually provided — handing a
  // ref to a plain function component (design components) would warn, and those
  // are never given a ref.
  return React.forwardRef(function ResponsiveCodeComponent(props: any, ref: any) {
    const canvasVpWidth = props['__canvasViewportWidth'] as number | undefined;

    const [windowWidth, setWindowWidth] = React.useState(
      typeof window !== 'undefined' ? window.innerWidth : 1440
    );

    React.useEffect(() => {
      if (canvasVpWidth !== undefined) return;
      const handler = () => setWindowWidth(window.innerWidth);
      window.addEventListener('resize', handler);
      return () => window.removeEventListener('resize', handler);
    }, [canvasVpWidth]);

    const vpWidth = canvasVpWidth ?? windowWidth;
    const responsiveStr = props['data-responsive'];
    let mergedProps = { ...props };

    if (responsiveStr) {
      try {
        const overrides = typeof responsiveStr === 'string'
          ? JSON.parse(responsiveStr) : responsiveStr;
        // _bp contains all viewport breakpoint widths for range computation.
        // Each breakpoint's range is (prev_bp, bp]. This prevents cascade
        // (e.g. tablet override doesn't leak to mobile).
        const allBp: number[] = Array.isArray(overrides._bp)
          ? overrides._bp : Object.keys(overrides).filter(k => k !== '_bp').map(Number);
        const sortedBp = [...allBp].sort((a, b) => a - b);

        // Find which range vpWidth falls into
        let matchedBp: number | undefined;
        for (let i = 0; i < sortedBp.length; i++) {
          const lower = i > 0 ? sortedBp[i - 1] : 0;
          if (vpWidth > lower && vpWidth <= sortedBp[i]) {
            matchedBp = sortedBp[i];
            break;
          }
        }
        if (matchedBp !== undefined && overrides[matchedBp]) {
          const ov = overrides[matchedBp];
          // A Scroll Variant binds `initialVariant={…Sv}` and OWNS it at runtime (morphs on
          // scroll). Don't let the per-viewport data-responsive entry freeze it on replicas —
          // skip ONLY `initialVariant` from the merge when a scroll variant is present. The
          // per-viewport CHOICE still drives the canvas + the Sv resting. (Mirrors @revyme/runtime.)
          if (props['data-scroll-variant'] && ov && typeof ov === 'object' && 'initialVariant' in ov) {
            const { initialVariant: _skip, ...rest } = ov as Record<string, unknown>;
            mergedProps = { ...mergedProps, ...rest };
          } else {
            mergedProps = { ...mergedProps, ...ov };
          }
        }
      } catch { /* invalid JSON — ignore */ }
    }

    delete mergedProps['data-responsive'];
    delete mergedProps['__canvasViewportWidth'];
    return React.createElement(Component, ref ? { ...mergedProps, ref } : mergedProps);
  });
}

// ─── Canvas renderer detection hook ─────────────────────────────────────────
// Returns true when running inside the canvas editor (CodeComponentHost), false in production.
// Code components use this to skip heavy effects (SVG filters, rAF loops, WebGL) on the canvas.
function useIsCanvasRenderer(): boolean {
  return true; // Always true in code-component-runtime (canvas context)
}

// next-themes stub — code components like ThemeToggle import `useTheme` from
// 'next-themes', which on the live Next.js site flips `<html class="dark">`
// and persists the choice. On the canvas the real package isn't bundled and
// the editor has its own theme switcher anyway, so we stub `useTheme` to
// return a fixed `{ theme: 'light', setTheme: noop }`. The button still
// renders correctly; clicking it is a harmless no-op.
const stubUseTheme = () => ({
  theme: 'light',
  resolvedTheme: 'light',
  systemTheme: 'light',
  themes: ['light', 'dark'],
  setTheme: () => {},
});
const nextThemesStub = {
  useTheme: stubUseTheme,
  ThemeProvider: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
};

// next-intl stub — code components like LocaleSwitcher / pages may
// `import { useTranslations, useLocale } from 'next-intl'`. On the canvas
// there's no NextIntlClientProvider in scope and the active-locale display
// is driven by the locale-override map (Renderer applies the override text
// on top of the JSX default). So `t(key)` returns the key as a fallback —
// safe enough for canvas; the live website resolves through real next-intl.
const stubUseTranslations = (_namespace?: string) => {
  const t = (key: string, _values?: any) => key;
  // next-intl's t() exposes .rich / .raw / .markup. Stub them so user code
  // that calls e.g. `t.rich('welcome', { strong: (chunks) => <strong>{chunks}</strong> })`
  // doesn't crash on the canvas.
  (t as any).rich = (key: string) => key;
  (t as any).raw = (key: string) => key;
  (t as any).markup = (key: string) => key;
  (t as any).has = () => false;
  return t;
};
const nextIntlStub = {
  useTranslations: stubUseTranslations,
  useLocale: () => 'en',
  useMessages: () => ({}),
  useFormatter: () => ({
    dateTime: (d: any) => String(d),
    number: (n: any) => String(n),
    relativeTime: (d: any) => String(d),
    list: (l: any[]) => l.join(', '),
  }),
  NextIntlClientProvider: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
};

// Module scope for Code component code execution — pre-loaded ES modules
const MODULE_MAP: Record<string, any> = {
  'react': { ...React, default: React, useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect, useReducer, useContext, createContext, forwardRef, memo, lazy, Suspense, Fragment, createElement: React.createElement },
  'framer-motion': motionRuntime,
  // `@revyme/runtime` is the new home for `withResponsiveProps`, `withCursor`,
  // `CursorPortal`, `useStaticCanvas`, etc. Generated user code (post-2026-05-06)
  // imports from here as a normal package; the canvas iframe has it pre-loaded
  // so the dynamic `import` resolves without a network roundtrip. Keeps the
  // same shape as the npm package once we publish.
  //
  // `useStaticCanvas` is OVERRIDDEN here to return `true`: the package's own
  // implementation defaults to `false` (production assumption), but on canvas
  // we want code components to take their static branch. Preview mode flips it back to
  // `false` lower in compileCodeComponent (see `previewOverrides` block).
  // `withResponsiveProps` is OVERRIDDEN with the LOCAL canvas copy: it is
  // identical to the package's responsive logic BUT forwards a `ref` (only when
  // one is passed) so a `forwardRef` inner — icon-set / vector-set instances,
  // which need the ref for hover/in-view effects + motion-value styles — still
  // receives it. The package version drops the ref. No-op for the plain-function
  // design components (never handed a ref). Live preview / export use the
  // package version directly (this MODULE_MAP only feeds the canvas sandbox).
  '@revyme/runtime': { ...revymeRuntime, useStaticCanvas: () => true, withResponsiveProps },
  // Legacy entries — older user projects still have `import withResponsiveProps
  // from '@/lib/withResponsiveProps'`. Resolve these to the same function so
  // they keep working without a project codemod. Old projects can migrate
  // lazily; new projects don't generate these imports.
  '@/lib/withResponsiveProps': { default: withResponsiveProps },
  'lib/withResponsiveProps': { default: withResponsiveProps },
  '@/lib/cursor-runtime': revymeRuntime,
  'lib/cursor-runtime': revymeRuntime,
  '@/lib/useIsCanvasRenderer': { default: useIsCanvasRenderer, useIsCanvasRenderer },
  'lib/useIsCanvasRenderer': { default: useIsCanvasRenderer, useIsCanvasRenderer },
  'next-themes': nextThemesStub,
  'next-intl': nextIntlStub,
};

// Lazily load three.js when first requested.
// Use Function('return import(...)') to prevent Vite from statically analyzing
// the import — three and spline are optional runtime dependencies, not bundled.
let _threeLoaded = false;
async function ensureThree() {
  if (_threeLoaded) return;
  _threeLoaded = true;
  try {
    const dynamicImport = new Function('specifier', 'return import(specifier)');
    const THREE = await dynamicImport('three');
    MODULE_MAP['three'] = { default: THREE, ...THREE };
    const gltfModule = await dynamicImport('three/examples/jsm/loaders/GLTFLoader.js');
    MODULE_MAP['three/examples/jsm/loaders/GLTFLoader.js'] = { GLTFLoader: gltfModule.GLTFLoader };
    trace.action('code-component-runtime:three-loaded');
  } catch { /* three not installed */ }
}

let _splineLoaded = false;
async function ensureSpline() {
  if (_splineLoaded) return;
  _splineLoaded = true;
  try {
    const dynamicImport = new Function('specifier', 'return import(specifier)');
    const spline = await dynamicImport('@splinetool/runtime');
    MODULE_MAP['@splinetool/runtime'] = { default: spline, ...spline };
    trace.action('code-component-runtime:spline-loaded');
  } catch { /* spline not installed */ }
}

// Cache compiled components by content hash
const codeComponentCache = new Map<string, React.ComponentType<any>>();

/** Cheap content hash — covers the WHOLE source so edits anywhere
 *  invalidate the cache. The previous `code.slice(0, 100)` cache key
 *  missed every edit past byte 100 (which is where the actual JSX
 *  lives in a typical icon-set/component file — past the imports +
 *  annotation comments). Result: editing a vector's color in the
 *  master never invalidated the compiled component, so instances
 *  rendered the stale version forever. */
const fastContentHash = simpleHash;

/**
 * Compile a Code component TSX file to an executable React component.
 * Uses @babel/standalone for TSX → JS, then new Function for execution.
 *
 * If the Component source wraps its export with withResponsiveProps, the compiled
 * component is already responsive-aware (reads __canvasViewportWidth from CodeComponentHost).
 * For legacy Code components without the wrapper, we apply it as a fallback.
 */
/** Brace-BALANCED removal of JSX mouse/pointer/click handler props
 *  (onMouseEnter={…}, onClick={…}, …) from code component source — they fire on the
 *  code component's own DOM and fight canvas interaction. The earlier `[^}]*` regex
 *  stopped at the FIRST `}` inside the handler (a block body `() => { … }` or
 *  an object literal `setX({…})` or a template `\`${x}\``), leaving a stray `}`
 *  that broke the JSX → "Compilation returned null". This scans the matching
 *  close brace so the whole prop is removed regardless of inner braces. */
const JSX_MOUSE_HANDLER_RE = /\bon(?:Mouse(?:Move|Enter|Leave|Down|Up|Over|Out)|Pointer(?:Move|Enter|Leave|Down|Up|Over|Out)|Click|DoubleClick|ContextMenu|Wheel)\s*=\s*\{/g;
function stripJsxMouseHandlers(src: string): string {
  let out = '';
  let last = 0;
  JSX_MOUSE_HANDLER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = JSX_MOUSE_HANDLER_RE.exec(src)) !== null) {
    const start = m.index;
    let i = start + m[0].length - 1; // index of the opening '{'
    let depth = 0;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    out += src.slice(last, start);
    last = i;
    JSX_MOUSE_HANDLER_RE.lastIndex = i;
  }
  return out + src.slice(last);
}

export function compileCodeComponent(
  code: string,
  componentName: string,
  opts?: { previewMode?: boolean; extraModules?: Record<string, any>; skipCache?: boolean },
): React.ComponentType<any> | null {
  // Upgrade legacy VECTOR SET files so an instance SCALES its vector with the box
  // (older files left the inner <svg> at a fixed px size → the vector didn't grow
  // when you resized the instance). Idempotent no-op for everything else.
  code = upgradeVectorSetInstanceBranch(code);
  // Check cache — preview mode gets a separate cache key.
  // Hash the WHOLE source so edits past the file header invalidate.
  const cacheKey = (opts?.previewMode ? 'preview:' : '') + code.length + ':' + fastContentHash(code);
  if (opts?.skipCache) {
    codeComponentCache.delete(cacheKey);
  }
  const cached = codeComponentCache.get(cacheKey);
  if (cached) {
    trace.fn('code-component-runtime:cache-hit', { componentName });
    return cached;
  }

  try {
    // Pre-populate MODULE_MAP for optional heavy dependencies (fire-and-forget)
    if (code.includes("from 'three'") || code.includes('from "three"')) {
      ensureThree();
    }
    if (code.includes("from '@splinetool/runtime'") || code.includes('from "@splinetool/runtime"')) {
      ensureSpline();
    }

    // Check if the source already wraps with withResponsiveProps
    const hasNativeResponsive = code.includes('withResponsiveProps');

    // 1. Strip @canvas and @controls comment blocks (not needed at runtime)
    let cleanCode = code
      .replace(/\/\*\*?\s*@canvas\s*\{[\s\S]*?\}\s*\*\/\s*\n?/g, '')
      .replace(/\/\*\*?\s*@label\s*"[^"]*"\s*\*\//g, '')
      .replace(/\/\*\*?\s*@comment\s*"[^"]*"\s*\*\//g, '')
      .replace(/\/\*\*?\s*@controls\s*\{[\s\S]*?\}\s*\*\//g, '');

    // 2. Strip 'use client' directive
    cleanCode = cleanCode.replace(/^['"]use client['"];?\s*\n?/gm, '');

    // 2b. Canvas safety: strip dangerous global side effects.
    // NOTE: CSS keyframe/animation stripping was removed — too many edge cases with
    // template expressions, JS vs CSS context, nested braces. Future approach: code components
    // provide their own static version via useIsCanvasRenderer() hook.
    // Strip window/document.addEventListener calls for mouse/pointer events.
    // Replace with `void 0` (a valid expression) instead of a comment, so the
    // result still parses inside arrow-function bodies — `return () => void 0`
    // is fine, but `return () => /* stripped */` is a syntax error. The
    // comment is kept inline so the strip is still discoverable in dev tools.
    cleanCode = cleanCode.replace(
      /(?:window|document)\.addEventListener\(\s*['"](?:mouse\w+|pointer\w+|click|dblclick|contextmenu|wheel)['"][^)]*\)/g,
      '(/* canvas: mouse listener stripped */ void 0)'
    );
    cleanCode = cleanCode.replace(
      /(?:window|document)\.removeEventListener\(\s*['"](?:mouse\w+|pointer\w+|click|dblclick|contextmenu|wheel)['"][^)]*\)/g,
      '(/* canvas: mouse listener stripped */ void 0)'
    );

    // 2c. Strip React JSX mouse/pointer event handler props (onMouseMove, onMouseEnter, etc.)
    // These fire on the code component's own DOM and interfere with canvas interaction.
    // Brace-balanced (handles block bodies / object literals inside the handler).
    cleanCode = stripJsxMouseHandlers(cleanCode);

    // 2d. Auto-inject missing framer-motion import. Master files
    // (icon-set / component) can drift into a state where
    // they reference `motion.svg` / `motion.div` etc. but lack the
    // `import { motion } from 'framer-motion'` line — mostly when the
    // edit happened through `modifyProjectFile` before its syncImports
    // pass landed, or when an older generator emitted the prefix
    // unconditionally. Without the import, `motion` is undefined at
    // runtime, the IIFE throws on first access, and EVERY instance of
    // the master renders blank with no error surfaced to the canvas.
    // Detect-and-fill here is a thin safety net so the live preview
    // doesn't break on legacy state — the long-term fix is the
    // generator + syncImports pair, which is already in place.
    if (/\bmotion\./.test(cleanCode) &&
        !/from\s+['"]framer-motion['"]/.test(cleanCode)) {
      trace.action('code-component-runtime:auto-inject-motion-import', { componentName });
      cleanCode = `import { motion } from 'framer-motion';\n` + cleanCode;
    }

    // 3. Convert imports to require calls for our module scope
    // Transform: import X from 'mod' → const X = __require('mod').default || __require('mod')
    // Transform: import { a, b } from 'mod' → const { a, b } = __require('mod')
    // Transform: import X, { a, b } from 'mod' → combined
    // SPECIAL: 'import React' is skipped because React is already passed as IIFE parameter
    cleanCode = cleanCode
      .replace(/import\s+React\s*,\s*\{([^}]+)\}\s+from\s+['"]react['"]/g,
        'const {$1} = __require("react")')
      .replace(/import\s+React\s+from\s+['"]react['"]/g, '/* React provided by runtime */')
      .replace(/import\s+(\w+)\s*,\s*\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g,
        'const $1 = __require("$3").default || __require("$3"); const {$2} = __require("$3")')
      .replace(/import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g, 'const {$1} = __require("$2")')
      .replace(/import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g, 'const $1 = __require("$2").default || __require("$2")');

    // 4. Convert export default → variable assignment
    cleanCode = cleanCode.replace(/export\s+default\s+function\s+(\w+)/, 'var __CODE_COMPONENT__ = function $1');
    cleanCode = cleanCode.replace(/export\s+default\s+/, 'var __CODE_COMPONENT__ = ');

    // 5. Wrap in IIFE so Babel treats it as a script (not module) and return works
    const wrapped = `(function(__require, React) {\n${cleanCode}\nreturn __CODE_COMPONENT__;\n})`;

    const result = transform(wrapped, {
      presets: ['react', 'typescript'],
      filename: `${componentName}.tsx`,
    });

    if (!result.code) throw new Error('Babel transform returned empty code');

    // 6. Create the require function for module resolution
    // In preview mode, override the "is this canvas?" hooks to return false so
    // animations run with full effects in the code component editor's preview pane.
    const useIsCanvasRendererOverride = opts?.previewMode ? () => false : useIsCanvasRenderer;
    const previewOverrides: Record<string, any> = opts?.previewMode ? {
      '@/lib/useIsCanvasRenderer': { default: useIsCanvasRendererOverride, useIsCanvasRenderer: useIsCanvasRendererOverride },
      'lib/useIsCanvasRenderer': { default: useIsCanvasRendererOverride, useIsCanvasRenderer: useIsCanvasRendererOverride },
      // `@revyme/runtime` is mapped above to a spread of the real package +
      // `useStaticCanvas: () => true`. Re-spread here with `() => false` so
      // preview-pane code components animate normally.
      '@revyme/runtime': { ...revymeRuntime, useStaticCanvas: () => false },
    } : {};

    const extraModules = opts?.extraModules || {};
    const __require = (mod: string) => {
      // Check preview overrides first
      if (previewOverrides[mod]) return previewOverrides[mod];
      // Caller-provided modules (e.g. nested component imports for live preview)
      if (extraModules[mod]) return extraModules[mod];
      const resolved = MODULE_MAP[mod];
      if (resolved) return resolved;
      const shortMod = mod.replace(/^@\//, '');
      if (previewOverrides[shortMod]) return previewOverrides[shortMod];
      if (extraModules[shortMod]) return extraModules[shortMod];
      if (MODULE_MAP[shortMod]) return MODULE_MAP[shortMod];
      trace.error('code-component-runtime:module-not-found', { module: mod, componentName });
      return {};
    };

    // 7. Execute — the IIFE returns the component function
    const factory = eval(result.code);
    let Component = factory(__require, React);

    // A component is a function OR a React "exotic" type — an OBJECT carrying a
    // `$$typeof` tag: `React.forwardRef(...)` (icon-set / vector-set instances use
    // this so page effects can bind a ref + animate a motion root), `React.memo`,
    // `lazy`, etc. The bare `typeof === 'function'` check wrongly rejected those
    // (forwardRef is an object) → the component compiled to null → blank render.
    const isRenderableComponent = typeof Component === 'function'
      || (typeof Component === 'object' && Component !== null && (Component as any).$$typeof != null);
    if (!isRenderableComponent) {
      trace.error('code-component-runtime:not-a-component', { componentName, type: typeof Component });
      return null;
    }

    // 8. Fallback: wrap legacy Code components that don't have native withResponsiveProps
    if (!hasNativeResponsive) {
      Component = withResponsiveProps(Component);
      trace.action('code-component-runtime:legacy-wrap', { componentName });
    }

    trace.action('code-component-runtime:compiled', { componentName, codeLength: code.length, nativeResponsive: hasNativeResponsive });
    codeComponentCache.set(cacheKey, Component);
    return Component;
  } catch (err: any) {
    trace.error('code-component-runtime:compile-failed', { componentName, error: err.message });
    return null;
  }
}

/** Clear the code component compilation cache (call when component source changes) */
export function clearCodeComponentCache(): void {
  codeComponentCache.clear();
  trace.action('code-component-runtime:cache-cleared');
}
