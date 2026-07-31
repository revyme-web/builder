// hoist-context.tsx — React context for surfacing the "Hoist Variable"
// menu item on ControlLabel chevrons without prop-drilling.
//
// Why a context: a prop row in `ComponentPropsTool.tsx` for a rich atom
// (Background / Shadow / Filter / ...) renders a compound editor like
// `FillControl` which has its OWN internal `<ControlLabel>`. The chevron
// the user wants to extend lives INSIDE that compound editor — we can't
// reach it via props from ComponentPropsTool without forking every atom
// to forward extraMenuItems.
//
// The context is a one-shot value the row-level component sets; every
// `<ControlLabel>` descendant in that subtree merges the item into its
// own menu automatically. Outside this context (e.g. style controls in
// the main StylesTool, or page-level instance editors) the context is
// null and no Hoist item appears — same as before.

import React, { createContext, useContext } from 'react';
import type { MenuItem } from './control-menu-items';

const HoistMenuItemContext = createContext<MenuItem | MenuItem[] | null>(null);

export function HoistMenuItemProvider({ item, children }: {
  /** One item (the common "Hoist/Create Variable" case) or several — e.g. a code-component control
   *  row offers BOTH "Create Variable" and a "Set Variable" submenu of existing typed variables. */
  item: MenuItem | MenuItem[] | null;
  children: React.ReactNode;
}) {
  return (
    <HoistMenuItemContext.Provider value={item}>
      {children}
    </HoistMenuItemContext.Provider>
  );
}

/**
 * Read the ambient hoist menu items — `[]` outside a provider. Normalises the single-or-array context
 * value so callers (ControlLabel) can always spread. Used to merge items into the chevron menu when the
 * row was wrapped in a `HoistMenuItemProvider`.
 */
export function useHoistMenuItems(): MenuItem[] {
  const v = useContext(HoistMenuItemContext);
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

/**
 * Back-compat single-item accessor — returns the FIRST hoist item (or null). Callers that only need to
 * know whether a hoist item is present (e.g. ToolRow's `!!hoistItem` delegate-to-ControlLabel check) or
 * that only ever set a single item keep working unchanged. ControlLabel uses `useHoistMenuItems` to
 * surface ALL of them (a code-component row sets both Create + Set Variable).
 */
export function useHoistMenuItem(): MenuItem | null {
  return useHoistMenuItems()[0] ?? null;
}
