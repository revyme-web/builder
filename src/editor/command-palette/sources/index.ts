// sources/index.ts — The ordered list of cmd+K search sources.
//
// Adding a source = write the file, add it here. Nothing else in the
// palette needs to change: the registry merges whatever this exports and
// the ranker sorts purely on score + category weight.
//
// Order here is irrelevant to display (CATEGORY_ORDER owns that) but does
// decide who wins an id collision in the registry's dedupe — first write
// wins, so ids are namespaced per source (`cmd:`, `layer:`, `cms:`) and
// collisions shouldn't happen in practice.

import type { SearchSource } from './types';
import { commandsSource } from './commands';
import { drawSource } from './draw';
import { panelsSource } from './panels';
import { librarySource } from './library';
import { pagesSource } from './pages';
import { pluginsSource } from './plugins';
import { projectSource } from './project';
import { appActionsSource } from './app-actions';
import { layersSource } from './layers';
import { cmsSource } from './cms';

export const SEARCH_SOURCES: SearchSource[] = [
  projectSource,
  appActionsSource,
  layersSource,
  librarySource,
  pagesSource,
  cmsSource,
  pluginsSource,
  commandsSource,
  drawSource,
  panelsSource,
];

export type { SearchSource, SourceContext } from './types';
export { MIN_CONTENT_QUERY } from './types';
