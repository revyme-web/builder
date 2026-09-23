// agent/ModelSelector.tsx — which model the agent's next turn runs on.
//
// Sits at the left of the composer's footer. It lists the Revyme CREDIT
// models and nothing else — the curated catalog (GET /api/freeform/models,
// the same list the service clamps to), grouped by vendor with the speed tier
// on the right, like the old Vibe panel's model chip. No local CLI, no pasted
// keys, no settings entry (owner, 2026-09-23): the chat runs on credits, and
// bringing your own AI is the MCP connector, set up in the site settings.
// Same combobox as the branch chip beside it (SearchableDropdown), opening
// upward in a portal.
//
// EFFORT, per model: hovering a row opens a flyout to its right with the
// thinking efforts that model takes (agent-chat-store effortOptionsFor) —
// picking one stores it for that model AND switches to it. The row shows the
// model's tier and its effort; the chip shows the effort when it is not the
// model's default.

import { useEffect, useMemo, useState } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import SearchableDropdown from '@/editor/ui/SearchableDropdown';
import {
  agentConfigAtom, agentEnginesAtom, agentServiceReachableAtom, agentEffortAtom, effectiveAgentConfig,
  effortOptionsFor, effortFor, EFFORT_LABELS, type AgentProviderConfig, type AgentEffort,
} from '@/code/stores/agent-chat-store';
import {
  fetchVibeModels, groupByVendor, FALLBACK_MODELS, FALLBACK_DEFAULT, FALLBACK_RETIRED, type VibeModelCatalog, type VibeModel,
} from '@/ai/vibe-models';
import { trace } from '@/shared/debug-trace';
import { VendorLogo } from './vendor-logos';

type Provider = AgentProviderConfig['provider'];

export interface ModelChoice {
  provider: Provider;
  model: string;
  /** The row in the list. */
  label: string;
  /** The chip — the row's label with the engine when the row alone is vague. */
  chip: string;
  group: string;
  vendor: VibeModel['vendor'];
  note?: string;
}

const choiceKey = (provider: Provider, model: string) => `${provider}:${model}`;

/** Every credit model, in list order — only when the service runs credits. */
export function modelChoices(offered: Provider[], catalog: VibeModelCatalog): ModelChoice[] {
  if (!offered.includes('revyme')) return [];
  return groupByVendor(catalog.models).flatMap((g) => g.models.map((m): ModelChoice => ({
    provider: 'revyme', model: m.id, label: m.label, chip: m.label, group: g.label, vendor: m.vendor, note: m.tier,
  })));
}

/** The row a stored choice runs as. Credits run a retired id on its
 *  successor and anything else off-catalog on the default (the server's
 *  resolveModelId), so the chip says that one. */
export function currentChoice(choices: ModelChoice[], current: AgentProviderConfig, catalog: VibeModelCatalog): ModelChoice | null {
  const exact = choices.find((c) => c.provider === current.provider && c.model === current.model);
  if (exact) return exact;
  if (current.provider !== 'revyme') return null;
  const runs = catalog.retired?.[current.model] ?? catalog.defaultModel;
  return choices.find((c) => c.provider === 'revyme' && c.model === runs) ?? null;
}

/** Same chip recipe as the branch selector beside it. */
const TRIGGER_CLASS =
  'flex h-6 max-w-[min(11rem,100%)] items-center gap-1.5 px-1.5 text-[11px] cut-corners text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] outline-none transition-colors disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent';
const INPUT_CLASS =
  'w-full px-2 py-1.5 text-xs bg-black/[0.06] hover:bg-black/[0.09] focus:bg-black/[0.12] dark:bg-white/[0.1] dark:hover:bg-white/[0.14] dark:focus:bg-white/[0.12] cut-corners text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] outline-none transition-colors';
const PANEL_PORTAL = { placement: 'up' as const, width: 250 };


export function ModelSelector() {
  const [config, setConfig] = useAtom(agentConfigAtom);
  const [efforts, setEfforts] = useAtom(agentEffortAtom);
  const offered = useAtomValue(agentEnginesAtom);
  const reachable = useAtomValue(agentServiceReachableAtom);
  const effective = useMemo(() => effectiveAgentConfig(config), [config]);

  const [catalog, setCatalog] = useState<VibeModelCatalog>({ models: FALLBACK_MODELS, defaultModel: FALLBACK_DEFAULT, retired: FALLBACK_RETIRED });
  const offersCredits = !!offered?.includes('revyme');
  useEffect(() => {
    if (!offersCredits) return;
    let live = true;
    void fetchVibeModels().then((c) => { if (live && c.models.length) setCatalog(c); });
    return () => { live = false; };
  }, [offersCredits]);

  const choices = useMemo(() => modelChoices(offered ?? [], catalog), [offered, catalog]);
  const active = currentChoice(choices, effective, catalog);
  const unavailable = reachable === false || !offered || !offered.includes('revyme');

  const pick = (c: ModelChoice) => {
    setConfig({ provider: c.provider, model: c.model, apiKey: '' });
    trace.action('agent-model-select:pick', { provider: c.provider, model: c.model });
  };

  const effortOf = (c: ModelChoice) => effortFor(efforts, c.provider, c.model);
  const pickEffort = (c: ModelChoice, effort: AgentEffort) => {
    setEfforts({ ...efforts, [c.model]: effort });
    pick(c);
    trace.action('agent-model-select:effort', { model: c.model, effort });
  };
  // The chip names the effort only when it is not the model's default.
  const activeEffort = active ? effortOf(active) : null;
  const activeDefault = active ? effortOptionsFor(active.provider, active.model)?.fallback : undefined;
  const chip = active && activeEffort && activeEffort !== activeDefault ? `${active.chip} · ${EFFORT_LABELS[activeEffort]}` : active?.chip;

  return (
    <div data-testid="agent-model-switcher" data-model={active ? choiceKey(active.provider, active.model) : ''} className="relative min-w-0">
      <SearchableDropdown
        items={choices}
        getKey={(c) => choiceKey(c.provider, c.model)}
        getLabel={(c) => c.label}
        getTrailing={(c) => {
          const e = effortOf(c);
          if (!e) return c.note || null;
          return c.note ? `${c.note} · ${EFFORT_LABELS[e]}` : EFFORT_LABELS[e];
        }}
        getSubmenu={(c) => {
          const opts = effortOptionsFor(c.provider, c.model);
          if (!opts) return null;
          return {
            title: 'Thinking effort',
            // The level the model runs at until you pick is marked as such.
            options: opts.options.map((o) => ({ key: o, label: EFFORT_LABELS[o], note: o === opts.fallback ? 'default' : undefined })),
            activeKey: effortOf(c),
            onPick: (key) => pickEffort(c, key as AgentEffort),
          };
        }}
        getGroup={(c) => c.group}
        getGroupIcon={(group) => {
          const vendor = choices.find((c) => c.group === group)?.vendor;
          return vendor ? <VendorLogo vendor={vendor} /> : null;
        }}
        matches={(c, q) => `${c.label} ${c.group} ${c.model}`.toLowerCase().includes(q)}
        activeKey={active ? choiceKey(active.provider, active.model) : null}
        triggerLabel={unavailable ? 'No agent' : chip ?? 'Choose a model'}
        triggerIcon={!unavailable && active ? <VendorLogo vendor={active.vendor} /> : null}
        itemIcon={null}
        placeholder="Search models…"
        emptyText="No model matches."
        triggerClassName={TRIGGER_CLASS}
        inputClassName={INPUT_CLASS}
        listClassName="max-h-72 overflow-y-auto scrollbar-hide py-1"
        onSelect={pick}
        portal={PANEL_PORTAL}
        disabled={unavailable}
        triggerTestId="agent-model-select"
        title={
          reachable === false ? 'Can’t reach the Revyme AI service'
            : unavailable ? 'This AI service does not run Revyme credits'
            : 'The model the next turn runs on — billed to your workspace’s credits'
        }
      />
    </div>
  );
}
