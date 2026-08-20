// ConnectAiSection.tsx — "Connect AI" settings section: the per-project MCP
// connection kit. One account-level MCP token (created in the DASHBOARD →
// Settings → API Tokens) + THIS project's endpoint URL = a config any MCP
// client (Claude Code, Cursor, claude.ai) can use to edit this project live.
//
// The token is never readable from the server (hash-stored) — the user pastes
// it here and the snippets assemble locally; nothing is persisted.

import React, { useState } from 'react';
import { trace } from '@/shared/debug-trace';
import { getProjectId } from '@/backend/project-id';
import { CLOUD_ENABLED } from '@/shared/cloud-flag';
import { openWorkspaceSettingsPage } from '@/code/stores/credits-store';

const MCP_BASE = (import.meta.env.VITE_MCP_URL as string | undefined)
  || (CLOUD_ENABLED ? 'https://mcp.revyme.com' : 'http://localhost:8082');

const TOKEN_PLACEHOLDER = 'rvy_mcp_YOUR_TOKEN';

function CopyBlock({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-[var(--text-secondary)]">{label}</span>
        <button
          onClick={() => {
            void navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
            trace.action('connect-ai:copy', { label });
          }}
          className="text-xs text-[var(--accent-text)] hover:opacity-80 cursor-pointer"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="text-[11px] leading-relaxed px-3 py-2.5 cut-corners cut-border [--cut-border-color:var(--border-light)] bg-[var(--grid-line)] border border-[var(--border-light)] text-[var(--text-primary)] whitespace-pre-wrap break-all select-all">{value}</pre>
    </div>
  );
}

export default function ConnectAiSection() {
  const [token, setToken] = useState('');
  const projectId = getProjectId();
  const url = `${MCP_BASE}/mcp/${projectId}`;
  const tok = token.trim() || TOKEN_PLACEHOLDER;

  const claudeCmd = `claude mcp add --transport http revyme ${url} --header "Authorization: Bearer ${tok}"`;
  const cursorJson = JSON.stringify({
    mcpServers: {
      revyme: { url, headers: { Authorization: `Bearer ${tok}` } },
    },
  }, null, 2);

  trace.fn('ConnectAiSection.render', { projectId, hasToken: !!token.trim() });

  return (
    <div className="max-w-[560px] mx-auto flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">Connect AI / MCP</h2>
        <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
          Let an AI assistant (Claude Code, Cursor, claude.ai) edit this project
          through MCP. It only ever reaches <b>this</b> project — the endpoint
          URL carries the scope. Keep the project open in a tab while the
          assistant works; changes land on the canvas live, checked by the same
          rules as every edit.
        </p>
      </div>

      <button
        onClick={() => openWorkspaceSettingsPage('api-tokens')}
        className="w-full h-9 cut-corners bg-[var(--accent)] text-[var(--accent-fg)] text-xs font-medium hover:opacity-90 cursor-pointer transition-opacity"
      >
        Manage API Tokens
      </button>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-[var(--text-secondary)]">Your MCP token</span>
        <input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={TOKEN_PLACEHOLDER}
          spellCheck={false}
          className="w-full h-9 px-3 text-xs font-mono bg-[var(--grid-line)] border border-[var(--control-border)] hover:border-[var(--control-border-hover)] focus:border-[var(--border-focus)] cut-corners cut-border hover:[--cut-border-color:var(--control-border-hover)] focus:[--cut-border-color:var(--border-focus)] text-[var(--text-primary)] placeholder:text-[var(--text-disabled)] focus:outline-none transition-colors"
        />
        <p className="text-[11px] text-[var(--text-disabled)]">
          One account-level token works for all your projects — create it with
          Manage API Tokens above. Pasting it here only fills the snippets
          below; it is not stored.
        </p>
      </div>

      <CopyBlock label="Claude Code" value={claudeCmd} />
      <CopyBlock label="Cursor / mcp.json" value={cursorJson} />
      <CopyBlock label="Endpoint URL (claude.ai connectors)" value={url} />
    </div>
  );
}
