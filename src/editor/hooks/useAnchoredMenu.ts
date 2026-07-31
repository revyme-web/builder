// useAnchoredMenu.ts — open/flip/fade state for trigger-anchored dropdowns.
//
// The canonical properties-panel dropdown pattern (InteractionsTool's add
// menu, AnimationTool's AddEffectDropdown): the menu mounts at opacity 0,
// measures the trigger to decide whether it fits BELOW (else flips ABOVE),
// then fades in on the next frame so the flip never shows as a position
// jump. While open, a document mousedown outside the container closes it.
//
// `menuHeight` is the hand-tuned per-menu estimate each call site already
// used — it is deliberately a required option (do NOT normalize these).

import { useEffect, useRef, useState, type RefObject } from 'react';

export interface AnchoredMenuOptions {
  /** Estimated menu height in px — flips the menu above the trigger when
   *  the space below is smaller than this. Hand-tuned per menu. */
  menuHeight: number;
  /** Initial flip direction before the first measurement (default 'down'). */
  defaultDir?: 'up' | 'down';
  /** Anchor element to measure. When omitted, attach the returned `btnRef`
   *  to the trigger button. */
  anchorRef?: RefObject<HTMLElement | null>;
}

export interface AnchoredMenu {
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  /** Which side of the trigger the menu should render on. */
  openDir: 'up' | 'down';
  /** False until the post-measure fade-in frame — drive `opacity` off this. */
  visible: boolean;
  /** Attach to the menu's positioned container (outside-click boundary). */
  ref: RefObject<HTMLDivElement | null>;
  /** Attach to the trigger button when no `anchorRef` option is given. */
  btnRef: RefObject<HTMLButtonElement | null>;
}

export function useAnchoredMenu(options: AnchoredMenuOptions): AnchoredMenu {
  const { menuHeight, defaultDir = 'down', anchorRef } = options;
  const [open, setOpen] = useState(false);
  const [openDir, setOpenDir] = useState<'up' | 'down'>(defaultDir);
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) { setVisible(false); return; }
    const btn = (anchorRef ?? btnRef).current;
    if (btn) setOpenDir(window.innerHeight - btn.getBoundingClientRect().bottom >= menuHeight ? 'down' : 'up');
    requestAnimationFrame(() => setVisible(true));
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
     
  }, [open, menuHeight, anchorRef]);

  return { open, setOpen, openDir, visible, ref, btnRef };
}
