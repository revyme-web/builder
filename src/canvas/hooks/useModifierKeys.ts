// useModifierKeys.ts — Shared Alt/Ctrl(Meta) key tracking (9.4c).
//
// Consolidates the byte-identical keydown/keyup/blur listener effect that
// DimensionsIndicators and DistanceIndicators each hand-rolled. `ctrl` is
// true for Control OR Meta (⌘ on macOS); blur clears both so a modifier held
// while the window loses focus doesn't stick.

import { useEffect, useState } from 'react';

export function useModifierKeys(): { alt: boolean; ctrl: boolean } {
  const [alt, setAlt] = useState(false);
  const [ctrl, setCtrl] = useState(false);

  useEffect(() => {
    const d = (e: KeyboardEvent) => { if (e.key === 'Alt') setAlt(true); if (e.key === 'Control' || e.key === 'Meta') setCtrl(true); };
    const u = (e: KeyboardEvent) => { if (e.key === 'Alt') setAlt(false); if (e.key === 'Control' || e.key === 'Meta') setCtrl(false); };
    const b = () => { setAlt(false); setCtrl(false); };
    window.addEventListener('keydown', d); window.addEventListener('keyup', u); window.addEventListener('blur', b);
    return () => { window.removeEventListener('keydown', d); window.removeEventListener('keyup', u); window.removeEventListener('blur', b); };
  }, []);

  return { alt, ctrl };
}
