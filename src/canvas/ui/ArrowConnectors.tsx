// ArrowConnectors.tsx — SVG arrows between connected variant blocks on the master page.
// Exact port from old builder:
//   - No arrowhead markers (line just touches the edge)
//   - No trigger labels on arrows
//   - Closest-edge detection (arrow exits/enters nearest side)
//   - Child selection: arrows grey out when a child of a variant is selected
//   - Only shows arrows for the selected node's connections (or ancestor's)

import { useEffect, useState, useMemo, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { nodesAtom, canvasInteractingAtom, selectedNodeAtom, getNodeFromCache } from '@/code/stores/store';
import { interactingViewportIdAtom } from '@/code/stores/viewport-store';
import { activeFilePathAtom, isComponentFilePath } from '@/code/project/active-file-store';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { parseConnections } from '@/code/variants/connection-config';
import { findNodeRect } from '@/canvas/node-ops';
import { computeArrowPathFromRects } from './arrow-path';
import { pickArrowColor, ARROW_COLOR } from './arrow-color';
import { useStaleRevealGate } from '@/canvas/hooks/useStaleRevealGate';
import { trace } from '@/shared/debug-trace';

const ARROW_WIDTH = 2;
const CORNER_RADIUS = 10;

export default function ArrowConnectors() {
  const activeFile = useAtomValue(activeFilePathAtom);
  const nodes = useAtomValue(nodesAtom);
  // Connections are parsed from the FILE (parseConnections(projectFS.readFile)),
  // not from `nodes` — and adding a connection via modifyProjectFile does NOT
  // reliably hand this component a fresh `nodes` reference (the derived nodesAtom
  // recompute doesn't always propagate to THIS subscriber). Subscribe to
  // projectVersion — bumped by EVERY modifyProjectFile write — and thread it into
  // the recompute effect below so the arrow re-parses + redraws the instant a
  // connection is added/removed, no page reload needed (live find 2026-07-24).
  const projectVersion = useAtomValue(projectVersionAtom);
  const selectedId = useAtomValue(selectedNodeAtom);
  const selectedVpId = useAtomValue(interactingViewportIdAtom);
  const isInteracting = useAtomValue(canvasInteractingAtom);
  const interactingRef = useRef(isInteracting);
  interactingRef.current = isInteracting;
  const [paths, setPaths] = useState<ArrowPath[]>([]);
  // STALE-REVEAL gate: keep the svg hidden after a pan/zoom until the first
  // COMPLETED post-interaction compute commits fresh geometry (see
  // useStaleRevealGate for the failure mode).
  const rootNodeIdRef = useRef<string | null>(null);
  // Endpoints the LAST compute actually anchored to (kept current by the RAF
  // loop below, which keeps computing while hidden) — the gate verifies ALL
  // of them, so a culled variant root / source node holds the reveal until
  // it is rendered and re-measured.
  const probeEndpointsRef = useRef<{ nodeId: string; vpId: string }[]>([]);
  const revealStale = useStaleRevealGate(isInteracting, 'arrow-connectors', () => {
    if (probeEndpointsRef.current.length > 0) return probeEndpointsRef.current;
    return rootNodeIdRef.current ? { nodeId: rootNodeIdRef.current, vpId: 'desktop' } : null;
  });
  const isComponent = isComponentFilePath(activeFile);

  // Find top-level ancestor of the selected node
  const { topLevelId, isChildSelection } = useMemo(() => {
    if (!selectedId) return { topLevelId: null, isChildSelection: false };
    const node = nodes.get(selectedId);
    if (!node) return { topLevelId: null, isChildSelection: false };

    // If this IS a top-level node, direct match
    if (!node.parentId) return { topLevelId: selectedId, isChildSelection: false };

    // Walk up to find top-level ancestor
    let current = node;
    while (current.parentId) {
      const parent = nodes.get(current.parentId);
      if (!parent) break;
      current = parent;
    }
    return { topLevelId: current ? current.id : null, isChildSelection: true };
  }, [selectedId, nodes]);

  // The variant root nodeId is whatever the component author put on the root
  // motion.div (e.g. data-id="card1") — NOT the synthetic 'root' string the
  // sandbox uses for page roots. Find the top-level node in the parsed tree.
  const rootNodeId = useMemo(() => {
    for (const n of nodes.values()) {
      if (!n.parentId && !n.isCanvasNode && n.type !== 'style') return n.id;
    }
    return null;
  }, [nodes]);
  // Mirror for the reveal gate's probe (called from its verify loop).
  rootNodeIdRef.current = rootNodeId;

  useEffect(() => {
    trace.fn('ArrowConnectors:recompute', { isComponent, rootNodeId, projectVersion });
    if (!isComponent) { setPaths([]); return; }
    if (!rootNodeId) { setPaths([]); return; }

    const code = projectFS.readFile(activeFile);
    if (!code) { setPaths([]); return; }

    const connections = parseConnections(code);
    trace.fn('ArrowConnectors:connectionsChanged', {
      connectionCount: connections.length,
      rootNodeId,
      connections: connections.map(c => ({ from: c.from, to: c.to, trigger: c.trigger })),
    });
    if (connections.length === 0) { setPaths([]); return; }

    let rafId: number;
    let lastComputeTime = 0;
    const THROTTLE_MS = 50; // Throttle to ~20fps — prevents blocking main thread for mousemove events
    const computePaths = () => {
      const now = performance.now();
      if (now - lastComputeTime < THROTTLE_MS || interactingRef.current) {
        rafId = requestAnimationFrame(computePaths);
        return;
      }
      lastComputeTime = now;
      const newPaths: ArrowPath[] = [];
      const probeEndpoints: { nodeId: string; vpId: string }[] = [];

      for (const conn of connections) {
        // Skip the arrow when its trigger/source node is HIDDEN in the FROM
        // variant — there's no clickable trigger rendered there, so the
        // connection can't fire. `hiddenOnVariants` is the per-variant
        // visibility source of truth; read fresh each frame so the arrow
        // reappears the moment the node is un-hidden. (Without this the arrow
        // fell back to drawing from the variant root, staying visible.)
        if (conn.sourceNode) {
          const srcNode = getNodeFromCache(conn.sourceNode);
          if (srcNode?.hiddenOnVariants?.has(conn.from)) continue;
        }

        const fromVpId = conn.from === 'default' ? 'desktop' : conn.from;
        const toVpId = conn.to === 'default' ? 'desktop' : conn.to;

        let d: string | null = null;

        // FROM rect: when the connection has a `sourceNode` (per-child
        // trigger), draw the arrow from THAT child's rect in the source
        // variant — visually matches where the click handler actually
        // lives in the rendered DOM. Falls back to the variant root if
        // the source node has been deleted from the JSX since the
        // connection was authored. TO rect always = variant root —
        // connections target the variant block itself, never an
        // equivalent child in the destination viewport.
        const fromAnchorId = conn.sourceNode
          ? (findNodeRect(conn.sourceNode, fromVpId) ? conn.sourceNode : rootNodeId)
          : rootNodeId;
        const fromRect = findNodeRect(fromAnchorId, fromVpId);
        const toRect = findNodeRect(rootNodeId, toVpId);
        probeEndpoints.push({ nodeId: fromAnchorId!, vpId: fromVpId }, { nodeId: rootNodeId!, vpId: toVpId });
        if (fromRect && toRect) {
          d = computeArrowPathFromRects(fromRect, toRect);
        }

        if (d) {
          newPaths.push({
            d,
            from: conn.from,
            to: conn.to,
            sourceNode: conn.sourceNode,
          });
        }
      }

      // Canvas-node connections: a node dragged out of the component keeps its variant connection stashed in
      // `data-conn-target="<to>:<trigger>"` (it can't run a live setVariant at module scope). Draw the arrow from
      // the free canvas node to the target variant root. Read from the code — the parser doesn't surface this attr.
      if (rootNodeId) {
        const fragIdx = code.indexOf('const canvasNodes');
        if (fragIdx !== -1) {
          const frag = code.slice(fragIdx);
          const tagRe = /<[A-Za-z][^>]*\bdata-conn-target="([^"]+)"[^>]*>/g;
          let cm: RegExpExecArray | null;
          while ((cm = tagRe.exec(frag)) !== null) {
            const idM = cm[0].match(/\bdata-id="([^"]+)"/);
            const to = cm[1].split(':')[0];
            if (!idM || !to) continue;
            const toVpId = to === 'default' ? 'desktop' : to;
            const fromRect = findNodeRect(idM[1], 'desktop');
            const toRect = findNodeRect(rootNodeId!, toVpId);
            probeEndpoints.push({ nodeId: idM[1], vpId: 'desktop' }, { nodeId: rootNodeId!, vpId: toVpId });
            const d = fromRect && toRect ? computeArrowPathFromRects(fromRect, toRect) : null;
            if (d) newPaths.push({ d, from: idM[1], to, sourceNode: idM[1] });
          }
        }
      }

      if (newPaths.length !== paths.length) {
        trace.fn('ArrowConnectors:pathsComputed', {
          pathCount: newPaths.length,
          routes: newPaths.map(p => `${p.from} → ${p.to}`),
        });
      }
      probeEndpointsRef.current = probeEndpoints;
      setPaths(newPaths);
      rafId = requestAnimationFrame(computePaths);
    };

    rafId = requestAnimationFrame(computePaths);
    return () => cancelAnimationFrame(rafId);
  }, [isComponent, activeFile, nodes, rootNodeId, projectVersion]);

  if (!isComponent || paths.length === 0) return null;

  // Per-arrow color rules live in `arrow-color.ts` so they can be
  // unit-tested without React. See that file for the rule table.
  const isCanvasNodeSelected = !!(selectedId && nodes.get(selectedId)?.isCanvasNode);
  const colorForArrow = (p: ArrowPath): string =>
    pickArrowColor(p, selectedId, isChildSelection, selectedVpId, isCanvasNodeSelected);

  return (
    <svg
      data-arrow-connectors
      data-arrow-count={paths.length}
      style={{
        position: 'fixed',
        left: 0, top: 0,
        width: '100vw', height: '100vh',
        pointerEvents: 'none',
        overflow: 'visible',
        zIndex: 2,
        opacity: isInteracting || revealStale ? 0 : 1,
        visibility: isInteracting || revealStale ? 'hidden' : 'visible',
        transition: isInteracting || revealStale ? 'none' : 'opacity 0.15s',
      }}
    >
      {/* Arrowhead marker — applied via `markerEnd` on highlighted
       *  (purple) arrows to show direction, the same shape the reference uses
       *  on its connection arrows. Greyed-out arrows skip the marker
       *  so the de-emphasized state stays visually quieter (matches the
       *  the reference convention of "arrow tip = the active connection").
       *  refX is shifted toward the tip so the arrowhead's point sits
       *  at the path endpoint instead of overshooting. orient="auto"
       *  rotates with the path's incoming tangent. */}
      <defs>
        <marker
          id="arrow-connectors-tip"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path d="M 0 0 L 10 5 L 0 10 Z" fill={ARROW_COLOR} />
        </marker>
      </defs>
      {paths.map((p, i) => {
        const stroke = colorForArrow(p);
        const isHighlighted = stroke === ARROW_COLOR;
        return (
          <path
            key={`${p.from}-${p.to}-${p.sourceNode ?? 'root'}-${i}`}
            d={p.d}
            fill="none"
            stroke={stroke}
            strokeWidth={ARROW_WIDTH}
            strokeLinecap="round"
            strokeLinejoin="round"
            markerEnd={isHighlighted ? 'url(#arrow-connectors-tip)' : undefined}
          />
        );
      })}
    </svg>
  );
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface ArrowPath {
  d: string;
  from: string;
  to: string;
  /** When set, the connection's trigger lives on this child element
   *  (data-id) — not the variant root. The arrow's origin point in the
   *  source variant tracks this child's rect. */
  sourceNode?: string;
}
