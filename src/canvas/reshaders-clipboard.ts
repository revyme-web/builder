// reshaders-clipboard.ts — receive a reshaders "Copy code component".
//
// reshaders writes the paste-engine envelope the way the Figma plugin does:
// a hidden text/html flavor, `<span data-revyme-clipboard='{json}'>`, with a
// single space as text/plain — so pasting into a text editor yields nothing
// and the component source never sits in plain view on the clipboard. The
// JSON is the same `{ revymeClipboard: 1, data: ClipboardData }` envelope
// the older text flavor carried (shortcuts.ts still accepts that one).
//
// Chrome SANITIZES html on clipboard.read() (re-quoted, entity-encoded
// attributes), so extraction is DOM-based, exactly like the Figma path in
// code/import/figma/clipboard-html.

import type { ClipboardData } from '@/code/features/paste-engine/types';
import { trace } from '@/shared/debug-trace';

export const RESHADERS_CLIPBOARD_ATTR = 'data-revyme-clipboard';

export interface ReshadersEnvelope {
  revymeClipboard: 1;
  data: ClipboardData;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function extractJson(html: string): string | null {
  if (typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const raw = doc.querySelector(`[${RESHADERS_CLIPBOARD_ATTR}]`)?.getAttribute(RESHADERS_CLIPBOARD_ATTR);
      if (raw) return raw;
    } catch {
      // fall through to the regex forms
    }
  }
  const single = html.match(new RegExp(`${RESHADERS_CLIPBOARD_ATTR}='([^']*)'`));
  if (single) return decodeEntities(single[1]);
  const double = html.match(new RegExp(`${RESHADERS_CLIPBOARD_ATTR}="([^"]*)"`));
  if (double) return decodeEntities(double[1]);
  return null;
}

/** Parse a clipboard text/html flavor into the reshaders envelope, or null
 *  when the html isn't a reshaders copy. */
export function extractReshadersEnvelopeFromHtml(html: string): ReshadersEnvelope | null {
  if (!html || !html.includes(RESHADERS_CLIPBOARD_ATTR)) return null;
  const json = extractJson(html);
  if (!json) {
    trace.error('reshaders-paste:marker-present-but-unextractable', { htmlLength: html.length });
    return null;
  }
  try {
    const parsed = JSON.parse(json);
    if (parsed && parsed.revymeClipboard === 1 && parsed.data && Array.isArray(parsed.data.nodes)) {
      return parsed as ReshadersEnvelope;
    }
    trace.error('reshaders-paste:json-not-an-envelope', { keys: Object.keys(parsed ?? {}) });
  } catch (err) {
    trace.error('reshaders-paste:json-parse-failed', { error: String(err) });
  }
  return null;
}

/** Read the clipboard's text/html flavor and extract the envelope. Returns
 *  null when the clipboard isn't a reshaders copy. */
export async function readReshadersClipboard(): Promise<ReshadersEnvelope | null> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.read) return null;
  let items: ClipboardItems;
  try {
    items = await navigator.clipboard.read();
  } catch (err) {
    trace.error('reshaders-paste:clipboard-read-failed', { error: String(err) });
    return null;
  }
  for (const item of items) {
    if (!item.types.includes('text/html')) continue;
    try {
      const html = await (await item.getType('text/html')).text();
      const env = extractReshadersEnvelopeFromHtml(html);
      if (env) {
        trace.action('reshaders-paste:envelope-detected', { nodes: env.data.nodes.length, components: env.data.components?.length ?? 0 });
        return env;
      }
    } catch (err) {
      trace.error('reshaders-paste:html-flavor-failed', { error: String(err) });
    }
  }
  return null;
}
