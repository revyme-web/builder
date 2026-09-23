// The composer's model chip: lists exactly what the connected service runs,
// grouped like the old Vibe model chip, and writes the stored choice.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { ModelSelector, modelChoices, currentChoice } from './ModelSelector';
import {
  agentConfigAtom, agentEnginesAtom, agentServiceReachableAtom, agentEffortAtom, effortFor, effortWire, type AgentProviderConfig,
} from '@/code/stores/agent-chat-store';
import { FALLBACK_MODELS, FALLBACK_DEFAULT, FALLBACK_RETIRED } from '@/ai/vibe-models';

vi.mock('@/ai/vibe-models', async (orig) => {
  const real = await orig<typeof import('@/ai/vibe-models')>();
  return { ...real, fetchVibeModels: vi.fn(async () => ({ models: real.FALLBACK_MODELS, defaultModel: real.FALLBACK_DEFAULT })) };
});

const CATALOG = { models: FALLBACK_MODELS, defaultModel: FALLBACK_DEFAULT, retired: FALLBACK_RETIRED };
const cfg = (provider: AgentProviderConfig['provider'], model = '', apiKey = ''): AgentProviderConfig => ({ provider, model, apiKey });

beforeEach(() => { cleanup(); localStorage.clear(); });

function mount(engines: AgentProviderConfig['provider'][] | null, config: AgentProviderConfig) {
  const store = createStore();
  store.set(agentEnginesAtom, engines);
  store.set(agentServiceReachableAtom, engines === null ? null : true);
  store.set(agentConfigAtom, config);
  render(<Provider store={store}><ModelSelector /></Provider>);
  return store;
}

describe('modelChoices', () => {
  it('the credit catalog grouped by vendor — nothing else (no local CLI, no pasted keys)', () => {
    const rows = modelChoices(['revyme', 'claude-cli', 'anthropic'], CATALOG);
    expect(rows.every((r) => r.provider === 'revyme')).toBe(true);
    expect([...new Set(rows.map((r) => r.group))]).toEqual(['Claude', 'ChatGPT', 'Gemini']);
    expect(rows.find((r) => r.model === 'anthropic/claude-sonnet-5')?.note).toBe('standard');
  });

  it('a service without credits: no models', () => {
    expect(modelChoices(['claude-cli', 'anthropic'], CATALOG)).toEqual([]);
  });

  it('an off-catalog credits id reads as the model the service runs it on: a retired one\'s successor, else the default', () => {
    const rows = modelChoices(['revyme'], CATALOG);
    expect(currentChoice(rows, cfg('revyme', 'some/unknown-model'), CATALOG)?.model).toBe(FALLBACK_DEFAULT);
    // Picked Opus 4.8 before it left the catalog — still an Opus, not Flash.
    expect(currentChoice(rows, cfg('revyme', 'anthropic/claude-opus-4.8'), CATALOG)?.label).toBe('Claude Opus 5.5');
  });
});

describe('ModelSelector', () => {
  it('shows the model on the chip, lists the credit models under vendor headers, and picking one stores it', () => {
    const store = mount(['revyme', 'claude-cli'], cfg('revyme', 'anthropic/claude-sonnet-5'));
    const chip = screen.getByTestId('agent-model-select');
    expect(chip.textContent).toContain('Claude Sonnet 5');
    // The chip carries the model maker's logo.
    expect(chip.querySelector('svg[data-vendor="anthropic"]')).toBeTruthy();
    fireEvent.click(chip);
    expect(screen.getByText('Gemini')).toBeTruthy();
    // Each vendor header has its logo beside the name.
    for (const [name, vendor] of [['Claude', 'anthropic'], ['ChatGPT', 'openai'], ['Gemini', 'google']]) {
      expect(screen.getByText(name).parentElement!.querySelector(`svg[data-vendor="${vendor}"]`)).toBeTruthy();
    }
    expect(screen.queryByText(/Claude Code/)).toBeNull();
    // No settings entry under the list any more.
    expect(screen.queryByText(/Agent settings/)).toBeNull();
    fireEvent.click(screen.getByText('GPT-6 Sol'));
    expect(store.get(agentConfigAtom)).toEqual({ provider: 'revyme', model: 'openai/gpt-6-sol', apiKey: '' });
    expect(screen.getByTestId('agent-model-select').textContent).toContain('GPT-6 Sol');
  });

  it('a stored non-credits engine (the old CLI default) shows as the default credit model', () => {
    mount(['revyme'], cfg('claude-cli'));
    expect(screen.getByTestId('agent-model-select').textContent).toContain('Claude Sonnet 5');
  });

  it('no credits on the service (the open-source builder): a disabled "No agent" chip', () => {
    mount([], cfg('revyme', 'anthropic/claude-sonnet-5'));
    const chip = screen.getByTestId('agent-model-select') as HTMLButtonElement;
    expect(chip.disabled).toBe(true);
    expect(chip.textContent).toContain('No agent');
  });
});

describe('thinking effort, per model', () => {
  it('each OpenRouter model row shows its tier and effort; hovering opens the efforts it takes', () => {
    mount(['revyme'], cfg('revyme', 'google/gemini-3.8-flash'));
    fireEvent.click(screen.getByTestId('agent-model-select'));
    const sonnet = screen.getByText('Claude Sonnet 5').closest('button')!;
    expect(sonnet.textContent).toContain('standard · Low');
    fireEvent.mouseEnter(sonnet);
    const flyout = screen.getByTestId('searchable-dropdown-submenu');
    // Always thinking: Low is the least, and it is Claude's default.
    expect([...flyout.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Lowdefault', 'Medium', 'High']);
    // Gemini: its levels only — a level is what makes it send its thinking.
    // The chip also reads "Gemini 3.8 Flash" — take the LIST row.
    fireEvent.mouseEnter(screen.getAllByText('Gemini 3.8 Flash').map((e) => e.closest('button')!).find((b) => b.dataset.testid !== 'agent-model-select')!);
    expect([...screen.getByTestId('searchable-dropdown-submenu').querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Low', 'Highdefault']);
  });

  it('picking an effort stores it for THAT model and switches to it; the chip names a non-default effort', () => {
    const store = mount(['revyme'], cfg('revyme', 'google/gemini-3.8-flash'));
    fireEvent.click(screen.getByTestId('agent-model-select'));
    fireEvent.mouseEnter(screen.getByText('Claude Sonnet 5').closest('button')!);
    fireEvent.click(screen.getByText('High'));
    expect(store.get(agentEffortAtom)).toEqual({ 'anthropic/claude-sonnet-5': 'high' });
    expect(store.get(agentConfigAtom).model).toBe('anthropic/claude-sonnet-5');
    expect(screen.getByTestId('agent-model-select').textContent).toContain('Claude Sonnet 5 · High');
  });
});

describe('what a turn sends', () => {
  it('every OpenRouter model always sends a level — Low at the least; no control sends nothing', () => {
    expect(effortWire(effortFor({ 'anthropic/claude-sonnet-5': 'medium' }, 'revyme', 'anthropic/claude-sonnet-5'))).toBe('medium');
    expect(effortWire(effortFor({}, 'revyme', 'anthropic/claude-sonnet-5'))).toBe('low');
    expect(effortWire(effortFor({}, 'revyme', 'openai/gpt-6-sol'))).toBe('medium');
    // An "Off" stored before thinking became mandatory runs at the default.
    expect(effortFor({ 'anthropic/claude-sonnet-5': 'off' }, 'revyme', 'anthropic/claude-sonnet-5')).toBe('low');
    expect(effortFor({ 'x': 'high' }, 'claude-cli', 'opus')).toBeNull();
    // A stored level the model does not take falls back to its default —
    // and Gemini's default is a level that IS sent (it hides its thinking otherwise).
    expect(effortFor({ 'google/gemini-3.8-flash': 'auto' }, 'revyme', 'google/gemini-3.8-flash')).toBe('high');
    expect(effortWire(effortFor({}, 'revyme', 'google/gemini-3.8-flash'))).toBe('high');
  });
});
