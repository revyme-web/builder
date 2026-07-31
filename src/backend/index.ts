// index.ts — Backend adapter factory.
// Switches between cloud (RevymeBackend) and local (LocalBackend) based on env var.

import { LocalBackend } from './local-backend';
import { CLOUD_ENABLED } from '@/shared/cloud-flag';
import { RevymeBackend } from './revyme-backend';
export type { ProjectBackend, ProjectData, RevymeUser } from './types';

export const backend = CLOUD_ENABLED
  ? new RevymeBackend()
  : new LocalBackend();
