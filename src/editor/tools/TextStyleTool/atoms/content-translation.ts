// content-translation.ts — the Content row's handling of TRANSLATED text.
//
// A localized text node's JSX child is `{t('key')}`, not a string. The parser
// records that as `node.translationKey` and leaves `node.textContent` EMPTY
// (parser.ts ~2032) — the words live in `messages/{locale}.json`. Every other
// translation surface knows this; the Content row did not, so on a localized
// page it rendered a blank input, and typing into it appended a stray JSXText
// NEXT TO the surviving t() call (generator-crud.ts appends when it finds no
// JSXText to replace), leaving the element rendering its translation and the
// typed text at once. User report 2026-08-09.
//
// Pure, so the decision can be tested without a canvas, a store or a project
// FS — same split as `decoration-helpers.ts` next door.

/** Strip JSX/HTML tags for display, as every other Content branch does. */
const stripTags = (s: string) => s.replace(/<[^>]*>/g, '');

export interface TranslatedContent {
  /** The node's words come from the message store, not from its JSX. */
  isTranslated: boolean;
  /** What the Content row displays. */
  text: string;
}

/**
 * Resolve what the Content row should show for a possibly-translated node.
 *
 * `overrideText` is the `localeOverridesAtom` entry's `text`, which
 * `buildTranslationTextOverrides` already resolved for the ACTIVE locale —
 * default locale included (locale-override-map.ts, and its test at
 * "default locale resolves its own messages"). Nothing new needs computing
 * here; the value was always sitting in the atom, gated behind a
 * `!isDefaultLocale` check that stopped this row from reading it.
 *
 * A translated node with NO message anywhere resolves to `''` but stays
 * `isTranslated`. Those two answers must not be collapsed: there is nothing to
 * show, yet the WRITE still belongs to the message store. Treating "empty" as
 * "not translated" would send the first edit of an unseeded key down the JSX
 * path and produce exactly the duplicate-text corruption above.
 *
 * The message KEY is the node's `data-id`, a system-wide invariant — every
 * writer calls `transformTextToTranslation(code, nodeId, key = nodeId)`,
 * `readTranslationText` looks a key up by node id, and the oracle enforces it
 * (`TRANSLATION_KEY_MISMATCH`). A hand-written file that breaks it is already
 * broken in the translation panel and on the live site, so this row does not
 * try to compensate.
 */
export function resolveTranslatedContent(opts: {
  /** `node.translationKey` — set only when the JSX child is a `t('...')` call. */
  translationKey: string | null | undefined;
  /** `localeOverridesAtom.get(nodeId)?.text`. */
  overrideText: string | null | undefined;
}): TranslatedContent {
  if (!opts.translationKey) return { isTranslated: false, text: '' };
  return { isTranslated: true, text: stripTags(opts.overrideText ?? '') };
}
