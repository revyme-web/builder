// translate-client.ts — client for the ai-generator batch-translation
// endpoints (Localization view's "AI Translate"). Mirrors freeform-client's
// transport: plain JSON POST to AI_SERVICE_URL, workspaceId in the body,
// 402 surfaces as a normal error string, caller refreshes credits after.

import { trace } from '@/shared/debug-trace';

const AI_SERVICE_URL = import.meta.env.VITE_AI_SERVICE_URL || 'http://localhost:8082';

export interface TranslateItem { key: string; text: string; }

export async function estimateTranslate(items: TranslateItem[]): Promise<{ credits: number } | null> {
  try {
    const res = await fetch(`${AI_SERVICE_URL}/api/translate/estimate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    trace.action('translate-client:estimate', { items: items.length, credits: data.credits });
    return typeof data.credits === 'number' ? { credits: data.credits } : null;
  } catch (err) {
    trace.error('translate-client:estimate-failed', err);
    return null;
  }
}

export async function runAiTranslate(opts: {
  items: TranslateItem[];
  sourceLocale: string;
  targetLocale: string;
  workspaceId?: string;
  model?: string;
}): Promise<{ success: true; translations: Record<string, string> } | { success: false; error: string; outOfCredits?: boolean }> {
  trace.action('translate-client:run', { items: opts.items.length, target: opts.targetLocale });
  try {
    const res = await fetch(`${AI_SERVICE_URL}/api/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok || !data.success) {
      // 402 = workspace credit pool exhausted — the UI shows a Top Up
      // button (deep link to the workspace credits page) instead of the
      // raw server message.
      return { success: false, error: data.error || `Request failed: ${res.status}`, outOfCredits: res.status === 402 };
    }
    trace.action('translate-client:done', { translated: Object.keys(data.translations ?? {}).length });
    return { success: true, translations: data.translations ?? {} };
  } catch (err) {
    trace.error('translate-client:failed', err);
    return { success: false, error: err instanceof Error ? err.message : 'Translation failed' };
  }
}
