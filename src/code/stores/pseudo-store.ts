// pseudo-store.ts — Pseudo-element styles atom.
// Re-parses ::before/::after rules from the page's <style> block on code changes.
// Mirrors cssHoverStylesAtom in animation-store.ts.

import { atom } from 'jotai';
// Stable mirror — pseudo rules don't change on reparent.
import { stableCodeAtom as codeAtom } from './store';
import { extractStyleCSS } from '@/code/parsing/parser';
import { parsePseudoRules, type PseudoStyles } from '@/code/parsing/pseudo-parser';
import { trace } from '@/shared/debug-trace';

/** Parsed pseudo-element styles for all nodes in the active file. */
export const pseudoStylesAtom = atom<Map<string, PseudoStyles>>((get) => {
  const code = get(codeAtom);
  if (!code) return new Map();
  const css = extractStyleCSS(code);
  if (!css) return new Map();
  const result = parsePseudoRules(css);
  trace.fn('pseudo-store:pseudoStylesAtom', { ruleCount: result.size });
  return result;
});
