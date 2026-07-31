// runtime-bridge.ts — Re-export React so dynamically-loaded component bundles
// share the SAME module instance the sandbox iframe already has loaded.
//
// Why explicit re-exports (not `export *`):
//   Vite optimizes React (a CommonJS package) into a wrapper that exposes
//   only `default` and a CJS-internal `t` symbol as ES exports. Hooks like
//   `useState`, `useEffect`, `useSyncExternalStore` live on the DEFAULT
//   export object, NOT as named ES exports. So `export * from 'react'`
//   re-exports almost nothing — and bundles that do
//   `import { useSyncExternalStore } from 'react'` crash with
//   "does not provide an export named 'useSyncExternalStore'".
//
//   The fix: namespace-import React (which gives us a real object with
//   all properties), then explicitly `export const X = R.X` for each
//   API. Vite happily transforms the import into the same React module
//   the sandbox itself uses, so the bundle and the sandbox share one
//   instance — one ReactCurrentDispatcher → hooks work correctly inside
//   CDN-loaded components.

import * as React from 'react';

export default React;
export const useState = React.useState;
export const useReducer = React.useReducer;
export const useEffect = React.useEffect;
export const useLayoutEffect = React.useLayoutEffect;
export const useInsertionEffect = React.useInsertionEffect;
export const useRef = React.useRef;
export const useMemo = React.useMemo;
export const useCallback = React.useCallback;
export const useContext = React.useContext;
export const useId = React.useId;
export const useDeferredValue = React.useDeferredValue;
export const useTransition = React.useTransition;
export const useSyncExternalStore = React.useSyncExternalStore;
export const useImperativeHandle = React.useImperativeHandle;
export const useDebugValue = React.useDebugValue;
export const useActionState = React.useActionState;
export const useOptimistic = React.useOptimistic;
export const useFormStatus = (React as any).useFormStatus;
export const createContext = React.createContext;
export const createElement = React.createElement;
export const cloneElement = React.cloneElement;
export const isValidElement = React.isValidElement;
export const Children = React.Children;
export const forwardRef = React.forwardRef;
export const memo = React.memo;
export const lazy = React.lazy;
export const Suspense = React.Suspense;
export const Fragment = React.Fragment;
export const StrictMode = React.StrictMode;
export const Profiler = React.Profiler;
export const startTransition = React.startTransition;
export const version = React.version;
