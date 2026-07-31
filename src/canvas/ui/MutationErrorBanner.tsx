// MutationErrorBanner.tsx — Displays a validation-failed error overlay when
// AI mutations are blocked by the mutation queue's validation step.

import type { MutationErrorDetail } from '@/code/mutation/mutation-queue';

export default function MutationErrorBanner({ error }: { error: MutationErrorDetail }) {
  return (
    <div style={{
      position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
      zIndex: 9999, backgroundColor: '#1e1e1e', color: '#fff', border: '1px solid #ef4444',
      padding: '12px 16px', borderRadius: 8, fontSize: 12, maxWidth: 580,
      boxShadow: '0 4px 20px rgba(0,0,0,0.6)', pointerEvents: 'none',
      lineHeight: 1.5, fontFamily: 'monospace',
    }}>
      <div style={{ color: '#ef4444', fontWeight: 700, fontSize: 13, marginBottom: 6, fontFamily: 'sans-serif' }}>
        AI changes blocked — validation failed
      </div>
      <div style={{ color: '#888', marginBottom: 6, fontFamily: 'sans-serif', fontSize: 11 }}>
        Mutations: {error.mutationTypes.join(', ')}
      </div>
      <div style={{ color: '#fca5a5', marginBottom: error.codeExcerpt ? 8 : 0 }}>
        {error.message}
      </div>
      {error.codeExcerpt && (
        <pre style={{
          margin: 0, padding: '8px 10px', borderRadius: 4,
          backgroundColor: '#111', color: '#d4d4d4', fontSize: 11,
          overflowX: 'auto', whiteSpace: 'pre', lineHeight: 1.6,
          borderLeft: '3px solid #ef4444',
        }}>
          {error.codeExcerpt}
        </pre>
      )}
    </div>
  );
}
