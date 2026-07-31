// PluginChat.tsx — chat UI for AI-powered plugin authoring.
//
// Mirrors `ComponentChat.tsx` exactly — both are thin wrappers around
// the shared `ChatShell` (single-line input, streaming code into the
// editor, message history, abort, clear) — this one just hits the
// plugin-chat endpoint whose system prompt has the full Revyme plugin
// SDK context. Plugin authors describe a plugin in plain English,
// watch it write itself into the Monaco editor, then hit Run.
//
// Lives at the bottom of the preview pane in `PluginEditor.tsx`.

import { useAtomValue } from 'jotai';
import { pluginChatStream } from '@/ai/plugin-chat-client';
import { pluginEditorFileAtom } from './plugin-editor-store';
import ChatShell from '@/editor/ui/ChatShell';

interface PluginChatProps {
  code: string;
  onCodeChange: (code: string) => void;
}

export default function PluginChat({ code, onCodeChange }: PluginChatProps) {
  const pluginFilePath = useAtomValue(pluginEditorFileAtom);

  return (
    <ChatShell
      code={code}
      onCodeChange={onCodeChange}
      filePath={pluginFilePath}
      chatStream={pluginChatStream}
      sendTraceName="plugin-chat:send"
      doneFallbackText="Plugin updated"
      emptyState={<>Describe a plugin or a change.<br />The AI knows the full Revyme SDK and will write the code.</>}
      loadingLabel="Writing plugin…"
      idlePlaceholder="Describe a plugin…"
      loadingPlaceholder="Generating…"
    />
  );
}
