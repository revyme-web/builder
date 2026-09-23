// agent/SkillMenu.tsx — the composer's `/` menu: the project's skills.
//
// Typing `/` at the start of a word opens it above the composer; the letters
// after the slash filter it; ↑ ↓ move, Enter or Tab picks, Esc closes. A pick
// writes `/name ` into the message — the SEND is what invokes it
// (skills-config invokedSkillNames), so a skill typed by hand works the same
// as one picked here. "Always apply" skills are listed too (marked) — they
// ride every request anyway; picking one is harmless.

import type { CSSProperties } from 'react';
import type { ProjectSkill } from '@/code/project/skills-config';

/** A piece of a message: plain text, or a `/name` that names a skill. */
export type SkillSegment = { text: string; skill?: string };

/**
 * Split a message into plain text and skill commands — by the same rule a
 * send invokes them (skills-config invokedSkillNames): `/name` at the start
 * or after whitespace, for a name the project has. A half-typed `/des` is
 * plain text until it names a skill.
 */
export function skillSegments(text: string, names: Iterable<string>): SkillSegment[] {
  const known = new Set(names);
  const out: SkillSegment[] = [];
  let at = 0;
  for (const m of text.matchAll(/(^|\s)\/([a-z0-9][a-z0-9-]*)/g)) {
    const name = m[2].replace(/-+$/, '');
    if (!known.has(name)) continue;
    const start = (m.index ?? 0) + m[1].length;
    if (start > at) out.push({ text: text.slice(at, start) });
    out.push({ text: `/${name}`, skill: name });
    at = start + 1 + name.length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

/** The badge a skill command wears — in the composer and in the sent
 *  message. The "padding" is a box-shadow in the badge colour: it takes no
 *  layout space, so the composer's highlight layer stays exactly under the
 *  text box's own glyphs (same widths, same wrapping). */
export const SKILL_BADGE_STYLE: CSSProperties = {
  background: 'color-mix(in srgb, var(--accent) 20%, transparent)',
  boxShadow: '0 0 0 2px color-mix(in srgb, var(--accent) 20%, transparent)',
  borderRadius: 3,
  color: 'var(--accent-text, var(--accent))',
};

/** A message with its skill commands shown as badges. */
export function SkillText({ text, names }: { text: string; names: Iterable<string> }) {
  return (
    <>
      {skillSegments(text, names).map((seg, i) => (seg.skill
        ? <span key={i} data-skill={seg.skill} style={SKILL_BADGE_STYLE}>{seg.text}</span>
        : <span key={i}>{seg.text}</span>))}
    </>
  );
}

/** The `/query` being typed at the caret, if any: the slash must start the
 *  message or follow whitespace, and only name characters may follow it. */
export function slashQueryAt(text: string, caret: number): { query: string; start: number } | null {
  const before = text.slice(0, caret);
  const m = /(?:^|\s)\/([a-z0-9-]*)$/.exec(before);
  if (!m) return null;
  return { query: m[1], start: caret - m[1].length - 1 };
}

/** The message with the `/query` at `start` replaced by `/name `, and where
 *  the caret goes after it. */
export function applySkillPick(text: string, caret: number, start: number, name: string): { text: string; caret: number } {
  const insert = `/${name} `;
  const rest = text.slice(caret).replace(/^[a-z0-9-]*/, '').replace(/^ /, '');
  return { text: text.slice(0, start) + insert + rest, caret: start + insert.length };
}

/** Skills matching the query — names starting with it first, then the rest
 *  that contain it (in the name or the description). */
export function matchSkills(skills: readonly ProjectSkill[], query: string): ProjectSkill[] {
  const q = query.toLowerCase();
  if (!q) return [...skills];
  const starts = skills.filter((s) => s.name.startsWith(q));
  const contains = skills.filter((s) => !s.name.startsWith(q) && (s.name.includes(q) || s.description.toLowerCase().includes(q)));
  return [...starts, ...contains];
}

export function SkillMenu({ skills, activeIndex, onPick, onHover, onManage }: {
  skills: ProjectSkill[];
  activeIndex: number;
  onPick: (name: string) => void;
  onHover: (index: number) => void;
  onManage: () => void;
}) {
  return (
    <div
      data-testid="agent-skill-menu"
      role="listbox"
      // Above the composer; mousedown is kept from blurring the text box.
      onMouseDown={(e) => e.preventDefault()}
      className="absolute bottom-full left-2 right-2 z-[60] -mb-0.5 bg-[var(--dropdown-bg)] border border-[var(--border-light)] cut-corners cut-lg cut-border [--cut-border-color:var(--border-light)] shadow-[var(--shadow-lg)] overflow-hidden"
    >
      <div className="px-2.5 pt-2 pb-1 text-[9px] uppercase tracking-wider text-[var(--text-secondary)]">Skills</div>
      <div className="max-h-56 overflow-y-auto scrollbar-hide pb-1">
        {skills.length === 0 ? (
          <div className="px-2.5 py-1.5 text-xs text-[var(--text-tertiary)]">No skill matches.</div>
        ) : skills.map((s, i) => (
          <button
            key={s.name}
            type="button"
            role="option"
            aria-selected={i === activeIndex}
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(s.name)}
            className={`mx-1 my-0.5 flex w-[calc(100%-0.5rem)] items-baseline gap-2 rounded px-2.5 py-1.5 text-left text-xs transition-colors ${
              i === activeIndex ? 'bg-[var(--accent)] text-[var(--accent-fg)]' : 'text-[var(--text-primary)]'
            }`}
          >
            <span className="shrink-0 font-medium">/{s.name}</span>
            <span className={`min-w-0 flex-1 truncate text-[11px] ${i === activeIndex ? 'opacity-80' : 'text-[var(--text-secondary)]'}`}>{s.description}</span>
            {s.alwaysApply && <span className={`shrink-0 text-[10px] ${i === activeIndex ? 'opacity-80' : 'text-[var(--text-tertiary)]'}`}>always</span>}
          </button>
        ))}
      </div>
      <div aria-hidden className="mx-2 h-px bg-black/[0.08] dark:bg-white/10" />
      <div className="p-1">
        <button
          type="button"
          onClick={onManage}
          className="w-full rounded px-2.5 py-1.5 text-left text-xs text-[var(--text-secondary)] transition-colors hover:bg-white/[0.06] hover:text-[var(--text-primary)]"
        >
          Manage skills…
        </button>
      </div>
    </div>
  );
}
