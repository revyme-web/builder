// rtl-text.ts — right-to-left languages: the TEXT follows its script, the
// LAYOUT stays as designed.
//
// Picking Arabic used to put `dir="rtl"` on the whole page (canvas content root
// and the live site's <html>). That mirrors every flex row, grid and default
// alignment while absolute / pinned elements keep their physical `left`, so the
// page came out half-mirrored (user report 2026-10-16: the nav reversed, an
// untranslated label jumped right). Now:
//
//   • TEXT — `unicode-bidi: plaintext` on text elements under an RTL `lang`.
//     Each paragraph takes its direction from its own first strong character:
//     Arabic reads right to left with its punctuation at the correct end and
//     starts at the right of ITS OWN box, English stays left, and the
//     `direction` property — which is what flex/grid layout reads — is never
//     touched. Zero specificity (`:where`) so an authored style still wins.
//   • LAYOUT — never mirrors, for any language, on the canvas, in Preview or
//     on the live site (user decision 2026-10-16).

/** Primary subtags of right-to-left scripts. */
export const RTL_LANGUAGES: readonly string[] = [
  'ar', 'arc', 'ckb', 'dv', 'fa', 'he', 'ku', 'ps', 'sd', 'syr', 'ug', 'ur', 'yi',
];

/** True when the locale's language is written right to left (`ar`, `ar-EG`, `he`…). */
export function isRtlLocale(code: string | null | undefined): boolean {
  if (!code) return false;
  return RTL_LANGUAGES.includes(code.split('-')[0].toLowerCase());
}

/** Elements that hold text: a text node's own tag (p/h1…/span/a/button…), plus
 *  form fields so typed Arabic reads correctly too. */
const TEXT_ELEMENTS = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,label,figcaption,caption,td,th,dt,dd,legend,pre,span,a,button,textarea,input';

/** The one rule both the canvas and the generated providers ship. */
export const RTL_TEXT_CSS =
  `:where(${TEXT_ELEMENTS}):where(${RTL_LANGUAGES.map((l) => `:lang(${l})`).join(',')}){unicode-bidi:plaintext}`;
