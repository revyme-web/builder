// editor/plugin-editor/PluginEditor.tsx — split Monaco + live preview pane.
//
// Layout mirrors `ComponentEditorOverlay`:
//   - Header bar fixed at `top: 0, left: 308, right: 260, height: 52`
//     so it sits between the LeftHeader (308 = left menu 52 + panel 256)
//     and the RightHeader (260). The Library panel + canvas chrome
//     stay visible behind/around the editor — it does NOT cover the
//     whole screen.
//   - Body fixed at `top: 52, left: 308, right: 0, bottom: 0` —
//     fills the canvas area. Two columns: Monaco editor on the left,
//     live preview iframe on the right, with a draggable split
//     handle between.
//
// Lifecycle:
//   - Mounted by `PluginEditorMount` in App.tsx when
//     `pluginEditorFileAtom` is non-null.
//   - Cmd+S saves to projectFS without running.
//   - Cmd+Enter / Run button compiles + bundles + reloads the
//     preview iframe with a fresh blob URL.
//   - Auto-save on Run so a crash mid-bundle doesn't lose work.
//   - Blob URL revoked before each rebuild + on unmount.
//   - A fresh `PluginRouter` attaches per Run so subscriptions from
//     a previous run don't bleed into the next one.

import { useEffect, useMemo, useRef, useState, useCallback, type PointerEvent as ReactPointerEvent } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import PluginChat from './PluginChat';
import {
  readPluginSource,
  writePluginSource,
  pluginPathToInternalName,
  deriveTier2Manifest,
} from './plugin-files';
import { bundlePluginToBlobUrl } from './plugin-bundler';
import { PluginRouter } from '@/plugins/router';
import Breadcrumb from '@/design-system/Breadcrumb';
import Button from '@/design-system/Button';
import { useIsDark } from '@/shared/useIsDark';
import { trace } from '@/shared/debug-trace';

interface PluginEditorProps {
  filePath: string;
  onClose: () => void;
}

export default function PluginEditor({ filePath, onClose }: PluginEditorProps) {
  const internalName = pluginPathToInternalName(filePath);
  const manifest = useMemo(() => deriveTier2Manifest(filePath), [filePath]);

  // Source string — initial value loaded from projectFS, then owned
  // by Monaco. We mirror Monaco's value back into a state variable on
  // every change so Run can build with the latest source without
  // touching Monaco's internals.
  const [source, setSource] = useState<string>(() => readPluginSource(filePath));
  const [savedSource, setSavedSource] = useState<string>(() => readPluginSource(filePath));
  const hasUnsavedChanges = source !== savedSource;
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // Escape closes the editor — same affordance ComponentEditorOverlay uses.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Save without running — writes Monaco's current value to projectFS.
  const handleSave = useCallback(() => {
    writePluginSource(filePath, source);
    setSavedSource(source);
    trace.action('plugin-editor:save', { filePath });
  }, [filePath, source]);

  // Build a new bundle + blob URL. Auto-saves to projectFS first so
  // a crash mid-Run doesn't lose work. Revokes the previous blob URL
  // because every blob: is a discrete object the GC won't collect
  // until we tell it explicitly.
  const handleRun = useCallback(() => {
    setError(null);
    setRunning(true);
    try {
      writePluginSource(filePath, source);
      setSavedSource(source);
      const url = bundlePluginToBlobUrl(source, {
        pluginId: manifest.id,
        pluginName: manifest.name,
      });
      setBlobUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
      trace.action('plugin-editor:run', { filePath });
    } catch (e) {
      setError((e as Error).message);
      trace.error('plugin-editor:run-failed', { filePath, error: String(e) });
    } finally {
      setRunning(false);
    }
  }, [filePath, source, manifest.id, manifest.name]);

  // Attach a fresh router whenever the iframe URL swaps. Teardown
  // runs before re-attach, so subscriptions from a previous run
  // don't bleed into the next one.
  useEffect(() => {
    const el = iframeRef.current;
    if (!el || !blobUrl) return;
    const router = new PluginRouter(manifest);
    router.attach(el);
    return () => router.detach();
  }, [blobUrl, manifest]);

  // Revoke the blob URL on full unmount so a long editor session
  // doesn't accumulate leaked blobs.
  useEffect(() => {
    return () => {
      setBlobUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    };
  }, []);

  const handleEditorMount: OnMount = useCallback((editor, monaco) => {
    // Cmd+S / Ctrl+S → save.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const current = editor.getValue();
      writePluginSource(filePath, current);
      setSavedSource(current);
      trace.action('plugin-editor:save-shortcut', { filePath });
    });
    // Cmd+Enter / Ctrl+Enter → save + Run.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      const current = editor.getValue();
      setSource(current);
      Promise.resolve().then(handleRun);
    });
  }, [filePath, handleRun]);

  return (
    <>
      {/* Header bar — sits between LeftHeader (left: 308) and
          RightHeader (right: 260), same row, 52px high. Mirror of
          ComponentEditorOverlay's header. */}
      <div
        className="fixed z-[10000] border-b border-[var(--border-light)] bg-[var(--bg-surface)] flex items-center justify-between px-4"
        style={{ top: 0, left: 308, right: 260, height: 52 }}
      >
        <Breadcrumb segments={[
          {
            label: 'Back',
            icon: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            ),
            onClick: onClose,
          },
          {
            label: internalName,
            icon: (
              // Puzzle-piece glyph — same shape PluginsSection uses for plugin rows.
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M14 4a2 2 0 1 1 4 0v3h3a2 2 0 0 1 2 2v3h-1.5a2.5 2.5 0 1 0 0 5H23v3a2 2 0 0 1-2 2h-3v-1.5a2.5 2.5 0 1 0-5 0V21H10a2 2 0 0 1-2-2v-3H6.5a2.5 2.5 0 1 1 0-5H8V8a2 2 0 0 1 2-2h3V4z" />
              </svg>
            ),
            color: 'var(--accent)',
            dot: hasUnsavedChanges,
          },
        ]} />
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={handleRun} disabled={running}>
            {running ? 'Bundling…' : '▶ Run'}
          </Button>
          <Button
            variant={hasUnsavedChanges ? 'primary' : 'secondary'}
            size="sm"
            disabled={!hasUnsavedChanges}
            onClick={handleSave}
          >
            Save
          </Button>
        </div>
      </div>

      {/* Body — Monaco | (preview top + AI chat bottom), sits below
          header in the canvas area. The AI chat streams generated
          source straight into Monaco via `onSourceChange`. */}
      <PluginEditorBody
        source={source}
        onSourceChange={setSource}
        onEditorMount={handleEditorMount}
        blobUrl={blobUrl}
        error={error}
        pluginName={internalName}
        iframeRef={iframeRef}
      />
    </>
  );
}

interface PluginEditorBodyProps {
  source: string;
  onSourceChange: (v: string) => void;
  onEditorMount: OnMount;
  blobUrl: string | null;
  error: string | null;
  pluginName: string;
  iframeRef: React.MutableRefObject<HTMLIFrameElement | null>;
}

function PluginEditorBody({
  source, onSourceChange, onEditorMount, blobUrl, error, pluginName, iframeRef,
}: PluginEditorBodyProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isDark = useIsDark();
  const [splitRatio, setSplitRatio] = useState(0.6);
  const draggingRef = useRef(false);
  // Tracked as state (not just ref) so the transparent drag overlay
  // mounts/unmounts on render. The overlay covers the iframe while
  // resizing so the iframe doesn't swallow pointermove events — without
  // it, the drag dies the moment the cursor crosses into the preview.
  const [isDragging, setIsDragging] = useState(false);

  const handlePointerDown = useCallback((e: ReactPointerEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    setIsDragging(true);
    const container = containerRef.current;
    if (!container) return;

    const onMove = (ev: globalThis.PointerEvent) => {
      if (!draggingRef.current) return;
      const rect = container.getBoundingClientRect();
      const ratio = Math.max(0.2, Math.min(0.85, (ev.clientX - rect.left) / rect.width));
      setSplitRatio(ratio);
    };
    const onUp = () => {
      draggingRef.current = false;
      setIsDragging(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);

  return (
    <div
      ref={containerRef}
      className="fixed z-[9000] bg-[var(--bg-surface)] flex"
      // Full-height overlay. The BottomToolbar is HIDDEN by App.tsx
      // while the plugin editor is open — same pattern as
      // ComponentEditorOverlay — so the editor reaches all the way
      // to the bottom of the screen without competing with toolbar
      // chrome.
      style={{ top: 52, left: 308, right: 0, bottom: 0 }}
    >
      {/* Drag-shield overlay — only mounted while resizing the splitter.
          Covers the entire editor including the iframe so pointermove
          events stay in the parent document instead of getting eaten
          by the iframe. zIndex sits above the iframe but below any
          editor chrome that needs to remain interactive (none during
          a drag — user is busy dragging). */}
      {isDragging && (
        <div
          className="absolute inset-0"
          style={{ zIndex: 10000, cursor: 'col-resize' }}
        />
      )}

      {/* Left: Monaco editor */}
      <div className="min-w-0 h-full" style={{ width: `calc(100% * ${splitRatio})` }}>
        <Editor
          height="100%"
          language="typescript"
          theme={isDark ? 'vs-dark' : 'vs'}
          value={source}
          onChange={(v) => onSourceChange(v ?? '')}
          onMount={onEditorMount}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            wordWrap: 'on',
            tabSize: 2,
            scrollBeyondLastLine: false,
          }}
        />
      </div>

      {/* Drag handle — same affordance ComponentEditorOverlay uses */}
      <div
        onPointerDown={handlePointerDown}
        className="shrink-0 flex items-center justify-center cursor-col-resize hover:bg-[var(--accent)]/20 transition-colors group"
        style={{ width: 6 }}
      >
        <div className="w-0.5 h-8 rounded-full bg-[var(--text-disabled)] group-hover:bg-[var(--accent)] transition-colors" />
      </div>

      {/* Right: Preview iframe (top) + AI Chat (bottom). The chat
          mirrors the code component editor's layout — same
          interaction shape (single-line input, streamed code into
          editor, abort, clear). The AI's system prompt has full
          context of every wired Revyme plugin SDK method, so plugin
          authors describe what they want and the model writes the
          source directly into Monaco. */}
      <div
        className="min-w-0 h-full flex flex-col bg-[var(--bg-surface)] border-l border-[var(--border-light)]"
        style={{ width: `calc(100% * ${1 - splitRatio} - 6px)` }}
      >
        {/* Preview pane — fills upper portion. Bottom pane (chat)
            takes a fixed-but-resizable height. The vertical split is
            simpler than a draggable splitter for now — chat = 240px,
            preview gets the rest. Future: drag handle between them. */}
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="px-3 py-2 border-b border-[var(--border-light)] text-[11px] text-[var(--text-secondary)] flex items-center justify-between shrink-0">
            <span>Preview</span>
            {error && <span className="text-[var(--error)] truncate ml-2" title={error}>{error}</span>}
          </div>
          {blobUrl ? (
            <iframe
              ref={iframeRef}
              key={blobUrl}
              src={blobUrl}
              title={pluginName}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              className="flex-1 border-none bg-transparent w-full"
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-[var(--text-disabled)] text-[11px] p-6 text-center leading-relaxed">
              Press <kbd className="bg-[var(--button-secondary-bg)] px-1.5 py-0.5 rounded mx-1">▶ Run</kbd> or
              <kbd className="bg-[var(--button-secondary-bg)] px-1.5 py-0.5 rounded mx-1">Cmd+Enter</kbd>
              to bundle and run
            </div>
          )}
        </div>
        {/* AI chat pane — bottom of preview column. Fixed 240px height
            so the preview iframe always has comfortable room. */}
        <div
          className="border-t border-[var(--border-light)] bg-[var(--bg-surface)] shrink-0 flex flex-col"
          style={{ height: 240 }}
        >
          <div className="px-3 py-1.5 border-b border-[var(--border-light)] text-[10px] uppercase tracking-wider text-[var(--text-disabled)] shrink-0">
            AI Chat
          </div>
          <div className="flex-1 min-h-0">
            <PluginChat code={source} onCodeChange={onSourceChange} />
          </div>
        </div>
      </div>
    </div>
  );
}
