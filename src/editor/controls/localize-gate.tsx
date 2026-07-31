// localize-gate.tsx — ancestor gate that suppresses the "Localize" menu item
// on every ControlLabel beneath it. Animation-tool rows (Appear/Scroll/Hover/
// Tap/Transition…) are motion props, not CSS — :lang() localization is
// meaningless there (user request 2026-07-22). Mirrors CreateVariableGate.

import { createContext, useContext, type ReactNode } from 'react';

const LocalizeGateContext = createContext(false);

export function LocalizeGate({ hidden, children }: { hidden: boolean; children: ReactNode }) {
  return <LocalizeGateContext.Provider value={hidden}>{children}</LocalizeGateContext.Provider>;
}

export function useLocalizeHidden(): boolean {
  return useContext(LocalizeGateContext);
}
