// AddEffectDropdown.tsx — Animation type dropdown.
// Flat list of options — clicking a row queues the add mutation + opens
// that effect's popup.

import { useState, useRef, useEffect, useCallback } from 'react';
import { useAnchoredMenu } from '../../hooks/useAnchoredMenu';
import { createPortal } from 'react-dom';
import { useAtomValue } from 'jotai';
import { keyframeNamesAtom } from '@/code/stores/animation-store';
import { type AnimEntryType } from './shared';

/** Add-action keys. Superset of AnimEntryType with UI-only markers:
 *  'scrollAnimation' (the On-Scroll trigger of the `appear` effect — shares
 *  the `appear` entry so it's mutually exclusive with Appear), 'scrollVariant'
 *  (placeholder, disabled), and 'scrollGroup' (the Scroll submenu header). */
export type AddActionType = AnimEntryType | 'scrollAnimation' | 'scrollVariant' | 'scrollGroup' | 'pageTransition';

interface AddOption {
  type: AddActionType;
  label: string;
  desc: string;
  /** Picker filter: hide this option when ANY of these types already exists.
   *  Defaults to [type]. Multi-engine outcomes list every engine variant
   *  so the unified picker entry knows it's been added regardless of which
   *  engine landed in the code. */
  engines?: AnimEntryType[];
  /** Only show this row when editing a text node (Text Effect / Split /
   *  Scramble / Replace). */
  textOnly?: boolean;
  /** Render disabled (greyed, non-clickable) — e.g. a not-yet-built effect. */
  disabled?: boolean;
  /** When set, this row is a flyout group; clicking opens the children. */
  submenu?: AddOption[];
}

// standard "Scroll" submenu: the scroll-linked effects grouped together.
// Scroll Animation shares the `appear` engine with the top-level Appear option,
// so adding either one hides BOTH (you get the one effect with whichever
// trigger). Scroll Speed / Transform are independent and stack.
const SCROLL_SUBMENU: AddOption[] = [
  { type: 'scrollAnimation', label: 'Scroll Animation', desc: 'In-view / scroll-triggered animation — plays a transition when triggered.',
    engines: ['appear'] },
  { type: 'scrollSpeed', label: 'Scroll Speed', desc: 'Parallax — scroll faster or slower than the page.',
    engines: ['scrollSpeed'] },
  { type: 'scrollTransform', label: 'Scroll Transform', desc: 'Scrub a property From→To as you scroll. Add sections for multi-step.',
    engines: ['scrollTransform'] },
  { type: 'scrollVariant', label: 'Scroll Variant', desc: 'Switch the component’s variant as you scroll. Add sections for multi-step.', disabled: true },
];

// Effects hidden from the Add picker. CSS @keyframes DOESN'T compose with the
// framer-motion motion-value system — stacking them on the same element fights
// over transform/opacity. Its parser + generator stay intact (existing saved
// projects still render); to re-enable it in the picker, just remove its type
// from this set.
const HIDDEN_ADD_TYPES = new Set<AddActionType>(['keyframe']);

// Labels are intentionally short — the picker is a quick selector, not a
// reference. `desc` is preserved on every option and shown as the row's
// native tooltip (`title` attribute) so users who hover get the longer
// explanation without us renting any visual space for it.
const ADD_OPTIONS: AddOption[] = [
  // Interaction
  // Hover/Tap are Motion-only. For "hover one element → several react", make it
  // a component and use a mouseEnter variant connection (conflict-free with layout).
  { type: 'hover', label: 'Hover', desc: 'Animate this element on mouse over.' },
  { type: 'tap', label: 'Tap', desc: 'Animate this element on click/tap.' },
  // Appear (On Appear trigger) — animate in once on enter. Mutually exclusive
  // with Scroll Animation (both are the `appear` effect; adding either hides
  // the other from the menu).
  { type: 'appear', label: 'Appear', desc: 'Animate in once when it enters the viewport.',
    engines: ['appear'] },
  // Scroll ▸ submenu (the reference): Scroll Animation / Speed / Transform / Variant.
  { type: 'scrollGroup', label: 'Scroll', desc: 'Scroll-linked effects.', submenu: SCROLL_SUBMENU },
  { type: 'loop', label: 'Loop', desc: 'Repeats forever. Yoyo + repeat delay supported.' },
  // Glide — add on a container; its children glide smoothly when one resizes
  // (e.g. an FAQ accordion pushing siblings down) instead of jumping.
  { type: 'glide', label: 'Glide', desc: 'Smoothly animate children when one resizes — e.g. accordions pushing content.' },
  // Page Transition — page-level enter/exit via the View Transitions API. Only
  // offered on a page viewport/root (glideOnly), alongside Glide.
  { type: 'pageTransition', label: 'Page Transition', desc: 'Animate the page in/out on navigation (View Transitions).' },
  { type: 'keyframe', label: 'Keyframe', desc: '@keyframes block. No JS. Visual scrubber.' },
  // Text
  { type: 'textEffect', label: 'Text', desc: 'Character/word/line stagger via Motion.', textOnly: true },
];

/** Keyframe sub-menu — portaled flyout to the left of the button.
 *  Lets the user either create a new keyframe (opens NameInputModal) or
 *  apply an existing one from the project. */
function KeyframeSubMenu({ label, desc, existingKeyframes, onCreateNew, onApply }: {
  label: string; desc: string; existingKeyframes: string[];
  onCreateNew: () => void; onApply: (name: string) => void;
}) {
  const [showSub, setShowSub] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const portalRef = useRef<HTMLDivElement>(null);
  const [subPos, setSubPos] = useState({ x: 0, y: 0 });

  const updatePos = useCallback(() => {
    if (!btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    setSubPos({ x: rect.left - 8, y: rect.top });
  }, []);

  useEffect(() => {
    if (showSub) updatePos();
  }, [showSub, updatePos]);

  // Stop native mousedown from reaching the document listener that closes the main dropdown
  useEffect(() => {
    const el = portalRef.current;
    if (!el) return;
    const stop = (e: MouseEvent) => e.stopPropagation();
    el.addEventListener('mousedown', stop, true);
    return () => el.removeEventListener('mousedown', stop, true);
  });

  return (
    <div onMouseEnter={() => setShowSub(true)} onMouseLeave={() => setShowSub(false)}>
      <button ref={btnRef} type="button" title={desc}
        className="group flex items-center justify-between mx-1.5 px-2.5 py-1.5 rounded w-[calc(100%-12px)] text-left cursor-pointer bg-transparent hover:!bg-[var(--accent)] border-none whitespace-nowrap"
        onClick={() => setShowSub(!showSub)}>
        <span className="text-xs font-medium text-[var(--text-primary)] group-hover:text-white">{label}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          className="text-[var(--text-secondary)] group-hover:text-white shrink-0 ml-2">
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
      {showSub && createPortal(
        <div
          ref={portalRef}
          style={{ position: 'fixed', left: subPos.x, top: subPos.y, transform: 'translateX(-100%)', zIndex: 9999 }}
          onMouseEnter={() => setShowSub(true)}
          onMouseLeave={() => setShowSub(false)}
        >
          {/* Invisible bridge to cover the gap between button and flyout */}
          <div style={{ position: 'absolute', top: 0, right: -12, width: 16, height: '100%' }} />
          <div className="min-w-max bg-[var(--dropdown-bg)] border border-[var(--border-light)] rounded-[var(--radius-md)] shadow-2xl py-1">
            <button type="button"
              className="group flex items-center gap-2 w-full px-3 py-1.5 text-left cursor-pointer bg-transparent hover:!bg-[var(--accent)] border-none"
              onClick={onCreateNew}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-[var(--text-secondary)] group-hover:text-white shrink-0">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              <span className="text-[12px] font-medium text-[var(--text-primary)] group-hover:text-white">Create New</span>
            </button>
            {existingKeyframes.length > 0 && (
              <>
                <div className="h-px mx-2 my-1" style={{ backgroundColor: 'rgba(255,255,255,0.12)' }} />
                <div className="px-2 py-1">
                  <span className="text-[10px] font-semibold text-[var(--text-disabled)] uppercase">Existing</span>
                </div>
                {existingKeyframes.map(name => (
                  <button key={name} type="button"
                    className="group flex items-center gap-2 w-full px-3 py-1.5 text-left cursor-pointer bg-transparent hover:!bg-[var(--accent)] border-none"
                    onClick={() => onApply(name)}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-[var(--text-secondary)] group-hover:text-white shrink-0">
                      <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
                    </svg>
                    <span className="text-[12px] text-[var(--text-primary)] group-hover:text-white truncate">{name}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

/** Generic flyout submenu (e.g. the "Scroll" group). Renders child options to
 *  the left of the row; disabled children render greyed and non-clickable. */
function EffectSubMenu({ label, desc, children, onSelect }: {
  label: string; desc: string;
  children: { type: AddActionType; label: string; desc: string; disabled?: boolean }[];
  onSelect: (t: AddActionType) => void;
}) {
  const [showSub, setShowSub] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const portalRef = useRef<HTMLDivElement>(null);
  const [subPos, setSubPos] = useState({ x: 0, y: 0 });

  const updatePos = useCallback(() => {
    if (!btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    setSubPos({ x: rect.left - 8, y: rect.top });
  }, []);
  useEffect(() => { if (showSub) updatePos(); }, [showSub, updatePos]);
  useEffect(() => {
    const el = portalRef.current;
    if (!el) return;
    const stop = (e: MouseEvent) => e.stopPropagation();
    el.addEventListener('mousedown', stop, true);
    return () => el.removeEventListener('mousedown', stop, true);
  });

  return (
    <div onMouseEnter={() => setShowSub(true)} onMouseLeave={() => setShowSub(false)}>
      <button ref={btnRef} type="button" title={desc}
        className="group flex items-center justify-between mx-1.5 px-2.5 py-1.5 rounded w-[calc(100%-12px)] text-left cursor-pointer bg-transparent hover:!bg-[var(--accent)] border-none whitespace-nowrap"
        onClick={() => setShowSub(!showSub)}>
        <span className="text-xs font-medium text-[var(--text-primary)] group-hover:text-white">{label}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          className="text-[var(--text-secondary)] group-hover:text-white shrink-0 ml-2">
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
      {showSub && createPortal(
        <div ref={portalRef}
          style={{ position: 'fixed', left: subPos.x, top: subPos.y, transform: 'translateX(-100%)', zIndex: 9999 }}
          onMouseEnter={() => setShowSub(true)} onMouseLeave={() => setShowSub(false)}>
          <div style={{ position: 'absolute', top: 0, right: -12, width: 16, height: '100%' }} />
          <div className="min-w-max bg-[var(--dropdown-bg)] border border-[var(--border-light)] rounded-[var(--radius-md)] shadow-2xl py-1">
            {children.map(c => c.disabled ? (
              <div key={c.type} title={c.desc}
                className="mx-1 px-3 py-1.5 whitespace-nowrap">
                <span className="text-[12px] font-medium text-[var(--text-primary)] opacity-40">{c.label}</span>
              </div>
            ) : (
              <button key={c.type} type="button" title={c.desc}
                className="group flex items-center w-full px-3 py-1.5 text-left cursor-pointer bg-transparent hover:!bg-[var(--accent)] border-none whitespace-nowrap"
                onClick={() => onSelect(c.type)}>
                <span className="text-[12px] font-medium text-[var(--text-primary)] group-hover:text-white">{c.label}</span>
              </button>
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

export default function AddEffectDropdown({ onAdd, existing, isTextNode, isSketchNode, isComponentInstance, appearOnly, glideOnly, onApplyKeyframe }: {
  onAdd: (t: AddActionType) => void;
  existing: Set<AnimEntryType>;
  isTextNode?: boolean;
  /** Restrict the picker to ONLY the Glide effect — used on the viewport/root,
   *  where Glide ("Flow") is the one meaningful animation (the reference puts Flow on
   *  the page). Every other effect is hidden from the menu there. */
  glideOnly?: boolean;
  /** Scroll Variant switches a component's variant — only meaningful on a
   *  design-component instance, so the submenu item is gated on this. */
  isComponentInstance?: boolean;
  /** When true, the `+` button skips the type picker and immediately
   *  creates a `sketchDraw` animation. Sketch wrappers only support
   *  one animation type (the path-draw replay) so a dropdown is just
   *  noise. The button still renders identically — only the click
   *  behaviour changes. */
  isSketchNode?: boolean;
  /** Overlay nodes: only Appear makes sense (the panel mounts/unmounts with
   *  its trigger — hover/tap/scroll/loop on the floating panel itself fight
   *  the open/close animation). Everything else renders greyed. */
  appearOnly?: boolean;
  onApplyKeyframe?: (name: string) => void;
}) {
  // Estimated dropdown height 380 — flips above the trigger when it can't fit
  // below; menu mounts invisible, then fades in after the flip is applied.
  const { open, setOpen, openDir, visible, ref, btnRef } = useAnchoredMenu({ menuHeight: 380, defaultDir: 'up' });
  const existingKeyframes = useAtomValue(keyframeNamesAtom);

  // Conflicting pairs: if one exists, disable the other with a reason.
  // Hover and Tap are no longer here — both are unified picker entries
  // and their engine choice is handled inside their popups.
  // (Text Effect ↔ Text Split was the only pair; Text Split was removed.)
  const CONFLICT_LABELS: Record<string, { conflicts: AnimEntryType[]; reason: string }> = {};

  /** Check if an option is disabled due to conflict */
  const getConflictReason = useCallback((type: AddActionType): string | null => {
    const conflict = CONFLICT_LABELS[type as string];
    if (conflict?.conflicts.some(c => existing.has(c))) return conflict.reason;
    return null;
  }, [existing]);

  // Is a single option addable right now? (placeholders always show greyed.)
  const childVisible = useCallback((o: AddOption): boolean => {
    if (o.textOnly && !isTextNode) return false;
    if (o.disabled) return true;
    const variants = o.engines || [o.type as AnimEntryType];
    return !variants.some(v => existing.has(v));
  }, [existing, isTextNode]);

  // The ACTUAL children a submenu would render right now — instance-aware (Scroll
  // Variant is only a real option on a component instance) and filtered by what's
  // already present. Used for BOTH the group's visibility and its rendered list, so
  // the group can't show while opening to an empty flyout (the bug: the raw
  // `scrollVariant` placeholder is `disabled: true`, which `childVisible` treats as
  // always-visible, keeping the Scroll group up even with no addable children).
  const submenuKids = useCallback((o: AddOption) => (o.submenu || [])
    .map(c => c.type === 'scrollVariant' ? { ...c, disabled: !isComponentInstance } : c)
    .filter(c => c.disabled || childVisible(c)), [childVisible, isComponentInstance]);

  // Hide HIDDEN_ADD_TYPES + options already on the node + text options when not a text
  // node. A submenu group stays visible only while it has at least one addable child.
  const visibleOptions = ADD_OPTIONS.filter(o =>
    !HIDDEN_ADD_TYPES.has(o.type) &&
    (!glideOnly || o.type === 'glide' || o.type === 'pageTransition') &&
    // Page Transition is a PAGE-LEVEL effect — only when a viewport/root is the
    // selection (glideOnly), never on a normal element node.
    (o.type === 'pageTransition' ? !!glideOnly : o.submenu ? submenuKids(o).length > 0 : childVisible(o)));

  return (
    <div className="relative" ref={ref}>
      <button
        ref={btnRef}
        onClick={() => {
          // Sketch wrappers: only one animation type makes sense
          // (the perfect-freehand draw-on replay), so the type picker
          // would just be a single-option list. Skip it and create
          // directly. The user can still edit the resulting config
          // through the entry's editor popup.
          if (isSketchNode) {
            onAdd('sketchDraw');
            return;
          }
          setOpen(!open);
        }}
        className="flex items-center justify-end pl-[80px] -ml-[80px] cursor-pointer group text-[var(--text-primary)]"
        title="Add animation effect"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="transition-opacity group-hover:opacity-80">
          <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>

      {open && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-50" onClick={() => setOpen(false)} />

          {/* Dropdown — flat list, sized to fit the longest label rather
              than a fixed min-width. `w-max` collapses the box to the
              widest child (`whitespace-nowrap` on each row keeps them
              from wrapping and disturbing the intrinsic measurement). */}
          <div className={`absolute right-[10px] bg-[var(--dropdown-bg)] shadow-md rounded-[var(--radius-md)] py-1.5 z-[51] w-max max-h-[420px] overflow-y-auto border border-[var(--border-light)] space-y-0.5 transition-opacity duration-150 ${
            openDir === 'up' ? 'bottom-full mb-1' : 'top-full mt-1'
          }`} style={{ opacity: visible ? 1 : 0, scrollbarWidth: 'none' }}>
            {visibleOptions.length === 0 ? (
              <div className="px-3 py-2 text-xs text-[var(--text-secondary)]">
                All animation types added
              </div>
            ) : (
              visibleOptions.map(o => {
                const conflictReason = getConflictReason(o.type);
                const lockedToAppear = !!appearOnly && o.type !== 'appear';
                const disabled = !!conflictReason || lockedToAppear;
                if (disabled) {
                  return (
                    <div key={o.type} className="mx-1.5 px-2.5 py-1.5 rounded w-[calc(100%-12px)] whitespace-nowrap"
                      title={lockedToAppear ? 'Overlays only support Appear' : `Disable ${conflictReason?.replace(' active', '')} to use`}>
                      <span className="text-xs font-medium text-[var(--text-primary)] opacity-40">{o.label}</span>
                    </div>
                  );
                }
                if (o.submenu) {
                  // Flyout group (Scroll): the addable children + any greyed
                  // placeholders, computed by the shared submenuKids helper (same set
                  // that gates the group's visibility above).
                  const kids = submenuKids(o)
                    .map(c => ({ type: c.type, label: c.label, desc: c.desc, disabled: c.disabled }));
                  return (
                    <EffectSubMenu key={o.type} label={o.label} desc={o.desc} children={kids}
                      onSelect={(t) => { onAdd(t); setOpen(false); }} />
                  );
                }
                if (o.type === 'keyframe') {
                  return (
                    <KeyframeSubMenu key={o.type} label={o.label} desc={o.desc}
                      existingKeyframes={existingKeyframes}
                      onCreateNew={() => { onAdd('keyframe'); setOpen(false); }}
                      onApply={(name) => { onApplyKeyframe?.(name); setOpen(false); }} />
                  );
                }
                return (
                  <button key={o.type} type="button"
                    title={o.desc}
                    className="group flex items-center mx-1.5 px-2.5 py-1.5 rounded w-[calc(100%-12px)] text-left cursor-pointer bg-transparent hover:!bg-[var(--accent)] border-none whitespace-nowrap"
                    onClick={() => { onAdd(o.type); setOpen(false); }}>
                    <span className="text-xs font-medium text-[var(--text-primary)] group-hover:text-white">
                      {o.label}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
}
