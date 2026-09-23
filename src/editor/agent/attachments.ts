// attachments.ts — images pasted into the agent composer.
//
// One pasted image becomes TWO encodings, because it has two readers with
// opposite needs:
//
//   full   what the MODEL sees. Bounded, not tiny: a reference screenshot has
//          to stay legible. Lives in memory for this session only.
//   thumb  what the TRANSCRIPT shows, and the only one that is persisted —
//          `_meta/chat-history.json` rides every project save and is shared
//          with teammates, so a few hundred KB per paste would grow the
//          project for a picture rendered at 64px.
//
// After a reload a turn therefore still SHOWS what was pasted but no longer
// re-sends it; `buildAgentHistory` says so to the model in words rather than
// silently dropping the reference.

import type { AgentTurn, AgentTurnImage } from '@/code/stores/agent-chat-store';
import type { AgentMessageOut } from '@/ai/agent/agent-client';

export interface AgentAttachment extends AgentTurnImage {
  id: string;
  /** Always present on a fresh paste (optional only on a restored turn). */
  full: string;
}

/** Per message. A reference or two is the use; a dozen is a mis-paste, and
 *  every image is re-sent with each follow-up turn. */
export const MAX_ATTACHMENTS = 4;

/** Long-edge cap for the model's copy. Providers downscale on their side too
 *  (each to its own limit); this bounds the request, it does not pre-optimise
 *  for one vendor. */
export const MAX_IMAGE_EDGE = 2000;
export const THUMB_EDGE = 384;

/** A PNG this small stays a PNG — lossless, and it keeps transparency (a white
 *  logo on alpha turns invisible on a JPEG's white matte). Bigger, and it is a
 *  screenshot: JPEG is a tenth of the bytes and just as legible. */
export const PNG_KEEP_CHARS = 600_000;

/** How many image-bearing user turns keep their pixels in the history that is
 *  re-sent on every turn. Older ones keep their words. */
export const HISTORY_IMAGE_TURNS = 2;

const ACCEPTED = /^image\/(png|jpe?g|webp|gif)$/i;

/**
 * The images in a paste — or none, when the paste is really TEXT.
 *
 * Spreadsheets and word processors put a rendered PICTURE of the copied cells
 * on the clipboard next to the text. Taking it would swallow the user's text
 * and attach a bitmap of it instead, so plain text wins. A browser's "Copy
 * image" and an OS screenshot carry no `text/plain`, which is what makes the
 * test safe.
 */
export function imageFilesFromClipboard(data: Pick<DataTransfer, 'files' | 'items' | 'getData'> | null | undefined): File[] {
  if (!data) return [];
  let text = '';
  try { text = data.getData('text/plain') ?? ''; } catch { /* some sources throw */ }
  if (text.trim()) return [];

  const out: File[] = [];
  const files = data.files ? Array.from(data.files) : [];
  if (files.length > 0) {
    for (const f of files) if (ACCEPTED.test(f.type)) out.push(f);
    return out;
  }
  // Some browsers expose a pasted bitmap only through `items`.
  for (const item of data.items ? Array.from(data.items) : []) {
    if (item.kind !== 'file' || !ACCEPTED.test(item.type)) continue;
    const f = item.getAsFile();
    if (f) out.push(f);
  }
  return out;
}

/** Scale (w × h) down so its long edge fits `maxEdge`. Never scales UP. */
export function fitWithin(w: number, h: number, maxEdge: number): { width: number; height: number } {
  if (!(w > 0) || !(h > 0)) return { width: 0, height: 0 };
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** How many more images the composer takes. */
export function roomFor(current: number): number {
  return Math.max(0, MAX_ATTACHMENTS - current);
}

let seq = 0;

function draw(source: CanvasImageSource, width: number, height: number, matte: boolean): HTMLCanvasElement | null {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  if (matte) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height); }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

/**
 * Decode, bound and encode one pasted file. `null` when the browser cannot
 * decode it — the caller says so instead of attaching a broken image.
 *
 * Browser-only (canvas). Everything that decides WHAT happens — which files
 * count, the sizes, what the model receives — is in the pure functions around
 * it, which is where the tests are.
 */
export async function fileToAttachment(file: File): Promise<AgentAttachment | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  try {
    const size = fitWithin(bitmap.width, bitmap.height, MAX_IMAGE_EDGE);
    if (!size.width) return null;
    const lossless = !/jpe?g/i.test(file.type);
    let full = '';
    if (lossless) {
      const png = draw(bitmap, size.width, size.height, false)?.toDataURL('image/png') ?? '';
      if (png && png.length <= PNG_KEEP_CHARS) full = png;
    }
    if (!full) full = draw(bitmap, size.width, size.height, true)?.toDataURL('image/jpeg', 0.88) ?? '';
    if (!full.startsWith('data:image/')) return null;

    const t = fitWithin(bitmap.width, bitmap.height, THUMB_EDGE);
    const thumb = draw(bitmap, t.width, t.height, true)?.toDataURL('image/jpeg', 0.8) || full;
    return { id: `att-${Date.now().toString(36)}-${seq++}`, full, thumb, width: size.width, height: size.height };
  } finally {
    bitmap.close?.();
  }
}

/** Said to the model in place of pixels it no longer receives. */
export const IMAGE_DROPPED_NOTE = '[The user attached an image here earlier in the conversation. It is no longer included — ask them to paste it again if you need to look at it.]';
/** A user message must carry text for every provider dialect; an image-only
 *  send gets this rather than an empty block (which Anthropic rejects). */
export const IMAGE_ONLY_TEXT = 'See the attached image.';

/**
 * The conversation as the model receives it.
 *
 *  • Images ride with the user turn that carried them — but only for the
 *    newest HISTORY_IMAGE_TURNS such turns. History is re-sent in full every
 *    turn, so every kept image is paid for again on each follow-up.
 *  • A turn whose pixels are gone (older than that, or restored from disk,
 *    where only the thumbnail survives) says so in words.
 *  • No empty text blocks, and no empty messages: a tools-only assistant turn
 *    has `text: ''`, and an empty block is a 400 on the Anthropic dialect.
 */
export function buildAgentHistory(
  conversation: readonly AgentTurn[],
  next: { text: string; images?: readonly AgentTurnImage[] },
): AgentMessageOut[] {
  const turns: { role: 'user' | 'assistant'; text: string; images?: readonly AgentTurnImage[] }[] = [
    ...conversation.map((t) => ({ role: t.role, text: t.text, images: t.images })),
    { role: 'user' as const, text: next.text, images: next.images },
  ];

  // Newest-first: which user turns still send pixels.
  const sendsPixels = new Set<number>();
  for (let i = turns.length - 1; i >= 0 && sendsPixels.size < HISTORY_IMAGE_TURNS; i--) {
    const t = turns[i];
    if (t.role === 'user' && t.images?.some((im) => !!im.full)) sendsPixels.add(i);
  }

  const out: AgentMessageOut[] = [];
  turns.forEach((t, i) => {
    const content: AgentMessageOut['content'] = [];
    const images = t.role === 'user' ? (t.images ?? []) : [];
    const live = sendsPixels.has(i) ? images.filter((im) => !!im.full) : [];
    const dropped = images.length - live.length;

    let text = t.text.trim() ? t.text : '';
    if (!text && live.length > 0) text = IMAGE_ONLY_TEXT;
    if (dropped > 0) text = text ? `${text}\n\n${IMAGE_DROPPED_NOTE}` : IMAGE_DROPPED_NOTE;

    if (text) content.push({ type: 'text', text });
    for (const im of live) content.push({ type: 'image', dataUrl: im.full! });
    if (content.length > 0) out.push({ role: t.role, content });
  });
  return out;
}
