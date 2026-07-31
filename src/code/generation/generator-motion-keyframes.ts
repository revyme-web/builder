// generator-motion-keyframes.ts — @keyframes block manipulation in <style> tags.
// All code moved VERBATIM from generator-motion.ts (Phase 7.4 god-file split).
import { escapeRegExp } from '@/shared/regex-utils';
import { trace } from '@/shared/debug-trace';

// ─── Keyframes Manipulation ──────────────────────────────────────────────────

/**
 * Add or replace a @keyframes rule in the <style> block.
 * If the @keyframes already exists, replaces it. Otherwise appends.
 * If no <style> block exists, creates one.
 */
export function updateKeyframesInCode(code: string, name: string, css: string): string {
  trace.fn('generator.updateKeyframesInCode', { name, cssLength: css.length });

  // Find existing <style> block
  const styleMatch = code.match(/(<style>\s*\{[`'])([\s\S]*?)([`']\}\s*<\/style>)/);

  if (!styleMatch) {
    // No style block — create one with the keyframes after root opening tag
    const rootClose = code.indexOf('>');
    if (rootClose === -1) return code;
    // Find the actual root element closing > (skip nested elements in the opening tag area)
    const rootTag = code.match(/<\w[^>]*data-id="root"[^>]*>/);
    if (!rootTag) return code;
    const insertPos = (rootTag.index ?? 0) + rootTag[0].length;
    const styleBlock = `\n      <style>{\`\n${css}\n      \`}</style>`;
    return code.slice(0, insertPos) + styleBlock + code.slice(insertPos);
  }

  const [, prefix, existingCSS, suffix] = styleMatch;
  const fullMatchStart = styleMatch.index!;

  // Check if this @keyframes already exists
  const nameEscaped = escapeRegExp(name);
  const keyframeRegex = new RegExp(`@keyframes\\s+${nameEscaped}\\s*\\{[\\s\\S]*?\\n\\s*\\}`, 'g');

  let newCSS: string;
  if (keyframeRegex.test(existingCSS)) {
    // Replace existing
    newCSS = existingCSS.replace(keyframeRegex, css);
  } else {
    // Append
    newCSS = existingCSS.trimEnd() + '\n' + css + '\n      ';
  }

  return code.slice(0, fullMatchStart) + prefix + newCSS + suffix + code.slice(fullMatchStart + styleMatch[0].length);
}

/**
 * Remove a @keyframes rule from the <style> block.
 */
export function removeKeyframesFromCode(code: string, name: string): string {
  trace.fn('generator.removeKeyframesFromCode', { name });

  const nameEscaped = escapeRegExp(name);
  const keyframeRegex = new RegExp(`\\s*@keyframes\\s+${nameEscaped}\\s*\\{[\\s\\S]*?\\n\\s*\\}`, 'g');

  // Find the style block and remove the keyframes from it
  const styleMatch = code.match(/(<style>\s*\{[`'])([\s\S]*?)([`']\}\s*<\/style>)/);
  if (!styleMatch) return code;

  const [, prefix, existingCSS, suffix] = styleMatch;
  const fullMatchStart = styleMatch.index!;
  const newCSS = existingCSS.replace(keyframeRegex, '');

  return code.slice(0, fullMatchStart) + prefix + newCSS + suffix + code.slice(fullMatchStart + styleMatch[0].length);
}


