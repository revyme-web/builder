// read-tracker.ts — server-enforced STALE-WRITE guard for the MCP bridge.
//
// revyme_submit_files is a WHOLE-FILE REPLACE, and the user edits the SAME files
// in the editor between MCP calls. Any client (any AI, any session — its memory
// or system prompt is irrelevant) that builds a submission from a stale copy
// silently clobbers those edits. This tracker remembers the content the bridge
// last SERVED for each path (via read_file / get_context / a prior commit) and
// bounces a submit whose live target changed since — forcing a fresh read. No
// client cooperation required: the bounce message IS the just-in-time instruction.
//
// Scope: ONLY the MCP bridge path (bridge-client.submitFiles). The in-app freeform
// panel writes from live editor state, so it never needs this.

import { trace } from '@/shared/debug-trace';
import type { OracleViolation } from '@/code/oracle/check-file';

/** Fast non-crypto string hash (FNV-1a, 32-bit). Equality only, not security. */
export function hashContent(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// path → hash of the content the bridge last handed this session.
const lastSeen = new Map<string, string>();

/** Record that the client has now seen `code` for `path` (read_file / get_context /
 *  post-commit). A null/undefined code (missing file) credits nothing. */
export function creditRead(path: string, code: string | null | undefined): void {
  if (code == null) return;
  lastSeen.set(path, hashContent(code));
  trace.action('mcp-read-tracker:credit', { path });
}

/** Bounce any submit target that EXISTS on disk but whose live content differs from
 *  what the client last saw (or was never read this session). New files are exempt —
 *  there is nothing to clobber. `readLive` returns the current on-disk code or null. */
export function checkStaleWrites(
  files: Array<{ path: string }>,
  readLive: (path: string) => string | null | undefined,
): OracleViolation[] {
  const out: OracleViolation[] = [];
  for (const f of files) {
    const live = readLive(f.path);
    if (live == null) continue; // brand-new file — no existing content to overwrite
    const liveHash = hashContent(live);
    const seen = lastSeen.get(f.path);
    if (seen === liveHash) continue; // client is up to date
    out.push({
      code: 'STALE_FILE',
      tier: 1,
      message: seen == null
        ? `${f.path} already exists but you have not read it this session. revyme_submit_files REPLACES the whole file, so submitting blind would erase the live content — including the user's own manual edits in the editor. Call revyme_read_file("${f.path}") first, apply your change to THAT exact text, then resubmit.`
        : `${f.path} has changed in the editor since you last read it (the user edits the live file between your calls). revyme_submit_files REPLACES the whole file, so your copy is stale and would overwrite their changes. Call revyme_read_file("${f.path}") again, reapply your change to the fresh text, then resubmit.`,
    });
  }
  if (out.length) trace.action('mcp-read-tracker:stale', { paths: out.map((v) => v.message.split(' ')[0]) });
  return out;
}

/** Test/HMR reset. */
export function resetReadTracker(): void { lastSeen.clear(); }
