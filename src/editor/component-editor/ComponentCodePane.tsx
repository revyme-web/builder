// ComponentCodePane.tsx — Left side of Component Editor: Monaco editor.
// Saves on Cmd+S. Read-only while the agent is running a turn: it writes this FILE, and
// the overlay adopts the file only when the buffer has no edits of its own — typing during
// a run would make the buffer win and silently discard what the agent just wrote.

import { useCallback, useRef, useEffect } from 'react';
import { useAtomValue } from 'jotai';
import Editor, { type OnMount } from '@monaco-editor/react';
import { agentStatusAtom } from '@/code/stores/agent-chat-store';
import { useIsDark } from '@/shared/useIsDark';
import { trace } from '@/shared/debug-trace';

interface ComponentCodePaneProps {
  code: string;
  onChange: (code: string) => void;
  onSave: () => void;
}

export default function ComponentCodePane({ code, onChange, onSave }: ComponentCodePaneProps) {
  const editorRef = useRef<any>(null);
  const agentRunning = useAtomValue(agentStatusAtom) === 'running';
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

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.updateOptions({ readOnly: agentRunning });
  }, [agentRunning]);

  return (
    <div className="relative flex flex-col h-full">
      <div style={agentRunning ? { opacity: 0.85 } : undefined} className="flex-1 min-h-0">
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

    </div>
  );
}
