// save-encoding.ts — gzip the project save when the API says it can read it.
//
// A save PUTs the whole project — main plus every branch — and an external
// agent's every write saves before the tool answers, so a 5 MB project was
// 5 MB uploaded per agent edit, hundreds of times a day (2026-10-15). Project
// JSON compresses ~5×.
//
// Compression is OPT-IN by the server: only after a response carried
// `x-revyme-accept-encoding: gzip` (the backend's gzip-body middleware) does a
// save go out compressed, so an editor deployed before its backend keeps
// sending plain JSON. A compressed save the server refuses (400/415) turns
// compression off for this tab and is resent plain — see saveProject.

import { trace } from '@/shared/debug-trace';

export const ACCEPT_GZIP_HEADER = 'x-revyme-accept-encoding';
/** Bodies smaller than this are not worth compressing. */
export const GZIP_MIN_BYTES = 64 * 1024;

let acceptsGzip = false;

/** Read the API's capability header off any of its responses. */
export function noteServerEncodings(res: Response): void {
  if (acceptsGzip) return;
  if (res.headers?.get?.(ACCEPT_GZIP_HEADER)?.toLowerCase().includes('gzip')) {
    acceptsGzip = true;
    trace.action('save-encoding:gzip-enabled', {});
  }
}

/** The server refused a compressed body — send plain from now on. */
export function disableGzipBodies(): void {
  acceptsGzip = false;
}

export interface EncodedBody {
  body: BodyInit;
  headers: Record<string, string>;
  gzip: boolean;
}

/** The PUT body for `payload` (a JSON string): gzip when the server accepts it
 *  and it is big enough to matter, else the plain string. Never throws. */
export async function encodeSaveBody(payload: string, allowGzip = true): Promise<EncodedBody> {
  const plain: EncodedBody = { body: payload, headers: { 'Content-Type': 'application/json' }, gzip: false };
  if (!allowGzip || !acceptsGzip || payload.length < GZIP_MIN_BYTES || typeof CompressionStream === 'undefined') return plain;
  try {
    const stream = new Response(payload).body!.pipeThrough(new CompressionStream('gzip'));
    const body = await new Response(stream).arrayBuffer();
    trace.action('save-encoding:gzip', { from: payload.length, to: body.byteLength });
    return { body, headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, gzip: true };
  } catch (err) {
    trace.error('save-encoding:gzip-failed', { error: String(err) });
    return plain;
  }
}

/** Test-only. */
export function resetSaveEncodingForTest(): void {
  acceptsGzip = false;
}
