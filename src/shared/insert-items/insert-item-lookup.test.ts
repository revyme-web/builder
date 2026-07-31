// Tests for the insert-item lookup. The ghost overlay (ToolbarGhost) and
// any future code that wants "the card preview for this drag id" relies
// on this helper — pin a few representative ids so a refactor of
// element-data.ts surfaces here.

import { describe, test, expect } from 'vitest';
import { getInsertItem } from '@/shared/insert-items/insert-item-lookup';

describe('getInsertItem', () => {
  test('returns the item for a basic Element', () => {
    const frame = getInsertItem('frame');
    expect(frame).not.toBeNull();
    expect(frame!.iconKey).toBe('frame');
    expect(frame!.name).toBe('Frame');
  });

  test('returns the item for a brand integration with socialNetwork', () => {
    // Pinned because the ghost branches on `socialNetwork` to switch
    // from ELEMENT_ICON_MAP to react-social-icons. Renaming the field
    // would silently fall back to the wrong icon.
    const gmaps = getInsertItem('google-maps');
    expect(gmaps).not.toBeNull();
    expect(gmaps!.socialNetwork).toBe('google');
    expect(gmaps!.iconKey).toBe('googleMaps');
  });

  test('resolves items from CREATIVE_CATEGORIES (effects / cursors / etc.)', () => {
    // Pinned: the ghost overlay uses this resolver to decide whether to
    // render a full preview tile (`isPreviewIcon(iconKey)`) or fall back
    // to the 56×56 icon. Creative items are in their OWN top-level group
    // (CREATIVE_CATEGORIES), not CATEGORIES — without merging both lists
    // the lookup returns null and the drag ghost is empty.
    const marquee = getInsertItem('cs-marquee');
    expect(marquee).not.toBeNull();
    expect(marquee!.iconKey).toBe('effectMarquee');

    const blob = getInsertItem('cs-blobCursor');
    expect(blob).not.toBeNull();
    expect(blob!.iconKey).toBe('effectBlobCursor');

    const typing = getInsertItem('cs-typingText');
    expect(typing).not.toBeNull();
    expect(typing!.iconKey).toBe('creativeTypingText');
  });

  test('returns null for ids not in CATEGORIES', () => {
    expect(getInsertItem('cms:team')).toBeNull();
    expect(getInsertItem('component:Hero')).toBeNull();
    expect(getInsertItem('icon-mdi:home-12345')).toBeNull();
    expect(getInsertItem('totally-fake-item-id')).toBeNull();
  });

  test('cache returns the same instance across calls', () => {
    // Verifies the lookup is memoized (no rebuild per call). Cheap to
    // assert and protects against an accidental `build()`-per-call regression
    // that would walk every category × section × item on each ghost frame.
    const a = getInsertItem('frame');
    const b = getInsertItem('frame');
    expect(a).toBe(b);
  });
});
