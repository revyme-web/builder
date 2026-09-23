// What a turn runs with: the chat runs on Revyme CREDITS only (the composer's
// model select lists nothing else), and only where the connected AI service
// runs credits — none in the open-source build.
import { describe, it, expect } from 'vitest';
import { createStore } from 'jotai';
import {
  effectiveAgentConfig, providerNeedsKey, DEFAULT_MODELS,
  agentConfigAtom, agentEnginesAtom, agentServiceReachableAtom, isAgentConfiguredAtom,
} from './agent-chat-store';

describe('effectiveAgentConfig — credits only', () => {
  it('a credits choice is kept as is', () => {
    const c = { provider: 'revyme' as const, model: 'openai/gpt-6-sol', apiKey: '' };
    expect(effectiveAgentConfig(c)).toBe(c);
  });

  it('an engine stored from before (the old local-CLI default, a pasted key) runs as credits on the default model', () => {
    expect(effectiveAgentConfig({ provider: 'claude-cli', model: '', apiKey: '' }))
      .toEqual({ provider: 'revyme', model: DEFAULT_MODELS.revyme, apiKey: '' });
    expect(effectiveAgentConfig({ provider: 'anthropic', model: 'x', apiKey: 'sk-ant-1' }))
      .toEqual({ provider: 'revyme', model: DEFAULT_MODELS.revyme, apiKey: '' });
  });

  it('the chat can run only where the service runs credits', () => {
    const store = createStore();
    store.set(agentConfigAtom, { provider: 'claude-cli', model: '', apiKey: '' });
    store.set(agentEnginesAtom, []); // the open-source build: no service
    expect(store.get(isAgentConfiguredAtom)).toBe(false);
    store.set(agentEnginesAtom, ['claude-cli', 'anthropic']); // a local service without an OpenRouter key
    expect(store.get(isAgentConfiguredAtom)).toBe(false);
    store.set(agentEnginesAtom, ['revyme']);
    expect(store.get(isAgentConfiguredAtom)).toBe(true);
    store.set(agentServiceReachableAtom, false);
    expect(store.get(isAgentConfiguredAtom)).toBe(false);
  });

  it('credits send no key', () => {
    expect(providerNeedsKey('revyme')).toBe(false);
  });
});
