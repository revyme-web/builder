// LibraryUsageBadge — the "N uses" badge for a Library row (component / code
// component / vector set). Reads the project-wide usage index directly from
// `componentUsageAtom` (one memoized scan shared by every row) and reuses the
// preset panel's `UsageBadge` + `UsagePopup` — which already list each instance
// (label + file path) and navigate/zoom to it, including instances that live
// inside other component master files.
//
// Self-hides when the entry has zero instances (UsageBadge returns null at
// count 0), so unused rows are visually unchanged.

import React from 'react';
import { useAtomValue } from 'jotai';
import { componentUsageAtom } from '@/code/stores/library-usage-store';
import { UsageBadge } from '../presets/UsagePopup';

export const LibraryUsageBadge = React.memo(function LibraryUsageBadge({ filePath }: { filePath: string }) {
  const usageMap = useAtomValue(componentUsageAtom);
  const usages = usageMap.get(filePath) ?? [];
  return <UsageBadge count={usages.length} usages={usages} />;
});
