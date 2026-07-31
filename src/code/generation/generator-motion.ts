// generator-motion.ts — Animation writes against the JSX source.
// Covers: framer-motion <MotionConfig> default transition, per-variant entry
// transitions, @keyframes block manipulation in <style> tags, framer-motion
// `animate`/`initial`/`whileHover` etc. prop writes, and scroll-linked
// useScroll + useTransform/useMotionTemplate animations. Self-contained.

// Phase 7.4 split (oss-release-plan/phase-7-god-file-splits.md): the
// implementation now lives in the generator-motion-* section modules below;
// this file remains as the public barrel so importers are unchanged.
export * from './generator-motion-transition';
export * from './generator-motion-keyframes';
export * from './generator-motion-props';
export * from './generator-motion-scroll';
export * from './generator-motion-compose';
export * from './generator-motion-loop';
export * from './generator-motion-scroll-fx';
// Re-exported for existing callers (responsive-attrs-gen, hoist-prop, tests…)
export { buildScopedScalarExpr, parseScopedScalarExpr, ensureMediaQueryHook, ensureMediaGate, sweepOrphanMediaGates, type SerScope } from './scoped-expr';
