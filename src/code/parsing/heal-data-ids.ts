// heal-data-ids.ts — self-heal JSX that lost its `data-id`.
//
// A component-instance tag without `data-id` gets a parse-time `auto_<n>` id
// that exists NOWHERE in the source — so every mutation that targets it
// (drag-out move, prop write, style write) silently no-ops: the imperative
// cache updates (layers show the change), then the next parse rebuilds from
// the unchanged code and everything snaps back (user report 2026-07-30:
// ZaPoKa dragged to canvas reverted on the next drag). Real-world source ends
// up in this state via attribute corruption (a `data-id="X"` split into a
// bare `data-` + `id="X"` was found in the wild) or hand-edited/AI code.
//
// The heal runs when a file becomes ACTIVE: every PascalCase instance tag
// missing `data-id` gets a freshly generated one (same `<Tag>-<gen>` shape
// the creators use), and corrupted bare `data-` attributes (`data-="true"`,
// `data- `) inside those tags are stripped. Wrapper tags that the parser
// treats as transparent (LayoutGroup / MotionConfig / AnimatePresence) are
// skipped — they never carry node ids. Lowercase tags are left alone: every
// builder flow stamps ids on those at creation, and blanket-stamping text
// spans / style tags would be wrong.

import { generateNodeId } from '@/shared/id-utils';
import { findTagClose } from '@/code/generation/generator-utils';
import { trace } from '@/shared/debug-trace';

/** Parser-transparent wrappers — never node-bearing, never healed. */
const TRANSPARENT_TAGS = new Set(['LayoutGroup', 'MotionConfig', 'AnimatePresence', 'Fragment']);

/** Attributes literally named `data-` — corruption remnants, never legitimate. */
const JUNK_ATTR_RE = / data-(?:=(?:"[^"]*"|'[^']*'|\{[^}]*\}))?(?=[\s/>])/g;

export function healMissingInstanceDataIds(code: string): { code: string; healed: number; strippedJunk: number } {
  let healed = 0;
  let strippedJunk = 0;
  let out = code;
  let searchFrom = 0;

  const TAG_RE = /<([A-Z][A-Za-z0-9]*)\b/g;
  // Re-scan from the current position after each edit (offsets shift).
  for (;;) {
    TAG_RE.lastIndex = searchFrom;
    const m = TAG_RE.exec(out);
    if (!m) break;
    const tagName = m[1];
    const tagStart = m.index;
    if (TRANSPARENT_TAGS.has(tagName)) { searchFrom = tagStart + 1 + tagName.length; continue; }
    // The MotionLink declaration renders `<Link>`/`<div>` in its own body —
    // module scaffolding, never node-bearing. Stamping a data-id into it
    // (2026-08-26) mutated the canonical declaration line. The declaration
    // is single-line by construction, so "the tag's line starts the decl"
    // is a precise skip.
    {
      const lineStart = out.lastIndexOf('\n', tagStart) + 1;
      if (/^\s*const\s+MotionLink\s*=\s*motion\.create\(/.test(out.slice(lineStart, tagStart))) {
        searchFrom = tagStart + 1 + tagName.length;
        continue;
      }
    }
    const tagEnd = findTagClose(out, tagStart);
    if (tagEnd === -1) { searchFrom = tagStart + 1 + tagName.length; continue; }

    let tagContent = out.slice(tagStart, tagEnd + 1);

    // 1. Strip corrupted bare `data-` attributes inside this tag.
    const junkMatches = tagContent.match(JUNK_ATTR_RE);
    if (junkMatches && junkMatches.length > 0) {
      tagContent = tagContent.replace(JUNK_ATTR_RE, '');
      strippedJunk += junkMatches.length;
    }

    // 2. Stamp a data-id when missing. ` data-id="` with the attr-boundary
    //    space so `[data-id=` selectors in strings can't false-positive.
    if (!/ data-id="/.test(tagContent)) {
      const newId = generateNodeId(tagName);
      tagContent = `<${tagName} data-id="${newId}"` + tagContent.slice(1 + tagName.length);
      healed++;
    }

    if (tagContent !== out.slice(tagStart, tagEnd + 1)) {
      out = out.slice(0, tagStart) + tagContent + out.slice(tagEnd + 1);
    }
    searchFrom = tagStart + tagContent.length;
  }

  if (healed > 0 || strippedJunk > 0) {
    trace.action('heal-data-ids:healed', { healed, strippedJunk });
  }
  return { code: out, healed, strippedJunk };
}
