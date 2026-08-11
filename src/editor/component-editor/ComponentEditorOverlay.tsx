// ComponentEditorOverlay.tsx — Full-screen overlay for editing Code components.
// Layers on top of the canvas (canvas stays mounted behind).
// Header bar sits between LeftHeader and RightHeader (same row, 52px).
// Body: left Monaco editor, center preview + AI chat, right controls sidebar.
// Opens when componentEditorFileAtom is non-null. Closes on X or Escape.

import { useState, useCallback, useEffect, useRef, useMemo, type PointerEvent as ReactPointerEvent } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { componentEditorFileAtom, componentEditorPropsAtom, componentEditorStreamingAtom } from '@/code/stores/component-editor-store';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { parseComponentControlsMeta } from '@/code/components/controls-parser';
import { checkFile } from '@/code/oracle/check-file';
import { isCodeComponentSource } from '@/code/oracle/checks/shared';
import ComponentCodePane from './ComponentCodePane';
import ComponentPreviewPane from './ComponentPreviewPane';
import ComponentPropsPanel from './ComponentPropsPanel';
import Breadcrumb from '@/design-system/Breadcrumb';
import Button from '@/design-system/Button';
import { trace } from '@/shared/debug-trace';

export default function ComponentEditorOverlay() {
  const [filePath, setFilePath] = useAtom(componentEditorFileAtom);
  const [props, setProps] = useAtom(componentEditorPropsAtom);
  const bumpVersion = useSetAtom(projectVersionAtom);

  const [code, setCode] = useState('');
  const [savedCode, setSavedCode] = useState('');
  const hasUnsavedChanges = code !== savedCode;
  const codeRef = useRef(code);
  codeRef.current = code;

  // Parse @controls from saved code
  const metadata = useMemo(() => {
    try { return parseComponentControlsMeta(savedCode); } catch { return null; }
  }, [savedCode]);
  const controls = metadata?.controls;

  // Initialize props from @controls defaults when controls change
  useEffect(() => {
    if (!controls) return;
    setProps(prev => {
      const merged: Record<string, any> = {};
      for (const [key, def] of Object.entries(controls)) {
        merged[key] = key in prev ? prev[key] : def.default;
      }
      return merged;
    });
  }, [controls, setProps]);

  const handlePropChange = useCallback((key: string, value: any) => {
    setProps(prev => ({ ...prev, [key]: value }));
    trace.action('component-editor:prop-change', { key, value: typeof value === 'string' ? value.slice(0, 40) : value });
  }, [setProps]);

  // Load code when file changes
  useEffect(() => {
    if (!filePath) return;
    const content = projectFS.readFile(filePath);
    if (content) {
      setCode(content);
      setSavedCode(content);
      trace.action('component-editor:load', { filePath, size: content.length });
    }
  }, [filePath]);

  // EXTERNAL-CHANGE SYNC. The overlay used to load the file ONCE at open and
  // write its buffer back on close/save — a modal left open across an
  // external write (MCP submit, Vibe, collab file-sync) held a STALE buffer
  // and silently resurrected the old file ("the locale switcher reverted
  // AGAIN", 2026-07-22: each fix was clobbered within seconds by an open
  // Edit Code modal). Track the project version: when the file changes on
  // disk underneath us —
  //   · no local edits → adopt the new content (modal stays live);
  //   · local edits    → rebase the baseline so Save/close still write the
  //     user's work, but the conflict is traced instead of invisible.
  const projectVersion = useAtomValue(projectVersionAtom);
  useEffect(() => {
    if (!filePath) return;
    const disk = projectFS.readFile(filePath);
    if (disk == null || disk === savedCode) return;
    if (codeRef.current === savedCode) {
      setCode(disk);
      setSavedCode(disk);
      trace.action('component-editor:external-sync', { filePath, size: disk.length });
    } else {
      setSavedCode(disk);
      trace.action('component-editor:external-conflict', { filePath, keptLocalEdits: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectVersion, filePath]);

  // Escape to close
  useEffect(() => {
    if (!filePath) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); handleClose(); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [filePath]);

  // Auto-save when AI streaming finishes so preview recompiles.
  //
  // ORACLE-GATED (2026-08-11): this used to write the streamed buffer to disk
  // VERBATIM — the single largest ungated door in the app (any model output,
  // any file the overlay was pointed at, zero checks — not even syntax). The
  // AI path now runs the same checkFile the MCP gate uses; a violating stream
  // stays IN THE BUFFER (visible, editable) and is not committed. The user's
  // OWN typing is never gated: manual Save and close-with-changes below stay
  // as they were — sovereignty over one's own keyboard.
  const streaming = useAtomValue(componentEditorStreamingAtom);
  const prevStreamingRef = useRef(false);
  useEffect(() => {
    // Detect transition from streaming=true → false
    if (prevStreamingRef.current && !streaming && filePath) {
      const streamed = codeRef.current;
      const kind = filePath.startsWith('components/')
        ? (isCodeComponentSource(streamed) ? 'code-component' : 'component')
        : /LayoutClient\.tsx$/.test(filePath) ? 'template' : 'page';
      let violations: Array<{ code: string; message: string }> = [];
      try {
        violations = checkFile(streamed, { kind, path: filePath });
      } catch (err) {
        violations = [{ code: 'ORACLE_THREW', message: String(err) }];
      }
      if (violations.length > 0) {
        trace.error('component-editor:auto-save-blocked-by-oracle', {
          filePath, codes: violations.map((x) => x.code).slice(0, 10),
        });
        console.warn(
          `[Revyme] The AI's code for ${filePath} was NOT saved — it fails ${violations.length} oracle check(s) ` +
          `(${[...new Set(violations.map((x) => x.code))].slice(0, 5).join(', ')}). ` +
          `The code stays in the editor; fix it or ask the AI again. First issue: ${violations[0].message.slice(0, 300)}`,
        );
      } else {
        projectFS.writeFile(filePath, streamed);
        bumpVersion(v => v + 1);
        setSavedCode(streamed);
        trace.action('component-editor:auto-save-after-stream', { filePath });
      }
    }
    prevStreamingRef.current = streaming;
  }, [streaming, filePath, bumpVersion]);

  const handleClose = useCallback(() => {
    // Write ONLY a buffer that differs from what's on disk RIGHT NOW — never
    // re-impose a stale unedited copy over an externally-updated file.
    if (filePath && codeRef.current !== savedCode
      && codeRef.current !== projectFS.readFile(filePath)) {
      projectFS.writeFile(filePath, codeRef.current);
      bumpVersion(v => v + 1);
    }
    setFilePath(null);
    setProps({});
    trace.action('component-editor:close', { filePath });
  }, [filePath, savedCode, setFilePath, setProps, bumpVersion]);

  const handleSave = useCallback(() => {
    if (!filePath) return;
    projectFS.writeFile(filePath, codeRef.current);
    bumpVersion(v => v + 1);
    setSavedCode(codeRef.current);
    trace.action('component-editor:save', { filePath, size: codeRef.current.length });
  }, [filePath, bumpVersion]);

  const handleCodeChange = useCallback((newCode: string) => {
    setCode(newCode);
  }, []);

  if (!filePath) return null;

  const displayName = filePath.replace('components/', '').replace('.tsx', '');
  const hasControls = controls ? Object.keys(controls).length > 0 : false;

  return (
    <>
      {/* Header bar — sits between LeftHeader and RightHeader, same row */}
      <div
        className="fixed z-[10000] border-b border-[var(--border-light)] bg-[var(--bg-surface)] flex items-center justify-between px-4"
        style={{ top: 0, left: 308, right: 260, height: 52 }}
      >
        <Breadcrumb segments={[
          {
            label: 'Back',
            icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>,
            onClick: handleClose,
          },
          {
            label: displayName,
            icon: <svg width="14" height="14" viewBox="0 0 24 24"><g fill="none"><path d="M0 0h24v24H0z" /><path fill="currentColor" d="M14.62 2.662a1.5 1.5 0 0 1 1.04 1.85l-4.431 15.787a1.5 1.5 0 0 1-2.889-.81L12.771 3.7a1.5 1.5 0 0 1 1.85-1.039ZM7.56 6.697a1.5 1.5 0 0 1 0 2.12L4.38 12l3.182 3.182a1.5 1.5 0 1 1-2.122 2.121L1.197 13.06a1.5 1.5 0 0 1 0-2.12l4.242-4.243a1.5 1.5 0 0 1 2.122 0Zm8.88 2.12a1.5 1.5 0 1 1 2.12-2.12l4.243 4.242a1.5 1.5 0 0 1 0 2.121l-4.242 4.243a1.5 1.5 0 1 1-2.122-2.121L19.621 12z" /></g></svg>,
            color: 'var(--accent-secondary)',
            dot: hasUnsavedChanges,
          },
        ]} />
        {/* Right: Save. Sharing (Copy URL / Copy Import) lives on the
            Library panel right-click menu — no need to duplicate it here. */}
        <div className="flex items-center gap-2">
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

      {/* Body — code | preview+chat | controls sidebar */}
      <EditorBody
        code={code}
        savedCode={savedCode}
        fileName={filePath}
        onCodeChange={handleCodeChange}
        onSave={handleSave}
        controls={controls ?? {}}
        props={props}
        onPropChange={handlePropChange}
        hasControls={hasControls}
      />

    </>
  );
}

// ─── Three-column body: code | preview+chat | controls ──────────────────────

const CONTROLS_WIDTH = 260;

function EditorBody({ code, savedCode, fileName, onCodeChange, onSave, controls, props, onPropChange, hasControls }: {
  code: string; savedCode: string; fileName: string;
  onCodeChange: (code: string) => void; onSave: () => void;
  controls: Record<string, any>; props: Record<string, any>;
  onPropChange: (key: string, value: any) => void;
  hasControls: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [splitRatio, setSplitRatio] = useState(0.5);
  const draggingRef = useRef(false);
  // State-tracked twin of draggingRef so the drag-shield overlay
  // mounts during resize. The shield covers the preview iframe so
  // pointermove events keep flowing to the parent document — without
  // it, the cursor crossing into the iframe kills the drag mid-stroke.
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
      const available = rect.width - (hasControls ? CONTROLS_WIDTH : 0);
      const ratio = Math.max(0.2, Math.min(0.8, (ev.clientX - rect.left) / available));
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
  }, [hasControls]);

  const rightSidebarWidth = hasControls ? CONTROLS_WIDTH : 0;

  return (
    <div
      ref={containerRef}
      className="fixed z-[9000] bg-[var(--bg-surface)] flex"
      style={{ top: 52, left: 308, right: 0, bottom: 0 }}
    >
      {/* Drag-shield overlay — only mounted while resizing the splitter.
          Covers the entire editor including the iframe so pointermove
          events stay in the parent document instead of getting eaten
          by the iframe. */}
      {isDragging && (
        <div
          className="absolute inset-0"
          style={{ zIndex: 10000, cursor: 'col-resize' }}
        />
      )}

      {/* Left: Monaco editor */}
      <div className="min-w-0 h-full" style={{ width: `calc((100% - ${rightSidebarWidth}px) * ${splitRatio})` }}>
        <ComponentCodePane code={code} onChange={onCodeChange} onSave={onSave} />
      </div>

      {/* Drag handle */}
      <div
        onPointerDown={handlePointerDown}
        className="shrink-0 flex items-center justify-center cursor-col-resize hover:bg-[var(--accent)]/20 transition-colors group"
        style={{ width: 6 }}
      >
        <div className="w-0.5 h-8 rounded-full bg-[var(--text-disabled)] group-hover:bg-[var(--accent)] transition-colors" />
      </div>

      {/* Center: Preview (top) + AI Chat (bottom) */}
      <div className="min-w-0 h-full flex flex-col" style={{ width: `calc((100% - ${rightSidebarWidth}px) * ${1 - splitRatio} - 6px)` }}>
        <ComponentPreviewPane code={savedCode} fileName={fileName} liveCode={code} onCodeChange={onCodeChange} />
      </div>

      {/* Right: Controls sidebar */}
      {hasControls && (
        <div
          className="shrink-0 h-full border-l border-[var(--border-light)] bg-[var(--bg-surface)] overflow-y-auto scrollbar-hide"
          style={{ width: CONTROLS_WIDTH }}
        >
          <ComponentPropsPanel controls={controls} values={props} onChange={onPropChange} />
        </div>
      )}
    </div>
  );
}
