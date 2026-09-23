// transcript-io.ts — the transcript, to and from its stored form.
//
// Lifted out of AgentChat so the round trip is a pair of pure functions with a
// test, instead of two object literals inside two effects that had to be kept
// in step by eye.

import type { AgentTurn, AgentToolEntry, AgentBlock } from '@/code/stores/agent-chat-store';
import type { StoredChatMessage } from '@/code/project/chat-history-config';

/**
 * Restore the FULL transcript, not just the prose: the activity lines and
 * screenshots are the record of what the agent did, and dropping them on reload
 * left a reply with no visible work behind it.
 */
export function turnsFromStored(stored: readonly StoredChatMessage[]): AgentTurn[] {
  return stored.map((m) => ({
    role: m.role,
    text: m.content,
    // Only the thumbnail is stored, so a restored turn SHOWS the image but has
    // no `full` to re-send (attachments.ts).
    images: m.images?.map((thumb) => ({ thumb })),
    blocks: m.blocks?.map((b) => (b.kind === 'text' || b.kind === 'reasoning'
      ? { kind: b.kind, text: b.text }
      : {
          kind: 'tools' as const,
          tools: b.tools.map((t, i): AgentToolEntry => ({
            // Ids are per-run and not persisted; the transcript only needs
            // them to be unique within their block for React keys.
            id: `stored-${i}`,
            name: t.name, ok: t.ok, detail: t.detail,
            count: t.count, ms: t.ms, image: t.image, note: t.note,
          })),
        })),
    reasoning: m.reasoning,
    changes: m.changes,
    ...(m.via ? { via: m.via } : {}),
    ...(Array.isArray(m.skills) && m.skills.length ? { skills: m.skills.filter((n): n is string => typeof n === 'string') } : {}),
    ...(m.errorMessage ? { error: m.errorMessage } : {}),
  }));
}

/**
 * The prose AND the activity behind it, so reopening a chat shows the same
 * transcript it showed before. Token counts stay out: they are per-run
 * telemetry, not a record of what happened to the website. Every object is
 * FRESH — the store budgets images in place, and must never reach into the
 * live transcript to do it.
 */
export function storedFromTurns(turns: readonly AgentTurn[]): StoredChatMessage[] {
  return turns.map((t) => ({
    role: t.role,
    content: t.text,
    images: t.images?.map((im) => im.thumb),
    blocks: t.blocks?.map((b) => (b.kind === 'text' || b.kind === 'reasoning'
      ? { kind: b.kind, text: b.text }
      : {
          kind: 'tools' as const,
          tools: b.tools.map((x) => ({
            name: x.name,
            // A call still in flight when the turn ended did not land.
            ok: x.ok === true,
            detail: x.detail, count: x.count, ms: x.ms, image: x.image, note: x.note,
          })),
        })),
    reasoning: t.reasoning,
    changes: t.changes,
    ...(t.via ? { via: t.via } : {}),
    ...(t.skills?.length ? { skills: [...t.skills] } : {}),
    ...(t.error ? { error: true, errorMessage: t.error } : {}),
  }));
}

/**
 * The blocks as the transcript SHOWS them. Some models (Gemini) stream a
 * blank line of text between tool calls; each blank opened a new text block,
 * which ended the steps card — so a run rendered as one card PER STEP instead
 * of one card of work (2026-09-23). Blank text and blank thinking are
 * dropped here and the tool groups either side of them join up again. Pure,
 * and fresh objects only: the live blocks are appended in place.
 */
export function visibleBlocks(blocks: readonly AgentBlock[]): AgentBlock[] {
  const out: AgentBlock[] = [];
  for (const b of blocks) {
    if (b.kind !== 'tools' && !b.text.trim()) continue;
    const last = out[out.length - 1];
    if (b.kind === 'tools' && last?.kind === 'tools') out[out.length - 1] = { kind: 'tools', tools: [...last.tools, ...b.tools] };
    else out.push(b);
  }
  return out;
}
