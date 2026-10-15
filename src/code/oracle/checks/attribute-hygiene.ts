// oracle/checks/attribute-hygiene.ts — attribute shapes that build but mislead.
//
// DUPLICATE_ATTRIBUTE — `<Hero layout="a" layout={b} />` parses (Babel accepts
// it; esbuild only warns) and renders `b`: one props object, the later key
// wins. The first copy is dead, and edits that land on it change nothing on
// screen. The agent's old set_component_prop appended such copies whenever the
// existing value was an expression (2026-10-15); load heals the existing ones
// (duplicate-attr-heal), this keeps new ones out.
//
// INLINE_DATA_URI_TOO_LARGE — a base64 `data:` URI of a font or an image
// pasted into the source ships inside the HTML of EVERY page view, can never
// be cached, and bloats every save of the project (a 101 KB woff2 in a site's
// custom head, 2026-10-15). Files belong in uploaded storage, referenced by URL.

import { findDuplicateAttrSpans } from '@/code/components/jsx-tag-attrs';
import type { OracleViolation } from './shared';

/** Inline data URIs at or above this size are refused (≈ 20 KB of payload). */
export const INLINE_DATA_URI_MAX_CHARS = 20_000;

function lineAt(code: string, index: number): number {
  let n = 1;
  for (let i = code.indexOf('\n'); i !== -1 && i < index; i = code.indexOf('\n', i + 1)) n++;
  return n;
}

export function checkDuplicateAttributes(code: string, v: OracleViolation[]): void {
  const seen = new Set<string>();
  for (const d of findDuplicateAttrSpans(code)) {
    const key = `${d.tagStart}:${d.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tagName = /^<([\w.]+)/.exec(code.slice(d.tagStart, d.tagStart + 80))?.[1] ?? 'element';
    v.push({
      code: 'DUPLICATE_ATTRIBUTE', tier: 2,
      elementId: d.dataId,
      line: lineAt(code, d.wsStart),
      message: `<${tagName}${d.dataId ? ` data-id="${d.dataId}"` : ''}> carries the attribute "${d.name}" more than once. JSX applies only the LAST copy — the others are dead, and editing them changes nothing on screen. Keep exactly ONE ${d.name} attribute with the value you want (for a component prop, set_component_prop replaces it in place).`,
    });
  }
}

export function checkInlineDataUris(code: string, v: OracleViolation[]): void {
  const re = /data:([\w.+-]+\/[\w.+-]+)(?:;[\w=.+-]+)*;base64,[A-Za-z0-9+/=]{1000,}/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (m[0].length < INLINE_DATA_URI_MAX_CHARS) continue;
    const kb = Math.round(m[0].length / 1024);
    const isFont = /font|woff|ttf|otf/i.test(m[1]);
    v.push({
      code: 'INLINE_DATA_URI_TOO_LARGE', tier: 2,
      line: lineAt(code, m.index),
      message: `An inline ${m[1]} data URI of ${kb} KB is embedded in the source. It ships inside the HTML of every page view, can never be cached, and bloats every save. ${isFont
        ? 'Fonts belong in the font library (the user uploads the file in the font picker; then use set_font or a typography preset), referenced by URL.'
        : 'Upload the file (upload_image / revyme_upload_image) and reference the returned URL instead.'}`,
    });
  }
}
