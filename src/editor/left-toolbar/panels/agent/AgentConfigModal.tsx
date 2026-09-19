// AgentConfigModal.tsx — BYOK provider + model, stored per user in this browser.

import { useState } from 'react';
import { useAtom } from 'jotai';
import Modal from '@/design-system/Modal';
import SectionLabel from '@/design-system/SectionLabel';
import Button from '@/design-system/Button';
import { agentConfigAtom, DEFAULT_MODELS, providerNeedsKey, type AgentProviderConfig } from '@/code/stores/agent-chat-store';

const PROVIDERS: { id: AgentProviderConfig['provider']; label: string; keyHint: string }[] = [
  { id: 'claude-cli', label: 'Claude Code', keyHint: '' },
  { id: 'anthropic', label: 'Anthropic', keyHint: 'sk-ant-…' },
  { id: 'openai', label: 'OpenAI', keyHint: 'sk-…' },
  { id: 'google', label: 'Google', keyHint: 'AIza…' },
  { id: 'openrouter', label: 'OpenRouter', keyHint: 'sk-or-…' },
];

// The same control recipe ToolInput uses, so the agent's fields read as
// part of the editor rather than a bolted-on panel.
const field = 'w-full px-[var(--control-pad-x)] py-1.5 text-xs bg-[var(--grid-line)] border border-[var(--control-border)] [--cut-border-color:var(--control-border)] hover:border-[var(--control-border-hover)] hover:[--cut-border-color:var(--control-border-hover)] focus:border-[var(--border-focus)] focus:[--cut-border-color:var(--border-focus)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] cut-corners cut-border focus:outline-none transition-colors h-[var(--control-height)]';

export default function AgentConfigModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [config, setConfig] = useAtom(agentConfigAtom);
  const [draft, setDraft] = useState(config);
  const provider = PROVIDERS.find((p) => p.id === draft.provider)!;
  const needsKey = providerNeedsKey(draft.provider);

  const save = () => { setConfig(draft); onClose(); };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Agent settings" width={420}>
      <div className="p-3">
        <SectionLabel size="xs">Provider</SectionLabel>
        <div className="grid grid-cols-2 gap-1.5 px-3 pb-3">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setDraft({ ...draft, provider: p.id, model: DEFAULT_MODELS[p.id] })}
              className={`cut-corners cut-border border bg-[var(--grid-line)] px-2 py-1.5 text-xs transition-colors ${
                draft.provider === p.id
                  ? 'border-[var(--border-focus)] [--cut-border-color:var(--border-focus)] text-[var(--text-primary)]'
                  : 'border-[var(--control-border)] [--cut-border-color:var(--control-border)] text-[var(--text-secondary)] hover:border-[var(--control-border-hover)] hover:[--cut-border-color:var(--control-border-hover)]'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        <SectionLabel size="xs">Model</SectionLabel>
        <div className="px-3 pb-3">
          <input
            className={field}
            placeholder={needsKey ? '' : 'default (whatever Claude Code uses)'}
            value={draft.model}
            onChange={(e) => setDraft({ ...draft, model: e.target.value })}
          />
        </div>

        {needsKey ? (
          <>
            <SectionLabel size="xs">API key</SectionLabel>
            <div className="px-3 pb-1">
              <input
                className={field}
                type="password"
                autoComplete="off"
                placeholder={provider.keyHint}
                value={draft.apiKey}
                onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
              />
            </div>
            <p className="px-3 pb-3 text-[10px] leading-relaxed text-[var(--text-tertiary)]">
              Your key stays in this browser and is sent with each request to run the model. It is never stored on the server.
            </p>
          </>
        ) : (
          <p className="px-3 pb-3 text-[10px] leading-relaxed text-[var(--text-tertiary)]">
            Runs on the <code>claude</code> CLI already installed on this machine, using its own login — no API key and no
            per-token cost. It reaches this project through Revyme&rsquo;s own tools, so every edit still passes the oracle.
          </p>
        )}

        <div className="flex justify-end gap-2 border-t border-[var(--border-default)] px-3 pt-3">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={save} disabled={needsKey && (!draft.apiKey.trim() || !draft.model.trim())}>
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}
