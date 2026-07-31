// vibe-models.ts — model catalog for the Vibe panel's model select.
//
// The authoritative list lives in the AI service (GET /api/freeform/models —
// the same catalog its turn endpoint validates against). This module fetches
// it once per session and falls back to a static mirror when the service is
// unreachable (standalone/self-host: the select still renders, the server
// clamps whatever id it receives, so a stale mirror is harmless).

import { trace } from '@/shared/debug-trace';

export interface VibeModel {
  /** OpenRouter model slug — sent verbatim in the freeform turn body. */
  id: string;
  label: string;
  vendor: 'anthropic' | 'openai' | 'google';
  tier: 'fast' | 'standard' | 'best';
}

const AI_SERVICE_URL = import.meta.env.VITE_AI_SERVICE_URL || 'http://localhost:8082';

/** Static mirror of the server catalog (ai-generator model-catalog.ts). */
export const FALLBACK_MODELS: VibeModel[] = [
  { id: 'anthropic/claude-fable-5',      label: 'Claude Fable 5',   vendor: 'anthropic', tier: 'best' },
  { id: 'anthropic/claude-sonnet-5',     label: 'Claude Sonnet 5',  vendor: 'anthropic', tier: 'standard' },
  { id: 'anthropic/claude-opus-4.8',     label: 'Claude Opus 4.8',  vendor: 'anthropic', tier: 'best' },
  { id: 'anthropic/claude-haiku-4.5',    label: 'Claude Haiku 4.5', vendor: 'anthropic', tier: 'fast' },
  { id: 'openai/gpt-5.5',                label: 'GPT-5.5',          vendor: 'openai',    tier: 'best' },
  { id: 'openai/gpt-5.3-codex',          label: 'GPT-5.3 Codex',    vendor: 'openai',    tier: 'standard' },
  { id: 'openai/gpt-5.4-mini',           label: 'GPT-5.4 Mini',     vendor: 'openai',    tier: 'fast' },
  { id: 'google/gemini-3.5-flash',       label: 'Gemini 3.5 Flash', vendor: 'google',    tier: 'standard' },
  { id: 'google/gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro',   vendor: 'google',    tier: 'best' },
];

export const FALLBACK_DEFAULT = 'google/gemini-3.5-flash';

export const VENDOR_LABELS: Record<VibeModel['vendor'], string> = {
  anthropic: 'Claude',
  openai: 'ChatGPT',
  google: 'Gemini',
};

export interface VibeModelCatalog {
  models: VibeModel[];
  defaultModel: string;
}

let catalogPromise: Promise<VibeModelCatalog> | null = null;

/** Fetch the live catalog once per session; on failure return the static
 *  mirror WITHOUT caching, so a later open retries the service. */
export function fetchVibeModels(): Promise<VibeModelCatalog> {
  if (!catalogPromise) {
    catalogPromise = fetch(`${AI_SERVICE_URL}/api/freeform/models`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: { models?: VibeModel[]; defaultModel?: string }) => {
        const models = Array.isArray(d.models) && d.models.length ? d.models : FALLBACK_MODELS;
        const catalog = { models, defaultModel: d.defaultModel || FALLBACK_DEFAULT };
        trace.action('vibe-models:fetched', { count: models.length, defaultModel: catalog.defaultModel });
        return catalog;
      })
      .catch((err) => {
        trace.error('vibe-models:fetch-failed', { err: String(err?.message ?? err) });
        catalogPromise = null; // retry next time — do not cache the failure
        return { models: FALLBACK_MODELS, defaultModel: FALLBACK_DEFAULT };
      });
  }
  return catalogPromise;
}

/** Test seam. */
export function resetVibeModelCache(): void {
  catalogPromise = null;
}

/** Display label for a model id — falls back to the slug tail so an id the
 *  catalog no longer lists still renders something readable. */
export function vibeModelLabel(id: string | undefined, models: VibeModel[]): string {
  if (!id) return models.find((m) => m.id === FALLBACK_DEFAULT)?.label ?? 'Default';
  const hit = models.find((m) => m.id === id);
  if (hit) return hit.label;
  const tail = id.split('/').pop() ?? id;
  return tail;
}

/** Group models by vendor in a stable vendor order for the select popup. */
export function groupByVendor(models: VibeModel[]): Array<{ vendor: VibeModel['vendor']; label: string; models: VibeModel[] }> {
  const order: VibeModel['vendor'][] = ['anthropic', 'openai', 'google'];
  return order
    .map((vendor) => ({ vendor, label: VENDOR_LABELS[vendor], models: models.filter((m) => m.vendor === vendor) }))
    .filter((g) => g.models.length > 0);
}
