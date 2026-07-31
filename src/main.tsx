import { createRoot } from 'react-dom/client';
import { Provider, getDefaultStore } from 'jotai';
import ProjectLoader from './ProjectLoader';
import './styles/globals.css';

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
