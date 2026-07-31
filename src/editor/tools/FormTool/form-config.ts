// form-config.ts — the shape of a <form>'s config, stored as a JSON string in
// the form's `data-form` attribute (single-quoted in source, like data-overlay).
// The editor reads/writes it via the `updateHtmlAttrs` mutation; on deploy the
// transport layer (TBD) extracts it server-side. Keep this the single source of
// truth for the Form tool AND the future backend dispatcher.

export interface EmailDestination {
  id: string;
  type: 'email';
  recipient?: string;
  name?: string;
  subject?: string;
  body?: string;
}

export interface WebhookDestination {
  id: string;
  type: 'webhook';
  url?: string;
  secret?: string;
  fallback?: string;
}

interface SheetDestination {
  id: string;
  type: 'sheet';
  /** Reserved — wired when Google Sheets (OAuth) lands. */
  sheetId?: string;
}

export type FormDestination = EmailDestination | WebhookDestination | SheetDestination;

interface FormAntispam {
  mode: 'basic';
  /** Block = drop spam; Pass = forward labelled spam to the destination. */
  filtering: 'block' | 'pass';
}

export interface FormConfig {
  sendTo: FormDestination[];
  /** Success redirect — a page route ("/thank-you") or external URL. */
  redirect?: string;
  antispam?: FormAntispam | null;
  /** Analytics / A-B form-goal tracking id. */
  tracking?: string;
}

/** Parse a form's `data-form` JSON (from node.attrs). Always returns a usable
 *  config (never throws). */
export function readFormConfig(raw: string | undefined | null): FormConfig {
  if (!raw) return { sendTo: [] };
  try {
    const c = JSON.parse(raw) as Partial<FormConfig>;
    return { sendTo: Array.isArray(c.sendTo) ? c.sendTo : [], redirect: c.redirect, antispam: c.antispam ?? null, tracking: c.tracking };
  } catch {
    return { sendTo: [] };
  }
}

/** Serialize for the `data-form` attribute (compact; `updateHtmlAttrs`
 *  single-quotes it because it contains `"`). Strips empty/default keys. */
export function serializeFormConfig(c: FormConfig): string {
  const out: FormConfig = { sendTo: c.sendTo };
  if (c.redirect) out.redirect = c.redirect;
  if (c.antispam) out.antispam = c.antispam;
  if (c.tracking) out.tracking = c.tracking;
  return JSON.stringify(out);
}

let _idSeq = 0;
/** Short unique id for a destination row. */
export function newDestId(): string {
  _idSeq += 1;
  return `d${_idSeq.toString(36)}${Math.floor(performance.now()).toString(36)}`;
}

export function destLabel(d: FormDestination): string {
  return d.type === 'email' ? 'Email' : d.type === 'webhook' ? 'Webhook' : 'Sheet';
}
