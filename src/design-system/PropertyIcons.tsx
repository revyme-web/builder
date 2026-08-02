// PropertyIcons.tsx — SVG swatch icons for every CSS property category.
// Each icon: rounded square (accent bg) + a glyph that CONTRASTS with it.
// Override bg with `bg` prop, icon color with `iconColor` prop.

import React from 'react';

type P = React.SVGProps<SVGSVGElement> & { bg?: string; iconColor?: string };

const DEFAULT_BG = 'var(--accent)';
// The glyph has to track the badge it sits on. This was hardcoded '#ffffff',
// which only worked while the accent happened to be dark — a light accent made
// all 57 icons vanish into their own square.
const IC = 'var(--accent-fg)';
// A caller that overrides `bg` is drawing on something OTHER than the accent
// (the empty-state placeholders use --control-border), so --accent-fg would be
// wrong there. Those fall back to the normal text colour unless the caller
// names one.
const IC_ON_CUSTOM_BG = 'var(--text-primary)';

const W = ({ bg, iconColor, ...props }: P, children: (c: string) => React.ReactNode) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width={20} height={20} fill="none" {...props}>
    <rect width={16} height={16} rx={4} fill={bg || DEFAULT_BG} />
    {children(iconColor || (bg ? IC_ON_CUSTOM_BG : IC))}
  </svg>
);

// ─── Color & Fill ──────────────────────────────────────────────────────────

const ColorIcon: React.FC<P> = (p) => W(p, c =>
  <circle cx={8} cy={8} r={4} fill={c} />
);

const GradientIcon: React.FC<P> = (p) => W(p, c => <>
  <circle cx={8} cy={8} r={4} fill={c} opacity={0.4} />
  <path d="M8 4a4 4 0 0 0 0 8V4Z" fill={c} />
</>);

const FillIcon: React.FC<P> = (p) => W(p, c => <>
  <rect x={4} y={5} width={8} height={6} rx={1.5} fill={c} opacity={0.4} />
  <rect x={3} y={4} width={8} height={6} rx={1.5} fill={c} />
</>);

// ─── Spacing ───────────────────────────────────────────────────────────────

const PaddingIcon: React.FC<P> = (p) => W(p, c => <>
  <rect x={3} y={3} width={10} height={10} rx={1.5} stroke={c} strokeWidth={1.2} />
  <rect x={5.5} y={5.5} width={5} height={5} rx={1} fill={c} opacity={0.5} />
</>);

const MarginIcon: React.FC<P> = (p) => W(p, c => <>
  <rect x={2.5} y={2.5} width={11} height={11} rx={1.5} stroke={c} strokeWidth={1} strokeDasharray="2 1.5" />
  <rect x={5} y={5} width={6} height={6} rx={1} fill={c} />
</>);

const GapIcon: React.FC<P> = (p) => W(p, c => <>
  <rect x={3} y={3.5} width={4} height={9} rx={1} fill={c} />
  <rect x={9} y={3.5} width={4} height={9} rx={1} fill={c} opacity={0.5} />
</>);

// ─── Border & Radius ───────────────────────────────────────────────────────

// Corner-bracket "frame" glyph (radix/user-supplied) — scaled from its native 15×15 viewBox into the
// 16×16 swatch via a nested <svg viewBox>.
export const BorderIcon: React.FC<P> = (p) => W(p, c =>
  <svg x={2} y={2} width={12} height={12} viewBox="0 0 15 15">
    <path fill={c} d="M2.5 9a.5.5 0 0 1 .5.5v.6c0 .428 0 .72.019.945c.017.219.05.331.09.41c.096.187.249.34.437.436c.078.04.19.072.41.09c.224.019.516.019.944.019h.6a.5.5 0 0 1 0 1h-.621c-.402 0-.734 0-1.005-.023c-.281-.022-.54-.071-.782-.195a2 2 0 0 1-.874-.874c-.124-.242-.173-.501-.196-.782A13 13 0 0 1 2 10.121V9.5a.5.5 0 0 1 .5-.5m10 0a.5.5 0 0 1 .5.5v.621c0 .402 0 .734-.023 1.005c-.022.281-.071.54-.195.782a2 2 0 0 1-.874.874c-.242.124-.501.173-.782.195c-.27.023-.603.023-1.005.023H9.5a.5.5 0 0 1 0-1h.6c.428 0 .72 0 .945-.019c.219-.018.331-.05.41-.09a1 1 0 0 0 .436-.437c.04-.078.072-.19.09-.41c.019-.224.019-.516.019-.944v-.6a.5.5 0 0 1 .5-.5m-7-7a.5.5 0 0 1 0 1h-.6c-.428 0-.72 0-.945.019c-.219.017-.331.05-.41.09a1 1 0 0 0-.436.437c-.04.078-.073.19-.09.41C3 4.18 3 4.471 3 4.9v.6a.5.5 0 0 1-1 0v-.621c0-.402 0-.734.022-1.005c.023-.281.072-.54.196-.782a2 2 0 0 1 .874-.874c.242-.124.501-.173.782-.196C4.144 2 4.477 2 4.879 2zm4.621 0c.402 0 .734 0 1.005.022c.281.023.54.072.782.196a2 2 0 0 1 .874.874c.124.242.173.501.195.782c.023.27.023.603.023 1.005V5.5a.5.5 0 0 1-1 0v-.6c0-.428 0-.72-.019-.945c-.018-.219-.05-.331-.09-.41a1 1 0 0 0-.437-.436c-.078-.04-.19-.073-.41-.09A13 13 0 0 0 10.1 3h-.6a.5.5 0 0 1 0-1z" />
  </svg>
);

const RadiusIcon: React.FC<P> = (p) => W(p, c => <>
  <path d="M4 9V6a2 2 0 0 1 2-2h3" stroke={c} strokeWidth={2} strokeLinecap="round" />
  <path d="M12 7v3a2 2 0 0 1-2 2H7" stroke={c} strokeWidth={1.2} strokeLinecap="round" opacity={0.4} />
</>);

// ─── Layout ────────────────────────────────────────────────────────────────

const DisplayIcon: React.FC<P> = (p) => W(p, c => <>
  <rect x={3} y={3} width={4} height={4} rx={0.8} fill={c} />
  <rect x={9} y={3} width={4} height={4} rx={0.8} fill={c} opacity={0.7} />
  <rect x={3} y={9} width={4} height={4} rx={0.8} fill={c} opacity={0.7} />
  <rect x={9} y={9} width={4} height={4} rx={0.8} fill={c} opacity={0.4} />
</>);

const FlexDirectionIcon: React.FC<P> = (p) => W(p, c =>
  <path d="M4 8h8M10 5.5l2.5 2.5-2.5 2.5" stroke={c} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
);

const AlignIcon: React.FC<P> = (p) => W(p, c => <>
  <line x1={8} y1={3} x2={8} y2={13} stroke={c} strokeWidth={0.8} opacity={0.3} />
  <rect x={4} y={4.5} width={3} height={7} rx={0.8} fill={c} />
  <rect x={9} y={5.5} width={3} height={5} rx={0.8} fill={c} opacity={0.7} />
</>);

const JustifyIcon: React.FC<P> = (p) => W(p, c => <>
  <rect x={3} y={5} width={2.5} height={6} rx={0.8} fill={c} />
  <rect x={6.75} y={5} width={2.5} height={6} rx={0.8} fill={c} opacity={0.7} />
  <rect x={10.5} y={5} width={2.5} height={6} rx={0.8} fill={c} opacity={0.5} />
</>);

const WrapIcon: React.FC<P> = (p) => W(p, c =>
  <path d="M4 6h8a1.5 1.5 0 0 1 0 3H7" stroke={c} strokeWidth={1.5} strokeLinecap="round" />
);

// ─── Position & Size ───────────────────────────────────────────────────────

const PositionIcon: React.FC<P> = (p) => W(p, c => <>
  <circle cx={8} cy={8} r={1.8} fill={c} />
  <path d="M8 3.5v2M8 10.5v2M3.5 8h2M10.5 8h2" stroke={c} strokeWidth={1.2} strokeLinecap="round" />
</>);

const WidthIcon: React.FC<P> = (p) => W(p, c =>
  <path d="M3 8h10M5 6L3 8l2 2M11 6l2 2-2 2" stroke={c} strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" />
);

const HeightIcon: React.FC<P> = (p) => W(p, c =>
  <path d="M8 3v10M6 5L8 3l2 2M6 11l2 2 2-2" stroke={c} strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" />
);

// ─── Typography ────────────────────────────────────────────────────────────

const FontSizeIcon: React.FC<P> = (p) => W(p, c =>
  <path d="M5 12V5l3 7M6 10h3M11 12V7l2 5M11.5 10.5h2" fill="none" stroke={c} strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" />
);

const FontFamilyIcon: React.FC<P> = (p) => W(p, c =>
  <path d="M4.5 12l2.5-7h1l2.5 7M5.5 10h3M12 5v7" stroke={c} strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" fill="none" />
);

const FontWeightIcon: React.FC<P> = (p) => W(p, c =>
  <path d="M5.5 4h3a2.5 2.5 0 0 1 0 4H5.5V4ZM5.5 8h4a2.5 2.5 0 0 1 0 4H5.5V8Z" stroke={c} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" fill="none" />
);

const LineHeightIcon: React.FC<P> = (p) => W(p, c => <>
  <path d="M7 5h6M7 8h6M7 11h5" stroke={c} strokeWidth={1.2} strokeLinecap="round" opacity={0.5} />
  <path d="M4 4v8M3 5.5l1-1.5 1 1.5M3 10.5l1 1.5 1-1.5" stroke={c} strokeWidth={1} strokeLinecap="round" />
</>);

const LetterSpacingIcon: React.FC<P> = (p) => W(p, c => <>
  <path d="M5 5v6M10 5v6" stroke={c} strokeWidth={1.8} strokeLinecap="round" />
  <path d="M3 13h10" stroke={c} strokeWidth={1} strokeLinecap="round" opacity={0.5} />
</>);

const TextAlignIcon: React.FC<P> = (p) => W(p, c =>
  <path d="M4 4.5h8M4 7.5h5.5M4 10.5h8" stroke={c} strokeWidth={1.3} strokeLinecap="round" />
);

const TextTransformIcon: React.FC<P> = (p) => W(p, c =>
  <path d="M4.5 12l2-6h.8l2 6M5.5 10h2.5M11 6h2v6" stroke={c} strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" fill="none" />
);

export const TextDecorationIcon: React.FC<P> = (p) => W(p, c => <>
  <path d="M5.5 4v5.5a2.5 2.5 0 0 0 5 0V4" stroke={c} strokeWidth={1.3} strokeLinecap="round" fill="none" />
  <line x1={4} y1={13} x2={12} y2={13} stroke={c} strokeWidth={1.3} strokeLinecap="round" />
</>);

const TextColorIcon: React.FC<P> = (p) => W(p, c => <>
  <path d="M5.5 11l2.5-7h.5l2.5 7M6.5 9h3.5" stroke={c} strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" fill="none" />
  <rect x={4} y={12} width={8} height={1.5} rx={0.5} fill={c} />
</>);

// Text Stroke — an "A" glyph drawn as an OUTLINE (stroke only, no fill), which is
// exactly what a text stroke produces. Distinct from TextColorIcon (filled A + bar).
export const TextStrokeIcon: React.FC<P> = (p) => W(p, c => <>
  <path d="M4.5 12.5 8 3.5l3.5 9" stroke={c} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" fill="none" />
  <path d="M6 9.5h4" stroke={c} strokeWidth={1.4} strokeLinecap="round" fill="none" />
</>);

// ─── Effects ───────────────────────────────────────────────────────────────

const OpacityIcon: React.FC<P> = (p) => W(p, c => <>
  <circle cx={6.5} cy={8} r={3.5} fill={c} opacity={0.8} />
  <circle cx={9.5} cy={8} r={3.5} fill={c} opacity={0.35} />
</>);

// A solid box casting an offset drop-shadow — crisp at small sizes, clearly "shadow".
export const ShadowIcon: React.FC<P> = (p) => W(p, c => <>
  <rect x={5} y={5} width={8} height={8} rx={2} fill={c} opacity={0.35} />
  <rect x={3} y={3} width={8} height={8} rx={2} fill={c} />
</>);

const TextShadowIcon: React.FC<P> = (p) => W(p, c => <>
  <text x={9} y={11.5} fontSize={10} fontWeight={800} fill={c} opacity={0.3} textAnchor="middle">A</text>
  <text x={8} y={10.5} fontSize={10} fontWeight={800} fill={c} textAnchor="middle">A</text>
</>);

export const FilterIcon: React.FC<P> = (p) => W(p, c => <>
  <circle cx={8} cy={8} r={4.5} stroke={c} strokeWidth={1.3} />
  <path d="M5.5 8h5M8 5.5v5" stroke={c} strokeWidth={1} strokeLinecap="round" opacity={0.5} />
</>);

export const ClipPathIcon: React.FC<P> = (p) => W(p, c => <>
  <rect x={3} y={3} width={10} height={10} rx={1} stroke={c} strokeWidth={1} strokeDasharray="2 1.5" opacity={0.4} />
  <circle cx={8} cy={8} r={3.5} fill={c} />
</>);

export const MaskIcon: React.FC<P> = (p) => W(p, c => <>
  <rect x={3} y={3} width={10} height={10} rx={1.5} fill={c} opacity={0.25} />
  <path d="M3 9L13 3v10L3 9Z" fill={c} />
</>);

const BlendModeIcon: React.FC<P> = (p) => W(p, c => <>
  <circle cx={6.5} cy={7} r={3} fill={c} opacity={0.6} />
  <circle cx={9.5} cy={9} r={3} fill={c} opacity={0.6} />
</>);

// ─── Transform ─────────────────────────────────────────────────────────────

// 3D-cube glyph (user-supplied) — scaled from its native 24×24 viewBox into the 16×16 swatch.
export const TransformIcon: React.FC<P> = (p) => W(p, c =>
  <svg x={2} y={2} width={12} height={12} viewBox="0 0 24 24">
    <path fill={c} d="M21.22 6.894a3.7 3.7 0 0 0-1.4-1.37l-6-3.31a3.83 3.83 0 0 0-3.63 0l-6 3.31a3.7 3.7 0 0 0-1.4 1.37a3.74 3.74 0 0 0-.52 1.9v6.41a3.79 3.79 0 0 0 1.92 3.27l6 3.3a3.74 3.74 0 0 0 3.63 0l6-3.31a3.72 3.72 0 0 0 1.91-3.26v-6.36a3.64 3.64 0 0 0-.51-1.95m-1 8.31a2.2 2.2 0 0 1-1.14 1.95l-6 3.31q-.158.089-.33.14v-8.18l7.3-4.39c.092.242.136.5.13.76z" />
  </svg>
);

const RotateIcon: React.FC<P> = (p) => W(p, c =>
  <path d="M11 4.5a5 5 0 1 0 .8 5.5M11 2.5v3h2.5" stroke={c} strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" fill="none" />
);

const ScaleIcon: React.FC<P> = (p) => W(p, c => <>
  <rect x={6.5} y={6.5} width={6.5} height={6.5} rx={1} stroke={c} strokeWidth={1.3} fill="none" />
  <rect x={3} y={3} width={5} height={5} rx={1} stroke={c} strokeWidth={1} opacity={0.4} fill="none" />
</>);

const SkewIcon: React.FC<P> = (p) => W(p, c =>
  <path d="M5.5 13L8 3h4L9.5 13H5.5Z" stroke={c} strokeWidth={1.3} strokeLinejoin="round" fill={c} fillOpacity={0.2} />
);

const PerspectiveIcon: React.FC<P> = (p) => W(p, c =>
  <path d="M5 4L3 12h10L11 4H5Z" stroke={c} strokeWidth={1.3} strokeLinejoin="round" fill={c} fillOpacity={0.2} />
);

// ─── Overflow & Visibility ─────────────────────────────────────────────────

const OverflowIcon: React.FC<P> = (p) => W(p, c => <>
  <rect x={3.5} y={3.5} width={9} height={9} rx={1.5} stroke={c} strokeWidth={1.3} fill="none" />
  <rect x={7} y={7} width={6} height={6} rx={1} fill={c} opacity={0.5} />
</>);

/** Appear / whileInView (eye) */
export const AppearIcon: React.FC<P> = (p) => W(p, c =>
  <g transform="translate(1.5,2) scale(0.54)" fill={c}>
    <path d="M9.75 12a2.25 2.25 0 1 1 4.5 0a2.25 2.25 0 0 1-4.5 0" />
    <path fillRule="evenodd" d="M2 12c0 1.64.425 2.191 1.275 3.296C4.972 17.5 7.818 20 12 20s7.028-2.5 8.725-4.704C21.575 14.192 22 13.639 22 12c0-1.64-.425-2.191-1.275-3.296C19.028 6.5 16.182 4 12 4S4.972 6.5 3.275 8.704C2.425 9.81 2 10.361 2 12m10-3.75a3.75 3.75 0 1 0 0 7.5a3.75 3.75 0 0 0 0-7.5" clipRule="evenodd" />
  </g>
);

const HideIcon: React.FC<P> = (p) => W(p, c => <>
  <path d="M3 8s2-4 5-4 5 4 5 4-2 4-5 4S3 8 3 8Z" stroke={c} strokeWidth={1.2} fill="none" />
  <circle cx={8} cy={8} r={1.5} fill={c} />
</>);

const ZIndexIcon: React.FC<P> = (p) => W(p, c => <>
  <rect x={3} y={7} width={6} height={6} rx={1} fill={c} opacity={0.3} />
  <rect x={5} y={5} width={6} height={6} rx={1} fill={c} opacity={0.5} />
  <rect x={7} y={3} width={6} height={6} rx={1} fill={c} />
</>);

// ─── Animation ─────────────────────────────────────────────────────────────

export const AnimationIcon: React.FC<P> = (p) => W(p, c =>
  <path d="M3 10c1.5-4 3.5 1 5-2s3 2 5-2" stroke={c} strokeWidth={1.5} strokeLinecap="round" fill="none" />
);

export const TransitionIcon: React.FC<P> = (p) => W(p, c =>
  <path d="M3 12C5 5 8 5 13 5" stroke={c} strokeWidth={1.5} strokeLinecap="round" fill="none" />
);

/** Hover — solar:cursor-bold, clean filled cursor. */
export const HoverIcon: React.FC<P> = (p) => W(p, c =>
  <g transform="translate(1.5,1.5) scale(0.54)" fill={c}>
    <path d="m16.574 19.2l-3.938-3.938l-1.203 1.202c-1.23 1.232-1.846 1.847-2.508 1.702s-.963-.963-1.565-2.596l-2.007-5.45C4.152 6.861 3.55 5.232 4.39 4.392s2.47-.24 5.73.962l5.45 2.006c1.633.602 2.45.903 2.596 1.565s-.47 1.277-1.702 2.508l-1.202 1.203l3.938 3.938c.408.408.612.612.706.84c.125.303.125.643 0 .947c-.094.227-.298.431-.706.839s-.612.612-.84.706a1.24 1.24 0 0 1-.947 0c-.227-.094-.43-.298-.839-.706" />
  </g>
);

export const ScrollIcon: React.FC<P> = (p) => W(p, c => <>
  <rect x={5.5} y={3} width={5} height={10} rx={2.5} stroke={c} strokeWidth={1.3} fill="none" />
  <line x1={8} y1={5.5} x2={8} y2={7} stroke={c} strokeWidth={1.3} strokeLinecap="round" />
</>);

// ─── Pseudo Elements ───────────────────────────────────────────────────────

export const PseudoIcon: React.FC<P> = (p) => W(p, c => <>
  <rect x={3} y={3} width={10} height={10} rx={1.5} stroke={c} strokeWidth={1.2} strokeDasharray="2.5 1.5" fill="none" />
  <rect x={6} y={6} width={4} height={4} rx={0.5} fill={c} />
</>);

// ─── Image & Media ─────────────────────────────────────────────────────────

export const ImageIcon: React.FC<P> = (p) => W(p, c => <>
  <rect x={3} y={4} width={10} height={8} rx={1.5} stroke={c} strokeWidth={1.2} fill="none" />
  <circle cx={6} cy={7} r={1.2} fill={c} opacity={0.6} />
  <path d="M3 10.5l2.5-2.5 1.5 1.5 2.5-3L13 10.5" stroke={c} strokeWidth={1} strokeLinejoin="round" opacity={0.6} fill="none" />
</>);

export const VideoIcon: React.FC<P> = (p) => W(p, c => <>
  <rect x={3} y={4} width={10} height={8} rx={1.5} stroke={c} strokeWidth={1.2} fill="none" />
  <path d="M7 6.5v3l3-1.5L7 6.5Z" fill={c} />
</>);

// ─── SVG ───────────────────────────────────────────────────────────────────

const StrokeIcon: React.FC<P> = (p) => W(p, c =>
  <path d="M4 12L12 4" stroke={c} strokeWidth={2.5} strokeLinecap="round" />
);

// ─── Cursor & Interaction ──────────────────────────────────────────────────

/** Tap / Click — material-symbols:touch-app-rounded, clean touch icon. */
export const TapIcon: React.FC<P> = (p) => W(p, c =>
  <g transform="translate(1.5,1.5) scale(0.54)" fill={c}>
    <path d="M10.475 22q-.7 0-1.312-.3t-1.038-.85L3.1 14.475q-.2-.225-.175-.537t.225-.513q.5-.525 1.2-.625t1.3.275L7.5 14.2V6q0-.425.288-.712T8.5 5t.725.288t.3.712v5H17q1.25 0 2.125.875T20 14v4q0 1.65-1.175 2.825T16 22zm1.5-13q-.425 0-.712-.288T10.975 8q0-.05.125-.5q.2-.35.3-.712T11.5 6q0-1.25-.875-2.125T8.5 3t-2.125.875T5.5 6q0 .425.1.788t.3.712q.075.125.1.25t.025.25q0 .425-.275.713T5.05 9q-.275 0-.512-.15t-.363-.375q-.325-.55-.5-1.175T3.5 6q0-2.075 1.463-3.537T8.5 1t3.538 1.463T13.5 6q0 .675-.175 1.3t-.5 1.175q-.125.225-.35.375t-.5.15" />
  </g>
);

/** Loop / Restart — solar:restart-bold. Used for animation Loop and GSAP
 *  Animate rows. Distinct from `RotateIcon` (which is the generic CSS
 *  rotation property icon and stays simpler). */
export const LoopIcon: React.FC<P> = (p) => W(p, c =>
  <g transform="translate(1.5,1.5) scale(0.54)" fill={c}>
    <path d="M18.258 3.508a.75.75 0 0 1 .463.693v4.243a.75.75 0 0 1-.75.75h-4.243a.75.75 0 0 1-.53-1.28L14.8 6.31a7.25 7.25 0 1 0 4.393 5.783a.75.75 0 0 1 1.488-.187A8.75 8.75 0 1 1 15.93 5.18l1.51-1.51a.75.75 0 0 1 .817-.162" />
  </g>
);

/** Cursor pointer */
export const CursorIcon: React.FC<P> = (p) => W(p, c =>
  <path d="M5.5 3l1.5 10 2-3.5 3.5-1L5.5 3Z" fill={c} />
);

const PointerEventsIcon: React.FC<P> = (p) => W(p, c => <>
  <path d="M5.5 3l1.5 10 2-3.5 3.5-1L5.5 3Z" fill={c} opacity={0.4} />
  <line x1={4} y1={4} x2={12} y2={12} stroke={c} strokeWidth={1.5} strokeLinecap="round" />
</>);

// ─── Grid ──────────────────────────────────────────────────────────────────

const GridIcon: React.FC<P> = (p) => W(p, c => <>
  <rect x={3} y={3} width={10} height={10} rx={1} stroke={c} strokeWidth={1.2} fill="none" />
  <line x1={3} y1={7.5} x2={13} y2={7.5} stroke={c} strokeWidth={1} />
  <line x1={7.5} y1={3} x2={7.5} y2={13} stroke={c} strokeWidth={1} />
</>);

// ─── Content ───────────────────────────────────────────────────────────────

const ContentIcon: React.FC<P> = (p) => W(p, c =>
  <path d="M5 5h6M5 8h7M5 11h4" stroke={c} strokeWidth={1.3} strokeLinecap="round" />
);

// ─── Inset ─────────────────────────────────────────────────────────────────

const InsetIcon: React.FC<P> = (p) => W(p, c => <>
  <rect x={3} y={3} width={10} height={10} rx={1} stroke={c} strokeWidth={1} opacity={0.4} fill="none" />
  <path d="M8 4.5v2M11.5 8h-2M8 11.5v-2M4.5 8h2" stroke={c} strokeWidth={1.3} strokeLinecap="round" />
</>);

// ─── Lookup Map ────────────────────────────────────────────────────────────

const PROPERTY_ICON_MAP: Record<string, React.FC<P>> = {
  color: ColorIcon,
  backgroundColor: FillIcon,
  backgroundImage: GradientIcon,
  background: FillIcon,
  fill: ColorIcon,

  padding: PaddingIcon, paddingTop: PaddingIcon, paddingRight: PaddingIcon, paddingBottom: PaddingIcon, paddingLeft: PaddingIcon,
  margin: MarginIcon, marginTop: MarginIcon, marginRight: MarginIcon, marginBottom: MarginIcon, marginLeft: MarginIcon,
  gap: GapIcon, rowGap: GapIcon, columnGap: GapIcon,

  border: BorderIcon, borderWidth: BorderIcon, borderStyle: BorderIcon, borderColor: BorderIcon,
  borderRadius: RadiusIcon, borderTopLeftRadius: RadiusIcon, borderTopRightRadius: RadiusIcon, borderBottomRightRadius: RadiusIcon, borderBottomLeftRadius: RadiusIcon,

  display: DisplayIcon, flexDirection: FlexDirectionIcon, alignItems: AlignIcon, justifyContent: JustifyIcon, alignSelf: AlignIcon, flexWrap: WrapIcon,
  gridTemplateColumns: GridIcon, gridTemplateRows: GridIcon,

  position: PositionIcon, left: PositionIcon, top: PositionIcon, right: PositionIcon, bottom: PositionIcon, inset: InsetIcon,
  width: WidthIcon, height: HeightIcon, minWidth: WidthIcon, maxWidth: WidthIcon, minHeight: HeightIcon, maxHeight: HeightIcon,

  fontSize: FontSizeIcon, fontFamily: FontFamilyIcon, fontWeight: FontWeightIcon, lineHeight: LineHeightIcon, letterSpacing: LetterSpacingIcon,
  textAlign: TextAlignIcon, textTransform: TextTransformIcon, textDecoration: TextDecorationIcon, textDecorationLine: TextDecorationIcon,
  textDecorationStyle: TextDecorationIcon, textDecorationColor: TextColorIcon, whiteSpace: ContentIcon, writingMode: ContentIcon,

  opacity: OpacityIcon, boxShadow: ShadowIcon, textShadow: TextShadowIcon, filter: FilterIcon,
  clipPath: ClipPathIcon, maskImage: MaskIcon, mask: MaskIcon, mixBlendMode: BlendModeIcon,
  visibility: HideIcon, zIndex: ZIndexIcon, overflow: OverflowIcon, overflowX: OverflowIcon, overflowY: OverflowIcon,

  transform: TransformIcon, rotate: RotateIcon, rotateX: RotateIcon, rotateY: RotateIcon,
  scale: ScaleIcon, scaleX: ScaleIcon, scaleY: ScaleIcon, skew: SkewIcon, skewX: SkewIcon, skewY: SkewIcon,
  x: TransformIcon, y: TransformIcon, perspective: PerspectiveIcon, transformStyle: PerspectiveIcon,

  animation: AnimationIcon, transition: TransitionIcon,
  '::before': PseudoIcon, '::after': PseudoIcon,
  objectFit: ImageIcon, objectPosition: ImageIcon, src: ImageIcon, alt: ImageIcon, poster: VideoIcon,
  stroke: StrokeIcon, 'stroke-width': StrokeIcon, 'fill-opacity': OpacityIcon, 'stroke-opacity': OpacityIcon,
  cursor: CursorIcon, pointerEvents: PointerEventsIcon, content: ContentIcon,
  flex: DisplayIcon, flexGrow: DisplayIcon, flexShrink: DisplayIcon, flexBasis: WidthIcon, order: ZIndexIcon,
  WebkitTextStroke: StrokeIcon,
};

export function getPropertyIcon(property: string): React.FC<P> {
  return PROPERTY_ICON_MAP[property] || ContentIcon;
}
