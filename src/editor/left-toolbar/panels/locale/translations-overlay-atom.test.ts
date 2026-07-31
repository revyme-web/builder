// The Localization overlay may only exist while the globe (locale) panel is
// active (CMS-panel parity). The overlay atom's write-through selects the
// panel on open so openers from elsewhere (LocalePropPill, LocaleStylePopup)
// don't get instantly dismissed by App's close-on-panel-switch effect.
import { describe, it, expect } from 'vitest';
import { createStore } from 'jotai';
import { translationsOverlayOpenAtom } from '../LocalePanel';
import { leftPanelAtom } from '@/code/stores/left-panel-store';

describe('translationsOverlayOpenAtom write-through', () => {
  it('opening selects the locale panel', () => {
    const store = createStore();
    store.set(leftPanelAtom, 'pages-layers');
    store.set(translationsOverlayOpenAtom, true);
    expect(store.get(translationsOverlayOpenAtom)).toBe(true);
    expect(store.get(leftPanelAtom)).toBe('locale');
  });

  it('closing leaves the panel selection alone', () => {
    const store = createStore();
    store.set(translationsOverlayOpenAtom, true);
    store.set(leftPanelAtom, 'cms');
    store.set(translationsOverlayOpenAtom, false);
    expect(store.get(translationsOverlayOpenAtom)).toBe(false);
    expect(store.get(leftPanelAtom)).toBe('cms');
  });
});
