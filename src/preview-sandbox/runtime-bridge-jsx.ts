// runtime-bridge-jsx.ts — react/jsx-runtime re-exports for preview importmap.
// Mirror of `src/canvas-sandbox/runtime-bridge-jsx.ts`.
import * as JsxRuntime from 'react/jsx-runtime';

export const jsx = (JsxRuntime as any).jsx;
export const jsxs = (JsxRuntime as any).jsxs;
export const jsxDEV = (JsxRuntime as any).jsxDEV;
export const Fragment = (JsxRuntime as any).Fragment;
