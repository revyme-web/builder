// IconSetTool.tsx — Properties panel for icon-set instances.
//
// Renders when the selected node is an instance of an icon-set file (an
// `icons/{Name}.tsx` carrying the `@iconSet` annotation). Three controls:
//
//   1. Icon picker — clicking the row opens a popup with a thumbnail
//      grid of every icon in the set. Picking writes
//      `name="icon-X"` to the instance JSX.
//   2. Edit button — switches the active file to the icon-set master,
//      same flow as the "Edit Component" button on a component instance.
//   3. (Phase 2: Code Overrides — not implemented yet.)
//
// Detection: the parser sets `componentFile` on icon-set instances and
// flags them `isCodeComponent: true` (they render via the live React
// runtime). To distinguish them from regular code components we look up
// the file in the icon-set registry — only icon-set files carry the
// `@iconSet` annotation, so a non-null lookup means "this is an icon-set
// instance".

import { useMemo, useCallback, useRef, useState } from 'react';
import { useAtomValue, useSetAtom, useStore } from 'jotai';
import { useControl } from '../controls/ControlProvider';
import {
  codeAtom,
  nodesAtom,
  selectedIdsAtom,
  updatingFromCanvasAtom,
} from '@/code/stores/store';
import { activeFilePathAtom, componentBreadcrumbAtom } from '@/code/project/active-file-store';
import { suppressSelectionOverlayAtom } from '@/code/stores/editor-store';
import {
  interactingViewportIdAtom,
  isReplicaViewportAtom,
  interactingViewportWidthAtom,
  isComponentVariantViewportAtom,
  activeComponentVariantAtom,
} from '@/code/stores/viewport-store';
import { projectFS, projectVersionAtom, stableProjectVersionAtom } from '@/code/project/project-fs';
import { modifyProjectFile } from '@/code/project/modify-file';
import { setResponsiveOverride, setConditionalInstanceProp } from '@/code/components/instance-prop-overrides';
import { buildIconSetRegistry, parseIconSetFile, type IconSetInfo, type IconEntryInfo } from '@/code/icons/icon-set-registry';
import { enterComponentFile } from '@/canvas/component-navigation';
import { renderCodeComponentDirect } from '@/canvas/CodeComponentHost';
import { useCdnSource } from '@/cloud/components/cdn-source-hook';
import { linkedComponentModalUrlAtom } from '@/cloud/components/linked-component-modal-store';
import { ToolSection } from '../controls';
import ControlLabel from '../controls/ControlLabel';
import ToolPopup from '../ui/ToolPopup';
import Button from '@/design-system/Button';
import { trace } from '@/shared/debug-trace';

export default function IconSetTool() {
  const { node, nodeId } = useControl();
  const activeFile = useAtomValue(activeFilePathAtom);
  const projectVersion = useAtomValue(stableProjectVersionAtom);
  const setActiveFile = useSetAtom(activeFilePathAtom);
  const setBreadcrumb = useSetAtom(componentBreadcrumbAtom);
  const setSelectedIds = useSetAtom(selectedIdsAtom);
  const setUpdatingFromCanvas = useSetAtom(updatingFromCanvasAtom);
  const setInteractingVp = useSetAtom(interactingViewportIdAtom);
  const setCode = useSetAtom(codeAtom);
  const setVersion = useSetAtom(projectVersionAtom);
  const jotaiStore = useStore();

  // Context for routing the icon switch like a design-component prop: a replica
  // viewport writes per-breakpoint (data-responsive), a non-default master
  // variant writes a per-variant ternary, otherwise the base name= attribute.
  const isReplica = useAtomValue(isReplicaViewportAtom);
  const vpWidth = useAtomValue(interactingViewportWidthAtom);
  const isComponentVariant = useAtomValue(isComponentVariantViewportAtom);
  const activeComponentVariant = useAtomValue(activeComponentVariantAtom);

  // CDN-vector instances point at `https://assets.revyme.app/vectors/...`
  // — those bundles aren't in projectFS, so the registry can't find
  // them. Fetch the TSX source via `useCdnSource` (cached by URL) and
  // parse it directly with `parseIconSetFile`. The hook returns
  // `{ source: null }` while loading so the tool short-circuits to
  // null until it resolves; keying by full URL keeps the cache warm
  // across selection changes.
  const file = node?.componentFile ?? null;
  const isCdnVector = !!file && file.startsWith('http') && file.includes('/vectors/');
  const { source: cdnSource } = useCdnSource(isCdnVector ? file : null);
  const setLinkedModalUrl = useSetAtom(linkedComponentModalUrlAtom);

  // Look up the icon set this instance points to. The registry caches
  // by content hash, so this is cheap. We re-run on projectVersion
  // changes (e.g. addIconToSet just rewrote the file).
  const iconSet: IconSetInfo | null = useMemo(() => {
    if (!file) return null;
    if (isCdnVector) {
      // CDN vector path: parse the fetched TSX source. Use the URL's
      // hash segment as the registry contentHash so re-renders dedup.
      if (!cdnSource) return null; // still loading
      const hashMatch = file.match(/@([a-f0-9]+)\./);
      const hash = hashMatch?.[1] ?? file;
      return parseIconSetFile(file, cdnSource, hash);
    }
    if (!file.startsWith('icons/')) return null;
    const registry = buildIconSetRegistry(projectFS);
    for (const info of registry.values()) {
      if (info.filePath === file) return info;
    }
    return null;
  }, [file, isCdnVector, cdnSource, projectVersion]);

  // Which icon the picker highlights as active. The `name` prop can be a plain
  // literal, a per-variant ternary (`name={variant === 'v' ? a : b}` → parsed
  // into node.attrConditional), or a per-viewport override (data-responsive). It
  // must resolve for the SELECTED artboard/viewport — otherwise selecting the
  // instance on the default tile (or a replica) showed the wrong icon. Resolved
  // from the parsed node so it tracks the active variant/viewport reactively.
  const currentIconId = useMemo(() => {
    const fallback = iconSet?.icons[0]?.id ?? null;
    if (!iconSet || !node) return fallback;
    // Per-viewport override (replica tile): the data-responsive entry's `name`.
    if (isReplica && typeof node.attrs?.['data-responsive'] === 'string') {
      try {
        const ov = JSON.parse(node.attrs['data-responsive'] as string);
        const n = ov?.[String(vpWidth)]?.name;
        if (typeof n === 'string') return n;
      } catch { /* fall through */ }
    }
    // Per-variant override (master tile): resolve the name ternary for this variant.
    const cond = node.attrConditional?.name;
    if (cond) {
      const activeVar = activeComponentVariant ?? 'default';
      return cond[activeVar] ?? cond['default'] ?? (typeof node.attrs?.name === 'string' ? node.attrs.name : fallback);
    }
    // Plain literal `name="…"`.
    const literal = node.attrs?.name;
    return typeof literal === 'string' && literal ? literal : fallback;
  }, [iconSet, node, isReplica, vpWidth, activeComponentVariant]);

  const currentEntry = iconSet?.icons.find(i => i.id === currentIconId) ?? iconSet?.icons[0] ?? null;

  // ─── Picker open/close ──────────────────────────────────────────────────

  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerAnchorRef = useRef<HTMLButtonElement | null>(null);

  // ─── Pick icon — write name="..." to the instance JSX ───────────────────

  const handlePickIcon = useCallback((iconId: string) => {
    if (!nodeId || !iconSet || !activeFile) return;
    trace.action('icon-set-tool:pick', { nodeId, iconId, exportName: iconSet.exportName });

    // Route the icon `name` the SAME way design-component props route, so a
    // vector set can show a different icon per master variant and per replica
    // viewport instead of overwriting them all:
    //   - replica viewport       → per-breakpoint `data-responsive`
    //   - non-default master tile → per-variant `name={variant === 'v' ? … }` ternary
    //   - otherwise (page/default)→ the base `name="…"` (the default branch)
    // The base default name (`node.attrs.name`, the literal or the ternary's
    // default) is what a replica override clears back to.
    const baseName = (node?.attrs?.name as string | undefined) ?? iconSet.icons[0]?.id ?? '';
    modifyProjectFile(activeFile, (code) => {
      if (isReplica) {
        return setResponsiveOverride(code, nodeId, iconSet.exportName, vpWidth, 'name', iconId, baseName);
      }
      const parentVariant = (isComponentVariant && activeComponentVariant) ? activeComponentVariant : 'default';
      // The `name` prop is never deleted (an instance always needs a name): the
      // default removeDefaultValue ('default') never equals an icon id, so a
      // no-override result collapses to a plain `name="icon-x"` instead.
      return setConditionalInstanceProp(code, nodeId, iconSet.exportName, 'name', parentVariant, iconId);
    });

    // Push the new `name` prop directly to the live React mount in the
    // sandbox iframe — same imperative path ComponentPropsTool uses for
    // live slider updates. Without this, the parse cycle round-trip can
    // skip the iframe re-render (skip flags, batched atom updates) and
    // the icon stays stuck on the old name even though the file is correct.
    renderCodeComponentDirect(nodeId, { name: iconId });

    // Sync atoms so the panel picks up the new name immediately.
    const fresh = projectFS.readFile(activeFile);
    if (fresh) {
      setCode(fresh);
      setVersion(v => v + 1);
    }
    // Keep the picker open so the user can preview multiple icons in a
    // row without re-opening it each time — the active selection updates
    // live behind the popup. They can dismiss with × or click-outside.
    // NOTE: the variant/viewport-context values MUST be in the deps — without
    // them the callback closes over their initial-render values (interacting
    // viewport 'desktop' → default branch) and every pick overwrites the base
    // name across all variants instead of the active tile.
  }, [nodeId, iconSet, activeFile, setCode, setVersion, node, isReplica, vpWidth, isComponentVariant, activeComponentVariant]);

  // ─── Edit — open the icon-set master file ────────────────────────────────

  const handleEdit = useCallback(() => {
    if (!iconSet) return;
    // CDN vectors aren't editable in place — the master lives in
    // someone else's project and the bundle is immutable. Open the
    // LinkedComponentModal (Unlink Instance / Unlink & Replace All)
    // so the user can fork the bundle into their project before
    // editing, mirroring the canvas double-click + Component-tool
    // "Edit Component" flows for CDN components.
    if (isCdnVector && nodeId) {
      trace.action('icon-set-tool:edit-cdn', { url: iconSet.filePath, nodeId });
      setLinkedModalUrl({ url: iconSet.filePath, nodeId });
      return;
    }
    trace.action('icon-set-tool:edit', { iconSetFile: iconSet.filePath, focusNodeId: currentIconId });
    enterComponentFile(
      {
        fromFilePath: activeFile,
        componentFilePath: iconSet.filePath,
        // Land on the vector this instance is currently bound to (read
        // from the JSX `name="..."` prop above), mirroring the canvas
        // double-click flow. Without this, the master opens fit-to-all-
        // vectors and the user has to find the one they came from.
        focusNodeId: currentIconId ?? undefined,
      },
      {
        setActiveFile,
        setBreadcrumb,
        setSelectedIds,
        setUpdatingFromCanvas,
        setInteractingViewport: setInteractingVp,
        getNodes: () => jotaiStore.get(nodesAtom),
        setSuppressSelectionOverlay: (v) => jotaiStore.set(suppressSelectionOverlayAtom, v),
        // No openCodeEditor — icon-set files navigate to the master canvas,
        // not a code editor overlay. (enterComponentFile only routes to
        // openCodeEditor when @controls is present, which icon-set files
        // don't have, so this is also safe to omit.)
      },
    );
  }, [iconSet, activeFile, currentIconId, setActiveFile, setBreadcrumb, setSelectedIds, setUpdatingFromCanvas, setInteractingVp, jotaiStore, isCdnVector, nodeId, setLinkedModalUrl]);

  // ─── Render gates ────────────────────────────────────────────────────────

  if (!iconSet) return null;
  if (!node || node.componentFile !== iconSet.filePath) return null;

  return (
    <ToolSection title="Icon Set">
      {/* Icon picker row — label + current selection button */}
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Icon" property="__icon-set-name" plain />
        <button
          ref={pickerAnchorRef}
          onClick={() => setPickerOpen(o => !o)}
          className="flex items-center gap-2 w-full px-2 h-7 cut-corners bg-[var(--button-secondary-bg,rgba(255,255,255,0.06))] hover:brightness-125 cursor-pointer border-none text-xs text-[var(--text-primary)]"
        >
          {currentEntry ? (
            <IconThumb entry={currentEntry} size={16} />
          ) : (
            <span className="w-4 h-4 rounded bg-white/10" />
          )}
          <span className="flex-1 text-left truncate">{currentEntry?.displayName ?? 'No icons'}</span>
        </button>
      </div>

      {/* Edit master button */}
      <div className="w-full mt-2">
        <Button onClick={handleEdit} variant="secondary" size="md" className="w-full">
          Edit
        </Button>
      </div>

      {/* Picker popup — thumbnail grid */}
      <ToolPopup
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="Icon Set"
        anchorRef={pickerAnchorRef}
        width={280}
      >
        <div className="grid grid-cols-3 gap-2 p-2">
          {iconSet.icons.length === 0 ? (
            <div className="col-span-3 text-xs text-[var(--text-secondary)] text-center py-4">
              No icons in this set yet.
            </div>
          ) : (
            iconSet.icons.map((entry) => (
              <button
                key={entry.id}
                onClick={() => handlePickIcon(entry.id)}
                title={entry.displayName}
                className={`flex items-center justify-center aspect-square cut-corners cut-border border ${
                  entry.id === currentIconId
                    ? 'border-[var(--accent)] [--cut-border-color:var(--accent)] bg-[var(--accent)]/10'
                    : 'border-white/10 bg-white/[0.04] hover:bg-white/[0.08]'
                } cursor-pointer transition-colors`}
              >
                <IconThumb entry={entry} size={48} />
              </button>
            ))
          )}
        </div>
      </ToolPopup>
    </ToolSection>
  );
}

// ─── Helper: render an icon's SVG markup as a thumbnail ───────────────────

function IconThumb({ entry, size }: { entry: IconEntryInfo; size: number }) {
  // The icon's source SVG carries its own intrinsic viewBox (often a small
  // box like "0 0 32 32" inherited from the original artwork) but the
  // effective painted area on the master canvas is iconConfig's
  // width/height. For grouped icons whose children extend past the inner
  // viewBox (overflow="visible" on the canvas), the inner viewBox is too
  // small to encompass the actual icon — using it for the thumbnail crops
  // to the top-left patch, which is what the user sees as "only top-left".
  //
  // Wrap the icon's markup inside an OUTER <svg viewBox="0 0 W H"> sized
  // to iconConfig's full vector dimensions, so `preserveAspectRatio meet`
  // scales the entire painted area to fit the tile. The inner SVG keeps
  // its own viewBox (drives its inner geometry); the outer wrapper sizes
  // the whole composition.
  //
  //   • Outer viewBox = iconConfig width/height (full painted area)
  //   • Outer width/height = tile size (CSS scaling)
  //   • Outer overflow = hidden (tile clips anything that still spills)
  //   • Strip the inner SVG's `overflow="visible"` so it respects its own
  //     viewBox WITHIN the outer wrapper.
  const W = entry.width || 100;
  const H = entry.height || 100;

  // Modern vector variant (a div with positioned shapes): render every shape at
  // its real position, scaled to fit the tile (`min` so it CONTAINS). The card's
  // backgroundColor is INTENTIONALLY dropped — the picker tile stays transparent
  // (standard) so the icon reads against the modal, not its white card.
  // `bgColor` present iff it came from a div wrapper.
  if (entry.bgColor !== undefined) {
    const scale = Math.min(size / W, size / H);
    return (
      <span style={{ width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        <span
          style={{ position: 'relative', width: W, height: H, transform: `scale(${scale})`, transformOrigin: 'center', flexShrink: 0 }}
          dangerouslySetInnerHTML={{ __html: entry.svgMarkup }}
        />
      </span>
    );
  }

  // Legacy bare-svg entry: wrap in an outer sized <svg>.
  const innerCleaned = entry.svgMarkup.replace(/\s+overflow="[^"]*"/g, '');
  const outerSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" overflow="hidden">${innerCleaned}</svg>`;
  return (
    <span
      style={{ width: size, height: size, display: 'inline-block', overflow: 'hidden' }}
      dangerouslySetInnerHTML={{ __html: outerSvg }}
    />
  );
}
