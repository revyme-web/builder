// plugins/PluginVideoPickerHost.tsx — bridges the `assets.pickVideo` RPC to the
// editor's native VideoSearchModal. A plugin calls `assets.pickVideo()`, whose
// host handler (sdk-impl/assets.ts) dispatches `revyme:plugin-pick-video` with a
// `{ resolve }` detail. This globally-mounted component (App.tsx) opens the SAME
// Pixabay / Upload / URL modal the Fill tool uses and resolves with the chosen
// URL (or null on close). Mirrors the `ui.showContextMenu` render-from-RPC
// pattern. The chosen URL's bytes are fetched by the RPC handler via the backend
// media proxy so cross-origin clips stay decodable in the plugin.

import { useEffect, useRef, useState } from 'react';
import VideoSearchModal from '@/editor/ui/VideoSearchModal';
import { trace } from '@/shared/debug-trace';

type Resolver = (url: string | null) => void;

export default function PluginVideoPickerHost() {
  const [open, setOpen] = useState(false);
  const resolverRef = useRef<Resolver | null>(null);

  useEffect(() => {
    const onPick = (e: Event) => {
      const detail = (e as CustomEvent).detail as { resolve?: Resolver } | undefined;
      if (!detail?.resolve) return;
      // A picker is already open — reject the newcomer so it doesn't hang.
      if (resolverRef.current) { detail.resolve(null); return; }
      resolverRef.current = detail.resolve;
      setOpen(true);
      trace.action('plugin:video-picker:open', {});
    };
    window.addEventListener('revyme:plugin-pick-video', onPick as EventListener);
    return () => window.removeEventListener('revyme:plugin-pick-video', onPick as EventListener);
  }, []);

  const finish = (url: string | null) => {
    resolverRef.current?.(url);
    resolverRef.current = null;
    setOpen(false);
    trace.action('plugin:video-picker:close', { picked: !!url });
  };

  if (!open) return null;
  return (
    <VideoSearchModal
      isOpen={open}
      onClose={() => finish(null)}
      onSelect={(url: string) => finish(url)}
    />
  );
}
