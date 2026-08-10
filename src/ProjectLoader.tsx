// ProjectLoader.tsx — Async project initialization wrapper.
// Runs before <App /> is shown: loads user + project from backend,
// hydrates ProjectFS, and redirects to sign-in if unauthenticated (cloud).

import { useState, useEffect } from 'react';
import { CLOUD_ENABLED } from '@/shared/cloud-flag';
import { useSetAtom, getDefaultStore } from 'jotai';
import App from './App';
import RemixWorkspacePicker from './RemixWorkspacePicker';
import { backend } from './backend';
import { getProjectId } from './backend/project-id';
import { userAtom } from './backend/user-store';
import { projectFS, syncBuiltInCodeComponents, createEmptyProject } from './code/project/project-fs';
import { hydrateCameras } from './canvas/transform';
import { activeFilePathAtom, getPageFromUrl, getCmsFromUrl } from './code/project/active-file-store';
import { healMissingInstanceDataIds } from './code/parsing/heal-data-ids';
import { openCmsEditorAtom } from '@/code/stores/cms-editor-store';
import { trace } from '@/shared/debug-trace';
// Static atom imports for the __e2e test hook. Vite's `await import(...)`
// path resolves modules through HMR's runtime cache; SelectionOverlay's
// static import goes through the regular module graph. Mixing the two
// gives us two distinct atom-object identities, and writes through one
// path are invisible to readers on the other.
import { nodesAtom, selectedIdsAtom } from '@/code/stores/store';
import { interactingViewportIdAtom } from '@/code/stores/viewport-store';
import { overlayEditingIdAtom } from '@/code/stores/overlay-store';
import { shapeEditingIdAtom, groupEditingIdAtom } from '@/code/stores/shape-edit-store';
import { queueMutation, flushNow, setForceRender } from '@/code/mutation/mutation-queue';
import { setClosedSource } from '@/code/stores/closed-source-store';
import { setTemplatePromptArmed, templatePromptDismissKey } from '@/code/stores/fresh-site-store';
import { setViewerMode } from '@/code/stores/viewer-mode-store';
import { setProjectName } from '@/code/stores/project-store';
import { setCredits } from '@/code/stores/credits-store';
import { migrateLegacyLocaleTextOverrides, ensureIntlScaffold } from '@/code/project/translation-ops';
import { migrateCmsLocalization } from '@/code/project/cms-locale-migrate';
import { getI18nConfig } from '@/code/project/locale-ops';
import { openPluginIdAtom } from '@/plugins/registry';

export default function ProjectLoader() {
  const [ready, setReady] = useState(false);
  // When set, a `?remix=` load is paused on the workspace picker — the
  // remix only runs once the user chooses a workspace (see below).
  const [remixPrompt, setRemixPrompt] = useState<{ kind: 'approved' | 'share'; token: string } | null>(null);
  const setUser = useSetAtom(userAtom);
  const setActiveFile = useSetAtom(activeFilePathAtom);
  const openCmsEditor = useSetAtom(openCmsEditorAtom);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      trace.action('project-loader:start');

      // Dev escape hatch: `/builder/noauth` skips the auth flow entirely.
      // Loads an in-memory project (no backend round-trip), no user, no
      // redirect to /auth. Useful for debugging UI / paste / canvas flows
      // without going through the full sign-in chain. The project ID
      // resolves to 'noauth' so any backend save attempt becomes a no-op
      // (the row doesn't exist; PUT 404s harmlessly). All work is
      // transient — refresh the tab and it's gone. Don't ship to prod.
      const isNoAuthRoute =
        typeof window !== 'undefined' &&
        window.location.pathname.split('/').filter(Boolean).includes('noauth');
      if (isNoAuthRoute) {
        trace.action('project-loader:noauth-route');
        projectFS.loadSnapshot(createEmptyProject());
        syncBuiltInCodeComponents(projectFS);
        // Legacy i18n/{locale}.json text overrides → messages/*.json (one-shot,
        // idempotent — localization overhaul Phase 5).
        try { migrateLegacyLocaleTextOverrides(getI18nConfig()); } catch (err) { trace.error('locale-migration-failed', err); }
        // CMS half of the same migration: legacy collection overrides move onto
        // the rows, and existing collection lists gain their locale wrapper.
        try { migrateCmsLocalization(getI18nConfig()); } catch (err) { trace.error('cms-locale-migration-failed', err); }
        try { ensureIntlScaffold(); } catch (err) { trace.error('intl-scaffold-failed', err); }
        setUser(null);
        // Expose the dev introspection hook for E2E tests even in
        // noauth mode — without this, tests that need to peek at
        // projectFS / nodes get nothing back. Same shape as the
        // setup at the bottom of this useEffect; centralised here
        // so the noauth bail-out doesn't skip it.
        if (import.meta.env.DEV) {
          const store = getDefaultStore();
          (window as any).__e2e = {
            readFile: (path: string) => projectFS.readFile(path),
            listFiles: () => projectFS.listFiles(),
            // E2E seeding (noauth only): write a file and open it — lets a
            // headless test build an exact repro state without driving the
            // whole insert/group/variant UI flow.
            writeFile: (path: string, code: string) => { projectFS.writeFile(path, code); },
            openFile: (path: string) => { store.set(activeFilePathAtom, path); },
            selection: () => store.get(selectedIdsAtom),
            // Select + set the interaction viewport (e.g. 'variant-1') so the
            // overlay/resize target a specific tile without click choreography.
            select: (ids: string[], vpId?: string) => {
              store.set(selectedIdsAtom, ids);
              if (vpId) store.set(interactingViewportIdAtom, vpId);
            },
            openOverlay: (id: string | null) => { store.set(overlayEditingIdAtom, id); },
            // Ring-buffer trace access for headless e2e diagnosis — lets a
            // harness read which write paths a gesture took without the
            // DebugToolbar record/save flow.
            traceEntries: (pattern?: string) => {
              const re = pattern ? new RegExp(pattern) : null;
              return trace.getEntries()
                .filter((e: any) => !re || re.test(`${e.category ?? ''}`))
                .map((e: any) => ({ ts: e.ts, c: e.category, d: e.data }));
            },
            nodesSnapshot: () => {
              const map = store.get(nodesAtom);
              const out: Record<string, any> = {};
              map.forEach((n: any, id: string) => {
                out[id] = {
                  parentId: n.parentId ?? null,
                  type: n.type,
                  attrs: n.attrs,
                  isCodeComponent: n.isCodeComponent,
                  isCanvasNode: n.isCanvasNode,
                  componentFile: n.componentFile,
                  children: n.children,
                };
              });
              return out;
            },
            // Open an INSTALLED plugin's window by manifest id — headless plugin
            // e2e can't click through the panels UI to reach the row.
            openPlugin: (id: string) => { store.set(openPluginIdAtom, id); },
            // Enter svg-group isolation (the double-click state) — synthetic
            // pointer sequences don't reliably trigger the isolation drill-down.
            isolateGroupChild: (groupId: string, childId: string) => {
              store.set(groupEditingIdAtom, groupId);
              store.set(selectedIdsAtom, [childId]);
            },
          };
        }
        setReady(true);
        return;
      }

      // 1. Resolve authenticated user
      const user = await backend.getUser();
      trace.action('project-loader:user', { id: user?.id ?? null });

      // 2. Redirect to sign-in if cloud mode and not authenticated.
      //    `/auth` lives in revyme-cloud (reached via dispatcher rewrite).
      //    Pass returnTo so the user lands back here after auth instead
      //    of getting bounced to the dashboard. Earlier this redirected
      //    to `/auth/signin` which doesn't match any route — revyme-
      //    cloud's catch-all then sent them to /dashboard, looking
      //    exactly like the dashboard ate the click.
      if (CLOUD_ENABLED && !user) {
        trace.action('project-loader:redirect-signin');
        const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.replace(`/auth?returnTo=${returnTo}`);
        return;
      }

      if (cancelled) return;

      // 2b. Template remix entry-point.
      //
      // Landing pages link to `/builder/<uuid>?remix=<templateId>` for
      // the "Remix" button. We intercept BEFORE `loadProject(id)` runs
      // because the URL-supplied `<uuid>` doesn't exist yet — the
      // remix endpoint creates a fresh `websites` row owned by the
      // caller (deep-copying template assets, stamping `is_remix` +
      // `remix_template_id` for royalty queries) and returns the
      // canonical id. We then redirect to that real id so the rest of
      // the load runs against the actual website row instead of trying
      // to seed an empty project at a URL nobody can reach.
      //
      // Strip the `?remix=` param after the redirect so a page refresh
      // doesn't re-fire the remix (which would create another new
      // website each time).
      const queryParams = new URLSearchParams(window.location.search);
      const remixId = queryParams.get('remix');
      const remixShareHash = queryParams.get('remix-share');
      if ((remixId || remixShareHash) && user) {
        const kind: 'approved' | 'share' = remixId ? 'approved' : 'share';
        const token = remixId ?? remixShareHash!;
        // Don't remix on load. A remix must be attached to a workspace the
        // user picks — otherwise the new site is owned but workspace-less
        // and never shows in the (workspace-scoped) dashboard. Show the
        // blocking picker instead; it performs the remix with the chosen
        // workspace and redirects to the new website. Bail out of the
        // normal load — no placeholder project is created until then.
        trace.action('project-loader:remix-prompt', { kind, token });
        if (!cancelled) setRemixPrompt({ kind, token });
        return;
      }

      // 3. Load project data + the caller's effective role on this
      //    website. Role drives view-only mode: viewers see the editor
      //    but every write path is gated. Fetched in parallel so role
      //    resolution doesn't add latency on top of the snapshot load.
      const id = getProjectId();
      const [data, role, dbName, closedSource] = await Promise.all([
        backend.loadProject(id),
        backend.getWebsiteRole(id),
        backend.getWebsiteName(id),
        backend.getWebsiteClosedSource(id),
      ]);
      trace.action('project-loader:load', { id, found: !!data, role, dbName, closedSource });
      setViewerMode(role === 'viewer');
      // Closed-source remix: the design is fully editable but the template
      // author chose to hide the source — code panel + popup stay hidden.
      setClosedSource(closedSource);
      // The backend `websites.name` is the canonical, dashboard-visible name.
      // Seed the chip from it so a rename done in the dashboard shows up here
      // (and overrides any stale localStorage cache). Null in local mode →
      // keep the localStorage chip name.
      if (dbName != null) setProjectName(dbName);

      // Fire-and-forget workspace credit fetch — drives the balance the
      // AI chat bars show. Kept off the load critical path: the editor
      // renders immediately, the indicator pops in when this resolves.
      void (async () => {
        const workspaceId = await backend.getWebsiteWorkspaceId(id);
        if (!workspaceId) {
          setCredits(null);
          return;
        }
        const balance = await backend.getCredits(workspaceId);
        setCredits(balance === null ? null : { balance, workspaceId });
      })();

      if (cancelled) return;

      // 4. Hydrate ProjectFS.
      //    - Saved project with files → load that snapshot.
      //    - No files (just-created project from File → New project, or
      //      a new id not yet on the backend) → seed `createEmptyProject()`
      //      so the user sees a blank single-viewport page instead of
      //      whatever the previous project (now stale) left in projectFS.
      const fileCount = data?.files ? Object.keys(data.files).length : 0;
      if (fileCount > 0) {
        projectFS.loadSnapshot(new Map(Object.entries(data!.files)));
        trace.action('project-loader:snapshot-loaded', { fileCount });
      } else {
        projectFS.loadSnapshot(createEmptyProject());
        trace.action('project-loader:seeded-empty', { fileCount: projectFS.listFiles().length });
        // Brand-new cloud website (dashboard creates rows with zero files):
        // arm the "start from a template" prompt so the user can begin from
        // a free marketplace template instead of a blank canvas. Viewers
        // can't remix; an unresolved id can't be applied to; a previous
        // dismissal on this site means they chose to start from scratch.
        if (
          CLOUD_ENABLED && id !== 'local' && role !== 'viewer' &&
          !localStorage.getItem(templatePromptDismissKey(id))
        ) {
          setTemplatePromptArmed(true);
          trace.action('project-loader:template-prompt-armed', { id });
        }
      }

      // 4b. Sync built-in code components to latest templates (ensures new controls like 'upload' are available)
      syncBuiltInCodeComponents(projectFS);
        // Legacy i18n/{locale}.json text overrides → messages/*.json (one-shot,
        // idempotent — localization overhaul Phase 5).
        try { migrateLegacyLocaleTextOverrides(getI18nConfig()); } catch (err) { trace.error('locale-migration-failed', err); }
        // CMS half of the same migration: legacy collection overrides move onto
        // the rows, and existing collection lists gain their locale wrapper.
        try { migrateCmsLocalization(getI18nConfig()); } catch (err) { trace.error('cms-locale-migration-failed', err); }
        try { ensureIntlScaffold(); } catch (err) { trace.error('intl-scaffold-failed', err); }

      // 4c. Restore each file's saved camera (pan/zoom) from `_meta/page-camera.json`
      // into the in-memory cameraStash, and apply the active file's camera on the
      // first render — so a reload lands where you left it.
      hydrateCameras();

      // 5. Store user in atom
      setUser(user);

      // 6. Restore active page from ?page= URL param. Compares against
      // both halves of the home pair so a slug param that resolves to
      // the bare home doesn't trigger a redundant setActiveFile.
      const pageFromUrl = getPageFromUrl();
      if (pageFromUrl !== 'app/page.client.tsx' && pageFromUrl !== 'app/page.tsx' && projectFS.exists(pageFromUrl)) {
        setActiveFile(pageFromUrl);
        trace.action('project-loader:restore-page', { page: pageFromUrl });
      }

      // Self-heal missing instance data-ids on the BOOT-active page — the
      // switchActiveFile heal only covers later switches. Without a data-id
      // the parser assigns `auto_<n>` and every mutation against the node
      // silently no-ops (drag-out reverts on the next parse). Direct FS
      // write is safe here: the mutation queue initializes AFTER load with
      // this file's (healed) content.
      const bootFile = (pageFromUrl !== 'app/page.client.tsx' && pageFromUrl !== 'app/page.tsx' && projectFS.exists(pageFromUrl))
        ? pageFromUrl : 'app/page.client.tsx';
      const bootCode = projectFS.readFile(bootFile);
      if (bootCode) {
        const healedBoot = healMissingInstanceDataIds(bootCode);
        if (healedBoot.code !== bootCode) {
          projectFS.writeFile(bootFile, healedBoot.code);
          trace.action('project-loader:boot-heal-data-ids', { file: bootFile, healed: healedBoot.healed, strippedJunk: healedBoot.strippedJunk });
        }
      }

      // 7. Restore CMS overlay from ?cms= URL param. Item/field set if present;
      //    the overlay's auto-clear timer drops the field highlight after a moment.
      //
      //    The left panel MUST be switched to 'cms' as part of this. App.tsx
      //    enforces "the CMS overlay may only exist while the CMS panel is the
      //    active left panel" with an effect that closes the overlay whenever
      //    that panel isn't selected — and `leftPanelAtom` defaults to
      //    'pages-layers' on a fresh load. Without this line the overlay opened
      //    and was closed again in the same commit, leaving the ?cms=/?item=
      //    params in the URL (the URL sync only runs while the overlay is open)
      //    — reloading an item deep-link showed the plain canvas
      //    (user report 2026-07-25).
      const { slug: cmsSlug, itemId: cmsItem, fieldId: cmsField } = getCmsFromUrl();
      if (cmsSlug) {
        openCmsEditor({ collection: cmsSlug, itemId: cmsItem, fieldId: cmsField });
        trace.action('project-loader:restore-cms', { slug: cmsSlug, itemId: cmsItem, fieldId: cmsField });
      }

      // E2E hook (dev only). Exposes a tiny read-only helper for
      // Playwright tests to assert the in-memory ProjectFS state after
      // a drag — instead of round-tripping through localStorage's
      // debounced save. Read-only on purpose: tests should drive the
      // app through real pointer events, not bypass the mutation queue.
      if (import.meta.env.DEV) {
        // All atom + mutation imports are static (top of file) — see the
        // import block for why. Recapping: dynamic `await import(...)`
        // resolves through Vite's HMR runtime cache and yields a DIFFERENT
        // module instance than the rest of the app's static imports.
        // Atoms (and `getDefaultStore()`) become distinct identities and
        // writes don't propagate to readers.
        const store = getDefaultStore();
        (window as any).__e2e = {
          readFile: (path: string) => projectFS.readFile(path),
          listFiles: () => projectFS.listFiles(),
          selection: () => store.get(selectedIdsAtom),
          // Select + set the interaction viewport (e.g. 'mobile') so the
          // overlay/resize target a specific tile without click choreography.
          // Mirrors the noauth hook above — keep both surfaces in sync.
          select: (ids: string[], vpId?: string) => {
            store.set(selectedIdsAtom, ids);
            if (vpId) store.set(interactingViewportIdAtom, vpId);
            trace.action('e2e:select', { ids, vpId });
          },
          // Enter/exit overlay-edit mode (mirrors the noauth hook).
          openOverlay: (id: string | null) => { store.set(overlayEditingIdAtom, id); },
          // Switch the active file (e.g. open a component master `components/X.tsx`
          // so the viewport list becomes its variants). Mirrors the noauth hook.
          openFile: (path: string) => { store.set(activeFilePathAtom, path); },
          // Open an INSTALLED plugin's window by manifest id (mirrors the noauth
          // hook) — headless plugin e2e can't click through the panels UI.
          openPlugin: (id: string) => { store.set(openPluginIdAtom, id); },
          // Enter svg-group isolation (the double-click state) — mirrors the
          // noauth hook; synthetic pointers can't trigger the drill-down.
          isolateGroupChild: (groupId: string, childId: string) => {
            store.set(groupEditingIdAtom, groupId);
            store.set(selectedIdsAtom, [childId]);
          },
          // Add a variant connection the same way InteractionsTool.handleAdd
          // does (addConnection + refresh's setCode/setVersion + forceCanvasRender)
          // so a test can assert the ArrowConnectors overlay redraws immediately.
          addConnection: async (from: string, to: string, trigger: string) => {
            const cc = await import('@/code/variants/connection-config');
            const stMod = await import('@/code/stores/store');
            const pf = await import('@/code/project/project-fs');
            const nodeOps = await import('@/canvas/node-ops');
            const file = store.get(activeFilePathAtom);
            cc.addConnection(file, from, to, trigger as never, undefined, store.get(stMod.selectedNodeAtom) ?? undefined);
            const c = projectFS.readFile(file);
            if (c) { store.set(stMod.codeAtom, c); store.set(pf.projectVersionAtom, (v: number) => v + 1); }
            requestAnimationFrame(() => nodeOps.forceCanvasRender());
            trace.action('e2e:addConnection', { from, to, trigger, file });
          },
          // Ring-buffer trace access — mirrors the noauth hook above.
          traceEntries: (pattern?: string) => {
            const re = pattern ? new RegExp(pattern) : null;
            return trace.getEntries()
              .filter((e: any) => !re || re.test(`${e.category ?? ''} ${e.name ?? ''} ${e.message ?? ''}`));
          },
          // Snapshot of NodeMap (id → { parentId, type, children, styles, attrs }) for
          // tests that need to assert on parsed structure.
          nodesSnapshot: () => {
            const map = store.get(nodesAtom);
            const out: Record<string, {
              parentId?: string | null;
              type?: string;
              children?: string[];
              styles?: Record<string, string>;
              attrs?: Record<string, string>;
            }> = {};
            map.forEach((n: any, id: string) => {
              out[id] = {
                parentId: n.parentId ?? null,
                type: n.type,
                children: n.children,
                styles: n.styles,
                attrs: n.attrs,
              };
            });
            return out;
          },
          // Shape edit mode programmatic toggle. Used by E2E tests so they
          // don't have to drive double-click + outside-click via real pointer
          // events (which would also exercise the library's pointer logic
          // that's not what the normalization test cares about).
          //
          // SvgEditorOverlay only renders when the shape-edit id ALSO matches
          // the selected id (see SelectionOverlay.tsx) — so set both atoms
          // in lockstep here. Pass `null` to clear both (exit shape edit AND
          // deselect). Pass an id to enter shape edit mode for that node.
          setShapeEditing: (id: string | null) => {
            if (id === null) {
              store.set(shapeEditingIdAtom, null);
              store.set(selectedIdsAtom, []);
            } else {
              store.set(selectedIdsAtom, [id]);
              store.set(shapeEditingIdAtom, id);
            }
          },
          getShapeEditingId: () => store.get(shapeEditingIdAtom),
          // Queue a `replaceSvgInner` mutation and flush. Equivalent to what
          // SvgEditorOverlay does on pointerup commit — direct path swap.
          replaceSvgInner: (nodeId: string, innerJSX: string) => {
            setForceRender();
            queueMutation({ type: 'replaceSvgInner', nodeId, innerJSX });
            flushNow();
          },
          // Simulate the LIBRARY's mid-drag write: `bridge.setInnerHTML`
          // pushes new SVG children to the iframe DOM instantly without
          // touching source. Used by E2E tests to exercise the same
          // imperative-first path the real user's drag follows, so we
          // catch normalization bugs that only surface when source code
          // and iframe DOM diverge during the drag window.
          dragSetSvgInner: (nodeId: string, innerJSX: string) => {
            // Lazy import — `getCanvasBridge` lives in canvas/, which the
            // dev hook should not eagerly pull in for non-canvas pages.
            import('@/canvas/canvas-bridge').then(({ getCanvasBridge }) => {
              getCanvasBridge().setInnerHTML(nodeId, '', innerJSX);
            });
          },
        };
      }

      setReady(true);
      trace.action('project-loader:ready');
    }

    init().catch(err => {
      trace.error('project-loader:init-error', err);
      // Show app anyway so user isn't stuck on blank screen
      if (!cancelled) setReady(true);
    });

    return () => { cancelled = true; };
  }, [setUser, setActiveFile, openCmsEditor]);

  // Remix flow: hold on the workspace picker over a plain backdrop until
  // the user chooses a workspace (or cancels back to the dashboard). The
  // picker performs the remix + redirect itself.
  if (remixPrompt) {
    return (
      <>
        <div style={{ position: 'fixed', inset: 0, background: 'var(--bg-canvas, #1a1a2e)' }} />
        <RemixWorkspacePicker kind={remixPrompt.kind} token={remixPrompt.token} />
      </>
    );
  }

  if (!ready) {
    return <BuilderLoadingShell />;
  }

  // Keep the shell OVERLAID on the mounted App until the canvas has actually
  // painted (first Renderer render-complete) — dropping it at `ready` showed
  // an empty canvas for ~300ms while the sandbox rendered the viewports. The
  // shell fades out over the fully-drawn page instead.
  return (
    <>
      <App />
      <CanvasReadyShellOverlay />
    </>
  );
}

function CanvasReadyShellOverlay() {
  const [phase, setPhase] = useState<'waiting' | 'fading' | 'done'>('waiting');
  useEffect(() => {
    let cancelled = false;
    const finish = () => {
      // One extra frame so the just-completed render is actually painted
      // before the shell starts fading.
      requestAnimationFrame(() => { if (!cancelled) setPhase('fading'); });
    };
    window.addEventListener('revyme:render-complete', finish, { once: true });
    // Failsafe: an empty project may render before the listener attaches (or
    // never emit) — never trap the user behind the shell.
    const failsafe = setTimeout(finish, 4000);
    trace.action('project-loader:shell-overlay-waiting', {});
    return () => {
      cancelled = true;
      window.removeEventListener('revyme:render-complete', finish);
      clearTimeout(failsafe);
    };
  }, []);
  useEffect(() => {
    if (phase !== 'fading') return;
    trace.action('project-loader:shell-overlay-fade', {});
    const t = setTimeout(() => setPhase('done'), 280);
    return () => clearTimeout(t);
  }, [phase]);
  if (phase === 'done') return null;
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100000, pointerEvents: phase === 'fading' ? 'none' : 'auto',
      opacity: phase === 'fading' ? 0 : 1, transition: 'opacity 260ms ease',
    }}>
      <BuilderLoadingShell />
    </div>
  );
}

// ─── Loading shell ──────────────────────────────────────────────────────────
// Simulated editor chrome (header + icon rail + left panel + right panel at
// their real widths/colors, empty with pulsing placeholders) around a center
// spinner — the builder visibly "is there" while the project loads, instead
// of a bare Loading… label.

function BuilderLoadingShell() {
  const surface = 'var(--bg-surface, #16161d)';
  const border = '1px solid var(--border-light, rgba(255,255,255,0.08))';
  const ph = (w: number | string, h: number, r = 6): React.CSSProperties => ({
    width: w, height: h, borderRadius: r,
    background: 'var(--bg-hover, rgba(255,255,255,0.06))',
    animation: 'rvy-shell-pulse 1.4s ease-in-out infinite',
  });
  const sep: React.CSSProperties = { width: 1, height: 26, background: 'var(--border-light, rgba(255,255,255,0.08))', margin: '0 4px' };
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--bg-canvas, #1a1a2e)', fontFamily: 'Inter, sans-serif', overflow: 'hidden' }}>
      <style>{`
        @keyframes rvy-shell-pulse { 0%, 100% { opacity: 0.5; } 50% { opacity: 1; } }
      `}</style>

      {/* Top-left header — 52px tall, 52+256 wide, real logo already loaded */}
      <div style={{ position: 'absolute', top: 0, left: 0, width: 308, height: 52, background: surface, borderBottom: border, borderRight: border, display: 'flex', alignItems: 'center' }}>
        <div style={{ width: 51, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 779.79 1578.33" width={14} height={22} style={{ color: 'var(--text-primary, #eee)' }}>
            <polygon fill="currentColor" points="0 0 0 464.88 779.79 922.26 779.79 461.13 0 0" />
            <polygon fill="currentColor" points="779.79 1357.14 0 899.76 0 1357.14 408.64 1578.33 779.79 1357.14" />
            <polygon fill="currentColor" points="402.21 700.79 402.21 1135.67 779.79 922.26 402.21 700.79" />
          </svg>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 12 }}>
          <div style={ph(90, 12)} />
          <div style={ph(44, 12)} />
        </div>
      </div>

      {/* Icon rail — w-52, px-10 py-16, 32px buttons gap-8; bottom: 20px rule,
          28px + circle, 28px avatar circle (CollaboratorsSection geometry). */}
      <div style={{ position: 'absolute', top: 52, bottom: 0, left: 0, width: 52, background: surface, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', alignItems: 'center', padding: '16px 10px', borderRight: border }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (
            <div key={i} style={{ ...ph(32, 32, 6), animationDelay: `${i * 80}ms` }} />
          ))}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 20, height: 1, background: 'var(--border-light, rgba(255,255,255,0.08))' }} />
          <div style={{ ...ph(28, 28, 14), animationDelay: '200ms' }} />
          <div style={{ ...ph(28, 28, 14), animationDelay: '300ms' }} />
        </div>
      </div>

      {/* Left panel — 256px, empty surface */}
      <div style={{ position: 'absolute', top: 52, bottom: 0, left: 52, width: 256, background: surface, borderRight: border }} />

      {/* Bottom toolbar — same geometry as the real pill (see BottomToolbar) */}
      <div style={{ position: 'fixed', bottom: 14, left: '50%', transform: 'translateX(-50%)' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 2,
          background: surface, border,
          borderRadius: 12, padding: '6px 8px',
          boxShadow: '0 8px 30px rgba(0,0,0,0.35)',
        }}>
          <div style={{ ...ph(48, 32, 8) }} />
          <div style={{ ...ph(34, 32, 8), animationDelay: '90ms' }} />
          <div style={{ ...ph(34, 32, 8), animationDelay: '180ms' }} />
          <div style={{ ...ph(48, 32, 8), animationDelay: '270ms' }} />
          <div style={{ ...ph(48, 32, 8), animationDelay: '360ms' }} />
          <div style={sep} />
          <div style={{ ...ph(52, 32, 8), animationDelay: '450ms' }} />
          <div style={sep} />
          <div style={{ ...ph(64, 32, 8), animationDelay: '540ms' }} />
          <div style={{ ...ph(56, 32, 8), animationDelay: '630ms' }} />
          <div style={sep} />
          <div style={{ ...ph(34, 32, 8), animationDelay: '720ms' }} />
          <div style={{ ...ph(34, 32, 8), animationDelay: '810ms' }} />
          <div style={sep} />
          <div style={{ ...ph(72, 32, 8), animationDelay: '900ms' }} />
        </div>
      </div>

      {/* Right panel — empty surface (PropertiesPanel width) */}
      <div style={{ position: 'absolute', top: 0, bottom: 0, right: 0, width: 260, background: surface, borderLeft: border }} />
    </div>
  );
}
