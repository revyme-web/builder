// InteractionsTool.tsx — Properties-panel "Interactions" section.
//
// Two modes, picked by file type:
//   - Component master file → variant connections (existing): "from variant
//     X, on click, transition to variant Y". Backed by `connection-config.ts`.
//   - Regular page file → Set Variable actions: "on this node's click, set
//     page variable X to value V". Backed by `page-interactions-gen.ts`.
//
// The two render different forms (variant pickers vs variable pickers) but
// share the same +Add button, the same row shape, and the same trigger
// vocabulary.

import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useAnchoredMenu } from '../hooks/useAnchoredMenu';
import { createPortal } from 'react-dom';
import { useAtomValue, useSetAtom } from 'jotai';
import { isComponentFileAtom, selectedNodeAtom, codeAtom, variableModalRequestAtom } from '@/code/stores/store';
import { useNode } from '@/code/stores/node-family';
import { activeFilePathAtom, isLayoutFile } from '@/code/project/active-file-store';
import { interactingViewportIdAtom } from '@/code/stores/viewport-store';
import { isPrimaryViewport, forceCanvasRender } from '@/canvas/node-ops';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { parseConnections, addConnection, removeConnection, type ConnectionTrigger, type Connection } from '@/code/variants/connection-config';
import { parseVariantConfig } from '@/code/variants/variant-config';
import { pageVariablesAtom } from '@/code/stores/page-variables-store';
import { pageInteractionsForSelectedAtom, closeOverlayInteractionsForSelectedAtom, enclosingOverlayForSelectedAtom } from '@/code/stores/page-interactions-store';
import { overlayCallsAtom } from '@/code/stores/overlay-store';
import { stateVarName } from '@/code/generation/overlay-gen';
import {
  setterName,
  type InteractionTrigger,
  type PageInteraction,
} from '@/code/features/page-interactions';
import { defaultForType, type PageVariable } from '@/code/features/page-variables';
import { queueMutation, flushNow } from '@/code/mutation/mutation-queue';
import { buildComponentRegistry, type ComponentProp } from '@/code/components/component-registry';
import { parseChildEventFires, type EventFireTrigger } from '@/code/generation/event-fire-gen';
import { parseInstanceEventBindings } from '@/code/generation/instance-event-gen';
import { overlayCloseSetter } from '@/code/generation/close-overlay-gen';
import { ToolSection, ToolRow, ToolSelect, ToolInput, ToolSlider, ToolSegmentedControl, ToolPlusMinus, ColorInput, ControlActionRow, RemoveButton, ControlLabel } from '../controls';
import type { MenuItem } from '../controls/control-menu-items';
import ImagePickerInput from '../controls/ImagePickerInput';
import ToolPopup from '../ui/ToolPopup';
import { trace } from '@/shared/debug-trace';

const TRIGGER_OPTIONS = [
  { value: 'click', label: 'Click' },
  { value: 'clickStart', label: 'Click Start' },
  { value: 'mouseEnter', label: 'Mouse Enter' },
  { value: 'mouseLeave', label: 'Mouse Leave' },
  { value: 'inView', label: 'In View' },
  { value: 'afterDelay', label: 'After Delay' },
];

// Page-file triggers: subset that make sense on plain DOM elements (no
// motion-only events like clickStart/inView; those need framer-motion props).
const PAGE_TRIGGER_OPTIONS = [
  { value: 'click',      label: 'Click'       },
  { value: 'mouseEnter', label: 'Mouse Enter' },
  { value: 'mouseLeave', label: 'Mouse Leave' },
];

function formatTrigger(trigger: string): string {
  switch (trigger) {
    case 'afterDelay': return 'After Delay';
    case 'click': return 'Click';
    case 'clickStart': return 'Click Start';
    case 'mouseEnter': return 'Mouse Enter';
    case 'mouseLeave': return 'Mouse Leave';
    case 'inView': return 'In View';
    default: return trigger;
  }
}

export default function InteractionsTool() {
  const isComponentFile = useAtomValue(isComponentFileAtom);
  const activeFilePath = useAtomValue(activeFilePathAtom);
  const selectedId = useAtomValue(selectedNodeAtom);
  const selectedNode = useNode(selectedId) ?? null;

  if (!selectedId) return null;
  if (!selectedNode) return null;

  // `isComponentFileAtom` is TRUE for templates (LayoutClient.tsx) too, but
  // templates are PAGE dialect — their elements carry page interactions
  // (Set Variable / Close Overlay), not component variant connections. So the
  // component-variant branch is for REAL component masters only.
  const isTemplate = isLayoutFile(activeFilePath);

  // Component master files: only the root (top-level) node has variant
  // connections — that's where motion props attach. Regular pages + templates:
  // any node can carry interactions, so no top-level gate.
  if (isComponentFile && !isTemplate) {
    // ROOT and CHILDREN share ONE Interactions tool: the + opens a dropdown
    // (New Transition → variant-connection popup; New Event → create+fire a
    // component EVENT variable; Choose Event → fire an existing one). Children
    // were previously hidden entirely.
    return <ComponentInteractions selectedId={selectedId} isRoot={!selectedNode.parentId} />;
  }
  // A component INSTANCE on a page (this tool only mounts for instances that
  // live inside a collection list — see PropertiesPanel's isInsideCollectionList
  // gate). Surface its event-type prop bindings (e.g. Load More's `onLoadMore`,
  // auto-wired at pagination time) as Click interaction rows.
  if (selectedNode.isComponentInstance && selectedNode.componentFile) {
    return <ComponentInstanceEventInteractions selectedId={selectedId} componentFile={selectedNode.componentFile} />;
  }
  return <PageVarInteractions selectedId={selectedId} />;
}

// ─── Component-INSTANCE event interactions (page side) ──────────────────────
// A design component can declare event-type props (@propMeta type:'event'). On
// the page, the instance passes a handler for that event — e.g. the collection
// list's Load More passes `onLoadMore={() => setVisibleCount(c => c + N)}`. The
// component fires the event on click, so each bound event prop is a Click
// interaction. This branch READS those bindings and lists them (the binding is
// created/owned by the feature that inserted the instance, so it shows the
// moment Load More is created — no manual wiring needed).
function ComponentInstanceEventInteractions({ selectedId, componentFile }: { selectedId: string; componentFile: string }) {
  const code = useAtomValue(codeAtom);
  // The overlay this instance lives inside (null when not in one) — gates the
  // "Close Overlay" wiring below.
  const enclosingOverlay = useAtomValue(enclosingOverlayForSelectedAtom);
  const [editProp, setEditProp] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const eventProps = useMemo<ComponentProp[]>(() => {
    const reg = buildComponentRegistry(projectFS);
    for (const info of reg.values()) {
      if (info.filePath === componentFile) return info.props.filter(p => p.varType === 'event');
    }
    return [];
  }, [componentFile, code]);

  const bindings = useMemo(
    () => parseInstanceEventBindings(code ?? '', selectedId, eventProps.map(p => p.name)),
    [code, selectedId, eventProps],
  );

  // Write the delay (seconds) onto a NON-close instance handler (Load More) + re-render.
  const setDelay = useCallback((propName: string, seconds: number) => {
    const d = Math.max(0, Math.round(seconds * 10) / 10); // 1-decimal, no float drift
    trace.action('interactions-tool:instance-event-delay', { selectedId, propName, delay: d });
    queueMutation({ type: 'setInstanceEventDelay', nodeId: selectedId, propName, delaySeconds: d });
    flushNow();
    forceCanvasRender();
  }, [selectedId]);

  // Wire a design-component event prop → close the enclosing overlay, i.e. the
  // instance gets `event1={() => setOverlayXOpen(false)}`. Lets the component's
  // OWN X (which fires `event1` internally) dismiss the modal it sits in.
  const bindClose = useCallback((propName: string) => {
    if (!enclosingOverlay) return;
    trace.action('interactions-tool:instance-event-close-overlay', { selectedId, propName, overlayId: enclosingOverlay });
    queueMutation({ type: 'bindInstanceEventCloseOverlay', nodeId: selectedId, propName, overlayId: enclosingOverlay });
    flushNow();
    forceCanvasRender();
    setAddOpen(false);
  }, [selectedId, enclosingOverlay]);

  const unbind = useCallback((propName: string) => {
    trace.action('interactions-tool:instance-event-unbind', { selectedId, propName });
    queueMutation({ type: 'unbindInstanceEvent', nodeId: selectedId, propName });
    flushNow();
    forceCanvasRender();
  }, [selectedId]);

  // No event-type props on this component → nothing instance-specific to show;
  // fall back to the generic page-variable interactions so the section still
  // behaves like every other node.
  if (eventProps.length === 0) return <PageVarInteractions selectedId={selectedId} />;

  // Classify each event prop's current binding (plain filters — bindings/eventProps
  // are already memoised). A prop is a CLOSE-OVERLAY binding when its handler calls
  // the enclosing overlay's `set<X>Open(false)` (direct or setTimeout-delayed).
  const closeSetter = enclosingOverlay ? overlayCloseSetter(enclosingOverlay) : null;
  const bindingFor = (name: string) => bindings.find(b => b.propName === name);
  const isCloseBinding = (name: string) => !!closeSetter && !!bindingFor(name)?.handler?.includes(closeSetter);
  const closeBoundProps = eventProps.filter(p => isCloseBinding(p.name));
  // "Other" bound = a bound handler that ISN'T our close-overlay one (e.g. Load More).
  const otherBoundProps = eventProps.filter(p => bindingFor(p.name)?.bound && !isCloseBinding(p.name));
  const unboundProps = eventProps.filter(p => !bindingFor(p.name)?.bound);
  const hasContent = otherBoundProps.length > 0 || closeBoundProps.length > 0;

  // "+" is offered ONLY inside an overlay with an unbound event to wire — one item
  // per unbound event prop (native flyout, mirrors the other tools' Add dropdowns).
  const addAction = enclosingOverlay && unboundProps.length > 0 ? (
    <div className="relative">
      <button
        onClick={(e) => { e.stopPropagation(); setAddOpen(o => !o); }}
        className="flex items-center justify-end pl-[80px] -ml-[80px] cursor-pointer group text-[var(--text-primary)]"
        title="Add interaction"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
      </button>
      {addOpen && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setAddOpen(false)} />
          <div className="absolute right-0 top-full mt-1 bg-[var(--dropdown-bg)] shadow-md rounded-[var(--radius-md)] py-1.5 z-[51] w-max border border-[var(--border-light)] space-y-0.5">
            {unboundProps.map(p => (
              <button
                key={p.name}
                type="button"
                onClick={() => bindClose(p.name)}
                className="group flex items-center mx-1.5 px-2.5 py-1.5 rounded w-[calc(100%-12px)] text-left cursor-pointer bg-transparent hover:!bg-[var(--accent)] border-none whitespace-nowrap"
              >
                <span className="text-xs font-medium text-[var(--text-primary)] group-hover:text-[var(--accent-fg)]">Close Overlay · {p.label ?? p.name}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  ) : null;

  return (
    <>
      <ToolSection title="Interactions" hasContent={hasContent} action={addAction}>
        <div className="contents">
          {/* Non-close bound handlers (e.g. Load More) — Click row → delay form. */}
          {otherBoundProps.map(p => (
            <div key={`ie-${p.name}`} className="flex items-center justify-between w-full"
              ref={el => { if (el) rowRefs.current.set(p.name, el); }}>
              <span className="w-3/4 min-w-0 text-[11px] font-bold text-[var(--text-secondary)]">Click</span>
              <ControlActionRow className="!pr-2" onClick={() => setEditProp(p.name)}>
                {/* Event swatch matches the master-side event-fire row. */}
                <span className="flex items-center justify-center w-5 h-5 rounded border border-white/10 flex-shrink-0" style={{ backgroundColor: 'var(--accent-secondary, #a855f7)' }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="var(--accent-secondary-fg)"><path d="M13 2 L4 14 h6 l-1 8 9-12 h-6 z" /></svg>
                </span>
                <span className="truncate flex-1 min-w-0">{p.label ?? p.name}</span>
              </ControlActionRow>
            </div>
          ))}
          {/* <Event> → Close Overlay rows: CLICK opens the same On/Delay popup as a
              plain node's Close Overlay; × unbinds (RemoveButton stops propagation). */}
          {closeBoundProps.map(p => (
            <div key={`co-${p.name}`} className="flex items-center justify-between w-full"
              ref={el => { if (el) rowRefs.current.set(p.name, el); }}>
              <span className="w-3/4 min-w-0 text-[11px] font-bold text-[var(--text-secondary)]">{p.label ?? p.name}</span>
              <ControlActionRow className="!pr-2" onClick={() => setEditProp(p.name)}>
                <span className="flex items-center justify-center w-5 h-5 rounded border border-white/10 flex-shrink-0" style={{ backgroundColor: 'var(--accent-secondary, #a855f7)' }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="var(--accent-secondary-fg)"><path d="M13 2 L4 14 h6 l-1 8 9-12 h-6 z" /></svg>
                </span>
                <span className="truncate flex-1 min-w-0">Close Overlay</span>
                <RemoveButton onClick={() => unbind(p.name)} />
              </ControlActionRow>
            </div>
          ))}
        </div>
      </ToolSection>

      {editProp !== null && (() => {
        // One popup for BOTH row kinds — the Close Overlay binding and a plain
        // event handler (Load More) share the On/Delay form; the title + trigger
        // label differ. Delay routes through setInstanceEventDelay either way.
        const p = eventProps.find(x => x.name === editProp);
        if (!p) return null;
        const isClose = isCloseBinding(editProp);
        const delay = bindings.find(b => b.propName === editProp)?.delay ?? 0;
        return (
          <ToolPopup isOpen onClose={() => setEditProp(null)} title={isClose ? 'Close Overlay' : (p.label ?? p.name)}
            anchorRef={{ current: rowRefs.current.get(editProp) ?? null } as React.RefObject<HTMLElement>} width={260}>
            <InstanceEventForm triggerLabel={isClose ? 'Tap' : 'Click'} delay={delay} onSetDelay={(d) => setDelay(editProp, d)} />
          </ToolPopup>
        );
      })()}
    </>
  );
}

// Popup body for a component-instance event interaction. The component fires the
// event on click, so "On" is fixed to Click; "Delay" wraps the handler in a
// setTimeout (matches the master-side EventFireForm's On/Delay layout).
function InstanceEventForm({ delay, onSetDelay, triggerLabel = 'Click' }: { delay: number; onSetDelay: (d: number) => void; triggerLabel?: string }) {
  const safe = Number.isFinite(delay) ? delay : 0;
  return (
    <div className="flex flex-col gap-2">
      <ToolRow label="On">
        <ToolSelect value="click" onChange={() => {}} options={[{ value: 'click', label: triggerLabel }]} />
      </ToolRow>
      <ToolRow label="Delay">
        <ToolInput
          value={String(safe)}
          onChange={(v) => { const n = parseFloat(v); onSetDelay(Number.isFinite(n) ? Math.max(0, n) : 0); }}
          step={0.1}
          chevronLabel="s"
          className="!w-16 shrink-0"
        />
        <ToolPlusMinus value={safe} onChange={onSetDelay} min={0} max={60} step={0.1} />
      </ToolRow>
    </div>
  );
}

// ─── Event-fire Interactions (a CHILD inside a component master FIRES an Event var) ─
// standard component events: pick a trigger + an Event variable; the child gets
// `on<Trigger>={eventVar}`. The page instance later passes a handler for that event
// (e.g. opening an overlay), so the child's interaction fires it.

const EVENT_FIRE_TRIGGER_OPTIONS: Array<{ value: EventFireTrigger; label: string }> = [
  { value: 'click', label: 'Click' },
  { value: 'mouseEnter', label: 'Mouse Enter' },
  { value: 'mouseLeave', label: 'Mouse Leave' },
];

// ─── The + dropdown: New Transition / New Event / Choose Event ──────────────
// Item styling + the left-flyout submenu are COPIED from AnimationTool's
// AddEffectDropdown (its EffectSubMenu) so they look identical.
const ADD_ITEM = 'group flex items-center justify-between mx-1.5 px-2.5 py-1.5 rounded w-[calc(100%-12px)] text-left cursor-pointer bg-transparent hover:!bg-[var(--accent)] border-none whitespace-nowrap';
const ADD_ITEM_LABEL = 'text-xs font-medium text-[var(--text-primary)] group-hover:text-[var(--accent-fg)]';

/** "Choose Event" — a hover flyout that opens to the LEFT (portaled), exactly like
 *  the Animation tool's "Scroll ›" submenu. */
function ChooseEventSubMenu({ eventVars, onChoose }: { eventVars: ComponentProp[]; onChoose: (name: string) => void }) {
  const [showSub, setShowSub] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [subPos, setSubPos] = useState({ x: 0, y: 0 });
  useEffect(() => {
    if (showSub && btnRef.current) { const r = btnRef.current.getBoundingClientRect(); setSubPos({ x: r.left - 8, y: r.top }); }
  }, [showSub]);
  return (
    <div onMouseEnter={() => setShowSub(true)} onMouseLeave={() => setShowSub(false)}>
      <button ref={btnRef} type="button" className={ADD_ITEM} onClick={() => setShowSub(s => !s)}>
        <span className={ADD_ITEM_LABEL}>Choose Event</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--text-secondary)] group-hover:text-[var(--accent-fg)] shrink-0 ml-2"><polyline points="9 18 15 12 9 6" /></svg>
      </button>
      {showSub && createPortal(
        <div style={{ position: 'fixed', left: subPos.x, top: subPos.y, transform: 'translateX(-100%)', zIndex: 9999 }}
          onMouseEnter={() => setShowSub(true)} onMouseLeave={() => setShowSub(false)}>
          <div style={{ position: 'absolute', top: 0, right: -12, width: 16, height: '100%' }} />
          <div className="min-w-max bg-[var(--dropdown-bg)] border border-[var(--border-light)] rounded-[var(--radius-md)] shadow-2xl py-1">
            {eventVars.map(v => (
              <button key={v.name} type="button"
                className="group flex items-center w-full px-3 py-1.5 text-left cursor-pointer bg-transparent hover:!bg-[var(--accent)] border-none whitespace-nowrap"
                // onMouseDown (not onClick): this menu is portaled to <body>, and
                // the parent add-menu's click-outside handler closes on `mousedown`
                // — which unmounts this portal before a mouseup/onClick could fire.
                // Acting on mousedown runs the choice first. preventDefault stops
                // the button stealing focus / text-selection. (Same pattern as the
                // LinkUrlControl page picker.)
                onMouseDown={(e) => { e.preventDefault(); onChoose(v.name); }}>
                <span className="text-[12px] font-medium text-[var(--text-primary)] group-hover:text-[var(--accent-fg)]">{v.label ?? v.name}</span>
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

function InteractionAddMenu({ buttonRef, onNewTransition, onNewEvent, eventVars, onChooseEvent }: {
  buttonRef: React.RefObject<HTMLButtonElement | null>;
  onNewTransition: () => void;
  onNewEvent: () => void;
  eventVars: ComponentProp[];
  onChooseEvent: (name: string) => void;
}) {
  const { open, setOpen, openDir, visible, ref } = useAnchoredMenu({ menuHeight: 200, anchorRef: buttonRef });

  return (
    <div className="relative" ref={ref}>
      <button ref={buttonRef} onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
        className="flex items-center justify-end pl-[80px] -ml-[80px] cursor-pointer group text-[var(--text-primary)]" title="Add interaction">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="transition-opacity group-hover:opacity-80">
          <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setOpen(false)} />
          <div className={`absolute right-0 ${openDir === 'up' ? 'bottom-full mb-1' : 'top-full mt-1'} bg-[var(--dropdown-bg)] shadow-md rounded-[var(--radius-md)] py-1.5 z-[51] w-max min-w-[160px] border border-[var(--border-light)] transition-opacity duration-150`}
            style={{ opacity: visible ? 1 : 0 }}>
            <button type="button" className={ADD_ITEM} onClick={() => { setOpen(false); onNewTransition(); }}><span className={ADD_ITEM_LABEL}>New Transition</span></button>
            <button type="button" className={ADD_ITEM} onClick={() => { setOpen(false); onNewEvent(); }}><span className={ADD_ITEM_LABEL}>New Event</span></button>
            {eventVars.length > 0 && <ChooseEventSubMenu eventVars={eventVars} onChoose={(name) => { setOpen(false); onChooseEvent(name); }} />}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Component Interactions (root AND children of a component master) ───────
// Variant connections (New Transition) + component EVENT-variable fires (New Event /
// Choose Event). Each node owns its connections (by `sourceNode`) + event-fires.
function ComponentInteractions({ selectedId, isRoot }: { selectedId: string; isRoot: boolean }) {
  const code = useAtomValue(codeAtom);
  const activeFile = useAtomValue(activeFilePathAtom);
  const setCode = useSetAtom(codeAtom);
  const setVersion = useSetAtom(projectVersionAtom);
  const setVariableModalRequest = useSetAtom(variableModalRequestAtom);
  const vpId = useAtomValue(interactingViewportIdAtom);
  const [addOpen, setAddOpen] = useState(false);
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [editFire, setEditFire] = useState<EventFireTrigger | null>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const connRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const fireRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const currentVariant = isPrimaryViewport(vpId) ? 'default' : vpId;
  const allConnections = useMemo(() => code ? parseConnections(code) : [], [code]);
  // A connection belongs to its `sourceNode`; legacy connections (no source) → root.
  const connections = useMemo(() => allConnections.filter(c =>
    (c.sourceNode ? c.sourceNode === selectedId : isRoot) && c.from === currentVariant),
    [allConnections, selectedId, isRoot, currentVariant]);
  const variants = useMemo(() => code ? parseVariantConfig(code) : [], [code]);
  const variantOptions = useMemo(() => variants.map(v => ({ value: v.name, label: v.label })), [variants]);
  const getVariantLabel = useCallback((name: string) => variants.find(v => v.name === name)?.label ?? name, [variants]);

  const allProps = useMemo<ComponentProp[]>(() => {
    const reg = buildComponentRegistry(projectFS);
    for (const info of reg.values()) if (info.filePath === activeFile) return info.props;
    return [];
  }, [activeFile, code]);
  const eventVars = useMemo(() => allProps.filter(p => p.varType === 'event'), [allProps]);
  const eventNames = useMemo(() => eventVars.map(v => v.name), [eventVars]);
  const eventFires = useMemo(() => parseChildEventFires(code ?? '', selectedId, eventNames, currentVariant), [code, selectedId, eventNames, currentVariant]);

  // Re-read the file into codeAtom + bump projectVersion so the parsed-code
  // atoms (connections, nodes → the ArrowConnectors overlay) re-derive. Also
  // force a full Renderer rebuild on the next frame: a connection is a STRUCTURAL
  // codegen change (adds useState / event handlers / `initial=` to the master)
  // that the in-place DOM patch can't apply and the reactive render skips — so
  // the sandbox + arrow only reliably refresh on a full cycle (matches every
  // sibling interaction handler, which all `flushNow()` + `forceCanvasRender()`).
  // Deferred a frame so the setCode/setVersion above land in the re-derived
  // nodesAtom before the rebuild reads it.
  const refresh = useCallback(() => {
    const c = projectFS.readFile(activeFile);
    if (c) { setCode(c); setVersion(v => v + 1); }
    requestAnimationFrame(() => forceCanvasRender());
  }, [activeFile, setCode, setVersion]);
  const handleRemove = useCallback((conn: Connection) => { removeConnection(activeFile, conn.from, conn.to, { trigger: conn.trigger, sourceNode: conn.sourceNode ?? null }); refresh(); setEditIdx(null); }, [activeFile, refresh]);
  const handleAdd = useCallback((trigger: ConnectionTrigger, from: string, to: string, delay: number) => { addConnection(activeFile, from, to, trigger, delay || undefined, selectedId); refresh(); setAddOpen(false); }, [activeFile, refresh, selectedId]);
  const handleUpdate = useCallback((oldConn: Connection, t: ConnectionTrigger, f: string, to: string, d: number) => { removeConnection(activeFile, oldConn.from, oldConn.to, { trigger: oldConn.trigger, sourceNode: oldConn.sourceNode ?? null }); addConnection(activeFile, f, to, t, d || undefined, oldConn.sourceNode ?? selectedId); refresh(); }, [activeFile, refresh, selectedId]);

  const setFire = useCallback((trigger: EventFireTrigger, eventVar: string, replace?: EventFireTrigger, delay = 0) => {
    if (replace && replace !== trigger) queueMutation({ type: 'removeChildEventFire', childId: selectedId, trigger: replace, variantName: currentVariant });
    queueMutation({ type: 'setChildEventFire', childId: selectedId, trigger, eventVar, delay, variantName: currentVariant });
    flushNow();
    trace.action('interactions-tool:set-fire', { selectedId, trigger, eventVar, delay, variantName: currentVariant });
  }, [selectedId, currentVariant]);
  const removeFire = useCallback((trigger: EventFireTrigger) => { queueMutation({ type: 'removeChildEventFire', childId: selectedId, trigger, variantName: currentVariant }); flushNow(); setEditFire(null); }, [selectedId, currentVariant]);

  const usedFire = new Set(eventFires.map(b => b.trigger));
  const freeFire = (EVENT_FIRE_TRIGGER_OPTIONS.map(o => o.value).find(t => !usedFire.has(t)) ?? 'click') as EventFireTrigger;

  // New Event = auto-create an Event variable AND fire it on this layer (click)
  // immediately — no "create variable" step — then open the modal on the just-created
  // variable so it's only a RENAME (edit mode, no Create Variable button), exactly
  // like binding any other variable.
  const createAndFireEvent = useCallback((trigger: EventFireTrigger) => {
    const taken = new Set(allProps.map(p => p.name));
    let n = 1; let name = `event${n}`;
    while (taken.has(name)) name = `event${++n}`;
    queueMutation({ type: 'createTypedVariable', name, varType: 'event', literalKind: 'string', defaultValue: '' });
    queueMutation({ type: 'setChildEventFire', childId: selectedId, trigger, eventVar: name, variantName: currentVariant });
    flushNow();
    setVariableModalRequest({ property: '', propertyLabel: 'Event', currentValue: '', variableRef: name, nameEditable: true });
    trace.action('interactions-tool:create-fire-event', { selectedId, trigger, name, variantName: currentVariant });
  }, [allProps, selectedId, setVariableModalRequest, currentVariant]);

  // Open the Variable Modal to manage/rename the bound event variable.
  const openVariable = useCallback((name: string) => {
    setVariableModalRequest({ property: '', propertyLabel: 'Event', currentValue: '', variableRef: name, nameEditable: true });
  }, [setVariableModalRequest]);

  const hasRows = connections.length > 0 || eventFires.length > 0;

  return (
    <>
      <ToolSection title="Interactions" hasContent={hasRows}
        action={<InteractionAddMenu buttonRef={addBtnRef}
          onNewTransition={() => setAddOpen(true)} onNewEvent={() => createAndFireEvent(freeFire)}
          eventVars={eventVars} onChooseEvent={(name) => setFire(freeFire, name)} />}>
        <div className="contents">
          {connections.map((conn, i) => (
            <div key={`c-${conn.from}-${conn.to}-${conn.trigger}-${i}`} className="flex items-center justify-between w-full"
              ref={el => { if (el) connRefs.current.set(i, el); }}>
              <span className="w-3/4 min-w-0 text-[11px] font-bold text-[var(--text-secondary)]">{formatTrigger(conn.trigger)}</span>
              <ControlActionRow onClick={() => setEditIdx(i)}>
                <span className="truncate flex-1 min-w-0">{getVariantLabel(conn.to)}</span>
                <RemoveButton onClick={() => handleRemove(conn)} />
              </ControlActionRow>
            </div>
          ))}
          {eventFires.map(b => (
            <div key={`e-${b.trigger}`} className="flex items-center justify-between w-full"
              ref={el => { if (el) fireRefs.current.set(b.trigger, el); }}>
              <span className="w-3/4 min-w-0 text-[11px] font-bold text-[var(--text-secondary)]">{formatTrigger(b.trigger)}</span>
              <ControlActionRow onClick={() => setEditFire(b.trigger)} className="!pr-2">
                {/* Swatch matches the Fill tool's ColorSwatch (sm): w-5 h-5 rounded border-white/10. */}
                <span className="flex items-center justify-center w-5 h-5 rounded border border-white/10 flex-shrink-0" style={{ backgroundColor: 'var(--accent-secondary, #a855f7)' }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="var(--accent-secondary-fg)"><path d="M13 2 L4 14 h6 l-1 8 9-12 h-6 z" /></svg>
                </span>
                <span className="truncate flex-1 min-w-0">{eventVars.find(v => v.name === b.eventVar)?.label ?? b.eventVar}</span>
                <RemoveButton onClick={() => removeFire(b.trigger)} />
              </ControlActionRow>
            </div>
          ))}
        </div>
      </ToolSection>

      {editIdx !== null && connections[editIdx] && (
        <ToolPopup isOpen onClose={() => setEditIdx(null)} title="Edit Interaction"
          anchorRef={{ current: connRefs.current.get(editIdx) ?? null } as React.RefObject<HTMLElement>} width={240}>
          <EditInteractionForm conn={connections[editIdx]} variants={variantOptions}
            onUpdate={(t, f, to, d) => { handleUpdate(connections[editIdx!], t, f, to, d); setEditIdx(null); }}
            onRemove={() => handleRemove(connections[editIdx!])} />
        </ToolPopup>
      )}

      {editFire !== null && eventFires.find(b => b.trigger === editFire) && (
        <ToolPopup isOpen onClose={() => setEditFire(null)} title="Event"
          anchorRef={{ current: fireRefs.current.get(editFire) ?? null } as React.RefObject<HTMLElement>} width={260}>
          {(() => {
            const b = eventFires.find(x => x.trigger === editFire)!;
            return (
              <EventFireForm
                binding={b}
                eventVars={eventVars}
                onSetTrigger={(t) => { setFire(t, b.eventVar, b.trigger, b.delay); setEditFire(t); }}
                onSetDelay={(d) => setFire(b.trigger, b.eventVar, undefined, d)}
                onSetEvent={(name) => setFire(b.trigger, name, undefined, b.delay)}
                onCreateVariable={() => createAndFireEvent(b.trigger)}
                onOpenVariable={() => openVariable(b.eventVar)}
              />
            );
          })()}
        </ToolPopup>
      )}

      <ToolPopup isOpen={addOpen} onClose={() => setAddOpen(false)} title="Add Interaction" anchorRef={addBtnRef as React.RefObject<HTMLElement>} width={240}>
        <AddInteractionForm variants={variantOptions} onAdd={handleAdd} />
      </ToolPopup>
    </>
  );
}


// ─── Event popup body (On / Delay / Event ControlLabel + purple variable pill) ──
function EventFireForm({ binding, eventVars, onSetTrigger, onSetDelay, onSetEvent, onCreateVariable, onOpenVariable }: {
  binding: { trigger: EventFireTrigger; eventVar: string; delay: number };
  eventVars: ComponentProp[];
  onSetTrigger: (t: EventFireTrigger) => void;
  onSetDelay: (d: number) => void;
  onSetEvent: (name: string) => void;
  onCreateVariable: () => void;
  onOpenVariable: () => void;
}) {
  // Show the friendly @propMeta label (e.g. "rgergerg"), not the prop identifier (`event1`).
  const eventDisplay = eventVars.find(v => v.name === binding.eventVar)?.label ?? binding.eventVar;
  // The "Event" label is a REAL ControlLabel (same chevron menu as Fill/Radius). Its
  // menu: Create Variable + Set Variable › (cascading submenu of the component's events).
  const extraMenuItems: MenuItem[] = [
    { label: 'Create Variable', onClick: onCreateVariable, show: true },
    {
      label: 'Set Variable', onClick: () => {}, show: true,
      submenuItems: eventVars.length > 0
        ? eventVars.map(v => ({ label: v.label ?? v.name, onClick: () => onSetEvent(v.name), show: true }))
        : undefined,
    },
  ];
  return (
    // `pl-[14px]` gives the Event ControlLabel's chevron (which sits ~14px left of
    // the label via `-ml-[18px]` + `-left-[14px]`) room inside the popup instead of
    // overflowing its left edge. On/Delay shift right with it, staying aligned.
    <div className="flex flex-col gap-3 pl-[14px]">
      <ToolRow label="On">
        <ToolSelect value={binding.trigger} onChange={(v) => onSetTrigger(v as EventFireTrigger)} options={EVENT_FIRE_TRIGGER_OPTIONS} />
      </ToolRow>
      <ToolRow label="Delay">
        <DelayControl value={binding.delay} onChange={onSetDelay} />
      </ToolRow>
      {/* EXACT ToolRow layout: ControlLabel (w-3/4 + chevron gutter) + value div (w-full),
          so the Event row aligns with On/Delay above and the pill fills the value column. */}
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Event" property="" hideResetStyle hideCmsBinding hideCreateVariable extraMenuItems={extraMenuItems} />
        <div className="flex items-center gap-2 w-full">
          {/* The purple variable pill — clicking opens the Variable Modal to manage/rename it. */}
          <button type="button" onClick={onOpenVariable}
            className="w-full h-7 flex items-center gap-1.5 px-2 rounded-lg text-xs font-medium text-white cursor-pointer hover:brightness-110"
            style={{ backgroundColor: 'var(--accent-secondary, #a855f7)' }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 L4 14 h6 l-1 8 9-12 h-6 z" /></svg>
            <span className="truncate">{eventDisplay}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Page-Variable Interactions (regular page files) ────────────────────────

const CLOSE_TRIGGER_OPTIONS = [
  { value: 'click', label: 'Click' },
  { value: 'mouseEnter', label: 'Mouse Enter' },
  { value: 'mouseLeave', label: 'Mouse Leave' },
];

// The ⚡ swatch at the left of every interaction row. Colour follows the
// master-aware convention: --accent (blue) on a normal page, --accent-secondary
// (purple) inside a template or component master/instance.
function ZapSwatch({ secondary }: { secondary?: boolean }) {
  return (
    <span className="flex items-center justify-center w-5 h-5 rounded border border-white/10 flex-shrink-0" style={{ backgroundColor: secondary ? 'var(--accent-secondary)' : 'var(--accent)' }}>
      {/* The glyph tracks whichever fill the badge took — the two accents
          don't share a foreground (purple wants white, the brand accent
          wants its own --accent-fg, which is near-black or white depending
          on the accent). */}
      <svg width="11" height="11" viewBox="0 0 24 24" fill={secondary ? 'var(--accent-secondary-fg)' : 'var(--accent-fg)'}><path d="M13 2 L4 14 h6 l-1 8 9-12 h-6 z" /></svg>
    </span>
  );
}

// Native floating dropdown anchored at the "+" — mirrors the AnimationTool's
// AddEffectDropdown shell (relative wrapper + fixed backdrop + absolute menu),
// NOT a centered ToolPopup. Items: Set Variable / Close Overlay.
function AddInteractionMenu({ buttonRef, showSetVar, showClose, onSetVar, onCloseOverlay }: {
  buttonRef: React.RefObject<HTMLButtonElement | null>;
  showSetVar: boolean;
  showClose: boolean;
  onSetVar: () => void;
  onCloseOverlay: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  // hover pairs bg accent WITH --accent-fg text — text-primary is white on
  // dark themes and unreadable on a light accent (theme pairing rule).
  const itemCls = 'mx-1.5 px-2.5 py-1.5 rounded w-[calc(100%-12px)] whitespace-nowrap text-left text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--accent)] hover:text-[var(--accent-fg)] cursor-pointer block';
  return (
    <div className="relative" ref={ref}>
      <button
        ref={buttonRef}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        className="flex items-center justify-end pl-[80px] -ml-[80px] cursor-pointer group text-[var(--text-primary)]"
        title="Add interaction"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="transition-opacity group-hover:opacity-80">
          <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setOpen(false)} />
          <div
            className="absolute right-[10px] top-full mt-1 bg-[var(--dropdown-bg)] shadow-md rounded-[var(--radius-md)] py-1.5 z-[51] w-max border border-[var(--border-light)] space-y-0.5"
            style={{ scrollbarWidth: 'none' }}
          >
            {showSetVar && (
              <button className={itemCls} onClick={() => { setOpen(false); onSetVar(); }}>Set Variable</button>
            )}
            {showClose && (
              <button className={itemCls} onClick={() => { setOpen(false); onCloseOverlay(); }}>Close Overlay</button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// Edit form for a Close Overlay interaction — On (trigger) + Delay.
function CloseOverlayForm({ co, onChangeTrigger, onChangeDelay, onRemove }: {
  co: { trigger: InteractionTrigger; overlayId: string; delay: number };
  onChangeTrigger: (t: InteractionTrigger) => void;
  onChangeDelay: (d: number) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <ToolRow label="On">
        <ToolSelect value={co.trigger} onChange={(v) => onChangeTrigger(v as InteractionTrigger)} options={CLOSE_TRIGGER_OPTIONS} />
      </ToolRow>
      <ToolRow label="Delay">
        <DelayControl value={co.delay} onChange={onChangeDelay} />
      </ToolRow>
      <button
        onClick={onRemove}
        className="h-[var(--control-height-sm)] px-3 flex items-center justify-center text-xs font-medium text-[var(--text-primary)] bg-[var(--grid-line)] border border-[var(--control-border)] rounded-lg transition-colors cursor-pointer hover:bg-[var(--control-border)]"
      >
        Remove
      </button>
    </div>
  );
}

function PageVarInteractions({ selectedId }: { selectedId: string }) {
  const allVariables = useAtomValue(pageVariablesAtom);
  const code = useAtomValue(codeAtom);
  const activeFilePath = useAtomValue(activeFilePathAtom);
  const interactionsRaw = useAtomValue(pageInteractionsForSelectedAtom);
  const closeOverlays = useAtomValue(closeOverlayInteractionsForSelectedAtom);
  const enclosingOverlay = useAtomValue(enclosingOverlayForSelectedAtom);
  const overlays = useAtomValue(overlayCallsAtom);

  // "Set Variable" is page-only. Templates declare @pageVariables but DON'T emit
  // the useState hooks, so a Set Variable there generates `setX(...)` for an
  // undefined `setX` (gate: "would crash at runtime"). So: no Set Variable in
  // templates at all. On pages, also drop orphaned vars whose hook is absent
  // (the setter name appears only where a hook/call exists, never in the bare
  // @pageVariables annotation) — same broken-setter guard.
  const isTemplate = isLayoutFile(activeFilePath);
  const variables = useMemo(
    () => (isTemplate ? [] : allVariables.filter((v) => (code ?? '').includes(setterName(v.name)))),
    [isTemplate, allVariables, code],
  );
  const [addVarOpen, setAddVarOpen] = useState(false);
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editCloseKey, setEditCloseKey] = useState<string | null>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const editRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const closeRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // An overlay-close setter (`set<X>Open(false)`) ALSO parses as a plain
  // Set-Variable; filter those out so each shows only as a "Close Overlay" row.
  const overlayStateVars = useMemo(() => new Set(overlays.map((o) => stateVarName(o.overlayId))), [overlays]);
  const interactions = useMemo(
    () => interactionsRaw.filter((i) => !(overlayStateVars.has(i.varName) && i.value === 'false')),
    [interactionsRaw, overlayStateVars],
  );

  const handleRemove = useCallback((trigger: InteractionTrigger, varName: string) => {
    trace.action('interactions-tool:page-remove', { nodeId: selectedId, trigger, varName });
    queueMutation({ type: 'removePageInteraction', nodeId: selectedId, trigger, varName });
    setEditKey(null);
  }, [selectedId]);

  const handleAdd = useCallback((trigger: InteractionTrigger, varName: string, value: string) => {
    trace.action('interactions-tool:page-add', { nodeId: selectedId, trigger, varName, value });
    queueMutation({ type: 'addPageInteraction', nodeId: selectedId, trigger, varName, value });
    setAddVarOpen(false);
  }, [selectedId]);

  const handleUpdateValue = useCallback((trigger: InteractionTrigger, varName: string, value: string) => {
    trace.action('interactions-tool:page-update', { nodeId: selectedId, trigger, varName, value });
    queueMutation({ type: 'addPageInteraction', nodeId: selectedId, trigger, varName, value });
  }, [selectedId]);

  const handleAddClose = useCallback(() => {
    if (!enclosingOverlay) return;
    trace.action('interactions-tool:close-overlay-add', { nodeId: selectedId, overlayId: enclosingOverlay });
    queueMutation({ type: 'addCloseOverlay', nodeId: selectedId, trigger: 'click', overlayId: enclosingOverlay });
  }, [selectedId, enclosingOverlay]);

  const handleRemoveClose = useCallback((trigger: InteractionTrigger, overlayId: string) => {
    trace.action('interactions-tool:close-overlay-remove', { nodeId: selectedId, trigger, overlayId });
    queueMutation({ type: 'removeCloseOverlay', nodeId: selectedId, trigger, overlayId });
    setEditCloseKey(null);
  }, [selectedId]);

  const handleCloseDelay = useCallback((trigger: InteractionTrigger, overlayId: string, delay: number) => {
    queueMutation({ type: 'setCloseOverlayDelay', nodeId: selectedId, trigger, overlayId, delay });
  }, [selectedId]);

  const handleCloseTrigger = useCallback((oldTrigger: InteractionTrigger, newTrigger: InteractionTrigger, overlayId: string, delay: number) => {
    if (oldTrigger === newTrigger) return;
    queueMutation({ type: 'removeCloseOverlay', nodeId: selectedId, trigger: oldTrigger, overlayId });
    queueMutation({ type: 'addCloseOverlay', nodeId: selectedId, trigger: newTrigger, overlayId });
    if (delay > 0) queueMutation({ type: 'setCloseOverlayDelay', nodeId: selectedId, trigger: newTrigger, overlayId, delay });
    setEditCloseKey(null);
  }, [selectedId]);

  const noVariables = variables.length === 0;
  const canAdd = !noVariables || !!enclosingOverlay;
  const hasRows = interactions.length > 0 || closeOverlays.length > 0;

  return (
    <>
      <ToolSection
        title="Interactions"
        action={canAdd ? (
          <AddInteractionMenu
            buttonRef={addBtnRef}
            showSetVar={!noVariables}
            showClose={!!enclosingOverlay}
            onSetVar={() => setAddVarOpen(true)}
            onCloseOverlay={handleAddClose}
          />
        ) : null}
        hasContent={hasRows}
      >
        <div className="contents">
          {interactions.map((iact) => {
            const key = `${iact.trigger}:${iact.varName}`;
            return (
              <div key={key} className="flex items-center justify-between w-full" ref={el => { if (el) editRefs.current.set(key, el); }}>
                <span className="w-3/4 min-w-0 text-[11px] font-bold text-[var(--text-secondary)]">{formatTrigger(iact.trigger)}</span>
                <ControlActionRow className="!pr-2" onClick={() => setEditKey(key)}>
                  <ZapSwatch secondary={isTemplate} />
                  <span className="truncate flex-1 min-w-0">Set {iact.varName}</span>
                  <RemoveButton onClick={() => handleRemove(iact.trigger, iact.varName)} />
                </ControlActionRow>
              </div>
            );
          })}
          {closeOverlays.map((co) => {
            const key = `${co.trigger}:${co.overlayId}`;
            return (
              <div key={`co:${key}`} className="flex items-center justify-between w-full" ref={el => { if (el) closeRefs.current.set(key, el); }}>
                <span className="w-3/4 min-w-0 text-[11px] font-bold text-[var(--text-secondary)]">{formatTrigger(co.trigger)}</span>
                <ControlActionRow className="!pr-2" onClick={() => setEditCloseKey(key)}>
                  <ZapSwatch secondary={isTemplate} />
                  <span className="truncate flex-1 min-w-0">Close Overlay</span>
                  <RemoveButton onClick={() => handleRemoveClose(co.trigger, co.overlayId)} />
                </ControlActionRow>
              </div>
            );
          })}
        </div>
      </ToolSection>

      {/* Edit Set Variable popup */}
      {editKey !== null && (() => {
        const found = interactions.find(i => `${i.trigger}:${i.varName}` === editKey);
        if (!found) return null;
        const variable = variables.find(v => v.name === found.varName);
        return (
          <ToolPopup isOpen onClose={() => setEditKey(null)} title="Edit Interaction"
            anchorRef={{ current: editRefs.current.get(editKey) ?? null } as React.RefObject<HTMLElement>} width={240}>
            <EditPageInteractionForm interaction={found} variable={variable} variables={variables}
              onChangeValue={(value) => handleUpdateValue(found.trigger, found.varName, value)}
              onRemove={() => { handleRemove(found.trigger, found.varName); setEditKey(null); }} />
          </ToolPopup>
        );
      })()}

      {/* Edit Close Overlay popup */}
      {editCloseKey !== null && (() => {
        const found = closeOverlays.find(c => `${c.trigger}:${c.overlayId}` === editCloseKey);
        if (!found) return null;
        return (
          <ToolPopup isOpen onClose={() => setEditCloseKey(null)} title="Close Overlay"
            anchorRef={{ current: closeRefs.current.get(editCloseKey) ?? null } as React.RefObject<HTMLElement>} width={240}>
            <CloseOverlayForm co={found}
              onChangeTrigger={(tr) => handleCloseTrigger(found.trigger, tr, found.overlayId, found.delay)}
              onChangeDelay={(d) => handleCloseDelay(found.trigger, found.overlayId, d)}
              onRemove={() => handleRemoveClose(found.trigger, found.overlayId)} />
          </ToolPopup>
        );
      })()}

      {/* Add Set Variable popup */}
      <ToolPopup isOpen={addVarOpen} onClose={() => setAddVarOpen(false)} title="Add Interaction" anchorRef={addBtnRef as React.RefObject<HTMLElement>} width={240}>
        <AddPageInteractionForm variables={variables} onAdd={handleAdd} />
      </ToolPopup>
    </>
  );
}

// ─── Add button (small +) — shared shell ────────────────────────────────────

// Mirrors the +-button shape used by the Animation and Navigation
// (LinkTool) sections — same hit-target padding, same hover dim, same SVG —
// so the right-panel section headers all line up visually.
function AddButton({ onClick, buttonRef }: { onClick: () => void; buttonRef: React.RefObject<HTMLButtonElement | null> }) {
  return (
    <button
      ref={buttonRef}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="flex items-center justify-end pl-[80px] -ml-[80px] cursor-pointer group text-[var(--text-primary)]"
      title="Add interaction"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="transition-opacity group-hover:opacity-80">
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    </button>
  );
}

// ─── Edit Interaction Form ─────────────────────────────────────────────────

function EditInteractionForm({ conn, variants, onUpdate, onRemove }: {
  conn: Connection;
  variants: { value: string; label: string }[];
  onUpdate: (trigger: ConnectionTrigger, from: string, to: string, delay: number) => void;
  onRemove: () => void;
}) {
  const [trigger, setTrigger] = useState<ConnectionTrigger>(conn.trigger);
  const [from, setFrom] = useState(conn.from);
  const [to, setTo] = useState(conn.to);
  const [delay, setDelay] = useState<number>(conn.delay ?? 0);

  // External re-seed (undo/redo while the edit form is open): the parsed
  // connection comes back via `conn` — re-seed so the form doesn't show a
  // pre-undo state. The form only writes on its Update button, so a source
  // change while it's open is always external.
  const connSig = `${conn.trigger}|${conn.from}|${conn.to}|${conn.delay ?? 0}`;
  const prevConnSigRef = useRef(connSig);
  useEffect(() => {
    if (connSig === prevConnSigRef.current) return;
    prevConnSigRef.current = connSig;
    setTrigger(conn.trigger); setFrom(conn.from); setTo(conn.to); setDelay(conn.delay ?? 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connSig]);

  return (
    <div className="flex flex-col gap-2">
      <ToolRow label="Trigger">
        <ToolSelect value={trigger} onChange={(v) => setTrigger(v as ConnectionTrigger)} options={TRIGGER_OPTIONS} />
      </ToolRow>
      <ToolRow label="From">
        <ToolSelect value={from} onChange={setFrom} options={variants} />
      </ToolRow>
      <ToolRow label="To">
        <ToolSelect value={to} onChange={setTo} options={variants} />
      </ToolRow>
      <ToolRow label="Delay">
        <DelayControl value={delay} onChange={setDelay} />
      </ToolRow>
      <div className="flex gap-2">
        <button
          onClick={onRemove}
          className="h-[var(--control-height-sm)] px-3 flex items-center justify-center text-xs font-medium text-[var(--text-primary)] bg-[var(--grid-line)] border border-[var(--control-border)] rounded-lg transition-colors cursor-pointer hover:bg-[var(--control-border)]"
        >
          Remove
        </button>
        <button
          onClick={() => onUpdate(trigger, from, to, delay)}
          disabled={from === to}
          className="flex-1 h-7 flex items-center justify-center text-xs font-medium text-white rounded-lg transition-all cursor-pointer hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ backgroundColor: 'var(--accent-secondary, #a855f7)' }}
        >
          Update
        </button>
      </div>
    </div>
  );
}

// ─── Delay control (shared by Add + Edit forms) ────────────────────────────
//
// Delay is stored as seconds (number). Plus/minus stepper + numeric input —
// a slider imposed an arbitrary 0..2s range and CLAMPED typed values down
// (typing 4 forced 2, the "can't delay more than 2s" bug). Ceiling is a
// generous 1000s; the stepper matches `ConnectionTypeModal`'s UI so both
// entry points feel identical. `chevronLabel="s"` is a visual unit suffix;
// the underlying value remains a bare number.

const DELAY_MAX_SECONDS = 1000;

function DelayControl({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const safe = Number.isFinite(value) ? value : 0;
  return (
    <>
      <ToolPlusMinus
        value={safe}
        min={0}
        max={DELAY_MAX_SECONDS}
        step={0.1}
        onChange={(v) => onChange(Math.round(v * 10) / 10)}
      />
      <ToolInput
        value={String(safe)}
        onChange={(v) => {
          const n = parseFloat(v);
          onChange(Number.isFinite(n) ? Math.max(0, Math.min(DELAY_MAX_SECONDS, n)) : 0);
        }}
        step={0.1}
        chevronLabel="s"
        className="!w-16 shrink-0"
      />
    </>
  );
}

// ─── Add Interaction Form ──────────────────────────────────────────────────

function AddInteractionForm({ variants, onAdd }: {
  variants: { value: string; label: string }[];
  onAdd: (trigger: ConnectionTrigger, from: string, to: string, delay: number) => void;
}) {
  const [trigger, setTrigger] = useState<ConnectionTrigger>('click');
  const [from, setFrom] = useState(variants[0]?.value ?? 'default');
  const [to, setTo] = useState(variants[1]?.value ?? variants[0]?.value ?? 'default');
  const [delay, setDelay] = useState<number>(0);

  return (
    <div className="flex flex-col gap-3">
      <ToolRow label="Trigger">
        <ToolSelect value={trigger} onChange={(v) => setTrigger(v as ConnectionTrigger)} options={TRIGGER_OPTIONS} />
      </ToolRow>
      <ToolRow label="From">
        <ToolSelect value={from} onChange={setFrom} options={variants} />
      </ToolRow>
      <ToolRow label="To">
        <ToolSelect value={to} onChange={setTo} options={variants} />
      </ToolRow>
      <ToolRow label="Delay">
        <DelayControl value={delay} onChange={setDelay} />
      </ToolRow>
      <button
        onClick={() => onAdd(trigger, from, to, delay)}
        disabled={from === to}
        className="w-full h-7 flex items-center justify-center text-xs font-medium text-white rounded-lg transition-all cursor-pointer hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
        style={{ backgroundColor: 'var(--accent-secondary, #a855f7)' }}
      >
        Create Interaction
      </button>
    </div>
  );
}

// ─── Page-Variable: Add form ────────────────────────────────────────────────
//
// Picks a trigger + variable + value. The Value control adapts to the
// chosen variable's type — slider for number (0..1), color picker for
// color, text input otherwise, segmented yes/no for boolean.

function AddPageInteractionForm({
  variables,
  onAdd,
}: {
  variables: PageVariable[];
  onAdd: (trigger: InteractionTrigger, varName: string, value: string) => void;
}) {
  const [trigger, setTrigger] = useState<InteractionTrigger>('click');
  const [varName, setVarName] = useState<string>(variables[0]?.name ?? '');
  const variable = variables.find(v => v.name === varName) ?? variables[0];
  const [value, setValue] = useState<string>(variable ? variable.default : '');

  // Reset value when the user picks a different variable mid-form (the type
  // may have changed → the previous string would render in the wrong control).
  const handleVarChange = (newVarName: string) => {
    setVarName(newVarName);
    const newVar = variables.find(v => v.name === newVarName);
    if (newVar) setValue(newVar.default);
  };

  const variableOptions = useMemo(
    () => variables.map(v => ({ value: v.name, label: v.name })),
    [variables],
  );

  const canSubmit = !!variable && value !== undefined;

  return (
    <div className="flex flex-col gap-2">
      <ToolRow label="On">
        <ToolSelect
          value={trigger}
          onChange={(v) => setTrigger(v as InteractionTrigger)}
          options={PAGE_TRIGGER_OPTIONS}
        />
      </ToolRow>
      <ToolRow label="Variable">
        <ToolSelect value={varName} onChange={handleVarChange} options={variableOptions} />
      </ToolRow>
      <ToolRow label="Value">
        <PageVariableValueControl variable={variable} value={value} onChange={setValue} />
      </ToolRow>
      <button
        onClick={() => canSubmit && onAdd(trigger, varName, value)}
        disabled={!canSubmit}
        className="w-full h-7 flex items-center justify-center text-xs font-medium text-[var(--accent-fg)] rounded-lg transition-all cursor-pointer hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
        style={{ backgroundColor: 'var(--accent)' }}
      >
        Add Interaction
      </button>
    </div>
  );
}

// ─── Page-Variable: Edit form ──────────────────────────────────────────────

function EditPageInteractionForm({
  interaction,
  variable,
  variables,
  onChangeValue,
  onRemove,
}: {
  interaction: PageInteraction;
  variable: PageVariable | undefined;
  variables: PageVariable[];
  onChangeValue: (value: string) => void;
  onRemove: () => void;
}) {
  // Editing doesn't allow changing trigger or variable to keep the surface
  // small. Removing + re-adding covers those cases (and matches the reference's
  // "edit value, remove to swap" pattern).
  const [value, setValue] = useState(interaction.value);

  // External re-seed — same rationale as EditInteractionForm above.
  const prevValRef = useRef(interaction.value);
  useEffect(() => {
    if (interaction.value === prevValRef.current) return;
    prevValRef.current = interaction.value;
    setValue(interaction.value);
  }, [interaction.value]);

  return (
    <div className="flex flex-col gap-3">
      <ToolRow label="On">
        <ReadOnlyField text={formatTrigger(interaction.trigger)} />
      </ToolRow>
      <ToolRow label="Variable">
        <ReadOnlyField text={interaction.varName} />
      </ToolRow>
      <ToolRow label="Value">
        <PageVariableValueControl
          variable={variable}
          value={value}
          onChange={(v) => { setValue(v); onChangeValue(v); }}
        />
      </ToolRow>
      <button
        onClick={onRemove}
        className="w-full h-[var(--control-height-sm)] flex items-center justify-center text-xs font-medium text-red-400 hover:text-red-300 bg-[var(--grid-line)] border border-[var(--control-border)] rounded-lg transition-colors cursor-pointer"
      >
        Remove
      </button>
    </div>
  );
}

// ─── Read-only field — used in edit mode for trigger/variable display ──────

function ReadOnlyField({ text }: { text: string }) {
  return (
    <div className="w-full h-[var(--control-height-sm)] px-2 flex items-center text-xs bg-[var(--grid-line)] border border-[var(--control-border)] rounded-md text-[var(--text-secondary)] truncate">
      {text}
    </div>
  );
}

// ─── Type-aware value control ──────────────────────────────────────────────
//
// Mirrors the modal's DefaultValueControl shape. Centralised here so both
// Add and Edit forms share the same UX.

// The popup is narrow (240px) so the slider has limited room. We still want
// a slider for number variables — it's the most natural way to scrub an
// opacity-like value — so we always render slider + numeric input side by
// side for `number`. For non-0..1 numbers we widen the slider's max to fit
// the current value, otherwise the thumb pins to the right edge and the
// scrub feels broken.
function PageVariableValueControl({
  variable,
  value,
  onChange,
}: {
  variable: PageVariable | undefined;
  value: string;
  onChange: (v: string) => void;
}) {
  if (!variable) return <ToolInput value={value} onChange={onChange} text />;

  if (variable.type === 'boolean') {
    return (
      <ToolSegmentedControl
        value={value === 'true' ? 'true' : 'false'}
        onChange={onChange}
        options={[
          { value: 'true', label: 'Yes' },
          { value: 'false', label: 'No' },
        ]}
        size="sm"
      />
    );
  }
  if (variable.type === 'color') {
    return <ColorInput value={value || defaultForType('color')} onChange={onChange} />;
  }
  if (variable.type === 'image') {
    return <ImagePickerInput value={value} onChange={onChange} />;
  }
  if (variable.type === 'number') {
    const numRaw = parseFloat(value);
    const num = Number.isFinite(numRaw) ? numRaw : 0;
    // Choose a slider scale that contains the current value. 0..1 covers the
    // common opacity / progress case; otherwise widen to fit.
    const sliderMax = num <= 1 ? 1 : Math.max(num, 100);
    const sliderStep = sliderMax === 1 ? 0.01 : 1;
    const inputStep = sliderMax === 1 ? 0.1 : 1;
    return (
      <div className="flex items-center gap-2 w-full">
        <ToolSlider
          value={num}
          min={0}
          max={sliderMax}
          step={sliderStep}
          onChange={(n) => onChange(String(n))}
        />
        <ToolInput value={value} onChange={onChange} step={inputStep} />
      </div>
    );
  }
  return <ToolInput value={value} onChange={onChange} text />;
}
