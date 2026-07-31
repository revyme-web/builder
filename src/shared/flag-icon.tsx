// flag-icon.tsx — Country flags via the `flag-icons` CSS sprite.
//
// Emoji flags (🇺🇸) are unreliable: Windows ships no flag-emoji font, so they
// render as bare regional-indicator letters ("US"). This renders a real flag
// image instead. The `flag-icons` CSS is imported here once — anything that
// imports `FlagIcon` gets the styles.

import 'flag-icons/css/flag-icons.min.css';

/**
 * Convert a regional-indicator emoji flag (🇬🇪) to a lowercase ISO 3166-1
 * alpha-2 code ('ge'). Returns null for anything that isn't a flag emoji.
 */
export function emojiFlagToCC(emoji: string): string | null {
  const cps = Array.from(emoji);
  if (cps.length < 2) return null;
  const BASE = 0x1f1e6; // regional indicator symbol 'A'
  const a = cps[0].codePointAt(0) ?? 0;
  const b = cps[1].codePointAt(0) ?? 0;
  if (a < BASE || a > BASE + 25 || b < BASE || b > BASE + 25) return null;
  return String.fromCharCode(97 + (a - BASE)) + String.fromCharCode(97 + (b - BASE));
}

// A language code rarely matches its flag's country code (en→US, ja→JP…).
// This maps the common cases; anything unlisted falls back to the first two
// letters of the language code, which is correct for most (fr→fr, de→de…).
const LANG_TO_COUNTRY: Record<string, string> = {
  en: 'us', ja: 'jp', ko: 'kr', zh: 'cn', hi: 'in', ar: 'sa', he: 'il',
  fa: 'ir', ur: 'pk', bn: 'bd', ta: 'in', te: 'in', ml: 'in', mr: 'in',
  gu: 'in', kn: 'in', pa: 'in', sa: 'in', vi: 'vn', uk: 'ua', el: 'gr',
  cs: 'cz', da: 'dk', sv: 'se', nb: 'no', nn: 'no', no: 'no', et: 'ee',
  ka: 'ge', sq: 'al', hy: 'am', ms: 'my', sl: 'si', sr: 'rs', bs: 'ba',
  ga: 'ie', cy: 'gb', eu: 'es', ca: 'es', gl: 'es', am: 'et', ha: 'ng',
  ig: 'ng', yo: 'ng', sw: 'ke', af: 'za', xh: 'za', zu: 'za', jv: 'id',
  km: 'kh', lo: 'la', la: 'va', my: 'mm', ne: 'np', ps: 'af', si: 'lk',
  tl: 'ph', bo: 'cn', ug: 'cn',
};

/** Map a language / BCP-47 code to a representative ISO 3166-1 country code. */
export function localeToCC(code: string): string {
  const c = code.toLowerCase().slice(0, 2);
  return LANG_TO_COUNTRY[c] ?? c;
}

/**
 * A country flag from the `flag-icons` CSS sprite, rendered as a circle.
 * `code` is a lowercase ISO 3166-1 alpha-2 code. The `fis` class makes the
 * sprite square (1em × 1em) so `rounded-full` produces a true circle rather
 * than an ellipse. Size follows font-size — pass a `text-*` class to size
 * it. Renders nothing when `code` is falsy/invalid.
 */
export function FlagIcon({
  code,
  className = '',
}: {
  code?: string | null;
  className?: string;
}) {
  if (!code) return null;
  return (
    <span
      className={`fi fis fi-${code} shrink-0 rounded-full ${className}`}
      aria-hidden="true"
    />
  );
}
