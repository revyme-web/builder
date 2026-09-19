// markdown.tsx — the small subset of Markdown an agent reply actually uses.
//
// The model writes prose with `**bold**`, `` `code` `` and `- ` bullets
// because that is how a model writes; rendered as plain text the asterisks
// show up literally. A full Markdown pipeline would be a dependency and a
// sanitisation problem for four constructs, so this parses exactly those and
// returns REACT NODES — never HTML, so there is no injection surface at all.
//
// Unsupported syntax degrades to plain text rather than disappearing: a table
// or a heading still reads, it just is not styled.

import type { ReactNode } from 'react';

const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\n]+\*|_[^_\n]+_)/g;

/** Inline marks inside one line of text. */
function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  for (const part of text.split(INLINE)) {
    if (!part) continue;
    const key = `${keyBase}-${i++}`;
    if ((part.startsWith('**') && part.endsWith('**') && part.length > 4)
      || (part.startsWith('__') && part.endsWith('__') && part.length > 4)) {
      out.push(<strong key={key} className="font-semibold text-[var(--text-primary)]">{part.slice(2, -2)}</strong>);
    } else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      out.push(
        <code key={key} className="cut-corners bg-[var(--bg-hover)] px-1 py-px text-[11px] text-[var(--text-primary)]">
          {part.slice(1, -1)}
        </code>,
      );
    } else if ((part.startsWith('*') && part.endsWith('*') && part.length > 2)
      || (part.startsWith('_') && part.endsWith('_') && part.length > 2)) {
      out.push(<em key={key}>{part.slice(1, -1)}</em>);
    } else {
      out.push(part);
    }
  }
  return out;
}

/** A bullet: `- `, `* ` or `1. ` at the start of a line. */
const BULLET = /^\s*(?:[-*]|\d+\.)\s+/;

/**
 * Render an agent message. Blank lines separate paragraphs; consecutive
 * bullet lines become one list. Everything else is a paragraph that keeps its
 * own line breaks.
 */
export function renderMarkdown(text: string): ReactNode {
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let bullets: string[] = [];

  const flushPara = () => {
    if (para.length === 0) return;
    const body = para.join('\n');
    blocks.push(
      <p key={`p${blocks.length}`} className="whitespace-pre-wrap break-words">
        {renderInline(body, `p${blocks.length}`)}
      </p>,
    );
    para = [];
  };
  const flushBullets = () => {
    if (bullets.length === 0) return;
    blocks.push(
      <ul key={`u${blocks.length}`} className="flex list-none flex-col gap-0.5 pl-1">
        {bullets.map((b, i) => (
          <li key={i} className="flex gap-1.5 break-words">
            <span className="shrink-0 text-[var(--text-tertiary)]">•</span>
            <span>{renderInline(b, `u${blocks.length}-${i}`)}</span>
          </li>
        ))}
      </ul>,
    );
    bullets = [];
  };

  for (const line of lines) {
    if (BULLET.test(line)) {
      flushPara();
      bullets.push(line.replace(BULLET, ''));
      continue;
    }
    if (line.trim() === '') {
      flushBullets();
      flushPara();
      continue;
    }
    flushBullets();
    para.push(line);
  }
  flushBullets();
  flushPara();

  return <div className="flex flex-col gap-1.5">{blocks}</div>;
}
