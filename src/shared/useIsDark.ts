// useIsDark.ts — Reactive read of the app's dark-mode state.
//
// The editor theme is a `.dark` class on <html> (toggled by the
// BottomToolbar theme switcher). CSS variables follow it automatically,
// but some APIs need the theme as a plain value — e.g. Monaco's `theme`
// prop, which can't read a CSS var. This hook gives that value and
// re-renders when the class flips.

import { useSyncExternalStore } from 'react';

function subscribe(callback: () => void): () => void {
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class'],
  });
  return () => observer.disconnect();
}

function getSnapshot(): boolean {
  return document.documentElement.classList.contains('dark');
}

/** True when the editor is in dark mode (`.dark` on <html>). Reactive. */
export function useIsDark(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => true);
}
