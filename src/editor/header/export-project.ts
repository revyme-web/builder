// export-project.ts — Downloads the current project as a zip.
//
// Extracted from RightHeader's `handleExport` so the cmd+K palette runs the
// identical path instead of a second copy. The React-specific parts
// (`exporting` spinner, closing the dropdown) stay in the component; this
// module owns the fetch → blob → anchor-click sequence, which is the part
// that must not diverge between callers.
//
// Each format maps to its own backend route so the service layer can pick
// the right transformer. `source` ships today; `tailwind` returns 501 until
// Phase 2 lands, which surfaces as a "coming soon" message rather than a
// generic failure.

import { toast } from 'sonner';
import { trace } from '@/shared/debug-trace';
import { CLOUD_ENABLED } from '@/shared/cloud-flag';
import type { ExportFormat } from './ExportDropdown';

/** Whether export is reachable at all. Local mode has no backend to build
 *  the zip, so callers should hide the affordance entirely rather than
 *  offer one that always fails. */
export function canExport(): boolean {
  return CLOUD_ENABLED;
}

/**
 * Fetch and download the project zip.
 *
 * @returns `true` when the download started, `false` on any handled
 *          failure (already reported to the user).
 *
 * Never throws — every caller so far treats a failure as "tell the user and
 * carry on", and a rejected promise crossing into a click handler would be
 * an unhandled rejection.
 */
export async function exportProject(format: ExportFormat = 'source'): Promise<boolean> {
  if (!canExport()) return false;

  const { getProjectId } = await import('@/backend/project-id');
  const id = getProjectId();
  if (!id) return false;

  trace.action('export-project:start', { id, format });
  try {
    const res = await fetch(`/api/export/${format}/${id}`);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      trace.error('export-project:failed', { format, status: res.status, error: body });
      toast.error(
        res.status === 501
          ? 'This export format is coming soon.'
          : body?.error?.message ?? 'Export failed — check console',
      );
      return false;
    }

    // Honour the server's filename when it sends one; the backend names the
    // zip after the site, which is friendlier than a generic fallback.
    const disposition = res.headers.get('content-disposition') ?? '';
    const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] ?? 'revyme-export.zip';

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    trace.action('export-project:success', { format, filename, bytes: blob.size });
    return true;
  } catch (err) {
    trace.error('export-project:error', err);
    toast.error('Export failed — check console');
    return false;
  }
}
