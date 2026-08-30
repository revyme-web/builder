// ComponentPreviewPane.tsx — Center column of Component Editor: preview (top) + AI chat (bottom).
// Compiles the component TSX via code-component-runtime and renders it live.

import React, { useState, useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { useAtomValue } from 'jotai';
import { componentEditorPropsAtom } from '@/code/stores/component-editor-store';
import { compileCodeComponent } from '@/canvas/code-component-runtime';
import ComponentChat from './ComponentChat';
import CreditsIndicator from '../CreditsIndicator';
import { trace } from '@/shared/debug-trace';
import VibeComingSoonGate from '@/editor/ui/VibeComingSoonGate';

interface ComponentPreviewPaneProps {
  code: string;
  fileName: string;
  liveCode: string;
  onCodeChange: (code: string) => void;
}

export default function ComponentPreviewPane({ code, fileName, liveCode, onCodeChange }: ComponentPreviewPaneProps) {
  const props = useAtomValue(componentEditorPropsAtom);
  const [error, setError] = useState<string | null>(null);
  const [CompiledComponent, setCompiledComponent] = useState<React.ComponentType<any> | null>(null);

  // Compile the component whenever code changes
  useEffect(() => {
    if (!code || code.length < 10) {
      setCompiledComponent(null);
      return;
    }
    try {
      const componentName = fileName.replace('components/', '').replace('.tsx', '');
      const Component = compileCodeComponent(code, componentName, { previewMode: true });
      if (Component) {
        setCompiledComponent(() => Component);
        setError(null);
        trace.action('component-editor:compile-success', { componentName });
      } else {
        setError('Compilation returned null');
      }
    } catch (err: any) {
      setError(err.message || 'Compilation error');
      trace.error('component-editor:compile-error', err);
    }
  }, [code, fileName]);

  // Force refresh
  const handleRefresh = useCallback(() => {
    setCompiledComponent(null);
    setError(null);
    requestAnimationFrame(() => {
      try {
        const componentName = fileName.replace('components/', '').replace('.tsx', '');
        const Component = compileCodeComponent(code, componentName, { previewMode: true });
        if (Component) {
          setCompiledComponent(() => Component);
          setError(null);
        } else {
          setError('Compilation returned null');
        }
      } catch (err: any) {
        setError(err.message || 'Compilation error');
      }
    });
  }, [code, fileName]);

  const [chatHeight, setChatHeight] = useState(200);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const handleChatDragStart = useCallback((e: ReactPointerEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    const container = containerRef.current;
    if (!container) return;
    const startY = e.clientY;
    const startHeight = chatHeight;

    const onMove = (ev: globalThis.PointerEvent) => {
      if (!draggingRef.current) return;
      const containerH = container.getBoundingClientRect().height;
      const delta = startY - ev.clientY;
      setChatHeight(Math.max(100, Math.min(containerH * 0.7, startHeight + delta)));
    };
    const onUp = () => {
      draggingRef.current = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [chatHeight]);

  trace.fn('ComponentPreviewPane.render', { fileName, hasComponent: !!CompiledComponent, hasError: !!error, codeLen: code?.length, propCount: Object.keys(props).length });

  return (
    <div ref={containerRef} className="flex flex-col h-full">
      {/* Preview header */}
      <div className="flex items-center justify-between px-3 h-9 border-b border-[var(--border-light)] shrink-0">
        <span className="text-[11px] font-semibold text-[var(--text-secondary)]">Preview</span>
        <button
          onClick={handleRefresh}
          className="w-6 h-6 flex items-center justify-center cut-corners hover:bg-[var(--bg-hover)] text-[var(--text-disabled)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
          title="Refresh preview"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>
      </div>

      {/* Preview area — fills all available space */}
      <div className="flex-1 min-h-0 bg-[var(--bg-tertiary)] overflow-hidden relative">
        {error ? (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <div className="max-w-md p-4 cut-corners cut-border bg-red-500/10 border border-red-500/20">
              <p className="text-[11px] font-semibold text-red-400 mb-1">Compilation Error</p>
              <pre className="text-[10px] text-red-300/80 whitespace-pre-wrap font-mono leading-relaxed max-h-40 overflow-auto">{error}</pre>
            </div>
          </div>
        ) : CompiledComponent ? (
          <ErrorBoundary key={code + JSON.stringify(props)}>
            <div style={{ position: 'absolute', inset: 0 }}>
              <CompiledComponent
                {...props}
                style={{ width: '100%', height: '100%' }}
                data-id="component-preview"
                data-name="preview"
              />
            </div>
          </ErrorBoundary>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-[var(--text-disabled)]">
            {code ? 'Compiling...' : 'Save code to preview (\u2318S)'}
          </div>
        )}
      </div>

      {/* AI Chat — bottom with drag handle + collapse */}
      <div className="relative shrink-0 border-t border-[var(--border-light)] flex flex-col" style={{ height: chatCollapsed ? 28 : chatHeight }}>
        {/* Drag handle + header */}
        <div className="shrink-0 flex items-center h-7 select-none">
          <div className="flex items-center gap-1.5 pl-3 shrink-0 leading-none">
            <span className="text-[11px] font-semibold text-[var(--text-secondary)]">AI Chat</span>
            <CreditsIndicator />
          </div>
          <div
            onPointerDown={handleChatDragStart}
            className="flex-1 h-full flex items-center justify-center cursor-row-resize"
          >
            <svg width="20" height="6" viewBox="0 0 20 6" className="text-[var(--text-disabled)]">
              <circle cx="4" cy="3" r="1.2" fill="currentColor" />
              <circle cx="10" cy="3" r="1.2" fill="currentColor" />
              <circle cx="16" cy="3" r="1.2" fill="currentColor" />
            </svg>
          </div>
          <button
            onClick={() => setChatCollapsed(!chatCollapsed)}
            className="shrink-0 px-2 h-full text-[10px] text-[var(--text-disabled)] hover:text-[var(--text-secondary)] transition-colors cursor-pointer"
          >
            {chatCollapsed ? 'Show' : 'Hide'}
          </button>
        </div>

        {/* Chat content — hidden when collapsed */}
        {!chatCollapsed && (
          <div className="flex-1 min-h-0">
            <ComponentChat code={liveCode} onCodeChange={onCodeChange} />
          </div>
        )}

        {/* Whole-section gate (AI Chat strip + credits included) while the
            in-house agent is offline (see VibeComingSoonGate). */}
        <VibeComingSoonGate />
      </div>
    </div>
  );
}

// ─── Error Boundary ─────────────────────────────────────────────────────────

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: string | null }> {
  state = { error: null as string | null };

  static getDerivedStateFromError(err: Error) {
    return { error: err.message };
  }

  componentDidUpdate(prevProps: any) {
    if (prevProps.children !== this.props.children && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="max-w-md p-4 cut-corners cut-border bg-red-500/10 border border-red-500/20">
          <p className="text-[11px] font-semibold text-red-400 mb-1">Render Error</p>
          <pre className="text-[10px] text-red-300/80 whitespace-pre-wrap font-mono max-h-40 overflow-auto">{this.state.error}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}
