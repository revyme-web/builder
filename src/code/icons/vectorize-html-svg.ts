// vectorize-html-svg.ts — Turn an html-to-image style SVG (one
// <foreignObject> wrapping HTML) back into real vector SVG.
//
// "Export as SVG" used to write every selection that way, so a logo exported
// from Revyme and dropped back in came out EMPTY: the importers strip
// <foreignObject> as active content, and that was the whole file (user report
// 2026-10-19). The vectors are in there — the logo's <svg> paths sit inside
// the HTML — but where they sit is decided by CSS layout. So: lay the HTML
// out in a hidden, script-disabled iframe and run the same converter the
// exporter uses (shared/vector-svg-export.ts) on it.
//
// Safety: the iframe is `sandbox="allow-same-origin"` WITHOUT allow-scripts
// (we can measure it; nothing in it can run), and scripts, handlers,
// javascript: links and anything that would load or embed another document
// are removed before the markup goes in.

import { exportVectorSvg, type VectorExportResult } from '@/shared/vector-svg-export';
import { trace } from '@/shared/debug-trace';

const SVG_NS = 'http://www.w3.org/2000/svg';
const BLOCKED = 'script, iframe, frame, object, embed, link, meta, base, audio, video, source, track, portal';

/** Human wording for the converter's bail reasons (what the user can act on). */
export function describeVectorizeFailure(reason: string): string {
  if (reason === 'text') return 'it contains live text (export the text as outlines, or as a separate image)';
  if (reason.startsWith('html-img') || reason.startsWith('html-picture') || reason === 'svg-embeds-non-vector') return 'it contains a raster image';
  if (reason.startsWith('box-')) return `it uses an effect with no vector form (${reason.slice(4)})`;
  if (reason === 'nothing-to-draw') return 'there is nothing to draw in it';
  return `it can't be converted (${reason})`;
}

function stripActive(root: Element): void {
  for (const el of Array.from(root.querySelectorAll(BLOCKED))) el.remove();
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const a of Array.from(el.attributes)) {
      const v = a.value.trim().toLowerCase();
      if (a.name.toLowerCase().startsWith('on')) el.removeAttribute(a.name);
      else if ((a.name === 'href' || a.name === 'xlink:href' || a.name === 'src') && v.startsWith('javascript:')) el.removeAttribute(a.name);
    }
  }
}

function svgSize(svg: Element): { w: number; h: number } | null {
  const w = parseFloat(svg.getAttribute('width') ?? '');
  const h = parseFloat(svg.getAttribute('height') ?? '');
  if (w > 0 && h > 0) return { w, h };
  const vb = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  return vb.length === 4 && vb[2] > 0 && vb[3] > 0 ? { w: vb[2], h: vb[3] } : null;
}

function loadSandbox(w: number, h: number): Promise<HTMLIFrameElement> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-same-origin');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    // Off-screen, NOT visibility:hidden — the converter skips hidden boxes.
    frame.style.cssText = `position:fixed;left:-100000px;top:0;width:${w}px;height:${h}px;border:0;opacity:0;pointer-events:none;`;
    frame.srcdoc = '<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent}</style></head><body></body></html>';
    const timer = setTimeout(() => { frame.remove(); reject(new Error('sandbox load timeout')); }, 5000);
    frame.addEventListener('load', () => { clearTimeout(timer); resolve(frame); }, { once: true });
    document.body.appendChild(frame);
  });
}

/** Vector SVG for an HTML-snapshot SVG, or why it has none. */
export async function vectorizeHtmlSvg(svgText: string): Promise<VectorExportResult> {
  const parsed = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const svg = parsed.documentElement;
  if (!svg || svg.namespaceURI !== SVG_NS || parsed.querySelector('parsererror')) return { reason: 'unparseable' };
  const fo = svg.querySelector('foreignObject');
  if (!fo) return { reason: 'no-foreign-object' };
  const size = svgSize(svg);
  if (!size) return { reason: 'no-size' };

  let frame: HTMLIFrameElement | null = null;
  try {
    frame = await loadSandbox(size.w, size.h);
    const doc = frame.contentDocument;
    if (!doc) return { reason: 'sandbox-unavailable' };
    const host = doc.createElement('div');
    host.style.cssText = `position:relative;width:${size.w}px;height:${size.h}px;overflow:visible;`;
    for (const child of Array.from(fo.childNodes)) host.appendChild(doc.importNode(child, true));
    stripActive(host);
    doc.body.appendChild(host);
    // The snapshot's root is the exported element itself — convert IT, so a
    // root background/radius comes along; fall back to the host for several.
    const roots = Array.from(host.children);
    const result = exportVectorSvg(roots.length === 1 ? roots[0] : host);
    trace.action('vectorize-html-svg', 'svg' in result ? { ok: true, size: result.svg.length } : { ok: false, reason: result.reason });
    return result;
  } catch (err) {
    trace.error('vectorize-html-svg:failed', { error: String(err) });
    return { reason: 'sandbox-failed' };
  } finally {
    frame?.remove();
  }
}
