import { createRoot } from 'react-dom/client';
import { Provider, getDefaultStore } from 'jotai';
import ProjectLoader from './ProjectLoader';
import './styles/globals.css';
import { subscribeBuilderTheme } from './editor/builder-theme';

// Restore the saved builder accent BEFORE the first paint (so a non-default
// theme doesn't flash the stock brass on reload) and keep it in sync with both
// the atom and the light/dark switch thereafter.
subscribeBuilderTheme();

// Bind <Provider> to the global default store so non-React code paths
// (e.g. the dev-only `__e2e` hook in ProjectLoader, mutation queue
// callbacks) can read/write the same atoms React subscribes to. Without
// `store=`, <Provider> creates a fresh scoped store and any
// `getDefaultStore()` call lands on a different instance — atom writes
// from one path become invisible to readers on the other.
createRoot(document.getElementById('root')!).render(
  <Provider store={getDefaultStore()}>
    <ProjectLoader />
  </Provider>
);
