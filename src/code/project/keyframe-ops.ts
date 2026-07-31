// keyframe-ops.ts — Operations for reading/writing @keyframes in app/globals.css.
//
// Global keyframes live in app/globals.css alongside design tokens.
// This parallels preset-ops.ts for CSS custom properties.
// All pages import tokens.css so keyframes defined here are available everywhere.

import { projectFS } from './project-fs';
import { trace } from '@/shared/debug-trace';

const TOKENS_PATH = 'app/globals.css';
const KEYFRAMES_SECTION_MARKER = '/* Keyframes */';

/**
 * Add or replace a @keyframes rule in app/globals.css.
 * If the @keyframes already exists, replaces it. Otherwise appends.
 * If tokens.css doesn't exist yet, creates it with just the keyframes block.
 */
export function updateKeyframeInTokensCSS(name: string, keyframeCSSBlock: string): void {
  trace.fn('keyframe-ops:updateKeyframeInTokensCSS', { name, length: keyframeCSSBlock.length });
  let css = projectFS.readFile(TOKENS_PATH) ?? '';

  const nameEscaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const kfRegex = new RegExp(`@keyframes\\s+${nameEscaped}\\s*\\{[\\s\\S]*?\\n\\s*\\}`, 'g');

  if (kfRegex.test(css)) {
    // Replace existing block
    css = css.replace(kfRegex, keyframeCSSBlock);
    trace.action('keyframe-ops:replaced-existing', { name });
  } else {
    // Append — ensure a "Keyframes" section marker exists
    if (!css.includes(KEYFRAMES_SECTION_MARKER)) {
      css = css.trimEnd() + '\n\n' + KEYFRAMES_SECTION_MARKER + '\n';
    }
    css = css.trimEnd() + '\n\n' + keyframeCSSBlock + '\n';
    trace.action('keyframe-ops:appended-new', { name });
  }

  projectFS.writeFile(TOKENS_PATH, css);
  trace.action('keyframe-ops:updateKeyframeInTokensCSS:done', { name });
}

/**
 * Remove a @keyframes rule from app/globals.css.
 * No-op if the file or keyframe doesn't exist.
 */
export function removeKeyframeFromTokensCSS(name: string): void {
  trace.fn('keyframe-ops:removeKeyframeFromTokensCSS', { name });
  const css = projectFS.readFile(TOKENS_PATH);
  if (!css) return;

  const nameEscaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match optional leading whitespace + the full @keyframes block
  const kfRegex = new RegExp(`\\s*@keyframes\\s+${nameEscaped}\\s*\\{[\\s\\S]*?\\n\\s*\\}`, 'g');
  const updated = css.replace(kfRegex, '');

  projectFS.writeFile(TOKENS_PATH, updated);
  trace.action('keyframe-ops:removeKeyframeFromTokensCSS:done', { name });
}
