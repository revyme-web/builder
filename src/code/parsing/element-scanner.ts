// src/code/parsing/element-scanner.ts
//
// Shared JSX element scanner — the SINGLE source of truth for element
// extraction from builder-dialect JSX code.  Used by:
//   - verify-effect (product): request satisfaction verdicts
//   - n1-scenarios / f-regress (bench): satisfaction predicates
//
// Pure, store-free, no canvas dependencies.  Handles comments, self-closing
// tags, quoted attribute values (incl. backticks), `{…}` nesting in
// attributes (style objects, handlers, data-loop JSON).  Closing tags are
// matched to the top of the stack — well-formed JSX only, which is all the
// generators and the seeded corpus produce.

/** One JSX element as the scanner sees it: its role markers (data-id +
 *  data-name) and its inner markup (descendant tags included, so leaf-text
 *  checks strip `<…>`). */
export interface ScannedElement {
  tag: string;
  id: string | null;
  name: string | null;
  /** Opening-tag end → closing-tag start (inner markup). */
  text: string;
  start: number;
  end: number;
}

/** JSX element scan in document order. Handles comments, self-closing tags,
 *  quoted attribute values (incl. backticks) and `{…}` nesting in attributes
 *  (style objects, handlers, data-loop JSON). Closing tags are matched to the
 *  top of the stack — well-formed JSX only, which is all the generators and
 *  the seeded corpus produce. Same contract as the bench scanner. */
export function scanElements(code: string): ScannedElement[] {
  const out: ScannedElement[] = [];
  const stack: Array<{ tag: string; id: string | null; name: string | null; tagStart: number; textStart: number }> = [];
  const len = code.length;
  let i = 0;
  while (i < len) {
    const lt = code.indexOf('<', i);
    if (lt === -1) break;
    if (code.startsWith('<!--', lt)) {
      const close = code.indexOf('-->', lt + 4);
      if (close === -1) break;
      i = close + 3;
      continue;
    }
    const slice = code.slice(lt);
    const closeMatch = /<\/([a-zA-Z][\w.:-]*)\s*>/.exec(slice);
    if (closeMatch && closeMatch.index === 0) {
      const top = stack.pop();
      if (top && top.tag === closeMatch[1]) {
        out.push({
          tag: top.tag,
          id: top.id,
          name: top.name,
          text: code.slice(top.textStart, lt),
          start: top.tagStart,
          end: lt + closeMatch[0].length,
        });
      }
      i = lt + closeMatch[0].length;
      continue;
    }
    const openMatch = /<([a-zA-Z][\w.:-]*)\b/.exec(slice);
    if (openMatch && openMatch.index === 0) {
      let j = lt + openMatch[0].length;
      let quote: string | null = null;
      let brace = 0;
      while (j < len) {
        const ch = code[j];
        if (quote !== null) {
          if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'" || ch === '`') {
          quote = ch;
        } else if (ch === '{') {
          brace++;
        } else if (ch === '}') {
          brace--;
        } else if (ch === '>' && brace === 0) {
          break;
        }
        j++;
      }
      if (j >= len) break;
      const tagStr = code.slice(lt + 1, j);
      const id = /data-id="([^"]+)"/.exec(tagStr)?.[1] ?? null;
      const name = /data-name="([^"]+)"/.exec(tagStr)?.[1] ?? null;
      if (/\/\s*$/.test(tagStr)) {
        out.push({ tag: openMatch[1], id, name, text: '', start: lt, end: j + 1 });
      } else {
        stack.push({ tag: openMatch[1], id, name, tagStart: lt, textStart: j + 1 });
      }
      i = j + 1;
      continue;
    }
    i = lt + 1;
  }
  return out;
}

/** Lowercased "data-id data-name" role of an element — both spellings a
 *  competent model might pick (kebab ids and Name markers) are matched by a
 *  single regex. */
export const elementRole = (e: ScannedElement): string => `${e.id ?? ''} ${e.name ?? ''}`.toLowerCase();

/** Inner text with all descendant tags stripped, whitespace collapsed. */
export const elementText = (e: ScannedElement): string =>
  e.text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

/** True when the element carries ANY real content (an empty `</p>` is not a
 *  card — the n1-rich lesson). */
export const isFilled = (e: ScannedElement): boolean => elementText(e).length > 0;

/** Elements fully contained in `el` (recursively), excluding itself. */
export function descendantsOf(els: ScannedElement[], el: ScannedElement): ScannedElement[] {
  return els.filter((c) => c !== el && c.start >= el.start && c.end <= el.end);
}
