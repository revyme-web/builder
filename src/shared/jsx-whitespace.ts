// jsx-whitespace.ts — the canonical JSX text-whitespace normalizer.
//
// This is React/Babel's own algorithm (`cleanJSXElementLiteralChild` in
// @babel/types). It is NOT a blanket `.trim()`: it strips only the whitespace
// that a JSX compiler strips — leading/trailing spaces on lines that ARE
// adjacent to a newline (i.e. source indentation), and collapses runs of
// whitespace that CONTAIN a newline into a single space. Crucially it PRESERVES
// leading/trailing spaces that do NOT touch a newline — the meaningful spaces a
// user types in an editable text (e.g. `Time - ` with a trailing space).
//
// Why it matters: text-edit commits used to `.trim()` the JSXText value on read
// AND wrap it in `\n   …\n   ` on write, so a user's trailing/leading space was
// always destroyed. Using this normalizer on read + writing the text inline on
// write makes the round-trip WYSIWYG for edge spaces, while leaving existing
// pretty-printed (newline-wrapped) source parsing to the exact same result as
// the old `.trim()` did — so it's a no-op for everything already in the tree.

/**
 * Normalize a raw JSXText value the way a JSX compiler would when turning it
 * into a runtime string. Preserves same-line leading/trailing spaces; strips
 * newline-adjacent indentation; joins lines with a single space.
 *
 * Examples:
 *   'Time - '                     → 'Time - '   (single line: nothing trimmed)
 *   '  hi'                        → '  hi'       (leading same-line space kept)
 *   '\n      Time - \n    '       → 'Time -'     (indentation stripped, as JSX does)
 *   '\n   a\n   b\n'              → 'a b'         (lines joined by one space)
 *   '   '                         → '   '         (single line of only spaces kept verbatim)
 */
export function cleanJsxText(raw: string): string {
  const lines = raw.split(/\r\n|\n|\r/);

  let lastNonEmptyLine = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(/[^ \t]/)) lastNonEmptyLine = i;
  }

  let str = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isFirstLine = i === 0;
    const isLastLine = i === lines.length - 1;
    const isLastNonEmptyLine = i === lastNonEmptyLine;

    let trimmedLine = line.replace(/\t/g, ' ');
    // Leading whitespace is only source indentation when it follows a newline
    // (every line except the first). Trailing whitespace is only indentation
    // when a newline follows (every line except the last).
    if (!isFirstLine) trimmedLine = trimmedLine.replace(/^ +/, '');
    if (!isLastLine) trimmedLine = trimmedLine.replace(/ +$/, '');

    if (trimmedLine) {
      if (!isLastNonEmptyLine) trimmedLine += ' ';
      str += trimmedLine;
    }
  }

  return str;
}
