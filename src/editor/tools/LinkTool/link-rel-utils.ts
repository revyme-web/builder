// link-rel-utils.ts — `rel` attribute token model for the Link tool.
// `rel` is a space-separated token list (e.g. "nofollow noreferrer ugc").
// The Rel control exposes the 5 user-facing tokens; any other tokens the
// element already carries (notably the auto-added `noopener` on external
// links) are PRESERVED so we never strip a security default.

export interface RelOption {
  /** The actual `rel` token written to the attribute. */
  token: string;
  /** The label shown in the UI. */
  label: string;
}

/** User-pickable rel tokens (order = menu order). */
export const REL_OPTIONS: RelOption[] = [
  { token: 'nofollow', label: 'No Follow' },
  { token: 'noreferrer', label: 'No Referrer' },
  { token: 'me', label: 'Me' },
  { token: 'ugc', label: 'UGC' },
  { token: 'sponsored', label: 'Sponsored' },
];

const USER_TOKENS = new Set(REL_OPTIONS.map((o) => o.token));

/** Split a `rel` string into its tokens (de-duped, order preserved). */
export function parseRelTokens(rel: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of (rel || '').trim().split(/\s+/)) {
    if (t && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

/** Join tokens back into a `rel` string. */
export function formatRelTokens(tokens: string[]): string {
  return parseRelTokens(tokens.join(' ')).join(' ');
}

/** Display label for a token (falls back to the raw token for non-user ones). */
export function relLabel(token: string): string {
  return REL_OPTIONS.find((o) => o.token === token)?.label ?? token;
}

/** Tokens that aren't user-pickable (e.g. `noopener`) — preserved across edits. */
export function nonUserRelTokens(rel: string): string[] {
  return parseRelTokens(rel).filter((t) => !USER_TOKENS.has(t));
}

/** True when the token is one of the user-pickable rel options. */
export function isUserRelToken(token: string): boolean {
  return USER_TOKENS.has(token);
}
