// ComponentCodePane.tsx — Left side of Component Editor: Monaco editor.
// Saves on Cmd+S. During AI streaming: read-only + auto-scrolls to bottom + loader overlay.

import { useCallback, useRef, useEffect } from 'react';
import { useAtomValue } from 'jotai';
import Editor, { type OnMount } from '@monaco-editor/react';
import { componentEditorStreamingAtom, componentEditorThinkingAtom } from '@/code/stores/component-editor-store';
import { useIsDark } from '@/shared/useIsDark';
import { trace } from '@/shared/debug-trace';

interface ComponentCodePaneProps {
  code: string;
  onChange: (code: string) => void;
  onSave: () => void;
}

export default function ComponentCodePane({ code, onChange, onSave }: ComponentCodePaneProps) {
  const editorRef = useRef<any>(null);
  const streaming = useAtomValue(componentEditorStreamingAtom);
  const thinking = useAtomValue(componentEditorThinkingAtom);
  const isDark = useIsDark();

  const handleMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;

    editor.addCommand(
      2048 | 49,
      () => {
        trace.action('component-editor:save');
        onSave();
      }
    );

    const monaco = (window as any).monaco;
    if (monaco?.languages?.typescript) {
      const opts = { noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true };
      monaco.languages.typescript.typescriptDefaults?.setDiagnosticsOptions(opts);
      monaco.languages.typescript.javascriptDefaults?.setDiagnosticsOptions(opts);
    }
  }, [onSave]);

  // Toggle read-only when streaming state changes
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.updateOptions({ readOnly: streaming });
  }, [streaming]);

  // Auto-scroll to bottom during streaming when code changes
  useEffect(() => {
    if (!streaming) return;
    const editor = editorRef.current;
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;
    const lineCount = model.getLineCount();
    editor.revealLine(lineCount, 1);
  }, [streaming, code]);

  return (
    <div className="relative flex flex-col h-full">
      <div style={streaming ? { opacity: thinking ? 0.3 : 0.85, pointerEvents: 'none' } : undefined} className="flex-1 min-h-0">
        <Editor
          height="100%"
          defaultLanguage="javascript"
          theme={isDark ? 'vs-dark' : 'vs'}
          value={code}
          onChange={(val) => onChange(val ?? '')}
          onMount={handleMount}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            tabSize: 2,
            padding: { top: 8 },
            automaticLayout: true,
            renderLineHighlight: 'line',
            bracketPairColorization: { enabled: true },
            guides: { indentation: true },
          }}
        />
      </div>

      {/* Loader overlay — only during thinking phase (before first chunk) */}
      {thinking && <StreamingOverlay />}
    </div>
  );
}

function StreamingOverlay() {
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{ zIndex: 10 }}>
      <style>{`
        @keyframes __ce_pulse {
          0% { transform: scale(0); opacity: 1; }
          100% { transform: scale(1); opacity: 0; }
        }
      `}</style>
      <div style={{ width: 48, height: 48, position: 'relative' }}>
        <div style={{
          position: 'absolute', inset: 0,
          borderRadius: '50%',
          background: '#7C3AED',
          animation: '__ce_pulse 2s linear infinite',
        }} />
        <div style={{
          position: 'absolute', inset: 0,
          borderRadius: '50%',
          background: '#7C3AED',
          animation: '__ce_pulse 2s linear infinite 1s',
        }} />
      </div>
    </div>
  );
}
