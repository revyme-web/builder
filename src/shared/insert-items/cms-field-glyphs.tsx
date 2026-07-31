// cms-field-glyphs.tsx — Type-aware mini "drawings" for the CMS cards in the
// Insert panel. Instead of one flat line-icon for every field, each card
// renders a small mockup of what the field IS — a text bar, a calendar, an
// image frame, a toggle, a colour swatch… Collection cards get a matching
// "records list" drawing, and the prev/next nav cards get a pager drawing.
//
// Original artwork inspired by the reference's CMS field palette — the layered
// recessed-chip look, not a pixel copy.

import type { FieldDefinition } from '@/shared/types';
import { trace } from '@/shared/debug-trace';

type FieldType = FieldDefinition['type'];

// ─── Shared building blocks ─────────────────────────────────────────────────

/** Theme-aware soft drop shadow — subtle in light mode, deeper in dark.
 *  Reused by the Cards/Layouts mockups in `element-icons.tsx`. */
export const CHIP_SHADOW = 'shadow-[0_1px_4px_rgba(0,0,0,0.12)] dark:shadow-[0_2px_8px_rgba(0,0,0,0.4)]';

/** Theme-aware chip surface — a clean raised white tile in light mode, a
 *  darker recessed tile in dark mode. Pair with CHIP_SHADOW for depth. */
export const CHIP_SURFACE =
  'border border-black/[0.07] bg-[var(--bg-surface)] dark:border-white/[0.05] dark:bg-black/25';

/** Inset chip every glyph sits inside — a layered tile lifted off the card
 *  with a soft shadow (raised white in light mode, recessed dark in dark),
 *  so the drawing reads as an object rather than a flat monochrome icon. */
function Chip({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return (
    <div
      className={`flex overflow-hidden rounded-lg ${CHIP_SURFACE} ${CHIP_SHADOW} ${className}`}
    >
      {children}
    </div>
  );
}

/** A faint rounded bar — the building block for text-line mockups. */
function Bar({ w = 'w-6', strong = false }: { w?: string; strong?: boolean }) {
  return (
    <div
      className={`h-[3px] ${w} rounded-full ${strong ? 'bg-[var(--text-secondary)]' : 'bg-[var(--text-disabled)]'}`}
    />
  );
}

/** A tiny record card — two stub lines on a chip. Used by reference glyphs. */
function RecordCard({ className = '' }: { className?: string }) {
  return (
    <div
      className={`flex h-7 w-[18px] flex-col justify-center gap-[2px] rounded-[3px] ${CHIP_SURFACE} px-[3px] ${CHIP_SHADOW} ${className}`}
    >
      <div className="h-[2px] w-full rounded-full bg-[var(--text-disabled)]" />
      <div className="h-[2px] w-2/3 rounded-full bg-[var(--text-disabled)]" />
    </div>
  );
}

/** A short connector arrow drawn between two record cards. */
function LinkArrow() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3 shrink-0">
      <path
        d="M2 6h6.5M6 3l3 3-3 3"
        fill="none"
        stroke="var(--text-disabled)"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ─── Field glyph ────────────────────────────────────────────────────────────

/** Renders the type-aware drawing for a single CMS field card. */
export function CmsFieldGlyph({ type }: { type: FieldType }) {
  trace.fn('CmsFieldGlyph:render', { type });

  switch (type) {
    // Single-line text — a chunky "Aa".
    case 'text':
      return (
        <Chip className="h-9 w-12 items-center justify-center">
          <span className="text-[15px] font-semibold leading-none text-[var(--text-secondary)]">Aa</span>
        </Chip>
      );

    // Multi-line body — a paragraph of stacked lines.
    case 'textarea':
    case 'richtext':
      return (
        <Chip className="h-9 w-12 flex-col items-start justify-center gap-[3px] px-2.5">
          <Bar w="w-full" strong />
          <Bar w="w-full" />
          <Bar w="w-2/3" />
        </Chip>
      );

    // Number — a numeric sample.
    case 'number':
      return (
        <Chip className="h-9 w-12 items-center justify-center">
          <span className="text-[14px] font-semibold leading-none text-[var(--text-secondary)]">12</span>
        </Chip>
      );

    // Boolean — an on-state toggle pill.
    case 'boolean':
      return (
        <div
          className="flex h-5 w-9 items-center justify-end rounded-full px-[3px]"
          style={{ backgroundColor: 'var(--accent)' }}
        >
          <div className="h-3.5 w-3.5 rounded-full bg-white" />
        </div>
      );

    // Date — a calendar leaf: accent header strip + a day number.
    case 'date':
      return (
        <Chip className="h-10 w-9 flex-col justify-start">
          <div className="h-[7px] w-full" style={{ backgroundColor: 'var(--accent)' }} />
          <div className="flex flex-1 items-center justify-center">
            <span className="text-[13px] font-bold leading-none text-[var(--text-secondary)]">22</span>
          </div>
        </Chip>
      );

    // Image — a framed picture: sun + horizon hills.
    case 'image':
      return (
        <Chip className="relative h-9 w-12">
          <div className="absolute left-2 top-2 h-[7px] w-[7px] rounded-full bg-[var(--text-disabled)]" />
          <svg viewBox="0 0 48 16" preserveAspectRatio="none" className="absolute bottom-0 left-0 w-full">
            <path d="M0 16 L14 6 L22 11 L31 4 L48 16 Z" fill="var(--text-disabled)" />
          </svg>
        </Chip>
      );

    // File — a document page with a folded corner.
    case 'file':
      return (
        <Chip className="h-9 w-12 items-center justify-center">
          <svg
            viewBox="0 0 24 24"
            className="h-5 w-5"
            fill="none"
            stroke="var(--text-secondary)"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M14 3v5h5" />
            <path d="M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
          </svg>
        </Chip>
      );

    // URL / Link — an interlocking chain.
    case 'url':
    case 'link':
      return (
        <Chip className="h-9 w-12 items-center justify-center">
          <svg
            viewBox="0 0 24 24"
            className="h-5 w-5"
            fill="none"
            stroke="var(--text-secondary)"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M9.5 12a3 3 0 0 1 3-3h2.5a3 3 0 0 1 0 6h-1" />
            <path d="M14.5 12a3 3 0 0 1-3 3H9a3 3 0 0 1 0-6h1" />
          </svg>
        </Chip>
      );

    // Colour — a filled swatch with an accent-to-pink wash.
    case 'color':
      return (
        <div
          className={`h-9 w-9 rounded-lg ${CHIP_SHADOW}`}
          style={{ background: 'linear-gradient(135deg, var(--accent) 0%, #ec4899 100%)' }}
        />
      );

    // Enum — a select control with a caret.
    case 'enum':
      return (
        <Chip className="h-8 w-[52px] items-center justify-between px-2.5">
          <Bar w="w-4" strong />
          <svg viewBox="0 0 12 12" className="h-2.5 w-2.5">
            <path
              d="M3 4.5 6 7.5 9 4.5"
              fill="none"
              stroke="var(--text-disabled)"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </Chip>
      );

    // Tags — a little cluster of pill chips.
    case 'tags':
      return (
        <div className="flex flex-col items-center gap-1">
          <div className="flex gap-1">
            <div
              className="h-3 w-6 rounded-full border"
              style={{ backgroundColor: 'color-mix(in srgb, var(--accent) 18%, transparent)', borderColor: 'color-mix(in srgb, var(--accent) 35%, transparent)' }}
            />
            <div className={`h-3 w-4 rounded-full ${CHIP_SURFACE}`} />
          </div>
          <div className="flex gap-1">
            <div className={`h-3 w-3.5 rounded-full ${CHIP_SURFACE}`} />
            <div className={`h-3 w-5 rounded-full ${CHIP_SURFACE}`} />
          </div>
        </div>
      );

    // Slug — a URL path fragment.
    case 'slug':
      return (
        <Chip className="h-8 w-[52px] items-center justify-center gap-1.5 px-2.5">
          <span className="text-[12px] font-semibold leading-none text-[var(--text-disabled)]">/</span>
          <Bar w="w-5" strong />
        </Chip>
      );

    // Reference — one record pointing at another.
    case 'reference':
      return (
        <div className="flex items-center gap-1">
          <RecordCard />
          <LinkArrow />
          <RecordCard />
        </div>
      );

    // Multi-reference — one record pointing at a stack.
    case 'multi-reference':
      return (
        <div className="flex items-center gap-1">
          <RecordCard />
          <LinkArrow />
          <div className="relative h-7 w-[26px]">
            <RecordCard className="absolute left-0 top-[3px] opacity-50" />
            <RecordCard className="absolute left-2 top-0" />
          </div>
        </div>
      );

    default:
      return (
        <Chip className="h-9 w-12 items-center justify-center">
          <span className="text-[15px] font-semibold leading-none text-[var(--text-secondary)]">Aa</span>
        </Chip>
      );
  }
}

// ─── Prev / Next nav glyph ──────────────────────────────────────────────────

/** Pager drawing for the CMS prev/next nav cards — two chevron buttons with
 *  the card's own direction lit in the accent colour. */
export function CmsNavGlyph({ dir }: { dir: 'prev' | 'next' }) {
  trace.fn('CmsNavGlyph:render', { dir });

  const Btn = ({ active, children }: { active: boolean; children: React.ReactNode }) => (
    <div
      className={`flex h-7 w-7 items-center justify-center rounded-md border ${CHIP_SHADOW} ${
        active ? 'border-transparent text-white' : `${CHIP_SURFACE} text-[var(--text-disabled)]`
      }`}
      style={active ? { backgroundColor: 'var(--accent)' } : undefined}
    >
      {children}
    </div>
  );

  const Chevron = ({ left }: { left: boolean }) => (
    <svg viewBox="0 0 12 12" className="h-3 w-3">
      <path
        d={left ? 'M7.5 2.5 4 6l3.5 3.5' : 'M4.5 2.5 8 6l-3.5 3.5'}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );

  return (
    <div className="flex gap-1.5">
      <Btn active={dir === 'prev'}><Chevron left /></Btn>
      <Btn active={dir === 'next'}><Chevron left={false} /></Btn>
    </div>
  );
}

// ─── Collection glyph ───────────────────────────────────────────────────────

/** Records-list drawing for a CMS collection card — a chip holding a couple
 *  of list rows (a square thumbnail + text lines), i.e. a stack of items. */
export function CmsCollectionGlyph() {
  trace.fn('CmsCollectionGlyph:render');

  const Row = () => (
    <div className="flex items-center gap-1.5">
      <div className="h-2.5 w-2.5 shrink-0 rounded-[3px] bg-[var(--text-disabled)]" />
      <div className="flex flex-col gap-[3px]">
        <div className="h-[3px] w-3.5 rounded-full bg-[var(--text-secondary)]" />
        <div className="h-[3px] w-2.5 rounded-full bg-[var(--text-disabled)]" />
      </div>
    </div>
  );

  // Generous internal padding (p-2.5) so the list never crowds the chip
  // edges — matches the breathing room in the reference's collection glyph.
  return (
    <Chip className="h-12 w-14 flex-col items-center justify-center gap-2 p-2.5">
      <Row />
      <Row />
    </Chip>
  );
}
