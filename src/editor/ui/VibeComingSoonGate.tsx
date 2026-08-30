// VibeComingSoonGate.tsx — temporary gate over every in-house AI chat surface.
//
// The in-house Vibe agent is being reworked (timeouts, cost); until it ships,
// every chat panel renders normally but is blurred behind this overlay with a
// pointer to the MCP flow, which works well today. One component, four mounts:
//   - VibeDockShell   (docked chat: pages, design components, icon sets)
//   - AIChatSheet     (the same chats, detached/floating)
//   - ChatShell       (component-editor + plugin-editor chats)
//   - CmsAiPanel      (CMS overlay chat)
// Removing the gate later = delete this file + the four <VibeComingSoonGate />
// lines. Each mount's root is position:fixed or has `relative`, so the
// absolute overlay sizes to its panel.
//
// The button deep-links to Settings → "Connect AI / MCP" (the cloud plugin's
// `connect-ai` section). SettingsOverlay mounts after the CMS / component
// overlays at z-[10000], so it paints above them — no need to close the
// hosting overlay first.

import { useSetAtom } from 'jotai';
import { settingsOverlayOpenAtom, settingsSectionAtom } from '@/code/stores/website-settings-store';
import { trace } from '@/shared/debug-trace';

export default function VibeComingSoonGate({ onClose }: {
  /** The gate covers the WHOLE panel, host header (and its ✕) included — a
   *  host whose only close affordance lives under the blur passes its close
   *  here so the gate can render its own ✕ on top. */
  onClose?: () => void;
}) {
  const setSettingsOpen = useSetAtom(settingsOverlayOpenAtom);
  const setSection = useSetAtom(settingsSectionAtom);

  const openMcpSettings = () => {
    trace.action('vibe-gate:open-mcp-settings', {});
    setSection('connect-ai');
    setSettingsOpen(true);
  };

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center p-3"
      style={{
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        background: 'color-mix(in srgb, var(--bg-surface) 55%, transparent)',
      }}
    >
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          title="Close"
          className="absolute top-1.5 right-2 w-6 h-6 flex items-center justify-center bg-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
          style={{ border: 'none' }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
      <div className="max-w-[230px] w-full cut-corners cut-border [--cut-border-color:var(--border-light)] border border-[var(--border-light)] bg-[var(--control-bg)] px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <svg
            width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            className="text-[var(--accent)] shrink-0" aria-hidden="true"
          >
            <path d="M12 2.4l1.85 6.3 6.3 1.85-6.3 1.85L12 18.7l-1.85-6.3L3.85 10.55l6.3-1.85L12 2.4z" />
          </svg>
          <span className="text-[11px] font-medium text-[var(--text-primary)]">Coming soon</span>
        </div>
        <p className="mt-1 text-[10px] leading-relaxed text-[var(--text-secondary)]">
          The Revyme in-house agent is coming soon. For now, you can use the MCP to build with AI.
        </p>
        <button
          type="button"
          onClick={openMcpSettings}
          className="mt-2 w-full cut-corners bg-[var(--accent)] px-2 py-1.5 text-[11px] font-medium text-[var(--accent-fg)] transition-[filter] hover:brightness-110 cursor-pointer"
        >
          Connect with MCP
        </button>
      </div>
    </div>
  );
}
