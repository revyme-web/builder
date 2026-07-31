// text-anim-parser.ts — Parse data-text-anim attributes from JSX code.
// Returns TextAnimCall[] with nodeId, config, and code positions.

import type { TextAnimConfig } from '@/editor/tools/AnimationTool/motion/text-anim-presets';
import { trace } from '@/shared/debug-trace';
import { findTagClose } from '@/code/generation/generator-utils';

export interface TextAnimCall {
  nodeId: string;
  config: TextAnimConfig;
  codeStart: number;
  codeEnd: number;
}

/**
 * Parse all text animation declarations from JSX code.
 * Looks for elements with data-text-anim="..." attribute.
 */
export function parseTextAnimCalls(code: string): TextAnimCall[] {
  const results: TextAnimCall[] = [];

  // Find every `data-text-anim=` occurrence, then resolve the ENCLOSING opening tag via brace-aware
  // bounds. The old `<tag\s[^>]*data-text-anim=` regex broke on a composed node: the tag's onTap/
  // onHover handlers contain `=>` arrows, so `[^>]*` stopped before reaching data-text-anim — and the
  // fixed 500/2000-char windows fell short of a heavily-composed tag. findTagClose tracks `{}` depth, so
  // it skips `=>` inside handlers and the JSON braces in other attrs, finding the real tag end.
  const attrRegex = /\sdata-text-anim=/g;
  let match: RegExpExecArray | null;

  while ((match = attrRegex.exec(code)) !== null) {
    const tagStart = code.lastIndexOf('<', match.index);
    if (tagStart < 0) continue;
    const tagNameMatch = code.slice(tagStart).match(/^<(motion\.\w+|[\w]+)/);
    if (!tagNameMatch) continue;
    const tagName = tagNameMatch[1];

    const tagEnd = findTagClose(code, tagStart);
    if (tagEnd < 0) continue;
    const openTag = code.slice(tagStart, tagEnd + 1);

    const idMatch = openTag.match(/data-id="([^"]+)"/);
    if (!idMatch) continue;
    const nodeId = idMatch[1];

    // Extract data-text-anim JSON — single quote, double quote (escaped), or JSX expression.
    let config: TextAnimConfig | null = null;
    const sq = openTag.match(/data-text-anim='([^']+)'/);
    if (sq) { try { config = JSON.parse(sq[1]); } catch (err) { trace.error('text-anim-parser:parse-single-quote', { nodeId, error: String(err) }); } }
    if (!config) {
      const dq = openTag.match(/data-text-anim="([^"]+)"/);
      if (dq) { try { config = JSON.parse(dq[1].replace(/&quot;/g, '"')); } catch (err) { trace.error('text-anim-parser:parse-double-quote', { nodeId, error: String(err) }); } }
    }
    if (!config) {
      const ex = openTag.match(/data-text-anim=\{([^}]+)\}/);
      if (ex) { try { config = JSON.parse(ex[1]); } catch (err) { trace.error('text-anim-parser:parse-expr', { nodeId, error: String(err) }); } }
    }
    if (!config) continue;

    const closingTag = `</${tagName}>`;
    const closeIdx = code.indexOf(closingTag, tagEnd);
    const codeEnd = closeIdx >= 0 ? closeIdx + closingTag.length : tagEnd + 100;

    results.push({ nodeId, config, codeStart: tagStart, codeEnd });
  }

  trace.fn('text-anim-parser:parse', { count: results.length });
  return results;
}

/** Get the text animation for a specific node, if any */
export function getTextAnimForNode(calls: TextAnimCall[], nodeId: string): TextAnimCall | null {
  return calls.find(c => c.nodeId === nodeId) ?? null;
}
