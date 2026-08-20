// CursorTool.tsx — Cursor section in the right properties panel.
//
// Two flavors: a CSS `cursor` property picker (Web), and a component cursor
// that follows the mouse on hover (Component, see lib/cursor-runtime.tsx
// inside projectFS). The `+` button opens a dropdown to choose a flavor; the
// `−` button strips whichever is active.
//
// Web cursor uses the existing inline-style write path. Component cursor
// goes through src/code/generation/cursor-gen.ts which manages imports,
// the spread call, and the one-time `<CursorPortal />` mount in layout.tsx.

import { useCallback, useState, useRef, useEffect, useMemo } from 'react';
import { useClickOutside } from '../hooks/useClickOutside';
import { createPortal } from 'react-dom';
import { useAtomValue, useSetAtom } from 'jotai';
import { ToolSection, ToolSelect, ToolSegmentedControl, ToolInput, ControlLabel, ControlActionRow } from '../controls';
import { CURSOR_ICONS, cursorLabel } from './CursorTool/cursor-icons';
import { CursorPickerGrid } from './CursorTool/cursor-picker-grid';
import { useControl } from '../controls/ControlProvider';
import ToolPopup, { useToolPopup } from '../ui/ToolPopup';
import TransitionPanel from './AnimationTool/TransitionPanel';
import { summarizeTransition, TransitionCurveIcon } from './AnimationTool/CurvePreview';
import { stableCodeAtom as codeAtom, variableModalRequestAtom } from '@/code/stores/store';
import { activeFilePathAtom, isComponentFilePath } from '@/code/project/active-file-store';
import { projectFS, stableProjectVersionAtom as projectVersionAtom } from '@/code/project/project-fs';
import { modifyProjectFile } from '@/code/project/modify-file';
import { flushNow } from '@/code/mutation/mutation-queue';
import { parseVariantConfig } from '@/code/variants/variant-config';
import { getComponentDisplayName } from '@/code/components/component-ops';
import { buildComponentRegistry, type ComponentProp } from '@/code/components/component-registry';
import { setPropTypeInCode } from '@/code/components/prop-meta';
import { VariableTypeIcon } from '../controls/VariableTypeIcon';
import {
  addComponentCursorInCode,
  updateComponentCursorInCode,
  removeComponentCursorInCode,
  ensureCursorPortalInLayout,
  type AddComponentCursorOpts,
} from '@/code/generation/cursor-gen';
import { getComponentCursorForNode, type CursorTransition, type CursorSide, type CursorAlign } from '@/code/parsing/cursor-parser';
import { addBarePropToFunctionInCode } from '@/code/features/variable-ops';
import { ensureLayoutFile } from '@/code/generation/metadata-gen';
import VariableModal from '../ui/VariableModal';
import { LegacyVariableBoundPill } from '../controls/VariableBoundPill';
import { removeComponentCursorProjectWide } from '@/code/features/remove-component-cursor';
import { trace } from '@/shared/debug-trace';
import { AlignStartIcon, AlignCenterIcon, AlignEndIcon } from '@/shared/icons';

// CURSOR_OPTIONS removed — we now show every CSS cursor in a grid picker
// (see WebCursorRow / CursorPickerPanel below). The full list lives in
// CURSOR_NAMES from ./CursorTool/cursor-icons.

const MODE_OPTIONS = [
  { value: 'follow', label: 'Follow' },
  { value: 'replace', label: 'Replace' },
];

// Positioning options (Follow mode only — Replace auto-centers on the mouse).
const SIDE_OPTIONS = [
  { value: 'bottom', label: 'Bottom' },
  { value: 'top', label: 'Top' },
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
];

// Icon-only options — text labels would force the segmented control
// past the popup's right-side cell (3 buttons × `Start`/`Center`/`End`
// labels + per-button padding overflow what `Mode` and `Enter / Exit`
// fit at default size). Icons depict the cursor anchor's position
// along its track, matching the segmented control's icon-supporting
// `Option` shape.
const ALIGN_OPTIONS = [
  { value: 'start', icon: <AlignStartIcon /> },
  { value: 'center', icon: <AlignCenterIcon /> },
  { value: 'end', icon: <AlignEndIcon /> },
];

type Flavor = 'web' | 'component';

/**
 * Mount `<CursorPortal />` in the root layout so component cursors actually
 * render in preview. The portal is the single host the runtime's global
 * cursor store pushes into — without it, `withCursor`'s onMouseEnter fires
 * but there's nowhere to draw the cursor, so nothing appears on hover.
 *
 * Critically: `app/layout.tsx` may NOT exist yet (a project created without
 * the default layout seed). `modifyProjectFile` is a no-op on a missing file
 * (it returns null before running the transform), so we must CREATE the
 * layout first — otherwise the portal mount silently does nothing and the
 * cursor never shows. The preview's router only adds a layout to the chain
 * when its `layout.tsx` exists in projectFS, so creating it here is also what
 * makes the preview pick the portal up.
 */
function mountCursorPortal(): void {
  if (!projectFS.exists('app/layout.tsx')) {
    projectFS.writeFile('app/layout.tsx', ensureLayoutFile());
    trace.action('cursor-tool:create-layout-for-portal', {});
  }
  modifyProjectFile('app/layout.tsx', (c) => ensureCursorPortalInLayout(c));
}

export default function CursorTool() {
  const { node, nodeId, styles, updateStyle, getValueSource, removeVariable } = useControl();
  const code = useAtomValue(codeAtom);
  const activeFile = useAtomValue(activeFilePathAtom);
  // Re-read on every project version bump so cursor changes elsewhere reflect.
  useAtomValue(projectVersionAtom);

  const componentCursor = useMemo(() => {
    if (!nodeId || !code) return null;
    return getComponentCursorForNode(code, nodeId);
  }, [nodeId, code]);

  // Inside a component master, clicking + → Component drops in a
  // PLACEHOLDER cursor row instead of writing any JSX yet. The row's
  // right-side "Add" button then surfaces the Create / Set Variable
  // menu — the actual cursor binding only lands when the user picks a
  // variable. Matches the user's standard expectation: "click
  // Component, see the row, choose how to fill it." The pending state
  // is per-selection and resets when we navigate away.
  const [pending, setPending] = useState(false);
  useEffect(() => {
    // Reset when the selected node changes — pending state must not bleed
    // across selections (different node id → different cursor target).
    setPending(false);
  }, [nodeId]);

  const isInComponentMaster = isComponentFilePath(activeFile);

  // Is the CSS `cursor` bound to a component variable? (e.g. `cursor: myCursor`.) If so the web cursor
  // row renders the purple variable pill instead of the cursor picker — same as every other style.
  const cursorVarSource = getValueSource('cursor');
  const cursorIsVariable = cursorVarSource.source === 'prop' && !!cursorVarSource.ref;
  const webCursorActive = cursorIsVariable || (!!styles.cursor && styles.cursor !== 'auto' && styles.cursor !== 'default');
  const flavor: Flavor | null = componentCursor ? 'component' : webCursorActive ? 'web' : null;
  const showPending = flavor === null && pending && isInComponentMaster;

  trace.fn('CursorTool:render', { nodeId, flavor, pending: showPending });

  if (!node || !nodeId) return null;

  // Once a real cursor is written, the pending placeholder is no longer
  // meaningful — clear it so the row stops trying to render as "pending".
  // This handles the success path from PendingCursorRow's Create Variable
  // flow that lands a real `withCursor(...)` call in code.
  if (flavor !== null && pending) {
    setPending(false);
  }

  return (
    <ToolSection
      title="Cursor"
      collapsible
      hasContent={flavor !== null || showPending}
      action={
        flavor !== null
          ? <CursorRemoveButton nodeId={nodeId} flavor={flavor} updateStyle={updateStyle} />
          : showPending
            // While the placeholder row is showing, the section header's `-`
            // button just clears the pending state — there's no JSX to remove
            // yet, so going through the regular cursor-removal path would
            // be a no-op anyway.
            ? <button
                onClick={() => setPending(false)}
                className="flex items-center justify-end pl-[80px] -ml-[80px] cursor-pointer group text-[var(--text-primary)]"
                title="Cancel"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="transition-opacity group-hover:opacity-80">
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
            : <CursorAddButton nodeId={nodeId} onPending={() => setPending(true)} />
      }
    >
      {flavor === 'web' && (
        cursorIsVariable ? (
          <div className="flex items-center justify-between w-full">
            <ControlLabel label="Cursor" property="cursor" />
            <LegacyVariableBoundPill
              property="cursor"
              propertyLabel="Cursor"
              variableRef={cursorVarSource.ref!}
              currentValue={styles.cursor || ''}
              removeVariable={removeVariable}
            />
          </div>
        ) : (
          <WebCursorRow value={styles.cursor || 'auto'} onChange={(val) => updateStyle('cursor', val === 'auto' ? '' : val)} />
        )
      )}
      {flavor === 'component' && componentCursor && (
        <ComponentCursorRow nodeId={nodeId} cursor={componentCursor} />
      )}
      {showPending && (
        <PendingCursorRow
          nodeId={nodeId}
          activeFile={activeFile}
          onSatisfied={() => setPending(false)}
        />
      )}
      {flavor === null && !showPending && (
        <span className="text-[10px] text-[var(--text-disabled)]">Click + to add a cursor</span>
      )}
    </ToolSection>
  );
}

// ─── Add button (+ dropdown) ────────────────────────────────────────────────

function CursorAddButton({ nodeId, onPending }: { nodeId: string; onPending: () => void }) {
  const { updateStyle } = useControl();
  const activeFile = useAtomValue(activeFilePathAtom);
  const [open, setOpen] = useState(false);
  const [showComponentPicker, setShowComponentPicker] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const isInComponentMaster = isComponentFilePath(activeFile);

  useClickOutside(ref, open, () => setOpen(false));

  const handleWeb = useCallback(() => {
    setOpen(false);
    updateStyle('cursor', 'pointer');
    // Force the queue to flush in this same frame so the panel re-renders
    // showing the cursor section's content immediately. Without this, on
    // first interaction after page load the mutation goes through
    // requestIdleCallback and idle can take seconds to fire (initial parse,
    // font loads, the iframe still painting) — the user sees the dropdown
    // close but the Cursor row stays empty for 5+ seconds. Same scheduling
    // fix as Layout's +/- toggle.
    flushNow();
    trace.action('cursor-tool:create-web', { nodeId });
  }, [nodeId, updateStyle]);

  const handleComponent = useCallback(() => {
    setOpen(false);
    if (isInComponentMaster) {
      // Master file → drop in a placeholder row. The actual variable
      // wiring happens when the user clicks the row's "Add" button and
      // picks Create / Set Variable. This keeps the JSX clean until the
      // user commits to a variable name — no half-written `withCursor`
      // calls referencing identifiers that don't exist yet.
      trace.action('cursor-tool:create-component-pending', { nodeId });
      onPending();
      return;
    }
    setShowComponentPicker(true);
    trace.action('cursor-tool:create-component', { nodeId });
  }, [nodeId, isInComponentMaster, onPending]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center justify-end pl-[80px] -ml-[80px] cursor-pointer group text-[var(--text-primary)]"
        title="Add cursor"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="transition-opacity group-hover:opacity-80">
          <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setOpen(false)} />
          <div className="absolute right-[10px] top-full mt-1 bg-[var(--dropdown-bg)] shadow-md cut-corners cut-lg cut-border [--cut-border-color:var(--border-light)] py-1.5 z-[51] min-w-[180px] border border-[var(--border-light)]">
            <button
              type="button"
              className="group flex flex-col gap-0.5 mx-1.5 px-2.5 py-1.5 cut-corners w-[calc(100%-12px)] text-left cursor-pointer bg-transparent hover:!bg-[var(--accent)] border-none"
              onClick={handleWeb}
            >
              <div className="text-xs font-medium text-[var(--text-primary)] group-hover:text-[var(--accent-fg)]">Web</div>
              <div className="text-[11px] text-[var(--text-secondary)] group-hover:text-[var(--accent-fg)]/80">CSS cursor</div>
            </button>
            <button
              type="button"
              className="group flex flex-col gap-0.5 mx-1.5 px-2.5 py-1.5 cut-corners w-[calc(100%-12px)] text-left cursor-pointer bg-transparent hover:!bg-[var(--accent)] border-none"
              onClick={handleComponent}
            >
              <div className="text-xs font-medium text-[var(--text-primary)] group-hover:text-[var(--accent-fg)]">Component</div>
              <div className="text-[11px] text-[var(--text-secondary)] group-hover:text-[var(--accent-fg)]/80">
                {isInComponentMaster
                  ? 'Create / Set Variable'
                  : 'Component follows mouse'}
              </div>
            </button>
          </div>
        </>
      )}

      {showComponentPicker && (
        <ComponentCursorPicker
          nodeId={nodeId}
          activeFile={activeFile}
          onClose={() => setShowComponentPicker(false)}
          onCreated={() => {
            setShowComponentPicker(false);
            // modifyProjectFile bumps projectVersion automatically; nothing to do here.
          }}
        />
      )}
    </div>
  );
}

// ─── Remove button ──────────────────────────────────────────────────────────

function CursorRemoveButton({
  nodeId,
  flavor,
  updateStyle,
}: {
  nodeId: string;
  flavor: Flavor;
  updateStyle: (key: string, value: string) => void;
}) {
  const activeFile = useAtomValue(activeFilePathAtom);

  const handle = useCallback(() => {
    trace.action('cursor-tool:remove', { nodeId, flavor });
    if (flavor === 'web') {
      updateStyle('cursor', '');
      flushNow();
      return;
    }
    // Component cursor: rewrite the page file. modifyProjectFile bumps
    // projectVersion which triggers the panel to re-read. We leave the
    // <CursorPortal /> mount in layout alone — it's a no-op when the global
    // store is empty and other pages may still need it.
    // A cursor VARIABLE on a master root also has instances to clean up; the
    // sweep no-ops for a plain (imported-component) cursor, which has none.
    if (removeComponentCursorProjectWide(nodeId)) return;
    modifyProjectFile(activeFile, (c) => removeComponentCursorInCode(c, nodeId));
  }, [nodeId, flavor, activeFile, updateStyle]);

  // Minus icon (matches the +/- pattern in LayoutTool's section title), not
  // the × in RemoveButton — the cursor tool's "remove" sits on the section
  // title row, same place where Layout's `−` collapses the section back.
  return (
    <button
      onClick={handle}
      className="flex items-center justify-end pl-[80px] -ml-[80px] cursor-pointer group text-[var(--text-primary)]"
      title="Remove cursor"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="transition-opacity group-hover:opacity-80">
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    </button>
  );
}

// ─── Pending cursor row (master-mode placeholder) ──────────────────────────

/**
 * Placeholder row shown after the user picks "+ Component" inside a
 * component master, BEFORE any variable is wired. Reuses the same
 * label-plus-value-button shape as every other tool row — the value
 * column reads "Add" and opens a Create / Set Variable menu on click.
 * Picking either action writes the cursor JSX (identifier reference)
 * and clears the pending state, at which point the parent re-renders
 * as a real `ComponentCursorRow`.
 *
 * Lives at this seam so the rest of the cursor tool stays the same:
 * `componentCursor` (parsed from JSX) is the source of truth for the
 * committed state, and `pending` is purely an editor-session flag.
 */
function PendingCursorRow({
  nodeId,
  activeFile,
  onSatisfied,
}: {
  nodeId: string;
  activeFile: string;
  onSatisfied: () => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [submenuOpen, setSubmenuOpen] = useState<{ pos: { x: number; y: number } } | null>(null);
  // Open the GLOBAL variable modal (atom) — not a LOCAL one: writeCursorBinding satisfies the pending row, which
  // swaps PendingCursorRow → ComponentCursorRow and would unmount a local modal before it shows (the reported
  // "just a purple pill, modal never opens"). The host modal lives high in PropertiesPanel and survives the swap.
  const setVariableModalRequest = useSetAtom(variableModalRequestAtom);
  const menuPortalRef = useRef<HTMLDivElement>(null);
  // Existing master props — surfaced under "Set Variable" so the user
  // can wire the cursor onto an already-declared prop without creating
  // a new one. Read from the component registry the same way
  // VariableModal does for master files.
  useAtomValue(projectVersionAtom);
  const existingProps = useMemo(() => {
    const registry = buildComponentRegistry(projectFS);
    let props: ComponentProp[] = [];
    for (const info of registry.values()) {
      if (info.filePath === activeFile) { props = info.props; break; }
    }
    // Component-cursor "Set Variable" must offer ONLY component-cursor variables (tagged
    // `componentCursor`) — never a web-cursor or other-typed variable. Web cursors are a distinct type
    // (CSS `cursor`), set from the web cursor row's own menu.
    return props.filter(p => p.varType === 'componentCursor');
  }, [activeFile]);

  // ALL master prop names — to mint a unique name for an instant-created cursor variable.
  const allPropNames = useMemo(() => {
    const registry = buildComponentRegistry(projectFS);
    for (const info of registry.values()) if (info.filePath === activeFile) return new Set(info.props.map(p => p.name));
    return new Set<string>();
  }, [activeFile]);

  const writeCursorBinding = useCallback((propName: string, addProp: boolean) => {
    trace.action('cursor-tool:bind-pending-cursor', { nodeId, propName, addProp });
    modifyProjectFile(activeFile, (c) => {
      // Default the cursor prop to `() => null` so the master previews (and
      // any page instance that hasn't picked a component yet) render NO
      // cursor instead of crashing on `withCursor(undefined, …)`.
      let next = addProp ? addBarePropToFunctionInCode(c, propName, 'nullComponent') : c;
      // Tag it as a component-cursor variable so the modal/list show the cursor icon + editor and the
      // type-filtered "Set Variable" lists treat it correctly (it's not a CSS/data variable).
      next = setPropTypeInCode(next, propName, 'componentCursor');
      next = addComponentCursorInCode(next, nodeId, {
        componentName: propName,
        // Identifier reference — propName is in scope as a destructured
        // master prop, so no import is needed (and the cursor-gen helper
        // skips ensureComponentImport when componentImportPath is absent).
        mode: 'follow',
        side: 'bottom',
        align: 'center',
        offsetX: 0,
        offsetY: 0,
        transition: { type: 'spring', stiffness: 300, damping: 30 },
        enterExit: false,
      });
      return next;
    });
    mountCursorPortal();
    onSatisfied();
  }, [nodeId, activeFile, onSatisfied]);

  // Position math copied from ControlLabel — keeps the menu adjacent to
  // the trigger and clamped inside the viewport. Same constants so the
  // pending-cursor menu reads as the same UI vocabulary the user already
  // sees on every property row's chevron menu.
  const openMenu = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const MENU_WIDTH = 180;
    const GAP = 16;
    // Prefer LEFT of trigger (same as ControlLabel) and fall back to RIGHT
    // when there isn't room — keeps the menu out of the properties panel
    // column most of the time, matching the rest of the editor's
    // chevron-menu behaviour.
    let x = rect.left - MENU_WIDTH - GAP;
    if (x < 8) x = rect.right + GAP;
    if (x + MENU_WIDTH > window.innerWidth - 8) x = window.innerWidth - MENU_WIDTH - 8;
    const y = Math.min(rect.top, window.innerHeight - 120);
    setMenuPos({ x, y });
    setMenuOpen(true);
    trace.action('cursor-tool:open-pending-menu', { nodeId });
  }, [nodeId]);

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    setSubmenuOpen(null);
  }, []);

  // ESC to close — matches ControlLabel.
  useEffect(() => {
    if (!menuOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); }
    };
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [menuOpen, closeMenu]);

  const openSubmenu = useCallback(() => {
    const portal = menuPortalRef.current;
    if (!portal) return;
    const portalRect = portal.getBoundingClientRect();
    const SUB_WIDTH = 200;
    const SUB_GAP = 4;
    let x = portalRect.left - SUB_WIDTH - SUB_GAP;
    if (x < 8) x = portalRect.right + SUB_GAP;
    if (x + SUB_WIDTH > window.innerWidth - 8) x = window.innerWidth - SUB_WIDTH - 8;
    setSubmenuOpen({ pos: { x, y: portalRect.top } });
  }, []);

  return (
    <>
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Component" property="" plain />
        <button
          ref={triggerRef}
          type="button"
          onClick={openMenu}
          className="w-full h-[var(--control-height)] flex items-center justify-between px-2 bg-[var(--control-bg)] hover:bg-[var(--bg-hover)] border border-[var(--border-light)] cut-corners cut-border [--cut-border-color:var(--border-light)] text-xs cursor-pointer transition-colors"
        >
          <span className="truncate flex-1 text-left text-[var(--text-disabled)]">Add</span>
        </button>
      </div>

      {/* Chevron-style menu portal — same look as ControlLabel's menu so
          the "create / set variable" affordance reads as one consistent
          piece of the editor's UI vocabulary. */}
      {menuOpen && createPortal(
        <>
          <div
            className="fixed inset-0 z-[10000]"
            onClick={closeMenu}
            onContextMenu={(e) => { e.preventDefault(); closeMenu(); }}
          />
          <div
            ref={menuPortalRef}
            className="fixed bg-[var(--dropdown-bg)] shadow-[var(--shadow-lg)] cut-corners cut-lg cut-border [--cut-border-color:var(--border-light)] py-1.5 z-[10001] min-w-45 border border-[var(--border-light)] space-y-0.5"
            style={{ left: menuPos.x, top: menuPos.y }}
          >
            {existingProps.length > 0 && (
              <button
                type="button"
                onMouseEnter={openSubmenu}
                onClick={openSubmenu}
                className="group flex items-center justify-between gap-2 mx-1.5 px-2.5 py-1.5 cut-corners w-[calc(100%-12px)] text-left cursor-pointer hover:bg-[var(--accent-secondary)] transition-colors"
              >
                <span className="text-[var(--text-secondary)] group-hover:text-[var(--accent-fg)]">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                </span>
                <span className="text-xs font-medium text-[var(--text-primary)] group-hover:text-[var(--accent-fg)] flex-1">
                  Set Variable
                </span>
              </button>
            )}
            <button
              type="button"
              onMouseEnter={() => setSubmenuOpen(null)}
              onClick={() => {
                closeMenu();
                // INSTANT create (no name-input form anymore): mint a unique name, write the binding NOW, then
                // open the modal SELECTED on it (name focused to rename) — same as every other variable type.
                let name = 'cursor';
                for (let i = 1; allPropNames.has(name); i++) name = `cursor${i}`;
                writeCursorBinding(name, true);
                flushNow(); // the variable must exist before the modal reads the list
                // GLOBAL modal, opened SELECTED on the new var (name focused to rename). The modal auto-hides the
                // Default row for a componentCursor (its editor === 'componentCursor'), so no hideDefault needed.
                setVariableModalRequest({ property: 'cursor', propertyLabel: 'Cursor', currentValue: '', variableRef: name, nameEditable: true });
              }}
              className="group flex items-center justify-between gap-2 mx-1.5 px-2.5 py-1.5 cut-corners w-[calc(100%-12px)] text-left cursor-pointer hover:bg-[var(--accent-secondary)] transition-colors"
            >
              <span className="text-xs font-medium text-[var(--text-primary)] group-hover:text-[var(--accent-fg)] flex-1">
                Create Variable
              </span>
            </button>
          </div>

          {submenuOpen && existingProps.length > 0 && (
            <div
              className="fixed bg-[var(--dropdown-bg)] shadow-[var(--shadow-lg)] cut-corners cut-lg cut-border [--cut-border-color:var(--border-light)] py-1.5 z-[10002] min-w-[200px] max-h-[320px] overflow-y-auto border border-[var(--border-light)] space-y-0.5"
              style={{ left: submenuOpen.pos.x, top: submenuOpen.pos.y }}
              onMouseLeave={() => setSubmenuOpen(null)}
            >
              {existingProps.map((p) => (
                <button
                  key={p.name}
                  type="button"
                  onClick={() => { closeMenu(); writeCursorBinding(p.name, false); }}
                  className="group flex items-center mx-1.5 px-2.5 py-1.5 cut-corners w-[calc(100%-12px)] text-left cursor-pointer hover:bg-[var(--accent-secondary)] transition-colors"
                >
                  <span className="text-xs font-medium text-[var(--text-primary)] group-hover:text-[var(--accent-fg)] truncate">
                    {p.name}
                  </span>
                </button>
              ))}
            </div>
          )}
        </>,
        document.body,
      )}

    </>
  );
}

// ─── Web cursor row ─────────────────────────────────────────────────────────

function WebCursorRow({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const btnRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const current = value || 'default';
  const Icon = CURSOR_ICONS[current] ?? CURSOR_ICONS.default;

  return (
    <>
      <div className="flex items-center justify-between w-full" ref={btnRef}>
        <ControlLabel label="Cursor" property="cursor" />
        <ControlActionRow onClick={() => setOpen(true)}>
          <span className="flex-shrink-0 flex items-center justify-center w-5 h-5 text-[var(--text-primary)]">
            <Icon size={20} />
          </span>
          <span className="truncate flex-1">{cursorLabel(current)}</span>
        </ControlActionRow>
      </div>
      <ToolPopup
        isOpen={open}
        onClose={() => setOpen(false)}
        title="Cursor"
        anchorRef={btnRef}
        width={300}
      >
        <CursorPickerGrid value={current} onChange={(v) => { onChange(v); setOpen(false); }} />
      </ToolPopup>
    </>
  );
}

/**
 * Grid of cursor previews. Each cell sets its own `style.cursor` to the value
 * it represents so hovering shows the OS's actual cursor — that's the whole
 * point of a picker for a property whose values are just names.
 */
// CursorPickerGrid moved to ./CursorTool/cursor-picker-grid (shared with the web-cursor variable editor).

// ─── Component cursor row (when active) ─────────────────────────────────────

function ComponentCursorRow({
  nodeId,
  cursor,
}: {
  nodeId: string;
  cursor: ReturnType<typeof getComponentCursorForNode> & {};
}) {
  const activeFile = useAtomValue(activeFilePathAtom);
  const btnRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  const summary = cursor.componentName + (cursor.variant ? ` · ${cursor.variant}` : '');

  // Cursor-as-variable case (inside a master): the first arg of withCursor
  // is a prop identifier, not an imported component. Render the same purple
  // bound-variable pill the rest of the editor uses for hoisted variables —
  // T icon + variable name + × to unbind. Clicking the body still opens the
  // cursor editor so the user can tweak mode / transition / etc. (those opts
  // travel with the variable). Clicking × strips the withCursor call AND the
  // now-unused prop from the master signature.
  const removeVariableCursor = useCallback(() => {
    trace.action('cursor-tool:unbind-variable-cursor', { nodeId, propName: cursor.componentName });
    // Removing the LAST binding cascades project-wide: the prop leaves the master signature and
    // `cursor=`/`cursorOpts=` are stripped from every instance. Without this the instances keep
    // pointing at a parameter the master no longer declares. Falls back to the plain local unbind
    // when this isn't a component master (or another node still binds the same prop).
    if (removeComponentCursorProjectWide(nodeId)) return;
    modifyProjectFile(activeFile, (c) => removeComponentCursorInCode(c, nodeId));
  }, [nodeId, activeFile, cursor.componentName]);

  if (cursor.isVariable) {
    return (
      <>
        <div className="flex items-center justify-between w-full" ref={btnRef}>
          <ControlLabel label="Component" property="" plain />
          {/* Purple variable pill — clicking opens the VariableModal (like every other variable pill),
              with the full Component Cursor control mounted as its Default via renderDefaultValue. */}
          <button
            onClick={() => setOpen(true)}
            className="w-full h-8 flex items-center gap-2 px-2 cut-corners text-xs font-medium text-[var(--accent-secondary-fg)] cursor-pointer transition-colors hover:opacity-90 truncate"
            style={{ backgroundColor: 'var(--accent-secondary)' }}
            title={`Cursor variable: ${cursor.componentName} — click to manage`}
          >
            <span className="w-4 h-4 rounded bg-white/20 flex items-center justify-center shrink-0 text-[var(--accent-secondary-fg)]">
              <VariableTypeIcon iconKey="cursor" size={11} />
            </span>
            <span className="truncate flex-1 text-left">{cursor.componentName}</span>
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); removeVariableCursor(); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); removeVariableCursor(); } }}
              className="text-white/70 hover:text-white text-sm leading-none shrink-0 cursor-pointer"
              title="Remove cursor variable"
            >
              ×
            </span>
          </button>
        </div>
        <VariableModal
          isOpen={open}
          onClose={() => setOpen(false)}
          property=""
          propertyLabel="Cursor"
          currentValue=""
          currentVariableRef={cursor.componentName}
          onCreateVariable={() => setOpen(false)}
          // Component cursors have NO default value (standard) — modal shows only Name + Description.
        />
      </>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between w-full" ref={btnRef}>
        <ControlLabel label="Component" property="" plain />
        <ControlActionRow onClick={() => setOpen(true)}>
          <span className="truncate flex-1">{summary}</span>
        </ControlActionRow>
      </div>
      <ToolPopup
        isOpen={open}
        onClose={() => setOpen(false)}
        title="Component Cursor"
        anchorRef={btnRef}
        width={280}
      >
        <ComponentCursorEditor
          // Re-seed when the target node changes while the popup is open —
          // the editor copies `initial` into useState on mount only (see the
          // instance-row twin comment).
          key={nodeId}
          nodeId={nodeId}
          activeFile={activeFile}
          initial={{
            componentName: cursor.componentName,
            variant: cursor.variant,
            mode: cursor.mode ?? 'follow',
            side: cursor.side ?? 'bottom',
            align: cursor.align ?? 'center',
            offsetX: cursor.offsetX ?? 0,
            offsetY: cursor.offsetY ?? 0,
            transition: cursor.transition ?? { type: 'spring', stiffness: 300, damping: 30 },
            width: cursor.width === undefined ? '0' : String(cursor.width),
            height: cursor.height === undefined ? '0' : String(cursor.height),
            enterExit: cursor.enterExit ?? false,
          }}
          onWrite={(opts) => {
            trace.action('cursor-tool:update', { nodeId, componentName: opts.componentName, mode: opts.mode });
            modifyProjectFile(activeFile, (c) => updateComponentCursorInCode(c, nodeId, opts));
            // modifyProjectFile bumps projectVersion automatically; nothing to do here.
          }}
        />
      </ToolPopup>
    </>
  );
}

// ─── Component picker (initial creation popup) ──────────────────────────────

function ComponentCursorPicker({
  nodeId,
  activeFile,
  onClose,
  onCreated,
}: {
  nodeId: string;
  activeFile: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);

  // First component file in the project is the default. Editor will refine.
  const initialComponentFile = useMemo(() => {
    const files = projectFS.listFiles('components/').filter((f) => f.endsWith('.tsx'));
    return files[0] ?? null;
  }, []);

  if (!initialComponentFile) {
    // No components in the project — show a placeholder popup explaining that
    // the user needs to create a component first.
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30" onClick={onClose}>
        <div className="bg-[var(--bg-secondary)] cut-corners p-4 text-xs text-[var(--text-secondary)]">
          Create a component first, then attach it as a cursor.
        </div>
      </div>
    );
  }

  return (
    <>
      <div ref={anchorRef} className="absolute right-0 top-0 w-1 h-1 pointer-events-none" />
      <ToolPopup isOpen={true} onClose={onClose} title="Component Cursor" anchorRef={anchorRef} width={280}>
        <ComponentCursorEditor
          key={nodeId}
          nodeId={nodeId}
          activeFile={activeFile}
          initial={{
            componentName: nameFromPath(initialComponentFile),
            variant: undefined,
            mode: 'follow',
            side: 'bottom',
            align: 'center',
            offsetX: 0,
            offsetY: 0,
            transition: { type: 'spring', stiffness: 300, damping: 30 },
            width: '0',
            height: '0',
            enterExit: false,
          }}
          onWrite={(opts) => {
            const filePath = pathFromName(opts.componentName);
            trace.action('cursor-tool:add-component', {
              nodeId, componentName: opts.componentName, mode: opts.mode,
            });
            modifyProjectFile(activeFile, (c) =>
              addComponentCursorInCode(c, nodeId, {
                ...opts,
                componentImportPath: filePath ? `@/${filePath.replace(/\.tsx$/, '')}` : `@/components/${opts.componentName}`,
              }),
            );
            // Layout: ensure CursorPortal is mounted once. Idempotent — safe
            // to call on every cursor add. Creates app/layout.tsx first when
            // the project has none (otherwise the portal mount is a no-op and
            // the cursor never renders in preview).
            mountCursorPortal();
            onCreated();
          }}
          autoSubmitOnFirstWrite
        />
      </ToolPopup>
    </>
  );
}

// ─── Editor body (component picker + variant + mode + transition) ──────────

export interface EditorState {
  componentName: string;
  variant?: string;
  mode: 'follow' | 'replace';
  side: CursorSide;
  align: CursorAlign;
  offsetX: number;
  offsetY: number;
  transition: CursorTransition;
  /**
   * Default '0' so the ToolInput renders chevrons + the "px" label —
   * `parseDimension` treats 0 as "unset" and omits the field from the
   * generated call so intrinsic sizing kicks in for components that have
   * their own dimensions. CSS strings ('100%', '4rem') pass through as-is.
   */
  width: string;
  height: string;
  enterExit: boolean;
}

const ENTER_EXIT_OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'on', label: 'On' },
];

export function ComponentCursorEditor({
  initial,
  onWrite,
  autoSubmitOnFirstWrite,
  allowNoComponent,
}: {
  nodeId: string;
  activeFile: string;
  initial: EditorState;
  onWrite: (opts: AddComponentCursorOpts) => void;
  autoSubmitOnFirstWrite?: boolean;
  /**
   * When true, the Component dropdown gains a leading "Choose…" entry
   * (empty value) and may sit unselected. Used by the page-instance
   * cursor-variable editor: until the user actually picks a component,
   * `componentName` stays '' and `onWrite` receives '' — the caller then
   * leaves the instance prop unset (so the master's `() => null` default
   * applies and hovering does nothing). The master's own creation picker
   * never sets this — there a component is always required.
   */
  allowNoComponent?: boolean;
}) {
  const popup = useToolPopup();
  const [state, setState] = useState<EditorState>(initial);

  // External re-seed (undo/redo while the cursor editor is open): the
  // parsed cursor config comes back via `initial`. Own commits round-trip
  // to the same values, so a differing incoming config is external unless
  // it matches what we currently hold.
  const initCursorSig = JSON.stringify(initial);
  const stateSigRef = useRef(initCursorSig);
  const prevInitCursorSigRef = useRef(initCursorSig);
  useEffect(() => {
    if (initCursorSig === prevInitCursorSigRef.current) return;
    prevInitCursorSigRef.current = initCursorSig;
    if (stateSigRef.current === initCursorSig) return;
    stateSigRef.current = initCursorSig;
    setState(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initCursorSig]);
  useEffect(() => { stateSigRef.current = JSON.stringify(state); }, [state]);
  const [hasSubmitted, setHasSubmitted] = useState(false);

  // List components from projectFS. Re-derived on every render — cheap.
  // In `allowNoComponent` mode prepend a "Choose…" placeholder so the
  // dropdown can read as "nothing picked yet" instead of silently
  // defaulting to the first component.
  const componentOptions = useMemo(() => {
    const files = projectFS.listFiles('components/').filter((f) => f.endsWith('.tsx'));
    const opts = files.map((file) => {
      const display = getComponentDisplayName(file) ?? nameFromPath(file);
      return { value: nameFromPath(file), label: display };
    });
    return allowNoComponent ? [{ value: '', label: 'Choose…' }, ...opts] : opts;
  }, [allowNoComponent]);

  // Variant options for the chosen component.
  const variantOptions = useMemo(() => {
    const filePath = pathFromName(state.componentName);
    if (!filePath) return [];
    const code = projectFS.readFile(filePath) ?? '';
    const variants = parseVariantConfig(code);
    if (variants.length <= 1) return [];
    return variants.map((v) => ({ value: v.name, label: v.label || v.name }));
  }, [state.componentName]);

  const submit = useCallback(
    (next: EditorState) => {
      const filePath = pathFromName(next.componentName);
      onWrite({
        componentName: next.componentName,
        componentImportPath: filePath ? `@/${filePath.replace(/\.tsx$/, '')}` : `@/components/${next.componentName}`,
        variant: next.variant,
        mode: next.mode,
        side: next.side,
        align: next.align,
        offsetX: next.offsetX,
        offsetY: next.offsetY,
        transition: next.transition,
        width: parseDimension(next.width),
        height: parseDimension(next.height),
        enterExit: next.enterExit,
      });
      setHasSubmitted(true);
    },
    [onWrite],
  );

  // For the initial-creation flow, write on first interaction so the cursor
  // exists in code. Subsequent edits update in place.
  const writeNow = useCallback(
    (next: EditorState) => {
      setState(next);
      if (autoSubmitOnFirstWrite && !hasSubmitted) submit(next);
      else submit(next);
    },
    [autoSubmitOnFirstWrite, hasSubmitted, submit],
  );

  // Auto-submit on mount for the creation flow (gives the user a working
  // cursor immediately even before they tweak anything).
  useEffect(() => {
    if (autoSubmitOnFirstWrite && !hasSubmitted) submit(state);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reuse the same summary helper + curve preview icon used by every other
  // transition row in the editor (VariantTransitionControl, AnimationTool,
  // TextEffectPopup) for visual consistency.
  const transitionStringMap = transitionToStringMap(state.transition);
  const isSpringTransition = state.transition.type === 'spring';
  const transitionSummary = Object.keys(transitionStringMap).length > 0
    ? summarizeTransition(transitionStringMap)
    : 'Default';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Component" property="" plain />
        <ToolSelect
          value={state.componentName}
          onChange={(componentName) => writeNow({ ...state, componentName, variant: undefined })}
          options={componentOptions}
        />
      </div>

      {variantOptions.length > 0 && (
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Variant" property="" plain />
          <ToolSelect
            value={state.variant ?? variantOptions[0].value}
            onChange={(variant) => writeNow({ ...state, variant })}
            options={variantOptions}
          />
        </div>
      )}

      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Mode" property="" plain />
        <ToolSegmentedControl
          value={state.mode}
          onChange={(v) => writeNow({ ...state, mode: v as 'follow' | 'replace' })}
          options={MODE_OPTIONS}
        />
      </div>

      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Size" property="" plain />
        <div className="flex items-center gap-1 w-full">
          <ToolInput
            value={state.width}
            onChange={(val) => writeNow({ ...state, width: val })}
            chevronLabel="px"
          />
          <ToolInput
            value={state.height}
            onChange={(val) => writeNow({ ...state, height: val })}
            chevronLabel="px"
          />
        </div>
      </div>

      {/* Position / Align / Offset only apply to Follow mode. Replace mode
          auto-centers the component on the mouse, so these would be no-ops. */}
      {state.mode === 'follow' && (
        <>
          <div className="flex items-center justify-between w-full">
            <ControlLabel label="Position" property="" plain />
            <ToolSelect
              value={state.side}
              onChange={(v: string) => writeNow({ ...state, side: v as CursorSide })}
              options={SIDE_OPTIONS}
            />
          </div>
          <div className="flex items-center justify-between w-full">
            <ControlLabel label="Align" property="" plain />
            <ToolSegmentedControl
              value={state.align}
              onChange={(v: string) => writeNow({ ...state, align: v as CursorAlign })}
              options={ALIGN_OPTIONS}
            />
          </div>
          <div className="flex items-center justify-between w-full">
            <ControlLabel label="Offset" property="" plain />
            <div className="flex items-center gap-1 w-full">
              <ToolInput
                value={String(state.offsetX)}
                onChange={(val) => writeNow({ ...state, offsetX: Number(val) || 0 })}
                chevronLabel="X"
              />
              <ToolInput
                value={String(state.offsetY)}
                onChange={(val) => writeNow({ ...state, offsetY: Number(val) || 0 })}
                chevronLabel="Y"
              />
            </div>
          </div>
        </>
      )}

      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Transition" property="" plain />
        <ControlActionRow
          onClick={() =>
            popup.pushPanel(
              'Transition',
              <TransitionPanel
                initialTransition={transitionStringMap}
                onWrite={(t) => {
                  const parsed = stringMapToTransition(t);
                  writeNow({ ...state, transition: parsed });
                }}
              />,
            )
          }
        >
          <TransitionCurveIcon isSpring={isSpringTransition} />
          <span className="truncate flex-1">{transitionSummary}</span>
        </ControlActionRow>
      </div>

      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Enter / Exit" property="" plain />
        <ToolSegmentedControl
          value={state.enterExit ? 'on' : 'off'}
          onChange={(v: string) => writeNow({ ...state, enterExit: v === 'on' })}
          options={ENTER_EXIT_OPTIONS}
        />
      </div>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function nameFromPath(filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath;
  return base.replace(/\.tsx$/, '');
}

function pathFromName(name: string): string | null {
  const candidate = `components/${name}.tsx`;
  return projectFS.readFile(candidate) ? candidate : null;
}

/** Parse the editor's free-text Size input.
 *  '0' or empty → undefined (unset; runtime falls back to intrinsic size).
 *  '40' → 40 (number, runtime adds px). '100%' / '4rem' → string passthrough.
 *
 *  We treat 0 as "unset" because the input defaults to '0' so the chevrons
 *  + px label render — there's no other natural sentinel that keeps the
 *  ToolInput visually consistent with the rest of the panel. */
function parseDimension(s: string): number | string | undefined {
  const trimmed = s.trim();
  if (!trimmed) return undefined;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    return n === 0 ? undefined : n;
  }
  return trimmed;
}

/** Convert our typed transition to the string-map shape TransitionPanel expects. */
function transitionToStringMap(t: CursorTransition): Record<string, string> {
  const out: Record<string, string> = {};
  if (t.type) out.type = t.type;
  if (typeof t.stiffness === 'number') out.stiffness = String(t.stiffness);
  if (typeof t.damping === 'number') out.damping = String(t.damping);
  if (typeof t.mass === 'number') out.mass = String(t.mass);
  if (typeof t.duration === 'number') out.duration = String(t.duration);
  if (t.ease) out.ease = t.ease;
  return out;
}

function stringMapToTransition(t: Record<string, string>): CursorTransition {
  const out: CursorTransition = {};
  if (t.type === 'spring' || t.type === 'tween' || t.type === 'instant') out.type = t.type;
  if (t.stiffness) out.stiffness = Number(t.stiffness);
  if (t.damping) out.damping = Number(t.damping);
  if (t.mass) out.mass = Number(t.mass);
  if (t.duration) out.duration = Number(t.duration);
  if (t.ease) out.ease = t.ease;
  return out;
}
