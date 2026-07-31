// DebugToolbar.tsx — Floating draggable debug toolbar.
// Fixed at top center. Draggable. Record/stop button + dump + download.
// Only renders in development.

import { useState, useRef, useCallback, useEffect } from 'react';
import { trace, saveDebugCode, saveDebugProjectFiles } from '@/shared/debug-trace';
import { useAtomValue, useSetAtom } from 'jotai';
import { codeAtom, selectedNodeAtom } from '@/code/stores/store';
import { parseJSX, findFirstElementByDataId } from '@/code/parsing/ast-utils';
import { projectFS, createDefaultProject, createEmptyProject, resetProjectFS, projectVersionAtom } from '@/code/project/project-fs';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { DEFAULT_VIEWPORT_WIDTH } from '@/shared/constants';

function generateStressTestJSX(nodeCount: number): string {
  const colors = ['#f0f0ff', '#f0fff0', '#fff0f0', '#fffff0', '#f0ffff', '#fff0ff', '#e8f5e9', '#e3f2fd', '#fce4ec', '#fff3e0'];
  const rootW = DEFAULT_VIEWPORT_WIDTH;
  const rootH = Math.ceil(nodeCount / 5) * 220 + 200;
  const cols = 5;

  let jsx = `<div data-id="root" data-name="Stress Test" style={{
  position: 'relative', width: '${rootW}px', height: '${rootH}px',
  backgroundColor: '#f5f5f5'
}}>\n`;

  for (let i = 0; i < nodeCount; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const left = col * 280 + 20;
    const top = row * 220 + 20;
    const color = colors[i % colors.length];
    const id = `node-${i}`;

    jsx += `  <div data-id="${id}" data-name="Card ${i}" style={{
    position: 'absolute', left: '${left}px', top: '${top}px',
    width: '260px', height: '200px', backgroundColor: '${color}',
    borderRadius: '8px', padding: '16px',
    display: 'flex', flexDirection: 'column', gap: '8px'
  }}>
    <p data-id="${id}-title" style={{fontSize: '16px', fontWeight: '600', color: '#1a1a2e'}}>Card ${i}</p>
    <p data-id="${id}-desc" style={{fontSize: '12px', color: '#666', lineHeight: '1.4'}}>This is card number ${i} for performance testing.</p>
  </div>\n`;
  }

  jsx += `</div>`;
  return jsx;
}

/** Extract JSX source for a node by data-id. If withChildren=false, extracts only the opening tag. */
function extractNodeJSX(code: string, nodeId: string, withChildren: boolean): string | null {
  const ast = parseJSX(code);
  if (!ast) return null;
  let result: string | null = null;
  findFirstElementByDataId(ast, nodeId, (_path, element) => {
    const start = element.start;
    const end = element.end;
    if (start == null || end == null) return;
    if (withChildren) {
      result = code.slice(start, end);
    } else {
      // Self-closing or just the opening tag + closing tag without children
      const opening = element.openingElement;
      if (element.selfClosing || !element.closingElement) {
        result = code.slice(start, end);
      } else {
        // Opening tag only (up to >) + closing tag
        const openEnd = opening.end!;
        const closeStart = element.closingElement.start!;
        result = code.slice(start, openEnd) + code.slice(closeStart, end);
      }
    }
  });
  return result;
}

export default function DebugToolbar() {
  const code = useAtomValue(codeAtom);
  const setCode = useSetAtom(codeAtom);
  const selectedId = useAtomValue(selectedNodeAtom);
  const setProjectVersion = useSetAtom(projectVersionAtom);
  const setActiveFile = useSetAtom(activeFilePathAtom);
  const codeRef = useRef(code);
  codeRef.current = code;
  const beforeCodeRef = useRef('');

  const [recording, setRecording] = useState(false);
  const [entryCount, setEntryCount] = useState(0);
  const [position, setPosition] = useState({ x: 0, y: 0 }); // offset from default position
  // Starts COLLAPSED — a single small puck bottom-center — so the full
  // bar doesn't cover the canvas / floating UI on load. Click to expand.
  const [collapsed, setCollapsed] = useState(true);
  const dragRef = useRef<{ startX: number; startY: number; startPosX: number; startPosY: number } | null>(null);
  const intervalRef = useRef<number | null>(null);

  // Subscribe to recording state
  useEffect(() => {
    return trace.onRecordingStateChange(setRecording);
  }, []);

  // Update entry count while recording
  useEffect(() => {
    if (recording) {
      intervalRef.current = window.setInterval(() => {
        setEntryCount(trace.getEntries().length);
      }, 500);
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current);
      setEntryCount(0);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [recording]);

  const handleRecord = useCallback(() => {
    if (recording) {
      trace.stopRecording();
      trace.dump();
      trace.saveRecording();          // writes to debug-trace.json
      saveDebugCode(codeRef.current); // writes to debug-code.jsx (after)
      if (beforeCodeRef.current) {
        saveDebugCode(beforeCodeRef.current, 'debug-code-before.jsx'); // before snapshot
      }
      // Save all project files with directory structure
      const allFiles: Record<string, string> = {};
      for (const filePath of projectFS.listFiles()) {
        const content = projectFS.readFile(filePath);
        if (content !== null) allFiles[filePath] = content;
      }
      saveDebugProjectFiles(allFiles);
    } else {
      // Capture "before" code in memory (don't write to disk — triggers HMR reload)
      beforeCodeRef.current = codeRef.current;
      trace.startRecording();
    }
  }, [recording]);

  const handleDump = useCallback(() => {
    trace.dump(100);
  }, []);

  const handleSave = useCallback(() => {
    trace.saveRecording();
  }, []);

  const handleClear = useCallback(() => {
    trace.clear();
    setEntryCount(0);
  }, []);

  // Drag logic
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).tagName === 'BUTTON') return; // don't drag when clicking buttons
    e.preventDefault();
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startPosX: position.x,
      startPosY: position.y,
    };

    const handleMove = (me: MouseEvent) => {
      if (!dragRef.current) return;
      setPosition({
        x: dragRef.current.startPosX + (me.clientX - dragRef.current.startX),
        y: dragRef.current.startPosY + (me.clientY - dragRef.current.startY),
      });
    };
    const handleUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  }, [position]);

  // Don't render in production
  if (typeof import.meta !== 'undefined' && (import.meta as any).env?.PROD) return null;

  // Collapsed — a single 30×30 puck at the same bottom-center spot
  // (respecting any drag offset). The dot stays red while recording so
  // the state is visible even when the bar is closed. Click → expand.
  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        title="Open debug toolbar"
        style={{
          position: 'fixed',
          // Anchored bottom-LEFT (just clear of the 308px left menu +
          // panel) instead of bottom-center, so it sits beside the
          // bottom toolbar rather than covering the centred canvas UI.
          bottom: 80 - position.y,
          left: 320 + position.x,
          zIndex: 999999,
          width: 30,
          height: 30,
          padding: 0,
          borderRadius: 8,
          background: recording ? '#1c1017' : '#18181b',
          border: `1px solid ${recording ? '#7f1d1d' : '#333'}`,
          boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            width: 12,
            height: 12,
            borderRadius: recording ? 3 : 6,
            background: recording ? '#ef4444' : '#52525b',
            transition: 'border-radius 0.15s',
          }}
        />
      </button>
    );
  }

  return (
    <div
      style={{
        position: 'fixed',
        // Bottom-LEFT anchored (clear of the 308px left menu + panel) —
        // matches the collapsed puck's position so expand/collapse
        // doesn't jump.
        bottom: 80 - position.y,
        left: 320 + position.x,
        zIndex: 999999,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 8px',
        background: recording ? '#1c1017' : '#18181b',
        border: `1px solid ${recording ? '#7f1d1d' : '#333'}`,
        borderRadius: 8,
        fontSize: 11,
        fontFamily: 'monospace',
        color: '#a1a1aa',
        userSelect: 'none',
        boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
      }}
    >
      {/* Grip handle */}
      <div
        onMouseDown={handleMouseDown}
        style={{
          cursor: 'grab',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          padding: '4px 2px',
          marginRight: 2,
        }}
        title="Drag to move"
      >
        <div style={{ width: 12, height: 2, backgroundColor: '#555', borderRadius: 1 }} />
        <div style={{ width: 12, height: 2, backgroundColor: '#555', borderRadius: 1 }} />
        <div style={{ width: 12, height: 2, backgroundColor: '#555', borderRadius: 1 }} />
      </div>

      {/* Record / Stop button */}
      <button
        onClick={handleRecord}
        title={recording ? 'Stop recording & download' : 'Start recording'}
        style={{
          width: 20, height: 20,
          borderRadius: recording ? 4 : 10,
          border: 'none',
          background: recording ? '#ef4444' : '#dc2626',
          cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'border-radius 0.15s',
        }}
      >
        {recording ? (
          // Stop icon (square)
          <div style={{ width: 8, height: 8, background: '#fff', borderRadius: 1 }} />
        ) : (
          // Record icon (circle)
          <div style={{ width: 10, height: 10, background: '#fff', borderRadius: 5 }} />
        )}
      </button>

      {/* Status */}
      {recording ? (
        <span style={{ color: '#ef4444', fontWeight: 600, minWidth: 80 }}>
          REC {entryCount > 0 ? `(${entryCount})` : ''}
        </span>
      ) : (
        <span style={{ color: '#71717a', minWidth: 80 }}>Debug</span>
      )}

      {/* Dump to console */}
      <button
        onClick={handleDump}
        title="Dump last 100 entries to console"
        style={btnStyle}
      >
        Console
      </button>

      {/* Save trace to file */}
      <button
        onClick={handleSave}
        title="Save trace to debug-trace.json"
        style={btnStyle}
      >
        Save
      </button>

      {/* Save code snapshot */}
      <button
        onClick={() => saveDebugCode(codeRef.current)}
        title="Save current code to debug-code.jsx"
        style={btnStyle}
      >
        Code
      </button>

      {/* Clear */}
      <button
        onClick={handleClear}
        title="Clear trace buffer"
        style={btnStyle}
      >
        Clear
      </button>

      {/* Separator */}
      <div style={{ width: 1, height: 16, backgroundColor: '#3f3f46' }} />

      {/* Copy Node (selected element only, no children) */}
      <button
        onClick={() => {
          if (!selectedId) return;
          const jsx = extractNodeJSX(codeRef.current, selectedId, false);
          if (jsx) { navigator.clipboard.writeText(jsx); trace.action('debug-toolbar:copy-node', { nodeId: selectedId, withChildren: false, chars: jsx.length }); }
          else trace.error('debug-toolbar:copy-node-failed', { nodeId: selectedId });
        }}
        title={selectedId ? `Copy "${selectedId}" (tag only)` : 'Select a node first'}
        style={{ ...btnStyle, opacity: selectedId ? 1 : 0.4 }}
      >
        Copy
      </button>

      {/* Copy Full (selected element + all children) */}
      <button
        onClick={() => {
          if (!selectedId) return;
          const jsx = extractNodeJSX(codeRef.current, selectedId, true);
          if (jsx) { navigator.clipboard.writeText(jsx); trace.action('debug-toolbar:copy-node', { nodeId: selectedId, withChildren: true, chars: jsx.length }); }
          else trace.error('debug-toolbar:copy-node-failed', { nodeId: selectedId });
        }}
        title={selectedId ? `Copy "${selectedId}" (with children)` : 'Select a node first'}
        style={{ ...btnStyle, opacity: selectedId ? 1 : 0.4 }}
      >
        Full
      </button>

      {/* Separator */}
      <div style={{ width: 1, height: 16, backgroundColor: '#3f3f46' }} />

      {/* Stress test buttons */}
      <button
        onClick={() => { const t0 = performance.now(); setCode(generateStressTestJSX(100)); trace.action('debug-toolbar:stress-test', { nodes: 100, ms: +(performance.now()-t0).toFixed(1) }); }}
        title="Inject 100 nodes (300 elements)"
        style={btnStyle}
      >
        100
      </button>
      <button
        onClick={() => { const t0 = performance.now(); setCode(generateStressTestJSX(500)); trace.action('debug-toolbar:stress-test', { nodes: 500, ms: +(performance.now()-t0).toFixed(1) }); }}
        title="Inject 500 nodes (1500 elements)"
        style={btnStyle}
      >
        500
      </button>
      <button
        onClick={() => { const t0 = performance.now(); setCode(generateStressTestJSX(1600)); trace.action('debug-toolbar:stress-test', { nodes: 1600, ms: +(performance.now()-t0).toFixed(1) }); }}
        title="Inject 1600 nodes (~your real builder size)"
        style={{ ...btnStyle, color: '#ef4444' }}
      >
        1600
      </button>

      {/* Separator */}
      <div style={{ width: 1, height: 16, backgroundColor: '#3f3f46' }} />

      {/* Reset to default template */}
      <button
        onClick={() => {
          const defaults = createDefaultProject();
          resetProjectFS(defaults);
          // Active file might point to a page that no longer exists in the
          // freshly-seeded FS (e.g. user was editing a route-group page that
          // the reset wiped). Snap back to app/page.tsx — guaranteed to
          // exist in both default and empty seeds.
          setActiveFile('app/page.tsx');
          const mainPage = defaults.get('app/page.tsx') || '';
          setCode(mainPage);
          // Bump projectVersion so the FileExplorer (and anything else
          // memoizing on `stableProjectVersionAtom`) re-reads the now-
          // replaced projectFS. Without this the explorer keeps the stale
          // tree from before the reset.
          setProjectVersion(v => v + 1);
          trace.action('debug-toolbar:inject-default', { fileCount: defaults.size });
        }}
        title="Reset to default template (overwrites everything)"
        style={{ ...btnStyle, color: '#f59e0b' }}
      >
        Default
      </button>

      {/* Reset to empty starter — same files the dashboard's
          "Create New Website" flow seeds with. Empty Desktop viewport,
          layout/providers/globals/lib runtime helpers only. */}
      <button
        onClick={() => {
          const empty = createEmptyProject();
          resetProjectFS(empty);
          setActiveFile('app/page.tsx');
          const mainPage = empty.get('app/page.tsx') || '';
          setCode(mainPage);
          setProjectVersion(v => v + 1);
          trace.action('debug-toolbar:inject-empty', { fileCount: empty.size });
        }}
        title="Reset to empty starter (same as a fresh website)"
        style={{ ...btnStyle, color: '#10b981' }}
      >
        Empty
      </button>

      {/* Collapse — folds the bar back to the single puck. */}
      <button
        onClick={() => setCollapsed(true)}
        title="Collapse debug toolbar"
        style={{ ...btnStyle, padding: '2px 6px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <path d="M1 1L9 9M9 1L1 9" />
        </svg>
      </button>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  background: '#27272a',
  border: '1px solid #3f3f46',
  borderRadius: 4,
  color: '#a1a1aa',
  fontSize: 10,
  padding: '2px 8px',
  cursor: 'pointer',
  fontFamily: 'monospace',
};
