// ComponentPropsTool/CursorVariableInstanceRow.tsx — lifted verbatim from
// ComponentPropsTool.tsx (Phase 7 god-file split, item 7.5).

import { useCallback, useMemo, useRef, useState } from 'react';
import { projectFS } from '@/code/project/project-fs';
import { modifyProjectFile } from '@/code/project/modify-file';
import { parseComponentCursorCalls } from '@/code/parsing/cursor-parser';
import { ensureDefaultImportInCode, ensureCursorOptsForwardInCode, serializeInstanceCursorOpts, parseInstanceCursorOpts, cursorOptsPropName, type AddComponentCursorOpts } from '@/code/generation/cursor-gen';
import { getComponentDisplayName } from '@/code/components/component-ops';
import { ControlLabel, ControlActionRow } from '../../controls';
import ToolPopup from '../../ui/ToolPopup';
import { ComponentCursorEditor } from '../CursorTool';
import { setInstanceProp, removeInstanceProp, getInstancePropExpr } from './instance-props';
import { trace } from '@/shared/debug-trace';

// ─── Cursor Variable Instance Row ───────────────────────────────────────────

/**
 * Page-level instance editor row for a hoisted component-cursor variable.
 * Renders a BUTTON that opens the full cursor-controls popup — the same
 * `ComponentCursorEditor` the master uses (Component picker + Mode + Size +
 * Position + Align + Offset + Transition + Enter/Exit).
 *
 * The two halves of the editor BOTH write per-instance now:
 *   - **Component** (which concrete component fills the cursor) → the
 *     instance prop (`<Card myCursor={Pointer} />` + import).
 *   - **Behaviour opts** (variant / mode / transition / size / …) → the paired
 *     `<prop>Opts` instance prop (`<Card myCursorOpts={{"variant":"brand"}} />`),
 *     spread LAST into the master's `withCursor(prop, { …defaults, ...propOpts })`
 *     call (the ensure transform adds the forward lazily). The master's own
 *     opts remain the DEFAULTS for instances that never overrode. Historically
 *     behaviour wrote straight to the master call — setting "Brand" on
 *     instance 1 then "Motion" on instance 2 silently overwrote instance 1
 *     (live find 2026-07-06).
 *
 * When the `withCursor` call is forwarded through a nested child (multi-
 * level hoist) rather than living directly on this master, the behaviour
 * writes are skipped — only the Component picker applies. Picking the
 * component still works through the whole chain because the prop is
 * passed straight down.
 */
export function CursorVariableInstanceRow({
  label,
  currentComponent,
  masterFile,
  propName,
  instanceNodeId,
  instanceComponentName,
  activeFile,
  onChanged,
}: {
  label: string;
  currentComponent: string;
  masterFile: string;
  propName: string;
  instanceNodeId: string;
  instanceComponentName: string;
  activeFile: string;
  onChanged: () => void;
}) {
  const btnRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  // Locate the master's withCursor(propName, …) call — its opts are the
  // DEFAULTS the popup seeds from when this instance has no override yet.
  // Null when the cursor is forwarded into a nested child (the call doesn't
  // live directly on this master) — behaviour edits are skipped in that
  // case, only the Component picker applies.
  const masterCursor = useMemo(() => {
    const compCode = projectFS.readFile(masterFile);
    if (!compCode) return null;
    const calls = parseComponentCursorCalls(compCode);
    return calls.find((c) => c.componentName === propName) ?? null;
  }, [masterFile, propName]);

  // This instance's own behaviour override (`<prop>Opts={{…}}`), if any —
  // wins over the master defaults when seeding the popup.
  const instanceOpts = useMemo(() => {
    const pageCode = projectFS.readFile(activeFile);
    if (!pageCode) return null;
    return parseInstanceCursorOpts(
      getInstancePropExpr(pageCode, instanceNodeId, instanceComponentName, cursorOptsPropName(propName)),
    );
  }, [activeFile, instanceNodeId, instanceComponentName, propName, open]);

  // Display name for the currently-picked component (or "Choose…" when unset).
  const currentDisplay = useMemo(() => {
    if (!currentComponent) return 'Choose…';
    const file = `components/${currentComponent}.tsx`;
    return getComponentDisplayName(file) ?? currentComponent;
  }, [currentComponent]);

  trace.fn('CursorVariableInstanceRow:render', { label, currentComponent, hasMasterCall: !!masterCursor, hasInstanceOpts: !!instanceOpts });

  const handleWrite = useCallback((opts: AddComponentCursorOpts) => {
    // 1) Component identity → instance prop. Three cases:
    //    - a real component picked (≠ propName, non-empty) → write
    //      `<Inst propName={Chosen} />` + import.
    //    - "Choose…" selected (empty) → REMOVE the instance prop so the
    //      master's `() => null` default applies (cursor stays inactive,
    //      no crash on hover). Don't write a bogus component the user
    //      never picked.
    if (opts.componentName && opts.componentName !== propName) {
      modifyProjectFile(activeFile, (currentCode) => {
        let next = currentCode;
        if (opts.componentImportPath) {
          next = ensureDefaultImportInCode(next, opts.componentName, opts.componentImportPath);
        }
        next = setInstanceProp(next, instanceNodeId, instanceComponentName, propName, opts.componentName, true);
        return next;
      });
    } else if (!opts.componentName) {
      modifyProjectFile(activeFile, (currentCode) =>
        removeInstanceProp(currentCode, instanceNodeId, instanceComponentName, propName),
      );
    }

    // 2) Behaviour opts → PER-INSTANCE `<prop>Opts` prop, spread last into the
    //    master call so this instance's settings never leak onto its siblings.
    //    The master's own opts stay untouched (they're the defaults).
    if (masterCursor) {
      // Lazily wire the master to forward the per-instance opts (idempotent).
      modifyProjectFile(masterFile, (compCode) => ensureCursorOptsForwardInCode(compCode, propName));
      const json = serializeInstanceCursorOpts({
        variant: opts.variant,
        mode: opts.mode,
        side: opts.side,
        align: opts.align,
        offsetX: opts.offsetX,
        offsetY: opts.offsetY,
        transition: opts.transition,
        width: opts.width,
        height: opts.height,
        enterExit: opts.enterExit,
      });
      modifyProjectFile(activeFile, (currentCode) =>
        setInstanceProp(currentCode, instanceNodeId, instanceComponentName, cursorOptsPropName(propName), json, true),
      );
    }

    onChanged();
    trace.action('cursor-var-instance:write', { propName, component: opts.componentName, hasMasterCall: !!masterCursor, perInstance: true });
  }, [activeFile, masterFile, masterCursor, propName, instanceNodeId, instanceComponentName, onChanged]);

  return (
    <>
      <div className="flex items-center justify-between w-full" ref={btnRef}>
        <ControlLabel label={label} property="" subLabel="Cursor" />
        <ControlActionRow onClick={() => setOpen(true)}>
          <span className="truncate flex-1">{currentDisplay}</span>
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
          // The editor copies `initial` into its own useState ON MOUNT. When
          // the user selects ANOTHER instance while this popup stays open,
          // React would reuse the mounted editor (fresh props, STALE state) —
          // the popup kept showing instance 1's values on instance 2 (live
          // find 2026-07-06). Keying by instance remounts it with the newly
          // selected instance's seed.
          key={`${instanceNodeId}:${propName}`}
          nodeId={instanceNodeId}
          activeFile={activeFile}
          allowNoComponent
          initial={{
            // Empty when the instance hasn't picked a component yet — the
            // dropdown shows "Choose…", not a misleading auto-selected
            // first component. Behaviour seeds: this instance's own
            // override first, master defaults as fallback.
            componentName: currentComponent || '',
            variant: instanceOpts?.variant ?? masterCursor?.variant,
            mode: instanceOpts?.mode ?? masterCursor?.mode ?? 'follow',
            side: instanceOpts?.side ?? masterCursor?.side ?? 'bottom',
            align: instanceOpts?.align ?? masterCursor?.align ?? 'center',
            offsetX: instanceOpts?.offsetX ?? masterCursor?.offsetX ?? 0,
            offsetY: instanceOpts?.offsetY ?? masterCursor?.offsetY ?? 0,
            transition: instanceOpts?.transition ?? masterCursor?.transition ?? { type: 'spring', stiffness: 300, damping: 30 },
            width: instanceOpts?.width !== undefined ? String(instanceOpts.width) : masterCursor?.width === undefined ? '0' : String(masterCursor.width),
            height: instanceOpts?.height !== undefined ? String(instanceOpts.height) : masterCursor?.height === undefined ? '0' : String(masterCursor.height),
            enterExit: instanceOpts?.enterExit ?? masterCursor?.enterExit ?? false,
          }}
          onWrite={handleWrite}
        />
      </ToolPopup>
    </>
  );
}
