// clipboard-html.ts — extract the Figma plugin payload from a clipboard
// text/html flavor.
//
// The plugin writes `<span data-revyme-import='{json}'>` with SINGLE-quoted
// attributes. But Chrome's async clipboard API SANITIZES html on read: it
// re-parses and re-serializes the markup, turning the attribute into
// `data-revyme-import="{&quot;version&quot;:…}"` (double quotes + entity-
// encoded values) and often dropping <meta>/styles. So extraction must be
// DOM-based (attribute values come back entity-DECODED from getAttribute),
// with a tolerant regex fallback for non-DOM contexts.

import { isFigmaPayload, type FigmaPayload } from './payload-types';
import { trace } from '@/shared/debug-trace';

const ATTR = 'data-revyme-import';

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Pull the payload JSON string out of the html, or null. */
function extractJson(html: string): string | null {
  // Preferred: real DOM parsing — immune to quote style and entity encoding.
  if (typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const el = doc.querySelector(`[${ATTR}]`);
      const raw = el?.getAttribute(ATTR);
      if (raw) return raw; // getAttribute already entity-decodes
    } catch {
      // fall through to regex
    }
  }
  // Fallback: match either quoting form the sanitizer may produce.
  const single = html.match(new RegExp(`${ATTR}='([^']*)'`));
  if (single) return decodeEntities(single[1]);
  const double = html.match(new RegExp(`${ATTR}="([^"]*)"`));
  if (double) return decodeEntities(double[1]);
  return null;
}

/** Parse a clipboard text/html flavor into a FigmaPayload, or null when the
 *  html isn't a Figma "Import to Revyme" copy. */
export function extractFigmaPayloadFromHtml(html: string): FigmaPayload | null {
  if (!html || !html.includes(ATTR)) return null;
  const json = extractJson(html);
  if (!json) {
    trace.error('figma-import:marker-present-but-unextractable', { htmlLength: html.length });
    return null;
  }
  try {
    const parsed = JSON.parse(json);
    if (isFigmaPayload(parsed)) return parsed;
    trace.error('figma-import:json-not-a-payload', { keys: Object.keys(parsed ?? {}) });
    return null;
  } catch (err) {
    trace.error('figma-import:json-parse-failed', { error: String(err), jsonLength: json.length });
    return null;
  }
}
