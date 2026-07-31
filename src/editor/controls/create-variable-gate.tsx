// create-variable-gate.tsx — ambient "Create Variable" suppression.
// Wrap a subtree to hide the ControlLabel chevron-menu "Create Variable" item
// for every control inside it, without threading a `hideCreateVariable` prop
// through each atom. Used by the Text tool: only Content / Color / Font Size
// may become variables, so the section wraps everything in `hidden` and the
// three allowed controls override with `hidden={false}`.

import { createContext, useContext, type ReactNode } from 'react';

const CreateVariableGateContext = createContext(false);

export function CreateVariableGate({ hidden, children }: { hidden: boolean; children: ReactNode }) {
  return <CreateVariableGateContext.Provider value={hidden}>{children}</CreateVariableGateContext.Provider>;
}

/** True when an ancestor gate has suppressed "Create Variable". */
export function useCreateVariableHidden(): boolean {
  return useContext(CreateVariableGateContext);
}
