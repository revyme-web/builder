// project-store.ts — Project-level state that lives OUTSIDE the
// ProjectFS code (i.e. doesn't belong in any source file). Currently
// only holds the project's user-facing name; over time things like
// "last opened page" or non-versioned project flags can land here.
//
// The project name is intentionally separate from `metadata.title`
// (which is the SEO `<title>` baked into app/layout.tsx). A user can
// have a project called "Marketing site rebuild" while the published
// `<title>` is "Acme — Home". Conflating them was the previous
// design's mistake — the chip would silently overwrite SEO when the
// user renamed their project.
//
// Persistence is localStorage (keyed by project id) for an instant,
// reload-surviving cache. The CANONICAL name lives in the cloud
// `websites.name` column (what the dashboard tile shows): ProjectChip's
// rename calls `backend.renameWebsite()` to write it, and ProjectLoader
// seeds this atom from `backend.getWebsiteName()` on load so a rename done
// in the dashboard shows up in the editor. localStorage is just the
// optimistic cache; the backend value wins on load.

import { atom, getDefaultStore } from 'jotai';
import { getProjectId } from '@/backend/project-id';
import { trace } from '@/shared/debug-trace';

const STORAGE_KEY_PREFIX = 'revyme:project-name:';

/** Read the persisted name (if any) for the current project id. Used
 *  to seed `projectNameAtom` on first read so reloads don't flash
 *  "Untitled" before the name comes back. Returns empty string if
 *  nothing is stored or localStorage is unavailable. */
function readPersistedName(): string {
  if (typeof window === 'undefined' || !window.localStorage) return '';
  try {
    return window.localStorage.getItem(STORAGE_KEY_PREFIX + getProjectId()) ?? '';
  } catch {
    return '';
  }
}

/** Project name atom — empty string means "not set yet". Consumers
 *  should render a placeholder ("Untitled") when this is empty. The
 *  raw value is kept empty (not "Untitled") so the chip can style
 *  the placeholder differently than a user-typed name. */
export const projectNameAtom = atom<string>(readPersistedName());

/** Imperative setter that also persists to localStorage. Use this
 *  instead of `useSetAtom(projectNameAtom)` when you need writes to
 *  survive reloads (almost always). Trims whitespace and tolerates
 *  empty input (treated as "clear the name back to placeholder"). */
export function setProjectName(name: string): void {
  const trimmed = name.trim();
  const id = getProjectId();
  trace.action('project-store:set-name', { id, name: trimmed });
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      if (trimmed) {
        window.localStorage.setItem(STORAGE_KEY_PREFIX + id, trimmed);
      } else {
        window.localStorage.removeItem(STORAGE_KEY_PREFIX + id);
      }
    } catch (err) {
      trace.error('project-store:persist-failed', { error: String(err) });
    }
  }
  getDefaultStore().set(projectNameAtom, trimmed);
}
