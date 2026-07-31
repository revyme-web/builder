// runtime-bridge-motion.ts — Re-export `framer-motion` for shared bundles.
// Same explicit-re-export pattern as `runtime-bridge.ts` (see that file
// for the rationale): Vite optimizes framer-motion such that the named
// exports may not survive `export *`. Listing the surface explicitly
// guarantees CDN bundles that import `motion`, `AnimatePresence`, etc.
// resolve correctly to the sandbox's framer-motion instance — same
// motion context for layout animations, MotionConfig, LayoutGroup IDs.

import * as M from 'framer-motion';

export default M;
export const motion = M.motion;
export const m = (M as any).m;
export const AnimatePresence = M.AnimatePresence;
export const LayoutGroup = M.LayoutGroup;
export const MotionConfig = M.MotionConfig;
export const MotionConfigContext = M.MotionConfigContext;
export const LazyMotion = M.LazyMotion;
export const Reorder = M.Reorder;
export const useAnimate = M.useAnimate;
export const useAnimation = M.useAnimation;
export const useAnimationControls = M.useAnimationControls;
export const useMotionValue = M.useMotionValue;
export const useMotionValueEvent = M.useMotionValueEvent;
export const useMotionTemplate = M.useMotionTemplate;
export const useTransform = M.useTransform;
export const useSpring = M.useSpring;
export const useScroll = M.useScroll;
export const useVelocity = M.useVelocity;
export const useTime = M.useTime;
export const useInView = M.useInView;
export const useDragControls = M.useDragControls;
export const useReducedMotion = M.useReducedMotion;
export const useReducedMotionConfig = (M as any).useReducedMotionConfig;
export const usePresence = M.usePresence;
export const useIsPresent = M.useIsPresent;
export const useCycle = M.useCycle;
export const animate = M.animate;
export const animationControls = (M as any).animationControls;
export const transform = M.transform;
export const wrap = M.wrap;
export const stagger = M.stagger;
export const inView = M.inView;
export const hover = (M as any).hover;
export const press = (M as any).press;
export const scroll = M.scroll;
export const cubicBezier = M.cubicBezier;
export const mix = M.mix;
export const useWillChange = (M as any).useWillChange;
export const usePresenceData = (M as any).usePresenceData;
