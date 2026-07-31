// element-icons.tsx — Grid item icons for the Insert overlay secondary panel.
// Each icon renders in a ~w-20 h-14 container.
// Element icons copied EXACTLY from old builder src/icons/index.tsx.

import React from 'react';
import {
  CreativeMorphingTextIcon,
  CreativeWordRotateIcon,
  CreativeSpinningTextIcon,
  CreativeHangingCurvedIcon,
  CreativeMagneticTextIcon,
  CreativeTextPressureIcon,
  CreativeTypingTextIcon,
  CreativeRotatingText3DIcon,
  CreativeVideoTextIcon,
  CreativeCounterIcon,
  CreativeGlitchTextIcon,
  EffectCarouselIcon,
  EffectMarqueeIcon,
  EffectPathMarqueeIcon,
  EffectThreeDMarqueeIcon,
  EffectMotionTrailIcon,
  EffectHorizontalScrollIcon,
  EffectLensBoxIcon,
  EffectMagnetBoxIcon,
  EffectPixelatedHoverIcon,
  EffectNeonParticlesIcon,
  EffectDesignCursorIcon,
  EffectBlobCursorIcon,
  EffectRibbonCursorIcon,
  EffectSplashCursorIcon,
  EffectThemeToggleIcon,
  EffectLocaleSwitcherIcon,
} from '@/shared/insert-items/creative-preview-icons';
import { CHIP_SHADOW, CHIP_SURFACE } from '@/shared/insert-items/cms-field-glyphs';

// ─── Basic ─────────────────────────────────────────────────────────────────

/** Crosshair frame icon — EXACT from old builder FrameToolbarIcon */
function ColumnIcon() {
  return (
    <div className="w-7 h-10 rounded-md bg-pink-500/20 border border-pink-500/40 flex flex-col gap-0.5 p-1">
      <div className="w-full flex-1 bg-pink-400/50 rounded-sm" />
      <div className="w-full flex-1 bg-pink-400/30 rounded-sm" />
      <div className="w-full flex-1 bg-pink-400/20 rounded-sm" />
    </div>
  );
}

/** Teal horizontal 3-box row */
function RowIcon() {
  return (
    <div className="w-11 h-7 rounded-md bg-teal-500/20 border border-teal-500/40 flex gap-0.5 p-1">
      <div className="flex-1 h-full bg-teal-400/50 rounded-sm" />
      <div className="flex-1 h-full bg-teal-400/30 rounded-sm" />
      <div className="flex-1 h-full bg-teal-400/20 rounded-sm" />
    </div>
  );
}

/** Blue mountain/sun landscape icon — EXACT from old builder ElementImageIcon */
function AudioIcon() {
  return (
    <svg className="w-8 h-8" viewBox="0 0 16 16">
      <g fill="none" stroke="#ee99a0" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1">
        <path d="M5.5 12.5a2 2 0 0 1-2 2a2 2 0 0 1-2-2a2 2 0 0 1 2-2a2 2 0 0 1 2 2m9-2a2 2 0 0 1-2 2a2 2 0 0 1-2-2a2 2 0 0 1 2-2a2 2 0 0 1 2 2" />
        <path d="M5.5 12.5V5c0-.54.44-1.21 1.35-1.5l6.3-2c.9 0 1.35.88 1.35 1.5v7.58m-9-3.08l9-3" />
      </g>
    </svg>
  );
}

/** Blue pill with white line */
function ButtonIcon() {
  return (
    <div className="w-10 h-5 rounded-full bg-blue-500/80 flex items-center justify-center">
      <div className="w-5 h-1 bg-white/80 rounded" />
    </div>
  );
}

// ─── Typography ────────────────────────────────────────────────────────────

/** "H1" text — EXACT from old builder ElementHeadingIcon */
function HeadingIcon() {
  return (
    <svg className="w-8 h-8 text-[var(--text-secondary)]" viewBox="0 0 24 24">
      <g fill="none">
        <path d="m12.593 23.258l-.011.002l-.071.035l-.02.004l-.014-.004l-.071-.035q-.016-.005-.024.005l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.017-.018m.265-.113l-.013.002l-.185.093l-.01.01l-.003.011l.018.43l.005.012l.008.007l.201.093q.019.005.029-.008l.004-.014l-.034-.614q-.005-.018-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.004-.011l.017-.43l-.003-.012l-.01-.01z" />
        <path
          fill="currentColor"
          d="M13 2.5a1.5 1.5 0 0 1 1.493 1.356L14.5 4v16a1.5 1.5 0 0 1-2.993.144L11.5 20v-6.5h-6V20a1.5 1.5 0 0 1-2.993.144L2.5 20V4a1.5 1.5 0 0 1 2.993-.144L5.5 4v6.5h6V4A1.5 1.5 0 0 1 13 2.5m6 11.019V20a1 1 0 1 1-2 0v-4.634a1 1 0 0 1-1.055-1.698l1.485-.99a1.01 1.01 0 0 1 1.57.84Z"
        />
      </g>
    </svg>
  );
}

/** Horizontal lines (paragraph) — EXACT from old builder ElementParagraphIcon */
function ParagraphIcon() {
  return (
    <svg className="w-8 h-7 text-[var(--text-secondary)]" viewBox="0 0 512 512" fill="currentColor">
      <path d="M0 462h256v-64H0zm0-106.7h512v-64H0zm0-106.6h512v-64H0zM0 78v64h512V78z" />
    </svg>
  );
}

/** Chain link icon — EXACT from old builder ElementTextLinkIcon */
function TextLinkIcon() {
  const id = React.useId();
  return (
    <svg className="w-8 h-8" viewBox="0 0 20 20">
      <g fill="none">
        <path
          fill={`url(#${id})`}
          d="M14 6a4 4 0 0 1 .2 7.995L14 14h-2a.75.75 0 0 1-.102-1.493L12 12.5h2a2.5 2.5 0 0 0 .164-4.995L14 7.5h-2a.75.75 0 0 1-.102-1.493L12 6zM8 6a.75.75 0 0 1 .102 1.493L8 7.5H6a2.5 2.5 0 0 0-.164 4.995L6 12.5h2a.75.75 0 0 1 .102 1.493L8 14H6a4 4 0 0 1-.2-7.995L6 6zM6.25 9.25h7.5a.75.75 0 0 1 .102 1.493l-.102.007h-7.5a.75.75 0 0 1-.102-1.493zh7.5z"
        />
        <defs>
          <linearGradient id={id} x1="-3.143" x2="3.203" y1="2.5" y2="21.585" gradientUnits="userSpaceOnUse">
            <stop stopColor="#36dff1" />
            <stop offset="1" stopColor="#2764e7" />
          </linearGradient>
        </defs>
      </g>
    </svg>
  );
}

/** Quote marks — EXACT from old builder ElementQuoteIcon */
function QuoteIcon() {
  return (
    <svg className="w-8 h-7 text-[var(--text-secondary)]" viewBox="0 0 16 16" fill="currentColor">
      <path
        fillRule="evenodd"
        d="M1.5 3.75a.75.75 0 0 0-1.5 0v8.5a.75.75 0 0 0 1.5 0zM4.75 3a.75.75 0 0 0 0 1.5h7.5a.75.75 0 0 0 0-1.5zm0 4.25a.75.75 0 0 0 0 1.5h10.5a.75.75 0 0 0 0-1.5zm-.75 5a.75.75 0 0 1 .75-.75h6.5a.75.75 0 0 1 0 1.5h-6.5a.75.75 0 0 1-.75-.75"
        clipRule="evenodd"
      />
    </svg>
  );
}

// ─── Cards ─────────────────────────────────────────────────────────────────

// Card/Layout mockups share one visual language with the CMS field glyphs:
// a darker, borderless inset tile lifted off the panel with a soft shadow,
// holding neutral monochrome shapes \u2014 sleek and depth-y, no brand colour.

/** Faint thumbnail / image block. */
const THUMB = 'rounded-[3px] bg-[var(--text-tertiary)]';
/** Text-line bar \u2014 `strong` for headings, default for body copy. */
function CardLine({ w, strong }: { w: string; strong?: boolean }) {
  return (
    <div
      className={`${w} h-[3px] rounded-full ${strong ? 'bg-[var(--text-secondary)]' : 'bg-[var(--text-disabled)]'}`}
    />
  );
}

function CardShell({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`w-14 h-12 rounded-lg ${CHIP_SURFACE} ${CHIP_SHADOW} p-1.5 flex flex-col gap-1 overflow-hidden ${className}`}
    >
      {children}
    </div>
  );
}

/** Basic card \u2014 thumbnail above two text lines. */
function CardBasicIcon() {
  return (
    <CardShell>
      <div className={`w-full h-4 ${THUMB}`} />
      <CardLine w="w-full" strong />
      <CardLine w="w-3/4" />
    </CardShell>
  );
}

/** Horizontal card \u2014 thumbnail beside text. */
function CardHorizontalIcon() {
  return (
    <div
      className={`w-14 h-9 rounded-lg ${CHIP_SURFACE} ${CHIP_SHADOW} p-1.5 flex gap-1.5 overflow-hidden`}
    >
      <div className={`w-5 h-full shrink-0 ${THUMB}`} />
      <div className="flex-1 flex flex-col gap-1 justify-center">
        <CardLine w="w-full" strong />
        <CardLine w="w-3/4" />
      </div>
    </div>
  );
}

/** Profile card \u2014 avatar above centered text. */
function CardProfileIcon() {
  return (
    <CardShell className="items-center">
      <div className="w-4 h-4 rounded-full bg-[var(--text-tertiary)]" />
      <CardLine w="w-full" strong />
      <CardLine w="w-2/3" />
    </CardShell>
  );
}

/** Testimonial card \u2014 quote mark, copy, then an attribution row. */
function CardTestimonialIcon() {
  return (
    <CardShell>
      <div className="text-[9px] leading-[0.6] font-bold text-[var(--text-secondary)]">{'\u201C'}</div>
      <CardLine w="w-full" />
      <CardLine w="w-2/3" />
      <div className="mt-auto flex items-center gap-1">
        <div className="w-2.5 h-2.5 rounded-full bg-[var(--text-tertiary)] shrink-0" />
        <CardLine w="w-4" />
      </div>
    </CardShell>
  );
}

/** Pricing card \u2014 a price above feature lines. */
function CardPricingIcon() {
  return (
    <CardShell className="items-center">
      <div className="text-[9px] font-bold leading-none text-[var(--text-secondary)]">$29</div>
      <div className="flex-1 w-full flex flex-col gap-1 justify-center items-center">
        <CardLine w="w-full" />
        <CardLine w="w-full" />
        <CardLine w="w-2/3" />
      </div>
    </CardShell>
  );
}

/** Product card \u2014 image, title, then a price tag. */
function CardProductIcon() {
  return (
    <CardShell>
      <div className={`w-full h-5 ${THUMB}`} />
      <CardLine w="w-2/3" />
      <div className="mt-auto"><CardLine w="w-1/3" strong /></div>
    </CardShell>
  );
}

// ─── Layouts ───────────────────────────────────────────────────────────────

// Layout mockups reuse the inset-tile look. Cells are solid neutral blocks
// (no faint outline-on-outline) so the structure reads crisply; a "primary"
// region can be lifted with `CELL_STRONG` for a touch of hierarchy.
const CELL = 'rounded-[3px] bg-[var(--text-tertiary)]';
const CELL_STRONG = 'rounded-[3px] bg-[var(--text-secondary)]';

function LayoutShell({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`w-14 h-11 rounded-lg ${CHIP_SURFACE} ${CHIP_SHADOW} p-1.5 gap-1 overflow-hidden ${className}`}
    >
      {children}
    </div>
  );
}

function Layout2RowIcon() {
  return (
    <LayoutShell className="flex flex-col">
      <div className={`w-full flex-1 ${CELL}`} />
      <div className={`w-full flex-1 ${CELL}`} />
    </LayoutShell>
  );
}

function Layout3RowIcon() {
  return (
    <LayoutShell className="flex flex-col">
      <div className={`w-full flex-1 ${CELL}`} />
      <div className={`w-full flex-1 ${CELL}`} />
      <div className={`w-full flex-1 ${CELL}`} />
    </LayoutShell>
  );
}

function Layout2ColIcon() {
  return (
    <LayoutShell className="flex">
      <div className={`flex-1 h-full ${CELL}`} />
      <div className={`flex-1 h-full ${CELL}`} />
    </LayoutShell>
  );
}

function Layout3ColIcon() {
  return (
    <LayoutShell className="flex">
      <div className={`flex-1 h-full ${CELL}`} />
      <div className={`flex-1 h-full ${CELL}`} />
      <div className={`flex-1 h-full ${CELL}`} />
    </LayoutShell>
  );
}

function LayoutSplitTopIcon() {
  return (
    <LayoutShell className="flex flex-col">
      <div className={`w-full flex-[2] ${CELL}`} />
      <div className={`w-full flex-1 ${CELL}`} />
    </LayoutShell>
  );
}

function LayoutSidebarIcon() {
  return (
    <LayoutShell className="flex">
      <div className={`w-4 h-full shrink-0 ${CELL_STRONG}`} />
      <div className={`flex-1 h-full ${CELL}`} />
    </LayoutShell>
  );
}

function LayoutHeaderIcon() {
  return (
    <LayoutShell className="flex flex-col">
      <div className={`w-full h-2 shrink-0 ${CELL_STRONG}`} />
      <div className={`w-full flex-1 ${CELL}`} />
    </LayoutShell>
  );
}

// ─── Shapes — EXACT from old builder ───────────────────────────────────────

// ─── Creative ──────────────────────────────────────────────────────────────

function CarouselIconCreative() {
  return (
    <svg className="w-10 h-7 text-white/80" viewBox="0 0 32 22" fill="none">
      <rect x="7" y="2" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="1.5" opacity="0.7" />
      <rect x="1" y="5" width="5" height="12" rx="1" fill="currentColor" opacity="0.3" />
      <rect x="26" y="5" width="5" height="12" rx="1" fill="currentColor" opacity="0.3" />
    </svg>
  );
}

function MarqueeIconCreative() {
  return (
    <svg className="w-10 h-6 text-white/80" viewBox="0 0 32 20" fill="none">
      <path d="M2 10h28" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.4" />
      <rect x="6" y="7" width="4" height="6" rx="1" fill="currentColor" opacity="0.4" />
      <rect x="12" y="7" width="4" height="6" rx="1" fill="currentColor" opacity="0.5" />
      <rect x="18" y="7" width="4" height="6" rx="1" fill="currentColor" opacity="0.6" />
    </svg>
  );
}

function RibbonMarqueeIcon() {
  return (
    <svg className="w-10 h-6 text-white/80" viewBox="0 0 32 20" fill="none">
      <path d="M2 4h28M2 10h28M2 16h28" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.5" />
    </svg>
  );
}

function ThreeDMarqueeIcon() {
  return (
    <svg className="w-10 h-7 text-white/80" viewBox="0 0 32 22" fill="none">
      <rect x="4" y="3" width="24" height="16" rx="2" stroke="currentColor" strokeWidth="1" opacity="0.3" />
      <rect x="8" y="6" width="16" height="10" rx="1" stroke="currentColor" strokeWidth="1.5" opacity="0.6" />
    </svg>
  );
}

function MotionTrailIcon() {
  return (
    <svg className="w-9 h-8 text-white/80" viewBox="0 0 28 24" fill="none">
      <circle cx="20" cy="12" r="5" fill="currentColor" opacity="0.6" />
      <circle cx="14" cy="12" r="4" fill="currentColor" opacity="0.3" />
      <circle cx="9" cy="12" r="3" fill="currentColor" opacity="0.15" />
    </svg>
  );
}

function HorizontalScrollIcon() {
  return (
    <svg className="w-10 h-6 text-white/80" viewBox="0 0 32 20" fill="none">
      <rect x="2" y="4" width="8" height="12" rx="1.5" fill="currentColor" opacity="0.5" />
      <rect x="12" y="4" width="8" height="12" rx="1.5" fill="currentColor" opacity="0.35" />
      <rect x="22" y="4" width="8" height="12" rx="1.5" fill="currentColor" opacity="0.2" />
    </svg>
  );
}

/** Code snippet generic icon (code brackets) */
function CodeSnippetIcon() {
  return (
    <svg className="w-7 h-7 text-white/80" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 7l-4 5 4 5" opacity="0.7" />
      <path d="M16 7l4 5-4 5" opacity="0.7" />
      <line x1="11" y1="5" x2="13" y2="19" opacity="0.4" />
    </svg>
  );
}

// ─── Integrations ──────────────────────────────────────────────────────────

function InputIcon() {
  return (
    <svg className="w-11 h-6 text-blue-400" viewBox="0 0 36 18" fill="none">
      <rect x="1" y="1" width="34" height="16" rx="3" stroke="currentColor" strokeWidth="1.5" opacity="0.4" />
      <line x1="6" y1="5" x2="6" y2="13" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.5" />
      <text x="9" y="12" fill="currentColor" fontSize="8" opacity="0.3" fontFamily="sans-serif">Text</text>
    </svg>
  );
}

function TextareaIcon() {
  return (
    <svg className="w-10 h-8 text-blue-400" viewBox="0 0 28 24" fill="none">
      <rect x="1" y="1" width="26" height="22" rx="3" stroke="currentColor" strokeWidth="1.5" opacity="0.4" />
      <line x1="5" y1="6" x2="23" y2="6" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity="0.3" />
      <line x1="5" y1="10" x2="20" y2="10" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity="0.25" />
      <line x1="5" y1="14" x2="17" y2="14" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity="0.2" />
      <path d="M22 19l3 3m0-3l-3 3" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity="0.3" />
    </svg>
  );
}

function SelectIcon() {
  return (
    <svg className="w-11 h-6 text-blue-400" viewBox="0 0 36 18" fill="none">
      <rect x="1" y="1" width="34" height="16" rx="3" stroke="currentColor" strokeWidth="1.5" opacity="0.4" />
      <text x="6" y="12" fill="currentColor" fontSize="7" opacity="0.3" fontFamily="sans-serif">Select</text>
      <path d="M28 7l3 4-3 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" opacity="0.4" transform="rotate(90 29.5 9)" />
    </svg>
  );
}

function CheckboxIcon() {
  return (
    <svg className="w-7 h-7 text-blue-400" viewBox="0 0 24 24" fill="none">
      <rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" strokeWidth="1.5" opacity="0.5" />
      <path d="M7 12l3 3 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.6" />
    </svg>
  );
}

function RadioIcon() {
  return (
    <svg className="w-7 h-7 text-blue-400" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" opacity="0.5" />
      <circle cx="12" cy="12" r="4" fill="currentColor" opacity="0.5" />
    </svg>
  );
}

function FormIcon() {
  return (
    <svg className="w-9 h-8 text-blue-400" viewBox="0 0 28 24" fill="none">
      <rect x="2" y="2" width="24" height="5" rx="1.5" stroke="currentColor" strokeWidth="1" opacity="0.3" />
      <rect x="2" y="9" width="24" height="5" rx="1.5" stroke="currentColor" strokeWidth="1" opacity="0.3" />
      <rect x="2" y="16" width="12" height="5" rx="1.5" fill="currentColor" opacity="0.4" />
    </svg>
  );
}

function MapIcon() {
  return (
    <svg className="w-9 h-8 text-blue-400" viewBox="0 0 28 24" fill="none">
      <path d="M2 4l8-2 8 2 8-2v18l-8 2-8-2-8 2V4z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" opacity="0.4" />
      <line x1="10" y1="2" x2="10" y2="22" stroke="currentColor" strokeWidth="1" opacity="0.2" />
      <line x1="18" y1="4" x2="18" y2="24" stroke="currentColor" strokeWidth="1" opacity="0.2" />
    </svg>
  );
}

function CodeBlockIcon() {
  return (
    <svg className="w-9 h-7 text-blue-400" viewBox="0 0 28 22" fill="none">
      <rect x="1" y="1" width="26" height="20" rx="3" stroke="currentColor" strokeWidth="1.5" opacity="0.3" />
      <path d="M8 7l-4 4 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.5" />
      <path d="M20 7l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.5" />
      <line x1="13" y1="5" x2="15" y2="17" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.3" />
    </svg>
  );
}

// ─── Brand Logos (real official marks, white-on-transparent — card gradient supplies color) ─────

function SoundCloudIcon() {
  return (
    <svg className="w-8 h-8" viewBox="0 0 24 24" fill="white">
      <path d="M1.175 12.225a.4.4 0 0 0-.39.39v3.36a.4.4 0 0 0 .39.39.4.4 0 0 0 .39-.39v-3.36a.4.4 0 0 0-.39-.39zm1.96-1.41a.4.4 0 0 0-.39.4v4.78a.4.4 0 0 0 .39.4.4.4 0 0 0 .4-.4v-4.78a.4.4 0 0 0-.4-.4zm1.96-.78a.4.4 0 0 0-.4.39v5.95a.4.4 0 0 0 .4.39.4.4 0 0 0 .39-.39v-5.95a.4.4 0 0 0-.39-.39zm1.96-.27a.4.4 0 0 0-.39.39v6.49a.4.4 0 0 0 .39.39.4.4 0 0 0 .39-.39V10.16a.4.4 0 0 0-.39-.39zm1.96-.79a.4.4 0 0 0-.39.39v7.27a.4.4 0 0 0 .39.4.4.4 0 0 0 .39-.4V9.36a.4.4 0 0 0-.39-.39zm1.96-1.27a.4.4 0 0 0-.39.39v8.55a.4.4 0 0 0 .39.39.4.4 0 0 0 .4-.39V8.09a.4.4 0 0 0-.4-.39zm1.96-.36a.4.4 0 0 0-.39.39v8.91a.4.4 0 0 0 .39.39.4.4 0 0 0 .4-.39V7.73a.4.4 0 0 0-.4-.39zm6.78 4.59a3.7 3.7 0 0 0-1.45.3 6.5 6.5 0 0 0-6.45-5.93c-.79 0-1.57.16-2.28.46-.27.11-.34.22-.34.43v9.4a.4.4 0 0 0 .35.4h10.17a3.74 3.74 0 0 0 .01-7.46.4.4 0 0 0-.01.4z" />
    </svg>
  );
}

function SpotifyIcon() {
  return (
    <svg className="w-8 h-8" viewBox="0 0 24 24" fill="white">
      <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12C24 5.4 18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.42 1.56-.299.421-1.02.599-1.56.3z" />
    </svg>
  );
}

function FacebookIcon() {
  return (
    <svg className="w-8 h-8" viewBox="0 0 24 24" fill="white">
      <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
    </svg>
  );
}

function TwitterXIcon() {
  return (
    <svg className="w-8 h-8" viewBox="0 0 24 24" fill="white">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function InstagramIcon() {
  return (
    <svg className="w-8 h-8" viewBox="0 0 24 24" fill="white">
      <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z" />
    </svg>
  );
}

function LinkedInIcon() {
  return (
    <svg className="w-8 h-8" viewBox="0 0 24 24" fill="white">
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.063 2.063 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
    </svg>
  );
}

function PinterestIcon() {
  return (
    <svg className="w-8 h-8" viewBox="0 0 24 24" fill="white">
      <path d="M12 0C5.373 0 0 5.372 0 12c0 5.084 3.163 9.426 7.627 11.174-.105-.949-.2-2.405.042-3.441.218-.937 1.407-5.965 1.407-5.965s-.359-.719-.359-1.782c0-1.668.967-2.914 2.171-2.914 1.023 0 1.518.769 1.518 1.69 0 1.029-.655 2.568-.994 3.995-.283 1.194.599 2.169 1.777 2.169 2.133 0 3.772-2.249 3.772-5.495 0-2.873-2.064-4.882-5.012-4.882-3.414 0-5.418 2.561-5.418 5.207 0 1.031.397 2.138.893 2.738a.36.36 0 0 1 .083.345l-.333 1.36c-.053.22-.174.267-.402.161-1.499-.698-2.436-2.889-2.436-4.649 0-3.785 2.75-7.262 7.929-7.262 4.163 0 7.398 2.967 7.398 6.931 0 4.136-2.607 7.464-6.227 7.464-1.216 0-2.359-.631-2.75-1.378l-.748 2.853c-.271 1.043-1.002 2.35-1.492 3.146C9.57 23.812 10.763 24 12 24c6.627 0 12-5.373 12-12 0-6.628-5.373-12-12-12z" />
    </svg>
  );
}

function TikTokIcon() {
  return (
    <svg className="w-8 h-8" viewBox="0 0 24 24" fill="white">
      <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5.8 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1.84-.1z" />
    </svg>
  );
}

// ─── Form Integrations (real brand logos, white-on-transparent) ─────────────

function CalendlyIcon() {
  return (
    <svg className="w-8 h-8" viewBox="0 0 24 24" fill="white">
      <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.5 14.86c-.13.32-.34.6-.62.83-1.06.86-2.5 1.31-4.27 1.31-2.04 0-3.65-.7-4.78-2.06-.97-1.16-1.47-2.74-1.47-4.69 0-1.96.5-3.55 1.5-4.71 1.13-1.36 2.74-2.05 4.78-2.05 1.78 0 3.21.45 4.27 1.34.28.23.49.51.62.83.13.32.16.66.08.99l-.42 1.7c-.05.2-.18.36-.36.45-.18.09-.39.1-.58.03l-1.46-.55c-.18-.07-.32-.21-.4-.39-.36-.84-1.05-1.27-2.06-1.27-1.62 0-2.43 1.21-2.43 3.63 0 2.42.81 3.63 2.43 3.63 1.01 0 1.7-.43 2.06-1.27.08-.18.22-.32.4-.39l1.46-.55c.19-.07.4-.06.58.03.18.09.31.25.36.45l.42 1.7c.08.33.05.67-.08.99z" />
    </svg>
  );
}

function TypeformIcon() {
  return (
    <svg className="w-8 h-8" viewBox="0 0 24 24" fill="white">
      <path d="M9.4 2c1.5 0 2.7.4 3.7 1.1.9.6 1.7 1.5 2.4 2.5 1.4 2 2.5 4.5 3 6.7.6 2.4.7 4.5.5 5.9-.2 1.4-.7 2.4-1.4 3.1-.7.7-1.7 1.1-2.9 1.1-1.5 0-2.7-.4-3.7-1.1-.9-.6-1.7-1.5-2.4-2.5C7.2 16.8 6.1 14.3 5.6 12.1c-.6-2.4-.7-4.5-.5-5.9.2-1.4.7-2.4 1.4-3.1C7.2 2.4 8.2 2 9.4 2zm0 1.6c-.7 0-1.4.2-1.9.6-.5.4-.9 1-1.1 1.7-.4 1.2-.4 3 .1 5.1.5 2.1 1.4 4.3 2.7 6.1.6.9 1.3 1.6 2.1 2.2.8.5 1.6.8 2.5.8.7 0 1.4-.2 1.9-.6.5-.4.9-1 1.1-1.7.4-1.2.4-3-.1-5.1-.5-2.1-1.4-4.3-2.7-6.1-.6-.9-1.3-1.6-2.1-2.2-.8-.5-1.6-.8-2.5-.8z" />
    </svg>
  );
}

function GoogleFormsIcon() {
  return (
    <svg className="w-8 h-8" viewBox="0 0 24 24" fill="white">
      <path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11zM7.5 12h9v1.5h-9zm0 3h9v1.5h-9zm0 3h6v1.5h-6z" />
    </svg>
  );
}

function CustomFormIcon() {
  return (
    <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none">
      <rect x="3" y="3" width="18" height="18" rx="2" stroke="white" strokeWidth="1.5" fill="none" />
      <rect x="6" y="7" width="12" height="2" rx="1" fill="white" />
      <rect x="6" y="11" width="12" height="2" rx="1" fill="white" />
      <rect x="6" y="15" width="6" height="2.5" rx="1.25" fill="white" />
    </svg>
  );
}

// ─── Utility — Noises ─────────────────────────────────────────────────────

function NoiseFilmGrainIcon() {
  return (
    <svg viewBox="0 0 60 48" className="w-full h-12 rounded-md overflow-hidden">
      <defs>
        <filter id="filmGrainPrev"><feTurbulence type="fractalNoise" baseFrequency="1.2" numOctaves={4} stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter>
      </defs>
      <rect width="60" height="48" fill="#1a1a1a" />
      <rect width="60" height="48" filter="url(#filmGrainPrev)" opacity="0.35"/>
    </svg>
  );
}

function NoiseStaticIcon() {
  return (
    <svg viewBox="0 0 60 48" className="w-full h-12 rounded-md overflow-hidden">
      <defs>
        <filter id="staticPrev"><feTurbulence type="turbulence" baseFrequency="0.65 0.9" numOctaves={1} seed={3}/></filter>
      </defs>
      <rect width="60" height="48" fill="#0a0a0a" />
      <rect width="60" height="48" filter="url(#staticPrev)" opacity="0.5"/>
    </svg>
  );
}

function NoisePerlinIcon() {
  return (
    <svg viewBox="0 0 60 48" className="w-full h-12 rounded-md overflow-hidden">
      <defs>
        <filter id="perlinPrev"><feTurbulence type="fractalNoise" baseFrequency="0.03" numOctaves={5} stitchTiles="stitch"/></filter>
      </defs>
      <rect width="60" height="48" fill="#111" />
      <rect width="60" height="48" filter="url(#perlinPrev)" opacity="0.6"/>
    </svg>
  );
}

function NoiseHalftoneIcon() {
  return (
    <svg viewBox="0 0 60 48" className="w-full h-12 rounded-md overflow-hidden">
      <rect width="60" height="48" fill="#111" />
      {Array.from({length: 8}, (_, r) =>
        Array.from({length: 10}, (_, c) => {
          const dx = c * 7 + (r % 2 ? 3.5 : 0);
          const dy = r * 6 + 3;
          const dist = Math.sqrt((dx - 30) ** 2 + (dy - 24) ** 2);
          const radius = Math.max(0.5, 2.5 - dist * 0.06);
          return <circle key={`${r}-${c}`} cx={dx} cy={dy} r={radius} fill="#A78BFA" opacity="0.7"/>;
        })
      )}
    </svg>
  );
}

function NoiseScanlineIcon() {
  return (
    <svg viewBox="0 0 60 48" className="w-full h-12 rounded-md overflow-hidden">
      <rect width="60" height="48" fill="#111" />
      {Array.from({length: 16}, (_, i) => (
        <line key={i} x1="0" y1={i * 3} x2="60" y2={i * 3} stroke="#A78BFA" strokeWidth="1" opacity="0.35"/>
      ))}
    </svg>
  );
}

function NoiseChromaticIcon() {
  return (
    <svg viewBox="0 0 60 48" className="w-full h-12 rounded-md overflow-hidden">
      <defs>
        <filter id="chromPrev">
          <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves={3} seed={7}/>
          <feColorMatrix type="hueRotate" values="180"/>
        </filter>
      </defs>
      <rect width="60" height="48" fill="#0a0a0a" />
      <rect width="60" height="48" filter="url(#chromPrev)" opacity="0.55"/>
    </svg>
  );
}

// ─── Utility — Dividers ───────────────────────────────────────────────────

function DividerLineIcon() {
  return (
    <svg viewBox="0 0 120 48" className="w-full h-12" preserveAspectRatio="none">
      <line x1="8" y1="24" x2="112" y2="24" stroke="#F9A8D4" strokeWidth="3" strokeLinecap="round" strokeOpacity="0.9"/>
    </svg>
  );
}

function DividerWaveIcon() {
  return (
    <svg viewBox="0 0 120 48" className="w-full h-12" preserveAspectRatio="none">
      <defs><linearGradient id="waveFill" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#F9A8D4"/><stop offset="100%" stopColor="#FBCFE8"/></linearGradient></defs>
      <path d="M0 48 L0 32 Q15 18 30 32 Q45 46 60 32 Q75 18 90 32 Q105 46 120 32 L120 48 Z" fill="url(#waveFill)" fillOpacity="0.9"/>
    </svg>
  );
}

function DividerAngledIcon() {
  return (
    <svg viewBox="0 0 120 48" className="w-full h-12" preserveAspectRatio="none">
      <defs><linearGradient id="angleFill" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stopColor="#F9A8D4" stopOpacity="0.4"/><stop offset="100%" stopColor="#FBCFE8"/></linearGradient></defs>
      <path d="M0 24 L120 0 L120 48 L0 48 Z" fill="url(#angleFill)"/>
    </svg>
  );
}

function DividerCurvedIcon() {
  return (
    <svg viewBox="0 0 120 48" className="w-full h-12" preserveAspectRatio="none">
      <defs><linearGradient id="curveFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#FBCFE8"/><stop offset="100%" stopColor="#F9A8D4"/></linearGradient></defs>
      <path d="M0 48 Q60 -10 120 48 Z" fill="url(#curveFill)" fillOpacity="0.9"/>
    </svg>
  );
}

function DividerZigzagIcon() {
  return (
    <svg viewBox="0 0 120 48" className="w-full h-12" preserveAspectRatio="none">
      <path d="M0 48 L0 28 L10 18 L20 28 L30 18 L40 28 L50 18 L60 28 L70 18 L80 28 L90 18 L100 28 L110 18 L120 28 L120 48 Z" fill="#F9A8D4" fillOpacity="0.9"/>
    </svg>
  );
}

function DividerWavyLineIcon() {
  return (
    <svg viewBox="0 0 120 48" className="w-full h-12" preserveAspectRatio="none">
      <path d="M0 24 Q15 8 30 24 Q45 40 60 24 Q75 8 90 24 Q105 40 120 24" fill="none" stroke="#F9A8D4" strokeWidth="4" strokeOpacity="0.9" strokeLinecap="round"/>
    </svg>
  );
}

function DividerArrowIcon() {
  return (
    <svg viewBox="0 0 120 48" className="w-full h-12" preserveAspectRatio="none">
      <defs><linearGradient id="arrowFill" x1="0.5" y1="0" x2="0.5" y2="1"><stop offset="0%" stopColor="#FBCFE8" stopOpacity="0.3"/><stop offset="100%" stopColor="#F9A8D4"/></linearGradient></defs>
      <path d="M0 0 L60 36 L120 0 L120 48 L0 48 Z" fill="url(#arrowFill)"/>
    </svg>
  );
}

function DividerStepsIcon() {
  return (
    <svg viewBox="0 0 120 48" className="w-full h-12" preserveAspectRatio="none">
      <defs><linearGradient id="stepsFill" x1="0" y1="1" x2="1" y2="0"><stop offset="0%" stopColor="#F9A8D4"/><stop offset="100%" stopColor="#FBCFE8" stopOpacity="0.5"/></linearGradient></defs>
      <path d="M0 48 L0 38 L24 38 L24 28 L48 28 L48 19 L72 19 L72 10 L96 10 L96 0 L120 0 L120 48 Z" fill="url(#stepsFill)"/>
    </svg>
  );
}

// ─── Utility — Patterns ───────────────────────────────────────────────────

function PatternGridIcon() {
  return (
    <svg viewBox="0 0 60 48" className="w-full h-12">
      {[0, 12, 24, 36, 48, 60].map(x => <line key={`v${x}`} x1={x} y1="0" x2={x} y2="48" stroke="#7C3AED" strokeOpacity="0.5" strokeWidth="0.7"/>)}
      {[0, 12, 24, 36, 48].map(y => <line key={`h${y}`} x1="0" y1={y} x2="60" y2={y} stroke="#7C3AED" strokeOpacity="0.5" strokeWidth="0.7"/>)}
    </svg>
  );
}

function PatternDotsIcon() {
  return (
    <svg viewBox="0 0 60 48" className="w-full h-12">
      {Array.from({ length: 5 }, (_, r) => Array.from({ length: 6 }, (_, c) => (
        <circle key={`${r}-${c}`} cx={6 + c * 10} cy={6 + r * 10} r="1.4" fill="#7C3AED" fillOpacity="0.6" />
      )))}
    </svg>
  );
}

function PatternCrossesIcon() {
  return (
    <svg viewBox="0 0 60 48" className="w-full h-12">
      {Array.from({ length: 4 }, (_, r) => Array.from({ length: 5 }, (_, c) => (
        <g key={`${r}-${c}`}>
          <line x1={6 + c * 12} y1={2 + r * 12} x2={6 + c * 12} y2={10 + r * 12} stroke="#7C3AED" strokeOpacity="0.5" strokeWidth="0.8" />
          <line x1={2 + c * 12} y1={6 + r * 12} x2={10 + c * 12} y2={6 + r * 12} stroke="#7C3AED" strokeOpacity="0.5" strokeWidth="0.8" />
        </g>
      )))}
    </svg>
  );
}

function PatternDiagonalIcon() {
  return (
    <svg viewBox="0 0 60 48" className="w-full h-12">
      {Array.from({ length: 12 }, (_, i) => (
        <line key={i} x1={-20 + i * 10} y1="0" x2={-20 + i * 10 + 48} y2="48" stroke="#7C3AED" strokeOpacity="0.4" strokeWidth="0.8" />
      ))}
    </svg>
  );
}

function PatternGridMaskIcon() {
  return (
    <svg viewBox="0 0 60 48" className="w-full h-12">
      <defs>
        <radialGradient id="gridMaskPrev">
          <stop offset="0%" stopColor="white" stopOpacity="1" />
          <stop offset="70%" stopColor="white" stopOpacity="0" />
        </radialGradient>
        <mask id="gridMaskM">
          <rect width="60" height="48" fill="url(#gridMaskPrev)" />
        </mask>
      </defs>
      <g mask="url(#gridMaskM)">
        {[0, 10, 20, 30, 40, 50, 60].map(x => <line key={`v${x}`} x1={x} y1="0" x2={x} y2="48" stroke="#7C3AED" strokeOpacity="0.5" strokeWidth="0.7" />)}
        {[0, 10, 20, 30, 40, 48].map(y => <line key={`h${y}`} x1="0" y1={y} x2="60" y2={y} stroke="#7C3AED" strokeOpacity="0.5" strokeWidth="0.7" />)}
      </g>
    </svg>
  );
}

function PatternHoneycombIcon() {
  return (
    <svg viewBox="0 0 60 48" className="w-full h-12">
      {Array.from({ length: 5 }, (_, r) => Array.from({ length: 6 }, (_, c) => {
        const cx = c * 12 + (r % 2 ? 6 : 0);
        const cy = r * 10 + 4;
        const s = 5.5;
        const pts = Array.from({ length: 6 }, (_, i) => {
          const a = Math.PI / 3 * i - Math.PI / 6;
          return `${cx + s * Math.cos(a)},${cy + s * Math.sin(a)}`;
        }).join(' ');
        return <polygon key={`${r}-${c}`} points={pts} fill="none" stroke="#7C3AED" strokeOpacity="0.45" strokeWidth="0.7" />;
      }))}
    </svg>
  );
}

function PatternCheckerboardIcon() {
  return (
    <svg viewBox="0 0 60 48" className="w-full h-12">
      {Array.from({ length: 6 }, (_, r) => Array.from({ length: 8 }, (_, c) => (
        (r + c) % 2 === 0 ? <rect key={`${r}-${c}`} x={c * 8} y={r * 8} width="8" height="8" fill="#7C3AED" fillOpacity="0.25" /> : null
      )))}
    </svg>
  );
}

// ─── Utility — Shaders ────────────────────────────────────────────────────
//
// Each card is a small CSS preview that suggests the live look of the
// shader Code component — no actual canvas in the card (the panel renders many
// of these at once and a real canvas per card would tank scroll
// performance). Once dropped, the live animated Code component takes over.

function ShaderCard({ children, bg }: { children?: React.ReactNode; bg: string }) {
  return (
    <div
      className="w-full h-12 rounded-md overflow-hidden relative"
      style={{ background: bg }}
    >
      {children}
    </div>
  );
}

function ShaderWaveLinesIcon() {
  return (
    <ShaderCard bg="#0F0F1A">
      <svg viewBox="0 0 60 48" className="absolute inset-0 w-full h-full" preserveAspectRatio="none">
        {[0, 1, 2, 3, 4, 5, 6].map(i => (
          <path
            key={i}
            d={`M0 ${20 + i * 2} Q 10 ${16 + i * 2} 20 ${22 + i * 2} T 40 ${20 + i * 2} T 60 ${22 + i * 2}`}
            stroke="#FFFFFF"
            strokeOpacity={0.55 - i * 0.06}
            strokeWidth="0.6"
            fill="none"
          />
        ))}
      </svg>
    </ShaderCard>
  );
}

function ShaderWaveGradientIcon() {
  return (
    <ShaderCard bg="linear-gradient(115deg, #FF3624 0%, #FFAE00 30%, #E29EFF 65%, #9EABFF 100%)">
      <div
        className="absolute inset-0 mix-blend-screen opacity-60"
        style={{ background: 'radial-gradient(circle at 30% 60%, #FFAE00 0%, transparent 50%)' }}
      />
    </ShaderCard>
  );
}

function ShaderMeshGradientIcon() {
  return (
    <div
      className="w-full h-12 rounded-md overflow-hidden"
      style={{
        background:
          'radial-gradient(circle at 20% 30%, #FF6B6B 0%, transparent 50%), ' +
          'radial-gradient(circle at 80% 30%, #FFD93D 0%, transparent 55%), ' +
          'radial-gradient(circle at 50% 80%, #6BCB77 0%, transparent 55%), ' +
          'radial-gradient(circle at 90% 90%, #4D96FF 0%, transparent 55%), ' +
          '#FF9CEE',
        filter: 'blur(2px)',
      }}
    />
  );
}

function ShaderPlasmaIcon() {
  return (
    <ShaderCard bg="conic-gradient(from 90deg at 40% 60%, #FF006E 0%, #FFBE0B 33%, #3A86FF 66%, #FF006E 100%)" />
  );
}

function ShaderLiquidMetalIcon() {
  return (
    <ShaderCard bg="linear-gradient(135deg, #1A1A2E 0%, #7B61FF 50%, #FFFFFF 65%, #7B61FF 80%, #1A1A2E 100%)" />
  );
}

function ShaderCausticsIcon() {
  return (
    <ShaderCard bg="radial-gradient(circle at 40% 50%, #7DF9FF 0%, transparent 35%), radial-gradient(circle at 70% 70%, #7DF9FF 0%, transparent 30%), #001824">
      <svg viewBox="0 0 60 48" className="absolute inset-0 w-full h-full" preserveAspectRatio="none">
        <path d="M5 22 Q 15 16 25 22 T 45 22 T 60 22" stroke="#7DF9FF" strokeOpacity="0.6" strokeWidth="1" fill="none" />
        <path d="M0 32 Q 12 26 22 32 T 42 32 T 60 32" stroke="#7DF9FF" strokeOpacity="0.45" strokeWidth="1" fill="none" />
      </svg>
    </ShaderCard>
  );
}

// Aurora Background — northern-lights bands of #0ea5e9 / #a855f7 / #ec4899
// drifting across a dark sky. Mirrors the code component's WebGL fragment-shader
// defaults (colorA/B/C) so the panel preview reads as the same effect.
function ShaderAuroraIcon() {
  return (
    <ShaderCard bg="#020617">
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 100% 60% at 30% 70%, rgba(14,165,233,0.55) 0%, transparent 60%), ' +
            'radial-gradient(ellipse 80% 50% at 60% 40%, rgba(168,85,247,0.55) 0%, transparent 60%), ' +
            'radial-gradient(ellipse 70% 40% at 80% 65%, rgba(236,72,153,0.45) 0%, transparent 60%)',
          filter: 'blur(1px)',
        }}
      />
    </ShaderCard>
  );
}

// Matrix Rain — vertical streams of green glyphs over black. Static SVG
// suggests the falling-rain effect; code component renders the live Canvas 2D
// version once dropped.
function ShaderMatrixRainIcon() {
  return (
    <ShaderCard bg="#020617">
      <svg viewBox="0 0 60 48" className="absolute inset-0 w-full h-full" preserveAspectRatio="none">
        {[4, 12, 20, 28, 36, 44, 52].map((x, col) => {
          // Each column has a head + trail. Head is bright (#d1fae5),
          // trail fades into the code component's trail green (#22c55e).
          const headY = 6 + ((col * 7) % 36);
          return (
            <g key={col}>
              {[0, 1, 2, 3, 4].map((i) => (
                <text
                  key={i}
                  x={x}
                  y={headY - i * 6}
                  fontSize="6"
                  fontFamily="monospace"
                  fontWeight="700"
                  fill={i === 0 ? '#d1fae5' : '#22c55e'}
                  fillOpacity={i === 0 ? 1 : 0.55 - i * 0.1}
                  textAnchor="middle"
                >
                  {String.fromCharCode(0x30a0 + ((col * 5 + i * 7) % 96))}
                </text>
              ))}
            </g>
          );
        })}
      </svg>
    </ShaderCard>
  );
}

// Wave Distortion — sine-warped gradient between #06b6d4, #3b82f6 and
// #0f172a (the code component's default colorA/B/C). Static SVG ripple suggests
// the live shader's frequency/amplitude axis without spinning a canvas
// per panel tile.
function ShaderWaveDistortionIcon() {
  return (
    <ShaderCard bg="linear-gradient(135deg, #06b6d4 0%, #3b82f6 55%, #0f172a 100%)">
      <svg viewBox="0 0 60 48" className="absolute inset-0 w-full h-full" preserveAspectRatio="none">
        {[0, 1, 2, 3, 4].map((i) => (
          <path
            key={i}
            d={`M0 ${10 + i * 8} Q 10 ${4 + i * 8} 20 ${12 + i * 8} T 40 ${10 + i * 8} T 60 ${12 + i * 8}`}
            stroke="#FFFFFF"
            strokeOpacity={0.35 - i * 0.05}
            strokeWidth="0.7"
            fill="none"
          />
        ))}
      </svg>
    </ShaderCard>
  );
}

// ─── Utility — Interactive ────────────────────────────────────────────────

function LocaleSwitcherIcon() {
  // Globe with longitudes + an equator highlight.
  return (
    <svg className="w-9 h-9 text-white" viewBox="0 0 32 32" fill="none">
      <circle cx="16" cy="16" r="11.5" fill="white" fillOpacity="0.18" />
      <circle cx="16" cy="16" r="11.5" stroke="white" strokeOpacity="0.95" strokeWidth="1.4" />
      <ellipse cx="16" cy="16" rx="5.5" ry="11.5" stroke="white" strokeOpacity="0.85" strokeWidth="1.2" />
      <line x1="4.5" y1="16" x2="27.5" y2="16" stroke="white" strokeOpacity="0.9" strokeWidth="1.4" />
      <path d="M6 10 Q 16 13.5 26 10" stroke="white" strokeOpacity="0.7" strokeWidth="1.1" fill="none" />
      <path d="M6 22 Q 16 18.5 26 22" stroke="white" strokeOpacity="0.7" strokeWidth="1.1" fill="none" />
    </svg>
  );
}

function ThemeToggleIcon() {
  // Yin-yang style circle: right half bright (sun), left half dark (moon).
  return (
    <svg className="w-9 h-9" viewBox="0 0 32 32" fill="none">
      <circle cx="16" cy="16" r="11.5" fill="white" />
      <path d="M16 4.5 A 11.5 11.5 0 0 0 16 27.5 Z" fill="black" fillOpacity="0.78" />
      <circle cx="16" cy="16" r="11.5" stroke="white" strokeOpacity="0.95" strokeWidth="1.4" fill="none" />
    </svg>
  );
}

/** CMS Collection icon — small stack of three rows representing a list of
 *  CMS items. Used by the dynamic CMS section in the Insert panel. */
function CollectionIcon() {
  return (
    <svg className="w-9 h-9 text-[var(--text-secondary)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  );
}

/** CMS Field icon — single text-line glyph representing a bindable field
 *  (vs. the cylinder-stack used for whole collections). */

// ─── Icon Registry ─────────────────────────────────────────────────────────

function FrameIcon() {
  return (
    <svg className="w-9 h-9 text-[var(--text-secondary)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <g strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 6h18m-3-3v18M3 18h18M6 3v18" />
        <path fill="currentColor" opacity="0.16" d="M6 6h12v12H6z" />
      </g>
    </svg>
  );
}

/** Pink vertical 3-box stack */

function ImageIcon() {
  const id = React.useId();
  return (
    <svg className="w-9 h-9" viewBox="0 0 16 16">
      <g fill="none">
        <path
          fill={`url(#${id}-bg)`}
          d="M2 4.5A2.5 2.5 0 0 1 4.5 2h7A2.5 2.5 0 0 1 14 4.5v7a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 2 11.5z"
        />
        <path
          fill={`url(#${id}-mountain)`}
          d="M13.586 12.879A2.5 2.5 0 0 1 11.5 14h-7a2.5 2.5 0 0 1-2.086-1.121l4.384-4.384a1.7 1.7 0 0 1 2.404 0z"
        />
        <path
          fill={`url(#${id}-sun)`}
          d="M11.5 5.502a1.002 1.002 0 1 1-2.004 0a1.002 1.002 0 0 1 2.004 0"
        />
        <defs>
          <linearGradient id={`${id}-mountain`} x1="6.286" x2="7.572" y1="7.997" y2="14.347" gradientUnits="userSpaceOnUse">
            <stop stopColor="#b3e0ff" />
            <stop offset="1" stopColor="#8cd0ff" />
          </linearGradient>
          <linearGradient id={`${id}-sun`} x1="10.097" x2="10.829" y1="4.277" y2="6.913" gradientUnits="userSpaceOnUse">
            <stop stopColor="#fdfdfd" />
            <stop offset="1" stopColor="#b3e0ff" />
          </linearGradient>
          <radialGradient id={`${id}-bg`} cx="0" cy="0" r="1" gradientTransform="rotate(51.687 3.546 -5.177)scale(33.182 30.1812)" gradientUnits="userSpaceOnUse">
            <stop offset=".338" stopColor="#0fafff" />
            <stop offset=".529" stopColor="#367af2" />
          </radialGradient>
        </defs>
      </g>
    </svg>
  );
}

/** Purple camera/video icon — EXACT from old builder ElementVideoIcon */

function VideoIcon() {
  const id = React.useId();
  return (
    <svg className="w-9 h-9" viewBox="0 0 16 16">
      <g fill="none">
        <path
          fill={`url(#${id}-lens)`}
          d="M13.144 11.789L7.34 8l5.804-3.789A1.2 1.2 0 0 1 15 5.216v5.568a1.2 1.2 0 0 1-1.856 1.005"
        />
        <path
          fill={`url(#${id}-shadow)`}
          fillOpacity="0.75"
          d="M13.144 11.789L7.34 8l5.804-3.789A1.2 1.2 0 0 1 15 5.216v5.568a1.2 1.2 0 0 1-1.856 1.005"
        />
        <path
          fill={`url(#${id}-body)`}
          d="M1 5.5C1 4.12 2.099 3 3.455 3h4.09C8.901 3 10 4.12 10 5.5v5c0 1.38-1.099 2.5-2.455 2.5h-4.09C2.099 13 1 11.88 1 10.5z"
        />
        <path
          fill={`url(#${id}-screen)`}
          d="M2 9.5A1.5 1.5 0 0 1 3.5 8h4a1.5 1.5 0 1 1 0 3h-4A1.5 1.5 0 0 1 2 9.5"
          opacity="0.5"
        />
        <path
          fill="#babaff"
          d="M7.5 10.3a.75.75 0 1 0 0-1.5a.75.75 0 0 0 0 1.5M3.5 9a.5.5 0 0 0 0 1h2a.5.5 0 0 0 0-1z"
        />
        <defs>
          <radialGradient id={`${id}-lens`} cx="0" cy="0" r="1" gradientTransform="rotate(72.275 3.263 9.07)scale(10.0776 26.0793)" gradientUnits="userSpaceOnUse">
            <stop offset=".081" stopColor="#f08af4" />
            <stop offset=".341" stopColor="#9c6cfe" />
            <stop offset="1" stopColor="#4e44db" />
          </radialGradient>
          <radialGradient id={`${id}-body`} cx="0" cy="0" r="1" gradientTransform="rotate(45.625 -4.38 .952)scale(14.8065 31.1039)" gradientUnits="userSpaceOnUse">
            <stop stopColor="#f08af4" />
            <stop offset=".341" stopColor="#9c6cfe" />
            <stop offset="1" stopColor="#4e44db" />
          </radialGradient>
          <linearGradient id={`${id}-shadow`} x1="8.5" x2="14.991" y1="8" y2="7.75" gradientUnits="userSpaceOnUse">
            <stop stopColor="#312a9a" />
            <stop offset="1" stopColor="#312a9a" stopOpacity="0" />
          </linearGradient>
          <linearGradient id={`${id}-screen`} x1="1.841" x2="2.828" y1="8" y2="12.025" gradientUnits="userSpaceOnUse">
            <stop stopColor="#3b148a" />
            <stop offset="1" stopColor="#4b20a0" />
          </linearGradient>
        </defs>
      </g>
    </svg>
  );
}

/** Pink music note icon — EXACT from old builder ElementAudioIcon */

function LayoutGridIcon() {
  return (
    <LayoutShell className="grid grid-cols-2 grid-rows-2">
      <div className={CELL} />
      <div className={CELL} />
      <div className={CELL} />
      <div className={CELL} />
    </LayoutShell>
  );
}

function ShapeSquareIcon() {
  return (
    <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor">
      <path d="M19 2H5a3 3 0 0 0-3 3v14a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3V5a3 3 0 0 0-3-3" fill="var(--text-secondary)" opacity="0.6" />
    </svg>
  );
}

function ShapeCircleIcon() {
  return (
    <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 22q-2.075 0-3.9-.788t-3.175-2.137T2.788 15.9T2 12t.788-3.9t2.137-3.175T8.1 2.788T12 2t3.9.788t3.175 2.137T21.213 8.1T22 12t-.788 3.9t-2.137 3.175t-3.175 2.138T12 22" fill="var(--text-secondary)" opacity="0.6" />
    </svg>
  );
}

function ShapeTriangleIcon() {
  return (
    <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor">
      <path d="M10.285 3.858c.777-1.294 2.653-1.294 3.43 0l8.468 14.113c.8 1.333-.16 3.029-1.715 3.029H3.532c-1.554 0-2.514-1.696-1.715-3.029z" fill="var(--text-secondary)" opacity="0.6" />
    </svg>
  );
}

/** Star — EXACT from old builder ShapeStarIcon (yellow emoji star) */

function ShapeStarIcon() {
  return (
    <svg className="w-8 h-8" viewBox="0 0 72 72">
      <path
        fill="#fcea2b"
        d="M35.993 10.736L27.791 27.37L9.439 30.044l13.285 12.94l-3.128 18.28l16.412-8.636l16.419 8.624l-3.142-18.278l13.276-12.95l-18.354-2.66z"
      />
      <path
        fill="none"
        stroke="#000"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeMiterlimit="10"
        strokeWidth="2"
        d="M35.993 10.736L27.791 27.37L9.439 30.044l13.285 12.94l-3.128 18.28l16.412-8.636l16.419 8.624l-3.142-18.278l13.276-12.95l-18.354-2.66z"
      />
    </svg>
  );
}

/** Hexagon — EXACT from old builder ShapeHexagonIcon */

function ShapeHexagonIcon() {
  return (
    <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2l9 5.2v9.6l-9 5.2l-9-5.2V7.2z" fill="var(--text-secondary)" opacity="0.6" />
    </svg>
  );
}

/** Pentagon — EXACT from old builder ShapePentagonIcon */

function ShapePentagonIcon() {
  return (
    <svg className="w-8 h-8" viewBox="0 0 256 256" fill="currentColor">
      <path d="m231.26 105.19l-32 107.54l-.06.17A15.94 15.94 0 0 1 184 224H72a15.94 15.94 0 0 1-15.2-11.1l-.06-.17l-32-107.54a16 16 0 0 1 5.7-17.63l87.92-68.31l.18-.14a15.93 15.93 0 0 1 18.92 0l.18.14l87.92 68.31a16 16 0 0 1 5.7 17.63" fill="var(--text-secondary)" opacity="0.6" />
    </svg>
  );
}

function YouTubeIcon() {
  return (
    <svg className="w-8 h-8" viewBox="0 0 24 24" fill="white">
      <path d="M23.5 6.2c-.3-1-1.1-1.8-2.1-2.1C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.4.6C1.6 4.4.8 5.2.5 6.2 0 8.1 0 12 0 12s0 3.9.5 5.8c.3 1 1.1 1.8 2.1 2.1 1.9.5 9.4.6 9.4.6s7.5 0 9.4-.6c1-.3 1.8-1.1 2.1-2.1.5-1.9.5-5.8.5-5.8s0-3.9-.5-5.8zM9.6 15.6V8.4l6.2 3.6-6.2 3.6z" />
    </svg>
  );
}

function VimeoIcon() {
  return (
    <svg className="w-8 h-8" viewBox="0 0 24 24" fill="white">
      <path d="M23.98 6.6c-.1 2.16-1.61 5.13-4.51 8.88C16.46 19.4 13.93 21.36 11.85 21.36c-1.29 0-2.38-1.19-3.27-3.57-.6-2.18-1.19-4.36-1.79-6.55-.66-2.38-1.37-3.57-2.13-3.57-.17 0-.75.34-1.74 1.04L1.7 6.34c1.1-.97 2.18-1.93 3.25-2.91 1.47-1.27 2.57-1.94 3.31-2.01 1.74-.17 2.81 1.02 3.21 3.57.43 2.75.73 4.46.9 5.13.5 2.27 1.05 3.4 1.66 3.4.47 0 1.18-.74 2.13-2.23.94-1.49 1.45-2.62 1.51-3.4.13-1.18-.34-1.78-1.41-1.78-.5 0-1.02.11-1.55.34 1.04-3.4 3.02-5.05 5.93-4.96 2.16.06 3.18 1.46 3.07 4.21z" />
    </svg>
  );
}

function CollectionFieldIcon() {
  return (
    <svg className="w-9 h-9 text-[var(--text-secondary)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h16" />
      <path d="M4 12h10" />
      <path d="M4 17h13" />
    </svg>
  );
}

export const ELEMENT_ICON_MAP: Record<string, React.FC> = {
  // Basic
  frame: FrameIcon,
  column: ColumnIcon,
  row: RowIcon,
  image: ImageIcon,
  video: VideoIcon,
  audio: AudioIcon,
  button: ButtonIcon,
  // Typography
  heading: HeadingIcon,
  paragraph: ParagraphIcon,
  textLink: TextLinkIcon,
  quote: QuoteIcon,
  // Cards
  cardBasic: CardBasicIcon,
  cardHorizontal: CardHorizontalIcon,
  cardProfile: CardProfileIcon,
  cardTestimonial: CardTestimonialIcon,
  cardPricing: CardPricingIcon,
  cardProduct: CardProductIcon,
  // Layouts
  layout2Row: Layout2RowIcon,
  layout3Row: Layout3RowIcon,
  layout2Col: Layout2ColIcon,
  layout3Col: Layout3ColIcon,
  layoutGrid: LayoutGridIcon,
  layoutSplitTop: LayoutSplitTopIcon,
  layoutSidebar: LayoutSidebarIcon,
  layoutHeader: LayoutHeaderIcon,
  // Shapes
  shapeSquare: ShapeSquareIcon,
  shapeCircle: ShapeCircleIcon,
  shapeTriangle: ShapeTriangleIcon,
  shapeStar: ShapeStarIcon,
  shapeHexagon: ShapeHexagonIcon,
  shapePentagon: ShapePentagonIcon,
  // Creative — Effects (pixel-faithful ports of the old builder's
  // InsertCategoryOverlay previews — animated tiles that fill the
  // panel's full-width preview slot via the `effect*` iconKey branch
  // in isPreviewIcon).
  effectCarousel: EffectCarouselIcon,
  effectMarquee: EffectMarqueeIcon,
  effectPathMarquee: EffectPathMarqueeIcon,
  effectThreeDMarquee: EffectThreeDMarqueeIcon,
  effectMotionTrail: EffectMotionTrailIcon,
  effectHorizontalScroll: EffectHorizontalScrollIcon,
  effectLensBox: EffectLensBoxIcon,
  effectMagnetBox: EffectMagnetBoxIcon,
  effectPixelatedHover: EffectPixelatedHoverIcon,
  effectNeonParticles: EffectNeonParticlesIcon,
  effectDesignCursor: EffectDesignCursorIcon,
  effectBlobCursor: EffectBlobCursorIcon,
  effectRibbonCursor: EffectRibbonCursorIcon,
  effectSplashCursor: EffectSplashCursorIcon,
  effectThemeToggle: EffectThemeToggleIcon,
  effectLocaleSwitcher: EffectLocaleSwitcherIcon,
  // Legacy flat icons (kept for back-compat with any out-of-tree
  // iconKey references; not used by the current EFFECTS_ITEMS list).
  carousel: CarouselIconCreative,
  marquee: MarqueeIconCreative,
  ribbonMarquee: RibbonMarqueeIcon,
  threeDMarquee: ThreeDMarqueeIcon,
  motionTrail: MotionTrailIcon,
  horizontalScroll: HorizontalScrollIcon,
  // Creative — Code Snippets / Cursors / Text Effects
  codeSnippet: CodeSnippetIcon,
  // Creative — Animated text-effect previews. Each one mirrors its
  // code component's behaviour at panel-tile size so the user sees what
  // they're about to drag. Live in `creative-preview-icons.tsx`.
  creativeMorphingText: CreativeMorphingTextIcon,
  creativeWordRotate: CreativeWordRotateIcon,
  creativeSpinningText: CreativeSpinningTextIcon,
  creativeHangingCurved: CreativeHangingCurvedIcon,
  creativeMagneticText: CreativeMagneticTextIcon,
  creativeTextPressure: CreativeTextPressureIcon,
  creativeTypingText: CreativeTypingTextIcon,
  creativeRotatingText3D: CreativeRotatingText3DIcon,
  creativeVideoText: CreativeVideoTextIcon,
  creativeCounter: CreativeCounterIcon,
  creativeGlitchText: CreativeGlitchTextIcon,
  // Integrations — Forms (basic widgets)
  input: InputIcon,
  textarea: TextareaIcon,
  select: SelectIcon,
  checkbox: CheckboxIcon,
  radio: RadioIcon,
  form: FormIcon,
  // Integrations — Forms (full / 3rd-party)
  customForm: CustomFormIcon,
  calendly: CalendlyIcon,
  typeform: TypeformIcon,
  googleForms: GoogleFormsIcon,
  // Integrations — Embeds
  youtube: YouTubeIcon,
  vimeo: VimeoIcon,
  soundcloud: SoundCloudIcon,
  spotify: SpotifyIcon,
  map: MapIcon,
  codeBlock: CodeBlockIcon,
  // Integrations — Social
  facebook: FacebookIcon,
  twitterX: TwitterXIcon,
  instagram: InstagramIcon,
  linkedin: LinkedInIcon,
  pinterest: PinterestIcon,
  tiktok: TikTokIcon,
  // Utility — Noises
  noiseFilmGrain: NoiseFilmGrainIcon,
  noiseStatic: NoiseStaticIcon,
  noisePerlin: NoisePerlinIcon,
  noiseHalftone: NoiseHalftoneIcon,
  noiseScanlines: NoiseScanlineIcon,
  noiseChromatic: NoiseChromaticIcon,
  // Utility — Dividers
  dividerLine: DividerLineIcon,
  dividerWave: DividerWaveIcon,
  dividerAngled: DividerAngledIcon,
  dividerCurved: DividerCurvedIcon,
  dividerZigzag: DividerZigzagIcon,
  dividerWavyLine: DividerWavyLineIcon,
  dividerArrow: DividerArrowIcon,
  dividerSteps: DividerStepsIcon,
  // Utility — Interactive
  localeSwitcher: LocaleSwitcherIcon,
  themeToggle: ThemeToggleIcon,
  // Utility — Patterns
  patternGrid: PatternGridIcon,
  patternDots: PatternDotsIcon,
  patternCrosses: PatternCrossesIcon,
  patternDiagonal: PatternDiagonalIcon,
  patternGridMask: PatternGridMaskIcon,
  patternHoneycomb: PatternHoneycombIcon,
  patternCheckerboard: PatternCheckerboardIcon,
  // Utility — Shaders (animated canvas-2D effects)
  shaderWaveLines: ShaderWaveLinesIcon,
  shaderWaveGradient: ShaderWaveGradientIcon,
  shaderMeshGradient: ShaderMeshGradientIcon,
  shaderPlasma: ShaderPlasmaIcon,
  shaderLiquidMetal: ShaderLiquidMetalIcon,
  shaderCaustics: ShaderCausticsIcon,
  shaderAurora: ShaderAuroraIcon,
  shaderMatrixRain: ShaderMatrixRainIcon,
  shaderWaveDistortion: ShaderWaveDistortionIcon,
  // CMS — collection-stack vs. single-field glyph
  collection: CollectionIcon,
  collectionField: CollectionFieldIcon,
};
