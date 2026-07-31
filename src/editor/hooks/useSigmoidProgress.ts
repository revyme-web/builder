// useSigmoidProgress.ts — Fake-monotonic publish/deploy progress ticker.
//
// 0 → 0.95 over ~25 s on a sigmoid curve so the bar moves fast at the
// start and decelerates as it approaches the asymptote — "looks like
// it's working hard." Real success snaps it to 1.0 (`setProgress(1)`);
// real failure snaps it to 0. We don't model deploy progress because
// vinext doesn't expose any.
//
// Shared RAF harness — used by the header publish button (RightHeader),
// the Backups restore confirm modal, and the Staging deploy/promote
// confirm modal. Imperative API: call `startProgress()` when the request
// fires, `stopProgress()` when it settles, and snap `setProgress(0|1)`
// for the failure/success gesture. The RAF loop is always cancelled on
// unmount.

import { useCallback, useEffect, useRef, useState } from 'react';
import { sigmoidPublishProgress } from '@/editor/header/publish-utils';

export function useSigmoidProgress() {
  const [progress, setProgress] = useState(0);
  // Cleared on unmount and on completion. Holds the fake progress
  // ticker so we can stop it from anywhere.
  const progressRafRef = useRef<number | null>(null);
  const progressStartRef = useRef<number>(0);

  const stopProgress = useCallback(() => {
    if (progressRafRef.current != null) {
      cancelAnimationFrame(progressRafRef.current);
      progressRafRef.current = null;
    }
  }, []);

  const startProgress = useCallback(() => {
    stopProgress();
    progressStartRef.current = performance.now();
    setProgress(0);
    const tick = () => {
      const elapsedSec = (performance.now() - progressStartRef.current) / 1000;
      setProgress(sigmoidPublishProgress(elapsedSec));
      progressRafRef.current = requestAnimationFrame(tick);
    };
    progressRafRef.current = requestAnimationFrame(tick);
  }, [stopProgress]);

  // Always stop the RAF loop on unmount so a mid-flight ticker can't
  // outlive the component. `stopProgress` is idempotent, so callers
  // that also stop it from their own effects are unaffected.
  useEffect(() => () => stopProgress(), [stopProgress]);

  return { progress, setProgress, startProgress, stopProgress };
}
