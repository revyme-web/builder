// plugins/sdk-impl/meta.ts — informational namespaces.
//
// Covers `mode.current`, `user.getCurrentUser`, `project.getProjectInfo`,
// `project.getPublishInfo`. None of these are security-sensitive — they
// describe the runtime context, current user identity, and project
// metadata. Plugins use them for "Hi, $name" headers, project-name
// displays, and to branch logic on `mode === 'server'` (when the
// Server API parity ships).

import type { RpcHandler } from '../plugin-types';
import type { ProjectInfo, PublishInfo, RuntimeMode, User } from '@revyme/plugin-sdk';

export const metaHandlers: Record<string, RpcHandler> = {
  'mode.current': async (): Promise<RuntimeMode> => 'canvas',

  // Pass 1 placeholder — auth ships in a later pass. Returns a generic
  // "Local User" identity so plugins that show "Hi, $name" render
  // sensibly without crashing.
  'user.getCurrentUser': async (): Promise<User> => ({
    id: 'local-user',
    name: 'Local User',
    avatarUrl: null,
    initials: 'LU',
  }),

  'project.getProjectInfo': async (): Promise<ProjectInfo> => ({
    name: 'Revyme Project',
    id: 'project-' + (typeof location !== 'undefined' ? location.host : 'local'),
  }),

  'project.getPublishInfo': async (): Promise<PublishInfo> => ({
    url: null,
    publishedAt: null,
  }),
};
