// CanvasTextEditController.test.ts — Unit tests for commit branches.
// Mirrors the mocking pattern from DragCoordinator.test.ts.

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { CanvasTextEditController } from './CanvasTextEditController';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

vi.mock('@/shared/dom-utils', () => ({
  isEmptyTextEditHtml: vi.fn((html: string) => !html || html === '<p></p>' || html === '<p><br></p>'),
}));

vi.mock('@/shared/ghost-id', () => ({
  stripGhostSuffix: vi.fn((id: string) => id.replace(/__\d+$/, '')),
  isGhostNodeId: vi.fn((id: string) => id.includes('__')),
}));

vi.mock('@/shared/css-utils', () => ({
  toCamel: vi.fn((s: string) => s.replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase())),
}));

const mockQueueMutation = vi.fn();
const mockFlushNow = vi.fn();
vi.mock('@/code/mutation/mutation-queue', () => ({
  queueMutation: (...args: unknown[]) => mockQueueMutation(...args),
  flushNow: () => mockFlushNow(),
}));

const mockModifyProjectFile = vi.fn();
vi.mock('@/code/project/modify-file', () => ({
  modifyProjectFile: (...args: unknown[]) => mockModifyProjectFile(...args),
}));

vi.mock('@/code/project/project-fs', () => ({
  projectFS: { readFile: vi.fn(() => null), writeFile: vi.fn() },
}));

vi.mock('@/code/project/locale-ops', () => ({
  setNodeOverride: vi.fn(),
}));

vi.mock('@/code/generation/i18n-gen', () => ({
  transformTextToTranslation: vi.fn((_code: string, _nodeId: string) => ({ changed: false, code: _code, originalText: null })),
  setMessageValue: vi.fn((_raw: string, _ns: string, _key: string, val: string) => `{"ns":{"key":"${val}"}}`),
  getMessageValue: vi.fn(() => null),
  nodeHasTranslationCall: vi.fn(() => false),
}));

vi.mock('@/code/generation/map-ghost-propagate', () => ({
  propagateToGhosts: vi.fn(),
}));

vi.mock('@/canvas/node-ops', () => ({
  removeNode: vi.fn(),
  getContentRoot: vi.fn(() => document.createElement('div')),
  getViewportPrefix: vi.fn((vpId: string) => vpId === 'desktop' ? '' : `${vpId}-`),
}));

vi.mock('@/code/project/active-file-store', () => ({
  activeFilePathAtom: { toString: () => 'activeFilePathAtom' },
  filePathToSlug: vi.fn((path: string) => path.replace(/.*\//, '').replace(/\.tsx$/, '')),
  isComponentFilePath: (path: string) => typeof path === 'string' && path.startsWith('components/'),
}));

vi.mock('@/code/stores/store', () => ({
  nodesAtom: { toString: () => 'nodesAtom' },
  selectedIdsAtom: { toString: () => 'selectedIdsAtom' },
  hoveredIdAtom: { toString: () => 'hoveredIdAtom' },
  hoveredNodeIdAtom: { toString: () => 'hoveredNodeIdAtom' },
  mapContextAtom: { toString: () => 'mapContextAtom' },
  mapItemIndexAtom: { toString: () => 'mapItemIndexAtom' },
}));

vi.mock('@/code/stores/editor-store', () => ({
  selectionStylesAtom: { toString: () => 'selectionStylesAtom' },
  isTextEditingAtom: { toString: () => 'isTextEditingAtom' },
  textEditSnapshotAtom: { toString: () => 'textEditSnapshotAtom' },
}));

vi.mock('@/code/stores/locale-store', () => ({
  activeLocaleAtom: { toString: () => 'activeLocaleAtom' },
  isDefaultLocaleAtom: { toString: () => 'isDefaultLocaleAtom' },
  localeOverridesAtom: { toString: () => 'localeOverridesAtom' },
  i18nConfigAtom: { toString: () => 'i18nConfigAtom' },
}));

vi.mock('@/code/stores/viewport-store', () => ({
  viewportsConfigAtom: { toString: () => 'viewportsConfigAtom' },
}));

// ─── Atom identifiers ─────────────────────────────────────────────────────────
// We need to import the atom references AFTER the mocks so we get the mock objects.
import {
  nodesAtom,
  mapContextAtom,
  mapItemIndexAtom,
} from '@/code/stores/store';
import { isTextEditingAtom } from '@/code/stores/editor-store';
import { activeLocaleAtom, isDefaultLocaleAtom, i18nConfigAtom } from '@/code/stores/locale-store';
import { viewportsConfigAtom } from '@/code/stores/viewport-store';
import { activeFilePathAtom } from '@/code/project/active-file-store';

// ─── Store factory ────────────────────────────────────────────────────────────

function makeNode(overrides = {}) {
  return {
    id: 'node1', tag: 'p', styles: {}, children: [],
    parentId: null, binding: null, textOverrides: null,
    ...overrides,
  };
}

/**
 * Build a mock jotai-like store. Pass atom objects as keys directly:
 *   makeStore([[nodesAtom, new Map(...)], [isDefaultLocaleAtom, true]])
 */
function makeStore(initial: Array<[unknown, unknown]> = []) {
  const data: Map<unknown, unknown> = new Map(initial);
  return {
    get: vi.fn((atom: unknown) => data.get(atom) ?? null),
    set: vi.fn((atom: unknown, val: unknown) => {
      const resolved = typeof val === 'function' ? (val as (prev: unknown) => unknown)(data.get(atom)) : val;
      data.set(atom, resolved);
    }),
    sub: vi.fn(),
  };
}

function makeBridge() {
  return {
    startTextEdit: vi.fn(),
    commitTextEdit: vi.fn(() => Promise.resolve({ html: '' })),
    cancelTextEdit: vi.fn(),
    setDndHovered: vi.fn(),
  };
}

function makeRenderer() {
  return {
    setTextEditing: vi.fn(),
  };
}

function makeIframeRef() {
  const el = { style: { pointerEvents: '' } } as unknown as HTMLIFrameElement;
  return { current: el } as React.RefObject<HTMLIFrameElement | null>;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CanvasTextEditController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Branch 1: Regular text → queueMutation updateChildrenHTML ────────────

  test('regular text commit queues updateChildrenHTML', () => {
    const nodes = new Map([['node1', makeNode({ id: 'node1' })]]);
    const viewports = [{ id: 'desktop', width: 1440, isPrimary: true }];

    const store = makeStore([
      [nodesAtom, nodes],
      [isDefaultLocaleAtom, true],
      [activeLocaleAtom, 'en'],
      [viewportsConfigAtom, viewports],
      [mapContextAtom, null],
      [mapItemIndexAtom, null],
      [activeFilePathAtom, 'app/page.tsx'],
      [i18nConfigAtom, { defaultLocale: 'en' }],
    ]);

    const bridge = makeBridge();
    const renderer = makeRenderer();
    const iframeRef = makeIframeRef();

    const controller = new CanvasTextEditController({
      jotaiStore: store as ReturnType<typeof import('jotai').useStore>,
      bridge: bridge as unknown as import('@/canvas-sandbox/bridge-host').PostMessageBridge,
      iframeRef,
      renderer: renderer as unknown as import('../CanvasRenderer').CanvasRenderer,
      getInteractingVpId: () => 'desktop',
    });

    // Start then commit
    controller.startEdit('node1', 'Hello');
    controller.commitEditWithHtml('<p>Hello world</p>');

    // The store read for nodesAtom returns our map; for regular text it should
    // call queueMutation with updateChildrenHTML on the primary viewport
    const updateCall = mockQueueMutation.mock.calls.find(
      c => c[0]?.type === 'updateChildrenHTML',
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![0]).toMatchObject({
      type: 'updateChildrenHTML',
      nodeId: 'node1',
      html: 'Hello world',
    });

    // Renderer should be told to start + stop text editing
    expect(renderer.setTextEditing).toHaveBeenCalledWith(true);
  });

  // ─── Whitespace visibility: edge spaces auto-apply white-space: pre-wrap ──
  // Default CSS collapses a trailing space at the end of an inline box, so a
  // committed `Time - ` painted as `Time -` on canvas AND live even though the
  // data was preserved. The commit now queues whiteSpace: 'pre-wrap' (the reference
  // parity) when the text has edge/multiple spaces and no explicit whiteSpace.

  function makeWsController(nodes: Map<string, unknown>) {
    const viewports = [{ id: 'desktop', width: 1440, isPrimary: true }];
    const store = makeStore([
      [nodesAtom, nodes],
      [isDefaultLocaleAtom, true],
      [activeLocaleAtom, 'en'],
      [viewportsConfigAtom, viewports],
      [mapContextAtom, null],
      [mapItemIndexAtom, null],
      [activeFilePathAtom, 'app/page.tsx'],
      [i18nConfigAtom, { defaultLocale: 'en' }],
    ]);
    return new CanvasTextEditController({
      jotaiStore: store as ReturnType<typeof import('jotai').useStore>,
      bridge: makeBridge() as unknown as import('@/canvas-sandbox/bridge-host').PostMessageBridge,
      iframeRef: makeIframeRef(),
      renderer: makeRenderer() as unknown as import('../CanvasRenderer').CanvasRenderer,
      getInteractingVpId: () => 'desktop',
    });
  }

  test('trailing space commit queues whiteSpace: pre-wrap (the Time - bug)', () => {
    const controller = makeWsController(new Map([['node1', makeNode({ id: 'node1' })]]));
    controller.startEdit('node1', 'Time');
    controller.commitEditWithHtml('<p>Time -  </p>');

    const wsCall = mockQueueMutation.mock.calls.find(
      c => c[0]?.type === 'updateStyles' && c[0]?.styles?.whiteSpace === 'pre-wrap',
    );
    expect(wsCall).toBeDefined();
    expect(wsCall![0].nodeId).toBe('node1');
    // The text itself commits WITH the spaces
    const textCall = mockQueueMutation.mock.calls.find(c => c[0]?.type === 'updateChildrenHTML');
    expect(textCall![0].html).toBe('Time -  ');
  });

  test('text without edge/multiple spaces does NOT queue whiteSpace', () => {
    const controller = makeWsController(new Map([['node1', makeNode({ id: 'node1' })]]));
    controller.startEdit('node1', 'Hello');
    controller.commitEditWithHtml('<p>Hello world</p>');

    const wsCall = mockQueueMutation.mock.calls.find(
      c => c[0]?.type === 'updateStyles' && c[0]?.styles?.whiteSpace,
    );
    expect(wsCall).toBeUndefined();
  });

  test('an explicit user whiteSpace (nowrap) is never clobbered', () => {
    const controller = makeWsController(new Map([
      ['node1', makeNode({ id: 'node1', styles: { whiteSpace: 'nowrap' } })],
    ]));
    controller.startEdit('node1', 'Time');
    controller.commitEditWithHtml('<p>Time - </p>');

    const wsCall = mockQueueMutation.mock.calls.find(
      c => c[0]?.type === 'updateStyles' && c[0]?.styles?.whiteSpace,
    );
    expect(wsCall).toBeUndefined();
  });

  // ─── Branch 2: Empty content + scaffold pending → revert ──────────────────

  test('empty commit with scaffold pending reverts the scaffold', async () => {
    const nodes = new Map([['node1', makeNode({ id: 'node1' })]]);
    const viewports = [{ id: 'desktop', width: 1440, isPrimary: true }];

    const store = makeStore([
      [nodesAtom, nodes],
      [isDefaultLocaleAtom, true],
      [activeLocaleAtom, 'en'],
      [viewportsConfigAtom, viewports],
      [mapContextAtom, null],
      [mapItemIndexAtom, null],
      [activeFilePathAtom, 'app/page.tsx'],
      [i18nConfigAtom, { defaultLocale: 'en' }],
    ]);

    const bridge = makeBridge();
    const renderer = makeRenderer();
    const iframeRef = makeIframeRef();

    const controller = new CanvasTextEditController({
      jotaiStore: store as ReturnType<typeof import('jotai').useStore>,
      bridge: bridge as unknown as import('@/canvas-sandbox/bridge-host').PostMessageBridge,
      iframeRef,
      renderer: renderer as unknown as import('../CanvasRenderer').CanvasRenderer,
      getInteractingVpId: () => 'desktop',
    });

    // Set up empty-frame scaffold
    controller.setEmptyFrameScaffold({ frameId: 'frame1', textId: 'node1' });
    controller.startEdit('node1', '');

    // Commit with empty content — should revert
    controller.commitEditWithHtml('<p></p>');

    // Renderer text-editing gate should be reset
    expect(renderer.setTextEditing).toHaveBeenCalledWith(false);

    // isTextEditingAtom should be set to false
    expect(store.set).toHaveBeenCalledWith(isTextEditingAtom, false);

    // No updateChildrenHTML should have been queued
    const updateCall = mockQueueMutation.mock.calls.find(
      c => c[0]?.type === 'updateChildrenHTML',
    );
    expect(updateCall).toBeUndefined();

    // Controller should no longer be editing
    expect(controller.isEditing()).toBe(false);
  });

  // ─── Branch 3: Ghost-map item → propagateToGhosts ────────────────────────

  test.todo('ghost-map item commit calls propagateToGhosts for index 0');

  // ─── Branch 4: i18n non-default locale → modifyProjectFile ───────────────

  test.todo('non-default locale commit calls modifyProjectFile for JSX rewrite');

  // ─── Branch 5: FIT text → viewBox recalculation ──────────────────────────

  test.todo('fit-text commit recalculates viewBox and queues updateHtmlAttrs');

  // ─── cancelEdit ───────────────────────────────────────────────────────────

  test('cancelEdit clears editing state and resets renderer gate', () => {
    const nodes = new Map([['node1', makeNode({ id: 'node1' })]]);
    const viewports = [{ id: 'desktop', width: 1440, isPrimary: true }];

    const store = makeStore([
      [nodesAtom, nodes],
      [viewportsConfigAtom, viewports],
    ]);

    const bridge = makeBridge();
    const renderer = makeRenderer();
    const iframeRef = makeIframeRef();

    const controller = new CanvasTextEditController({
      jotaiStore: store as ReturnType<typeof import('jotai').useStore>,
      bridge: bridge as unknown as import('@/canvas-sandbox/bridge-host').PostMessageBridge,
      iframeRef,
      renderer: renderer as unknown as import('../CanvasRenderer').CanvasRenderer,
      getInteractingVpId: () => 'desktop',
    });

    controller.startEdit('node1', 'Hello');
    expect(controller.isEditing()).toBe(true);

    controller.cancelEdit();
    expect(controller.isEditing()).toBe(false);
    expect(renderer.setTextEditing).toHaveBeenCalledWith(false);
    expect(store.set).toHaveBeenCalledWith(isTextEditingAtom, false);
    expect(iframeRef.current?.style.pointerEvents).toBe('none');
  });

  // ─── startEdit ────────────────────────────────────────────────────────────

  test('startEdit sets isTextEditing atom and calls bridge.startTextEdit', () => {
    const nodes = new Map([['node1', makeNode({ id: 'node1' })]]);
    const store = makeStore([
      [nodesAtom, nodes],
    ]);

    const bridge = makeBridge();
    const renderer = makeRenderer();
    const iframeRef = makeIframeRef();

    const controller = new CanvasTextEditController({
      jotaiStore: store as ReturnType<typeof import('jotai').useStore>,
      bridge: bridge as unknown as import('@/canvas-sandbox/bridge-host').PostMessageBridge,
      iframeRef,
      renderer: renderer as unknown as import('../CanvasRenderer').CanvasRenderer,
      getInteractingVpId: () => 'desktop',
    });

    controller.startEdit('node1', '<p>Hello</p>', 'desktop');

    expect(store.set).toHaveBeenCalledWith(isTextEditingAtom, true);
    expect(bridge.startTextEdit).toHaveBeenCalledWith('node1', '', '<p>Hello</p>', false, []);
    expect(renderer.setTextEditing).toHaveBeenCalledWith(true);
    expect(iframeRef.current?.style.pointerEvents).toBe('auto');
    expect(controller.isEditing()).toBe(true);
    expect(controller.getEditingNodeId()).toBe('node1');
  });

  // ─── dispose ──────────────────────────────────────────────────────────────

  test('dispose clears all internal state', () => {
    const store = makeStore([[nodesAtom, new Map()]]);
    const bridge = makeBridge();
    const renderer = makeRenderer();
    const iframeRef = makeIframeRef();

    const controller = new CanvasTextEditController({
      jotaiStore: store as ReturnType<typeof import('jotai').useStore>,
      bridge: bridge as unknown as import('@/canvas-sandbox/bridge-host').PostMessageBridge,
      iframeRef,
      renderer: renderer as unknown as import('../CanvasRenderer').CanvasRenderer,
      getInteractingVpId: () => 'desktop',
    });

    // Manually set internal state
    controller.setEmptyFrameScaffold({ frameId: 'f1', textId: 't1' });
    // Can't directly verify private fields, but dispose should not throw
    expect(() => controller.dispose()).not.toThrow();
    expect(controller.isEditing()).toBe(false);
  });
});
