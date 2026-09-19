// PageChat.tsx — the VIBE surface for a page or design-component master.
//
// Chrome only. It picks the shell — docked `VibeDockShell` (the VIBE slot in
// the left toolbar) or detached `AIChatSheet` (the floating panel) — and
// renders the shared `AgentChat` inside it.
//
// The body used to be a self-contained freeform loop that called the AI
// service directly and wrote whole files back. That is gone: the agent now
// runs in ai-generator, edits through the builder's own semantic tools over
// the MCP bridge, and every write passes the oracle. Keeping a second,
// divergent chat implementation here would mean two dialects, two failure
// modes and two things to teach.

import { useAtomValue, useSetAtom } from 'jotai';
import { activeFilePathAtom, getFileDisplayName } from '@/code/project/active-file-store';
import { leftPanelAtom } from '@/code/stores/left-panel-store';
import {
  aiChatDetachedAtom, aiChatSheetOpenAtom, detachAiChatAtom, dockAiChatAtom,
} from '@/code/stores/editor-store';
import AIChatSheet from './AIChatSheet';
import VibeDockShell from './VibeDockShell';
import CreditsIndicator from './CreditsIndicator';
import AgentChat from './agent/AgentChat';
import { trace } from '@/shared/debug-trace';

export default function PageChat() {
  const activeFilePath = useAtomValue(activeFilePathAtom);
  const detached = useAtomValue(aiChatDetachedAtom);
  const sheetOpen = useAtomValue(aiChatSheetOpenAtom);
  const leftPanel = useAtomValue(leftPanelAtom);
  const detach = useSetAtom(detachAiChatAtom);
  const dock = useSetAtom(dockAiChatAtom);

  // Docked in the VIBE panel vs detached into the floating popup.
  const open = detached ? sheetOpen : leftPanel === 'vibe';
  if (!open) return null;

  trace.fn('PageChat.render', { detached, activeFilePath });
  const label = getFileDisplayName(activeFilePath);

  return detached ? (
    <AIChatSheet headerAccessory={<CreditsIndicator />} contextLabel={label} onClose={dock}>
      <AgentChat />
    </AIChatSheet>
  ) : (
    <VibeDockShell headerAccessory={<CreditsIndicator />} contextLabel={label} onDetach={detach}>
      <AgentChat />
    </VibeDockShell>
  );
}
