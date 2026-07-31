// runtime-bridge.ts — React re-exports for preview iframe importmap.
// Mirror of `src/canvas-sandbox/runtime-bridge.ts`. See that file for
// the full rationale: Vite's CommonJS-package optimization buries hooks
// inside the default export, so we must explicitly name-export each API
// for `import { useState } from "react"` to find them.

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
