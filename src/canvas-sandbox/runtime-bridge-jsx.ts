// runtime-bridge-jsx.ts — Re-export `react/jsx-runtime` for shared bundles.
// Same explicit-re-export pattern as `runtime-bridge.ts` (see that file
// for the full rationale): Vite's CommonJS-package optimization buries
// the `jsx` / `jsxs` / `Fragment` exports inside the default export
// object, not as named ES exports — so `export *` doesn't expose them.
// Bundles compiled with `automatic` JSX runtime emit
// `import { jsx } from "react/jsx-runtime"` lines that the importmap
// routes here, so we MUST surface those three names explicitly.

import * as JsxRuntime from 'react/jsx-runtime';

export const jsx = (JsxRuntime as any).jsx;
export const jsxs = (JsxRuntime as any).jsxs;
export const jsxDEV = (JsxRuntime as any).jsxDEV;
export const Fragment = (JsxRuntime as any).Fragment;
