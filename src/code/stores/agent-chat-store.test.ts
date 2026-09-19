import { describe, it, expect } from 'vitest';
import { createStore } from 'jotai';
import { agentConfigAtom, isAgentConfiguredAtom, providerNeedsKey, DEFAULT_MODELS } from './agent-chat-store';

describe('agent provider config', () => {
  it('defaults to the local Claude Code subscription — usable with no setup', () => {
    const store = createStore();
    const cfg = store.get(agentConfigAtom);
    expect(cfg.provider).toBe('claude-cli');
    expect(store.get(isAgentConfiguredAtom)).toBe(true);   // no key needed
  });

  it('only the local CLI is keyless; every BYOK provider needs one', () => {
    expect(providerNeedsKey('claude-cli')).toBe(false);
    for (const p of ['anthropic', 'openai', 'google', 'openrouter'] as const) {
      expect(providerNeedsKey(p)).toBe(true);
    }
  });

  it('a BYOK provider is not configured until a key is entered', () => {
    const store = createStore();
    store.set(agentConfigAtom, { provider: 'anthropic', model: DEFAULT_MODELS.anthropic, apiKey: '' });
    expect(store.get(isAgentConfiguredAtom)).toBe(false);
    store.set(agentConfigAtom, { provider: 'anthropic', model: DEFAULT_MODELS.anthropic, apiKey: 'sk-ant-x' });
    expect(store.get(isAgentConfiguredAtom)).toBe(true);
  });

  it('whitespace is not a key', () => {
    const store = createStore();
    store.set(agentConfigAtom, { provider: 'openai', model: 'gpt-5', apiKey: '   ' });
    expect(store.get(isAgentConfiguredAtom)).toBe(false);
  });

  it('every provider has a default model except the CLI, which follows its own', () => {
    expect(DEFAULT_MODELS['claude-cli']).toBe('');
    for (const p of ['anthropic', 'openai', 'google', 'openrouter'] as const) {
      expect(DEFAULT_MODELS[p].length).toBeGreaterThan(0);
    }
  });
});
