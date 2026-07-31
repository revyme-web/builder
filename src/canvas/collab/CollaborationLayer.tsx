// CollaborationLayer.tsx — Mounts inside CollaborationProvider. Drives
// the broadcast loops (cursor + selection) and renders the cursor
// overlay. Bundled into a single component so App.tsx only has one
// mount point to worry about.

import { useCollaborationCursor } from './useCollaborationCursor';
import { useCollaborationSelection } from './useCollaborationSelection';
import CollaboratorCursors from './CollaboratorCursors';

export default function CollaborationLayer() {
  useCollaborationCursor();
  useCollaborationSelection();
  return <CollaboratorCursors />;
}
