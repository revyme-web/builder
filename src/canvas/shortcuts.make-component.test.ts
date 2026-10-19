import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDefaultStore } from 'jotai';
import type { CanvasNode } from '@/code/parsing/parser';
import { keyboard } from './KeyboardManager';
import { registerShortcuts } from './shortcuts';
import { makeComponentRequestAtom } from '@/code/stores/context-menu-store';

// The context menu has advertised "Make Component · Ctrl+Alt+K" for a long time,
// but nothing registered the key, so pressing it did nothing (user report
// 2026-10-19). The shortcut asks ContextMenu for its name modal through
// makeComponentRequestAtom, behind the menu item's gates.
describe('Ctrl+Alt+K — Make Component shortcut', () => {
  const store = getDefaultStore();
  let stop: () => void;
  let unregister: () => void;

  const node = (id: string, extra: Partial<CanvasNode> = {}) =>
    ({ id, type: 'div', name: id, parentId: 'root', children: [], styles: {}, textContent: null, ...extra } as unknown as CanvasNode);

  const setup = (selected: string[], nodes: CanvasNode[]) => {
    unregister = registerShortcuts({
      selectedIdRef: { current: selected[0] ?? null },
      selectedIdsRef: { current: selected },
      nodesRef: { current: new Map(nodes.map((n) => [n.id, n])) },
      contentRef: { current: null },
      editingNodeIdRef: { current: null },
      toolModeRef: { current: 'select' },
      setToolMode: () => {},
      setSelectedIds: () => {},
      commitTextEdit: () => {},
      handleNodeMouseDown: () => {},
    });
  };

  // macOS: Option composes K into "˚"; the manager matches the physical key.
  const pressCtrlAltK = (mod: 'ctrlKey' | 'metaKey' = 'ctrlKey') =>
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: '˚', code: 'KeyK', altKey: true, [mod]: true, bubbles: true, cancelable: true,
    }));

  beforeEach(() => {
    store.set(makeComponentRequestAtom, null);
    stop = keyboard.listen();
  });
  afterEach(() => { unregister?.(); stop(); });

  it('requests the Make Component modal for the selected frame', () => {
    setup(['frame'], [node('frame')]);
    pressCtrlAltK();
    expect(store.get(makeComponentRequestAtom)).toBe('frame');
  });

  it('Cmd+Alt+K works the same', () => {
    setup(['frame'], [node('frame')]);
    pressCtrlAltK('metaKey');
    expect(store.get(makeComponentRequestAtom)).toBe('frame');
  });

  it('does nothing on a multi-selection (the menu hides the item too)', () => {
    setup(['a', 'b'], [node('a'), node('b')]);
    pressCtrlAltK();
    expect(store.get(makeComponentRequestAtom)).toBeNull();
  });

  it('does nothing on a component instance or an svg', () => {
    setup(['inst'], [node('inst', { componentFile: 'components/Card.tsx' } as Partial<CanvasNode>)]);
    pressCtrlAltK();
    expect(store.get(makeComponentRequestAtom)).toBeNull();
    unregister();

    setup(['icon'], [node('icon', { type: 'svg' } as Partial<CanvasNode>)]);
    pressCtrlAltK();
    expect(store.get(makeComponentRequestAtom)).toBeNull();
  });

  it('plain K is still the Sketch tool, not Make Component', () => {
    setup(['frame'], [node('frame')]);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', bubbles: true, cancelable: true }));
    expect(store.get(makeComponentRequestAtom)).toBeNull();
  });
});
