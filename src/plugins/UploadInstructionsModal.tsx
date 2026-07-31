// UploadInstructionsModal.tsx — modal that walks the user through
// packing a Tier 1 (dev URL) plugin and uploading it to the marketplace.
//
// Triggered from the LibraryPanel's plugin right-click menu. Pure
// informational — copies a sequence of terminal commands the author
// runs locally. The actual pack pipeline lives in the standalone
// `@revyme/plugin-tools` CLI (published to npm).
//
// Why a modal instead of an external docs page: keeps the publishing
// flow discoverable from inside the builder. Author sees exactly which
// commands to run for THEIR plugin without context-switching to a
// browser tab.

import { atom, useAtomValue, useSetAtom } from 'jotai';
import { useState } from 'react';

/**
 * Currently-active Upload Instructions modal — null when closed, the
 * plugin's display name when open. Drives `UploadInstructionsModal`.
 */
export const uploadInstructionsForAtom = atom<string | null>(null);

export function UploadInstructionsModal() {
  const pluginName = useAtomValue(uploadInstructionsForAtom);
  const setOpen = useSetAtom(uploadInstructionsForAtom);

  if (!pluginName) return null;

  return (
    <div
      onClick={() => setOpen(null)}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.65)',
        zIndex: 99999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 540,
          maxHeight: '85vh',
          overflow: 'auto',
          background: '#111',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 12,
          padding: 24,
          color: '#f8fafc',
          boxShadow: '0 24px 80px -16px rgba(0,0,0,0.7)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: '#f8fafc' }}>
            Publish {pluginName}
          </h2>
          <button
            onClick={() => setOpen(null)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'rgba(255,255,255,0.5)',
              cursor: 'pointer',
              padding: 4,
              fontFamily: 'inherit',
              fontSize: 14,
              lineHeight: 1,
            }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <p style={{ margin: '0 0 20px', fontSize: 12.5, color: 'rgba(248,250,252,0.6)', lineHeight: 1.55 }}>
          Build your plugin into a single zip, then drop it into the dashboard. Three steps, all in your terminal.
        </p>

        <Step
          number={1}
          title="Add the pack tool"
          description="One-time. Adds the @revyme/plugin-tools CLI to your plugin's dev dependencies."
          command="npm install --save-dev @revyme/plugin-tools"
        />

        <Step
          number={2}
          title="Pack your plugin"
          description={
            <>
              Runs <code style={inline}>npm run build</code> + zips <code style={inline}>dist/</code> and <code style={inline}>src/</code> into <code style={inline}>plugin.zip</code>.
              Source is always bundled — admins need to review it before approval.
              Whether end users see a "Download source" button is decided in the dashboard.
            </>
          }
          command={'npx revyme-plugin pack'}
        />

        <Step
          number={3}
          title="Upload"
          description={
            <>
              Open the creator dashboard, drag <code style={inline}>plugin.zip</code> into the Upload files tab. Fill in name, thumbnail, description, then submit for review.
            </>
          }
          linkLabel="Open dashboard →"
          href="https://revyme.com/dashboard"
        />

        <details style={{ marginTop: 20, fontSize: 12, color: 'rgba(248,250,252,0.55)' }}>
          <summary style={{ cursor: 'pointer', userSelect: 'none', color: 'rgba(248,250,252,0.75)', fontWeight: 500 }}>
            CI / advanced flags
          </summary>
          <div style={{ marginTop: 10, paddingLeft: 4, lineHeight: 1.65 }}>
            <code style={inline}>--prebuilt</code> — skip the build, just zip the existing dist (CI)<br />
            <code style={inline}>--dist-dir &lt;path&gt;</code> — non-default build output folder<br />
            <code style={inline}>--build-command &lt;cmd&gt;</code> — override the build script<br />
            <code style={inline}>--source-dir &lt;path&gt;</code> — non-default source folder (default: <code style={inline}>src</code>)
          </div>
        </details>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 22 }}>
          <button
            onClick={() => setOpen(null)}
            style={{
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.1)',
              color: '#f8fafc',
              padding: '8px 16px',
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 500,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

/** Single numbered step with a code block + copy button. */
function Step({
  number, title, description, command, linkLabel, href,
}: {
  number: number;
  title: string;
  description: React.ReactNode;
  command?: string;
  linkLabel?: string;
  href?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // clipboard write rejected (permissions) — silently fail
    }
  }

  return (
    <div style={{ display: 'flex', gap: 12, marginBottom: 18 }}>
      <div style={{
        width: 22,
        height: 22,
        flexShrink: 0,
        borderRadius: '50%',
        background: 'rgba(59,130,246,0.16)',
        color: '#60a5fa',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 11,
        fontWeight: 700,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {number}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#f8fafc', marginBottom: 4 }}>
          {title}
        </div>
        <div style={{ fontSize: 12, color: 'rgba(248,250,252,0.6)', lineHeight: 1.55, marginBottom: 10 }}>
          {description}
        </div>

        {command && (
          <div style={{ position: 'relative' }}>
            <pre style={{
              margin: 0,
              padding: '10px 14px',
              paddingRight: copied ? 14 : 64,
              background: '#0a0a0a',
              border: '1px solid rgba(255,255,255,0.06)',
              borderRadius: 6,
              fontSize: 11.5,
              fontFamily: 'ui-monospace, Menlo, monospace',
              color: 'rgba(248,250,252,0.88)',
              lineHeight: 1.55,
              overflow: 'auto',
              whiteSpace: 'pre',
            }}>{command}</pre>
            <button
              onClick={handleCopy}
              style={{
                position: 'absolute',
                top: 7,
                right: 7,
                padding: '4px 9px',
                background: copied ? 'rgba(16,185,129,0.15)' : 'rgba(255,255,255,0.04)',
                border: copied ? '1px solid rgba(16,185,129,0.3)' : '1px solid rgba(255,255,255,0.08)',
                color: copied ? '#34d399' : 'rgba(248,250,252,0.7)',
                borderRadius: 4,
                fontSize: 10,
                fontWeight: 500,
                cursor: 'pointer',
                fontFamily: 'inherit',
                transition: 'all 0.12s ease',
              }}
            >
              {copied ? '✓ Copied' : 'Copy'}
            </button>
          </div>
        )}

        {linkLabel && href && (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-block',
              marginTop: 2,
              fontSize: 12,
              fontWeight: 500,
              color: '#60a5fa',
              textDecoration: 'none',
            }}
          >
            {linkLabel}
          </a>
        )}
      </div>
    </div>
  );
}

const inline: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 3,
  padding: '1px 4px',
  fontSize: 11,
  fontFamily: 'ui-monospace, Menlo, monospace',
  color: '#f8fafc',
};
