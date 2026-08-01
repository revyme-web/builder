// FormTool — Properties-panel tool for a <form>. Mirrors the reference's Form panel:
// Send To (Email / Webhook / Sheet destinations), Redirect (success page),
// Antispam (Basic, Block/Pass) and a Tracking id. Config is stored as JSON in
// the form's `data-form` attribute via the `updateHtmlAttrs` mutation (which
// single-quotes JSON values). The actual SEND transport is wired later.
//
// Layout: every control is a ToolRow (label LEFT, value RIGHT), gap-2 between
// rows. "Send To" adds via a native floating dropdown (like the CMS pagination
// tool); each destination opens its config in a ToolPopup.

import { useState, useRef, useEffect, useCallback } from 'react';
import { useClickOutside } from '../../hooks/useClickOutside';
import { useControl } from '../../controls/ControlProvider';
import { ToolSection, ToolRow, ToolInput, ToolTextArea, ToolSegmentedControl, ControlActionRow, RemoveButton } from '../../controls';
import ToolPopup from '../../ui/ToolPopup';
import { LinkUrlField } from '../LinkTool/LinkUrlControl';
import { queueMutation, flushNow } from '@/code/mutation/mutation-queue';
import { trace } from '@/shared/debug-trace';
import {
  type FormConfig, type FormDestination, type EmailDestination, type WebhookDestination,
  readFormConfig, serializeFormConfig, newDestId, destLabel,
} from './form-config';

// Native dropdown item styling — matches the CMS pagination / Animation add menus.
const ADD_ITEM = 'group flex items-center gap-2 mx-1.5 px-2.5 py-1.5 rounded w-[calc(100%-12px)] text-left cursor-pointer bg-transparent hover:!bg-[var(--accent)] border-none whitespace-nowrap disabled:opacity-40 disabled:cursor-default';
const ADD_ITEM_LABEL = 'text-xs font-medium text-[var(--text-primary)] group-hover:text-[var(--accent-fg)]';

// Glyphs (24x24 viewBox).
const GLYPH = {
  email: <path d="M3 5h18v14H3z M3 6l9 7 9-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />,
  webhook: <path d="M9 9a3 3 0 0 1 4 0l2 2a3 3 0 0 1 0 4 M15 15a3 3 0 0 1-4 0l-2-2a3 3 0 0 1 0-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />,
  sheet: <path d="M5 4h14v16H5z M5 10h14 M11 4v16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />,
  plus: <path d="M12 5v14 M5 12h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />,
  redirect: <path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1 M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />,
  shield: <path d="M12 2 L20 5 V11 C20 16 16.5 19.5 12 21 C7.5 19.5 4 16 4 11 V5 Z" fill="currentColor" />,
} as const;

/** A 20×20 rounded icon chip — blue (filled/active) or neutral dark (empty/Add). */
function IconChip({ glyph, blue }: { glyph: React.ReactNode; blue?: boolean }) {
  return (
    <span className="flex items-center justify-center w-5 h-5 rounded shrink-0"
      style={blue ? { backgroundColor: '#3b82f6', color: '#fff' } : { backgroundColor: 'var(--grid-line)', color: 'var(--text-secondary)' }}>
      <svg width="13" height="13" viewBox="0 0 24 24">{glyph}</svg>
    </span>
  );
}

function DestIcon({ type }: { type: FormDestination['type'] }) {
  return <IconChip glyph={GLYPH[type]} blue />;
}

// Label cell matching ToolRow's geometry; `ghost` renders an invisible spacer
// for the 2nd+ rows of a multi-row control (EntryList pattern → the label sits
// on the FIRST row, top-aligned, like the color/shadow tools).
function LabelCell({ text, ghost }: { text: string; ghost?: boolean }) {
  return (
    <div className="w-3/4 select-none pl-[18px] -ml-[18px] mr-[2px]">
      <span className={`text-xs font-bold text-[var(--text-secondary)]${ghost ? ' invisible' : ''}`} aria-hidden={ghost}>{text}</span>
    </div>
  );
}

/** An empty "Add…" row — left icon chip + left-aligned grey "Add…" (matches the
 *  Collection List add rows). */
function AddRow({ glyph, onClick }: { glyph: React.ReactNode; onClick: () => void }) {
  return (
    <ControlActionRow onClick={onClick} className="!pr-2">
      <IconChip glyph={glyph} />
      <span className="flex-1 text-left text-[var(--text-secondary)]">Add…</span>
    </ControlActionRow>
  );
}

// ─── per-type editor panels (stateless: ToolInput.onChange fires on blur) ───
function EmailEditor({ dest, onSave }: { dest: EmailDestination; onSave: (d: EmailDestination) => void }) {
  return (
    <div className="flex flex-col gap-2 p-1">
      <ToolRow label="Recipient"><ToolInput value={dest.recipient ?? ''} onChange={(v) => onSave({ ...dest, recipient: v })} placeholder="you@email.com" /></ToolRow>
      <ToolRow label="Name"><ToolInput value={dest.name ?? ''} onChange={(v) => onSave({ ...dest, name: v })} placeholder="Revyme" /></ToolRow>
      <ToolRow label="Subject"><ToolInput value={dest.subject ?? ''} onChange={(v) => onSave({ ...dest, subject: v })} placeholder="New Submission" /></ToolRow>
      <ToolRow label="Body"><ToolTextArea value={dest.body ?? ''} onChange={(v) => onSave({ ...dest, body: v })} rows={3} placeholder="You've just received a new submission." /></ToolRow>
    </div>
  );
}

function WebhookEditor({ dest, onSave }: { dest: WebhookDestination; onSave: (d: WebhookDestination) => void }) {
  return (
    <div className="flex flex-col gap-2 p-1">
      <ToolRow label="API"><ToolInput value={dest.url ?? ''} onChange={(v) => onSave({ ...dest, url: v })} placeholder="URL" /></ToolRow>
      <ToolRow label="Secret"><ToolInput value={dest.secret ?? ''} onChange={(v) => onSave({ ...dest, secret: v })} placeholder="Optional" /></ToolRow>
      <ToolRow label="Fallback"><ToolInput value={dest.fallback ?? ''} onChange={(v) => onSave({ ...dest, fallback: v })} placeholder="you@email.com" /></ToolRow>
      <p className="text-[11px] text-[var(--text-secondary)] leading-snug px-0.5">If the Webhook stops working, we'll let you know via this address.</p>
    </div>
  );
}

// ─── Send To "Add…" — native floating dropdown (Email / Webhook / Sheet) ────
function SendToAddMenu({ onAdd }: { onAdd: (t: FormDestination['type']) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, open, () => setOpen(false));
  return (
    <div className="relative w-full" ref={ref}>
      <ControlActionRow onClick={() => setOpen((v) => !v)} className="!pr-2">
        <IconChip glyph={GLYPH.plus} />
        <span className="flex-1 text-left text-[var(--text-secondary)]">Add…</span>
      </ControlActionRow>
      {open && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 bg-[var(--dropdown-bg)] shadow-md rounded-[var(--radius-md)] py-1.5 z-[51] w-max border border-[var(--border-light)] space-y-0.5">
            {(['email', 'webhook', 'sheet'] as const).map((t) => (
              <button key={t} type="button" className={ADD_ITEM} disabled={t === 'sheet'}
                onClick={() => { onAdd(t); setOpen(false); }}>
                <span className={ADD_ITEM_LABEL}>{t === 'email' ? 'Email' : t === 'webhook' ? 'Webhook' : 'Sheet (soon)'}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function FormTool() {
  const { node } = useControl();
  const nodeId = node?.id ?? '';
  const anchorRef = useRef<HTMLDivElement>(null);
  type Popup = { kind: 'sendto'; index: number } | { kind: 'redirect' } | { kind: 'antispam' };
  const [popup, setPopup] = useState<Popup | null>(null);
  const [config, setConfig] = useState<FormConfig>(() => readFormConfig(node?.attrs?.['data-form']));

  // Re-seed on selection change AND on EXTERNAL `data-form` changes (undo/
  // redo, MCP commits) — an id-only sync left the Send-To / redirect /
  // antispam lists showing pre-undo entries until the node was reselected.
  // Own commits are skipped via the self-write counter (ShadowControl's
  // pattern) so mid-interaction state is never clobbered by a round-trip.
  const formAttr = node?.attrs?.['data-form'];
  const selfWriteCountRef = useRef(0);
  const prevAttrRef = useRef(formAttr);
  useEffect(() => { setConfig(readFormConfig(node?.attrs?.['data-form'])); }, [node?.id]);
  useEffect(() => {
    if (formAttr === prevAttrRef.current) return;
    prevAttrRef.current = formAttr;
    if (selfWriteCountRef.current > 0) { selfWriteCountRef.current--; return; }
    trace.action('form-tool:reseed-from-parse', { nodeId });
    setConfig(readFormConfig(formAttr));
  }, [formAttr, nodeId]);

  const commit = useCallback((next: FormConfig) => {
    setConfig(next);
    if (!nodeId) return;
    selfWriteCountRef.current++;
    queueMutation({ type: 'updateHtmlAttrs', nodeId, attrs: { 'data-form': serializeFormConfig(next) } });
    flushNow();
    trace.action('form-tool:commit', { nodeId, sendTo: next.sendTo.length });
  }, [nodeId]);

  if (!node || node.type !== 'form') return null;

  const addDest = (type: FormDestination['type']) => {
    const dest = { id: newDestId(), type } as FormDestination;
    const next = { ...config, sendTo: [...config.sendTo, dest] };
    commit(next);
    setPopup({ kind: 'sendto', index: next.sendTo.length - 1 });
  };
  const saveDest = (index: number, d: FormDestination) => {
    const sendTo = config.sendTo.slice(); sendTo[index] = d;
    commit({ ...config, sendTo });
  };
  const removeDest = (index: number) => commit({ ...config, sendTo: config.sendTo.filter((_, i) => i !== index) });

  const renderPopupBody = () => {
    if (!popup) return null;
    if (popup.kind === 'sendto') {
      const d = config.sendTo[popup.index];
      if (!d) return null;
      if (d.type === 'email') return <EmailEditor dest={d} onSave={(nd) => saveDest(popup.index, nd)} />;
      if (d.type === 'webhook') return <WebhookEditor dest={d} onSave={(nd) => saveDest(popup.index, nd)} />;
      return <div className="p-2 text-xs text-[var(--text-secondary)]">Google Sheets connection is coming soon.</div>;
    }
    if (popup.kind === 'redirect') {
      return (
        <div className="p-1"><ToolRow label="Link To"><LinkUrlField value={config.redirect ?? ''} onChange={(v) => commit({ ...config, redirect: v })} /></ToolRow></div>
      );
    }
    if (popup.kind === 'antispam') {
      const filtering = config.antispam?.filtering ?? 'block';
      return (
        <div className="p-1">
          <ToolRow label="Filtering">
            <ToolSegmentedControl value={filtering} onChange={(v) => commit({ ...config, antispam: { mode: 'basic', filtering: v as 'block' | 'pass' } })}
              options={[{ value: 'block', label: 'Block' }, { value: 'pass', label: 'Pass' }]} />
          </ToolRow>
          <p className="text-[11px] text-[var(--text-secondary)] leading-snug px-0.5 mt-1">Pass forwards labelled spam submissions to your destination.</p>
        </div>
      );
    }
    return null;
  };

  const popupTitle = popup?.kind === 'sendto' ? destLabel(config.sendTo[popup.index] ?? { id: '', type: 'email' })
    : popup?.kind === 'redirect' ? 'Success'
    : popup?.kind === 'antispam' ? 'Antispam' : '';

  return (
    <div ref={anchorRef}>
      <ToolSection title="Form">
        <div className="flex flex-col gap-2">
          {/* Send To — EntryList layout: label on the FIRST row (top), invisible
              spacer on the rest. Each destination is its own gap-2 row. */}
          {config.sendTo.map((d, i) => (
            <div key={d.id} className="flex items-center justify-between w-full">
              <LabelCell text="Send To" ghost={i > 0} />
              <div className="flex items-center gap-2 w-full">
                <ControlActionRow onClick={() => setPopup({ kind: 'sendto', index: i })} className="!pr-2">
                  <DestIcon type={d.type} />
                  <span className="truncate flex-1">{destLabel(d)}</span>
                  <RemoveButton onClick={() => removeDest(i)} />
                </ControlActionRow>
              </div>
            </div>
          ))}
          <div className="flex items-center justify-between w-full">
            <LabelCell text="Send To" ghost={config.sendTo.length > 0} />
            <div className="flex items-center gap-2 w-full">
              <SendToAddMenu onAdd={addDest} />
            </div>
          </div>

          {/* Redirect */}
          <ToolRow label="Redirect">
            {config.redirect ? (
              <ControlActionRow onClick={() => setPopup({ kind: 'redirect' })} className="!pr-2">
                <IconChip glyph={GLYPH.redirect} blue />
                <span className="truncate flex-1">{config.redirect}</span>
                <RemoveButton onClick={() => commit({ ...config, redirect: undefined })} />
              </ControlActionRow>
            ) : (
              <AddRow glyph={GLYPH.redirect} onClick={() => setPopup({ kind: 'redirect' })} />
            )}
          </ToolRow>

          {/* Antispam */}
          <ToolRow label="Antispam">
            {config.antispam ? (
              <ControlActionRow onClick={() => setPopup({ kind: 'antispam' })} className="!pr-2">
                <IconChip glyph={GLYPH.shield} blue />
                <span className="truncate flex-1">Basic</span>
                <RemoveButton onClick={() => commit({ ...config, antispam: null })} />
              </ControlActionRow>
            ) : (
              <AddRow glyph={GLYPH.shield} onClick={() => commit({ ...config, antispam: { mode: 'basic', filtering: 'block' } })} />
            )}
          </ToolRow>

          {/* Tracking */}
          <ToolRow label="Tracking">
            <ToolInput value={config.tracking ?? ''} onChange={(v) => commit({ ...config, tracking: v })} placeholder="ID" />
          </ToolRow>
        </div>
      </ToolSection>

      {popup && (
        <ToolPopup isOpen onClose={() => setPopup(null)} title={popupTitle} anchorRef={anchorRef} width={240}>
          {renderPopupBody()}
        </ToolPopup>
      )}
    </div>
  );
}
