// ComponentChat.tsx — Chat UI for AI-powered code component editing.
// Uses streaming: code fills into Monaco live as the AI generates it.
// Thin wrapper around the shared `ChatShell` — supplies the
// component-chat stream client, the copy, and the component editor's
// streaming/thinking atoms.

import { useSetAtom, useAtomValue } from 'jotai';
import { componentChatStream } from '@/ai/component-chat-client';
import { componentEditorStreamingAtom, componentEditorThinkingAtom, componentEditorFileAtom } from '@/code/stores/component-editor-store';
import ChatShell from '@/editor/ui/ChatShell';

interface ComponentChatProps {
  code: string;
  onCodeChange: (code: string) => void;
}

export default function ComponentChat({ code, onCodeChange }: ComponentChatProps) {
  const setStreaming = useSetAtom(componentEditorStreamingAtom);
  const setThinking = useSetAtom(componentEditorThinkingAtom);
  const componentFilePath = useAtomValue(componentEditorFileAtom);

  return (
    <ChatShell
      code={code}
      onCodeChange={onCodeChange}
      filePath={componentFilePath}
      chatStream={componentChatStream}
      sendTraceName="component-chat:send"
      renderTraceName="ComponentChat.render"
      clearTraceName="component-chat:clear"
      doneFallbackText="Code updated"
      emptyState={<>Describe what you want to change.<br />The AI will update the code.</>}
      loadingLabel="Writing code..."
      idlePlaceholder="Describe changes..."
      loadingPlaceholder="Generating..."
      onStreamingChange={setStreaming}
      onThinkingChange={setThinking}
    />
  );
}
