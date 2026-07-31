// OnboardingTutorial.tsx — first-run product tour.
//
// Pixel-perfect port of the old builder's
// `revyme-old/builder/src/builder/view/onboarding/OnboardingTutorial.tsx`.
// The modal / overlay-cutout / highlight UI is reproduced verbatim; only the
// step TARGETS and the panel-open callbacks were retargeted to Revyme's
// chrome (BottomToolbar, LeftMenu, LeftPanel, RightHeader, PropertiesPanel).
//
// Shows once on first load (localStorage gate). Steps point at elements
// tagged with `data-tutorial="<id>"`; the overlay cuts a rounded hole around
// the target and a card explains it.
//
// Revyme adaptations vs the old builder:
//  - icons are inline SVGs (no `lucide-react` dependency)
//  - `motion/react` → `framer-motion` (the convention in this repo)
//  - panel open/close goes through `leftPanelAtom` (Jotai default store)
//    instead of the old `interfaceOps`
//  - the old "ghost element" hack for the Style Panel step is dropped —
//    creating a node here would write a real code mutation into the user's
//    project. The step just highlights the always-present properties panel.

import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { getDefaultStore } from 'jotai';
import { leftPanelAtom, type LeftPanelId } from '@/code/stores/left-panel-store';
import { selectedIdsAtom, nodesAtom } from '@/code/stores/store';
import { trace } from '@/shared/debug-trace';

const STORAGE_KEY = 'revyme-onboarding-completed';

// Global flag — other components can read it to disable click-outside
// handlers while the tour owns the screen.
let isTutorialActive = false;

// ─── Inline icons (lucide-equivalent) ───────────────────────────────────────
// Standard lucide render: 24×24 viewBox, stroke currentColor, width 2,
// round caps/joins. Sized via className (w-4/w-3) exactly like the old
// `lucide-react` imports.

const XIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const ChevronRightIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 18 15 12 9 6" />
  </svg>
);

const ChevronLeftIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 18 9 12 15 6" />
  </svg>
);

// ─── Panel helper ───────────────────────────────────────────────────────────
// The old builder toggled panels via `interfaceOps`. Revyme's left panel
// is a single Jotai atom — set it directly on the default store.
const openPanel = (id: LeftPanelId) => {
  getDefaultStore().set(leftPanelAtom, id);
};

// ─── Style Panel step helper ────────────────────────────────────────────────
// The properties panel only fills with controls when a node is selected. On
// the "Style Panel" step, if the canvas has nothing selected, auto-pick a real
// element so the step shows live controls instead of an empty panel. The empty
// selection is restored on leave so the tour doesn't strand a node selected.
let autoSelectedForStylePanel = false;

const selectElementForStylePanel = () => {
  const store = getDefaultStore();
  // User already has something selected → the panel is already populated.
  if (store.get(selectedIdsAtom).length > 0) return;
  const nodes = store.get(nodesAtom);
  // Prefer a nested content element (one with a parent) over a viewport root.
  let pick: string | null = null;
  for (const node of nodes.values()) {
    if (node.parentId) { pick = node.id; break; }
  }
  if (!pick) {
    const first = nodes.keys().next();
    if (!first.done) pick = first.value;
  }
  if (pick) {
    store.set(selectedIdsAtom, [pick]);
    autoSelectedForStylePanel = true;
    trace.action('onboarding:style-panel-autoselect', { nodeId: pick });
  }
};

const clearStylePanelSelection = () => {
  if (autoSelectedForStylePanel) {
    getDefaultStore().set(selectedIdsAtom, []);
    autoSelectedForStylePanel = false;
  }
};

interface TutorialStep {
  id: string;
  title: string;
  description: string;
  // Optional image to display below the description
  image?: string;
  // Target element(s) - use data-tutorial="id" attribute on the element(s)
  // Can be a single target or array of targets (will combine bounding boxes)
  target?: string | string[];
  // Secondary target to highlight separately (e.g., a button that opens the main target)
  secondaryTarget?: string;
  // Target for card positioning (if different from highlight target)
  // Useful when you want the card to stay in one place while highlight moves
  cardTarget?: string;
  // Position relative to target element
  position?: 'top' | 'bottom' | 'left' | 'right';
  // Offset from target
  offset?: { x: number; y: number };
  // Callback when entering this step (e.g., to open panels)
  onEnter?: () => void;
  // Callback when leaving this step (e.g., to close panels)
  onLeave?: () => void;
}

// Default tutorial steps — retargeted to Revyme chrome.
const DEFAULT_STEPS: TutorialStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to Revyme',
    description: 'Let us show you around the builder. You can skip this tutorial at any time.',
    image: '/tutorial_images/welcome.jpg',
  },
  {
    id: 'frame-tool',
    title: 'Frame Tool',
    description: 'Draw containers, sections, and create hierarchies. Frames are the building blocks of your design. Press F to activate.',
    image: '/tutorial_images/frame.png',
    target: 'frame-tool',
    position: 'top',
  },
  {
    id: 'text-tool',
    title: 'Text Tool',
    description: 'Add text elements to your design. Click and drag to create a text box, then start typing. Press T to activate.',
    image: '/tutorial_images/text.png',
    target: 'text-tool',
    position: 'top',
  },
  {
    id: 'shape-tool',
    title: 'Shapes',
    description: 'Draw shapes like rectangles, circles, triangles, and custom paths. Great for decorative elements and icons.',
    image: '/tutorial_images/shapes.png',
    target: 'shape-tool',
    position: 'top',
  },
  {
    id: 'search-tool',
    title: 'Quick Search',
    description: 'Search for elements, actions, and commands. Press ⌘K (or Ctrl+K) to open the command palette.',
    image: '/tutorial_images/search.png',
    target: 'search-tool',
    position: 'top',
  },
  {
    id: 'theme-tool',
    title: 'Theme Switcher',
    description: 'Toggle between light and dark mode for your website design. This affects how your presets render.',
    image: '/tutorial_images/theme.png',
    target: 'theme-tool',
    position: 'top',
  },
  {
    id: 'comment-tool',
    title: 'Comments',
    description: 'Add comments to your design for collaboration and feedback. Click anywhere on the canvas to leave a note.',
    image: '/tutorial_images/comments.png',
    target: 'comment-tool',
    position: 'top',
  },
  {
    id: 'insert-panel',
    title: 'Insert Panel',
    description: 'Click the + button to browse elements, components, and pre-made sections. Drag and drop anything directly onto your canvas.',
    target: 'left-panel',
    secondaryTarget: 'insert-button',
    position: 'right',
    onEnter: () => openPanel('insert'),
    onLeave: () => openPanel('pages-layers'),
  },
  {
    id: 'pages',
    title: 'Pages',
    description: 'Manage your website pages — add, rename, reorder, and navigate between every page of your site from one place.',
    target: 'left-panel',
    secondaryTarget: 'pages-layers-button',
    position: 'right',
    onEnter: () => openPanel('pages-layers'),
  },
  {
    id: 'layers',
    title: 'Layers',
    description: 'View the layer hierarchy of the current page. Select, rename, and reorder every element on your canvas straight from the tree.',
    target: 'left-panel',
    secondaryTarget: 'layers-button',
    position: 'right',
    onEnter: () => openPanel('layers'),
  },
  {
    id: 'library',
    title: 'Library',
    description: 'Your reusable building blocks live here — Components, Vectors, Templates, and Plugins. Build something once and drag it onto any page; edit the original and every copy updates automatically. You can also publish a component to a public link and share it with the world — anyone can paste that link to drop your component straight into their own project.',
    image: '/tutorial_images/components.png',
    target: 'left-panel',
    secondaryTarget: 'library-button',
    position: 'right',
    offset: { x: 0, y: 80 },
    onEnter: () => openPanel('library'),
  },
  {
    id: 'library-presets',
    title: 'Presets',
    description: 'Create reusable styles for typography, colors, images, borders, shadows, and spacing. Apply consistent styling across your entire website with one click.',
    target: 'left-panel',
    secondaryTarget: 'presets-button',
    position: 'right',
    onEnter: () => openPanel('presets'),
  },
  {
    id: 'media',
    title: 'Media Gallery',
    description: 'All your images and media live in one place. Upload an asset once, then reuse it across every page — drag it straight onto the canvas whenever you need it.',
    target: 'left-panel',
    secondaryTarget: 'media-button',
    position: 'right',
    onEnter: () => openPanel('media'),
    onLeave: () => openPanel('pages-layers'),
  },
  {
    id: 'localization',
    title: 'Localization',
    description: 'Add multiple languages to your website. Translate content and manage different locale versions of your pages for international audiences.',
    target: 'left-panel',
    secondaryTarget: 'locale-button',
    position: 'right',
    onEnter: () => openPanel('locale'),
    onLeave: () => openPanel('pages-layers'),
  },
  {
    id: 'cms',
    title: 'CMS',
    description: 'Build a blog or any content collection. Define your fields once, then add entries — your design renders every entry automatically. Great for blog posts, products, team members, and more.',
    target: 'left-panel',
    secondaryTarget: 'cms-button',
    position: 'right',
    onEnter: () => openPanel('cms'),
    onLeave: () => openPanel('pages-layers'),
  },
  {
    id: 'right-toolbar',
    title: 'Style Panel',
    description: 'Select any element to customize its appearance. Adjust position, dimensions, layout, animations, colors, borders, shadows, and more.',
    target: 'right-toolbar',
    position: 'left',
    onEnter: () => { openPanel('pages-layers'); selectElementForStylePanel(); },
    onLeave: clearStylePanelSelection,
  },
  {
    id: 'header-settings',
    title: 'Settings',
    description: 'Configure your website settings including SEO, custom code, favicon, and domain. Manage your subscription plan and billing from here.',
    target: 'header-settings-button',
    position: 'bottom',
  },
  {
    id: 'header-export',
    title: 'Export',
    description: 'Export your website as production-ready React code. Download a ZIP file with all components, styles, and assets ready to deploy anywhere.',
    target: 'header-export-button',
    cardTarget: 'header-settings-button', // Keep card in same position as Settings
    position: 'bottom',
  },
  {
    id: 'header-preview',
    title: 'Preview',
    description: 'Preview your website exactly as visitors will see it. Test responsiveness across desktop, tablet, and mobile viewports before publishing.',
    target: 'header-preview-button',
    cardTarget: 'header-settings-button', // Keep card in same position as Settings
    position: 'bottom',
  },
  {
    id: 'header-publish',
    title: 'Publish',
    description: 'Make your website live with one click. Get a free revyme.app subdomain or connect your custom domain. Updates sync instantly when you publish again.',
    target: 'header-publish-button',
    cardTarget: 'header-settings-button', // Keep card in same position as Settings
    position: 'bottom',
  },
];

interface OnboardingTutorialProps {
  steps?: TutorialStep[];
  onComplete?: () => void;
}

export const OnboardingTutorial: React.FC<OnboardingTutorialProps> = ({
  steps = DEFAULT_STEPS,
  onComplete,
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [bubblePosition, setBubblePosition] = useState<{ top?: number; bottom?: number; left: number } | null>(null);
  const [mounted, setMounted] = useState(false);

  const currentStep = steps[currentStepIndex];
  const isFirstStep = currentStepIndex === 0;
  const isLastStep = currentStepIndex === steps.length - 1;

  // Check localStorage on mount
  useEffect(() => {
    setMounted(true);
    const completed = localStorage.getItem(STORAGE_KEY);
    if (!completed) {
      const timer = setTimeout(() => {
        trace.action('onboarding:auto-start');
        setIsVisible(true);
      }, 500);
      return () => clearTimeout(timer);
    }
  }, []);

  // Update global tutorial active flag
  useEffect(() => {
    isTutorialActive = isVisible;
    return () => {
      isTutorialActive = false;
    };
  }, [isVisible]);

  // Listen for manual trigger event (from dev tools)
  useEffect(() => {
    const handleStartTutorial = () => {
      trace.action('onboarding:manual-start');
      setCurrentStepIndex(0);
      setIsVisible(true);
    };

    window.addEventListener('startOnboardingTutorial', handleStartTutorial);
    return () => window.removeEventListener('startOnboardingTutorial', handleStartTutorial);
  }, []);

  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const [secondaryTargetRect, setSecondaryTargetRect] = useState<DOMRect | null>(null);
  const [isWobbling, setIsWobbling] = useState(false);

  // Wobble animation when clicking outside
  const handleOutsideClick = useCallback(() => {
    setIsWobbling(true);
    setTimeout(() => setIsWobbling(false), 300);
  }, []);

  // Call onEnter/onLeave callbacks when step changes
  useEffect(() => {
    if (!isVisible || !currentStep) return;

    trace.action('onboarding:step', { id: currentStep.id, index: currentStepIndex });
    // Call onEnter for current step
    currentStep.onEnter?.();

    return () => {
      // Call onLeave when leaving this step
      currentStep.onLeave?.();
    };
  }, [isVisible, currentStepIndex]);

  // Calculate bubble position based on target element(s)
  useEffect(() => {
    if (!isVisible || !currentStep) return;

    const calculatePosition = () => {
      if (!currentStep.target) {
        setBubblePosition(null);
        setTargetRect(null);
        setSecondaryTargetRect(null);
        return;
      }

      // Support single target or array of targets
      const targets = Array.isArray(currentStep.target) ? currentStep.target : [currentStep.target];

      // Get all target elements and their bounding rects
      const rects: DOMRect[] = [];
      for (const target of targets) {
        const targetEl = document.querySelector(`[data-tutorial="${target}"]`);
        if (targetEl) {
          rects.push(targetEl.getBoundingClientRect());
        }
      }

      if (rects.length === 0) {
        setBubblePosition(null);
        setTargetRect(null);
        setSecondaryTargetRect(null);
        return;
      }

      // Combine all rects into one bounding box
      const rect = rects.reduce((combined, r) => {
        const left = Math.min(combined.left, r.left);
        const top = Math.min(combined.top, r.top);
        const right = Math.max(combined.right, r.right);
        const bottom = Math.max(combined.bottom, r.bottom);
        return new DOMRect(left, top, right - left, bottom - top);
      }, rects[0]);
      setTargetRect(rect);

      // Calculate secondary target rect if specified
      if (currentStep.secondaryTarget) {
        const secondaryEl = document.querySelector(`[data-tutorial="${currentStep.secondaryTarget}"]`);
        if (secondaryEl) {
          setSecondaryTargetRect(secondaryEl.getBoundingClientRect());
        } else {
          setSecondaryTargetRect(null);
        }
      } else {
        setSecondaryTargetRect(null);
      }

      // Use cardTarget for positioning if specified, otherwise use target rect
      let cardRect = rect;
      if (currentStep.cardTarget) {
        const cardTargetEl = document.querySelector(`[data-tutorial="${currentStep.cardTarget}"]`);
        if (cardTargetEl) {
          cardRect = cardTargetEl.getBoundingClientRect();
        }
      }

      const offset = currentStep.offset || { x: 0, y: 0 };
      const position = currentStep.position || 'right';
      const modalWidth = 320; // w-80 = 320px
      // Estimate modal height - add extra height if step has an image
      const baseModalHeight = 180;
      const imageHeight = currentStep.image ? 160 : 0; // approximate image height
      const modalHeight = baseModalHeight + imageHeight;
      const gap = 16;

      let top: number | undefined;
      let bottom: number | undefined;
      let left = 0;

      switch (position) {
        case 'top':
          // Use bottom positioning so cards expand upward, anchored at a consistent bottom edge
          bottom = window.innerHeight - cardRect.top + gap + 8 - offset.y; // extra 8px for highlight border
          left = cardRect.left + cardRect.width / 2 - modalWidth / 2 + offset.x;
          break;
        case 'bottom':
          top = cardRect.bottom + gap + 8 + offset.y; // extra 8px for highlight border
          left = cardRect.left + cardRect.width / 2 - modalWidth / 2 + offset.x;
          break;
        case 'left':
          top = cardRect.top + cardRect.height / 2 - modalHeight / 2 + offset.y;
          left = cardRect.left - modalWidth - gap - 8 + offset.x; // extra 8px for highlight border
          break;
        case 'right':
          top = cardRect.top + cardRect.height / 2 - modalHeight / 2 + offset.y;
          left = cardRect.right + gap + 8 + offset.x; // extra 8px for highlight border
          break;
      }

      setBubblePosition({ top, bottom, left });
    };

    calculatePosition();
    // Recalculate after delays to handle dynamically opened panels/toolbars
    const delayedRecalculate1 = setTimeout(calculatePosition, 100);
    const delayedRecalculate2 = setTimeout(calculatePosition, 300);
    const delayedRecalculate3 = setTimeout(calculatePosition, 500);
    window.addEventListener('resize', calculatePosition);
    window.addEventListener('scroll', calculatePosition, true);
    return () => {
      clearTimeout(delayedRecalculate1);
      clearTimeout(delayedRecalculate2);
      clearTimeout(delayedRecalculate3);
      window.removeEventListener('resize', calculatePosition);
      window.removeEventListener('scroll', calculatePosition, true);
    };
  }, [isVisible, currentStep]);

  const handleClose = useCallback(() => {
    trace.action('onboarding:close', { stepId: currentStep?.id });
    // Call onLeave for current step before closing
    currentStep?.onLeave?.();
    setIsVisible(false);
    onComplete?.();
  }, [onComplete, currentStep]);

  const handleNeverShowAgain = useCallback(() => {
    trace.action('onboarding:never-show-again', { stepId: currentStep?.id });
    // Call onLeave for current step before closing
    currentStep?.onLeave?.();
    localStorage.setItem(STORAGE_KEY, 'true');
    setIsVisible(false);
    onComplete?.();
  }, [onComplete, currentStep]);

  const handleNext = useCallback(() => {
    if (isLastStep) {
      trace.action('onboarding:complete');
      // Call onLeave for current step before closing
      currentStep?.onLeave?.();
      // Reaching the end via "Get Started" counts as completing the tour —
      // persist it so the tutorial doesn't reappear next session. (Closing
      // early with the X still leaves it un-set so it can re-show.)
      localStorage.setItem(STORAGE_KEY, 'true');
      setIsVisible(false);
      onComplete?.();
    } else {
      setCurrentStepIndex((prev) => prev + 1);
    }
  }, [isLastStep, onComplete, currentStep]);

  const handlePrev = useCallback(() => {
    if (!isFirstStep) {
      setCurrentStepIndex((prev) => prev - 1);
    }
  }, [isFirstStep]);

  if (!mounted || !isVisible || !currentStep) return null;

  // Combine target and secondary target rects for the overlay cutout
  const overlayCutoutRect = (() => {
    if (!targetRect && !secondaryTargetRect) return null;
    if (!secondaryTargetRect) return targetRect;
    if (!targetRect) return secondaryTargetRect;
    // Combine both rects
    const left = Math.min(targetRect.left, secondaryTargetRect.left);
    const top = Math.min(targetRect.top, secondaryTargetRect.top);
    const right = Math.max(targetRect.right, secondaryTargetRect.right);
    const bottom = Math.max(targetRect.bottom, secondaryTargetRect.bottom);
    return new DOMRect(left, top, right - left, bottom - top);
  })();

  // Step card — the centered (no target) and positioned (target) variants
  // below render the exact same card; only the outer className and inline
  // style differ. Plain function (not a component) so the element tree is
  // unchanged.
  const renderStepCard = (cardClassName: string, cardStyle?: React.CSSProperties) => (
    <motion.div
      key={currentStepIndex}
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{
        opacity: 1,
        scale: 1,
        x: isWobbling ? [0, -3, 3, -2, 2, 0] : 0,
      }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{
        duration: 0.15,
        ease: "easeOut",
        x: isWobbling ? { duration: 0.3, ease: "easeInOut" } : { duration: 0 },
      }}
      className={cardClassName}
      style={cardStyle}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-light)]">
        <motion.h3
          key={currentStepIndex}
          initial={{ opacity: 0, x: -10 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.2 }}
          className="text-xs font-bold text-[var(--text-primary)]"
        >
          {currentStep.title}
        </motion.h3>
        <button
          onClick={handleClose}
          className="p-1 hover:bg-[var(--bg-hover)] rounded-md transition-colors"
        >
          <XIcon className="w-4 h-4 text-[var(--text-secondary)]" />
        </button>
      </div>

      {/* Content */}
      <div className="p-4">
        {/* Step indicator with sliding animation */}
        {steps.length > 1 && (
          <div className="flex gap-1 mb-3 relative">
            {steps.map((_, index) => (
              <div
                key={index}
                className="h-1 flex-1 rounded-full bg-[var(--border-light)] relative overflow-hidden"
              >
                {index === currentStepIndex && (
                  <motion.div
                    layoutId="progress-indicator"
                    className="absolute inset-0 bg-[var(--accent)] rounded-full"
                    transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
                  />
                )}
              </div>
            ))}
          </div>
        )}

        <motion.p
          key={currentStepIndex}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, delay: 0.1 }}
          className="text-[11px] text-[var(--text-secondary)] leading-relaxed mb-4"
        >
          {currentStep.description}
        </motion.p>

        {/* Optional image */}
        {currentStep.image && (
          <motion.img
            key={`img-${currentStepIndex}`}
            src={currentStep.image}
            alt=""
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.2, delay: 0.15 }}
            className="w-full mb-4 rounded-lg"
          />
        )}

        {/* Actions */}
        <div className="flex items-center justify-between">
          <button
            onClick={handleNeverShowAgain}
            className="text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"
          >
            Don't show again
          </button>

          <div className="flex gap-2">
            {!isFirstStep && (
              <button
                onClick={handlePrev}
                className="flex items-center gap-1 px-3 py-1.5 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] rounded-md transition-colors"
              >
                <ChevronLeftIcon className="w-3 h-3" />
                Back
              </button>
            )}
            <button
              onClick={handleNext}
              className="flex items-center gap-1 px-4 py-1.5 text-[11px] text-white bg-[var(--accent)] hover:opacity-90 rounded-md transition-opacity"
            >
              {isLastStep ? 'Get Started' : 'Next'}
              {!isLastStep && <ChevronRightIcon className="w-3 h-3" />}
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  );

  const content = (
    <AnimatePresence>
      {isVisible && (
        <div className="fixed inset-0 z-[99999] flex items-center justify-center">
          {/* Dark overlay with rounded cutout using box-shadow */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute cursor-not-allowed"
            onClick={handleOutsideClick}
            style={{
              top: overlayCutoutRect ? overlayCutoutRect.top - 8 : 0,
              left: overlayCutoutRect ? overlayCutoutRect.left - 8 : 0,
              width: overlayCutoutRect ? overlayCutoutRect.width + 16 : '100%',
              height: overlayCutoutRect ? overlayCutoutRect.height + 16 : '100%',
              borderRadius: overlayCutoutRect ? '12px' : '0px',
              boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.5)',
              backgroundColor: overlayCutoutRect ? 'transparent' : 'rgba(0, 0, 0, 0.5)',
            }}
          />

          {/* Highlight border around target - blocks clicks on target too */}
          {targetRect && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={handleOutsideClick}
              className="absolute rounded-md cursor-not-allowed"
              style={{
                top: targetRect.top - 4,
                left: targetRect.left - 4,
                width: targetRect.width + 8,
                height: targetRect.height + 8,
                border: '2px solid var(--accent)',
                boxShadow: '0 0 0 4px rgba(var(--accent-rgb, 59, 130, 246), 0.2)',
              }}
            />
          )}

          {/* Secondary highlight border (e.g., for the + button) */}
          {secondaryTargetRect && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={handleOutsideClick}
              className="absolute rounded-md cursor-not-allowed"
              style={{
                top: secondaryTargetRect.top - 4,
                left: secondaryTargetRect.left - 4,
                width: secondaryTargetRect.width + 8,
                height: secondaryTargetRect.height + 8,
                border: '2px solid var(--accent)',
                boxShadow: '0 0 0 4px rgba(var(--accent-rgb, 59, 130, 246), 0.2)',
              }}
            />
          )}

          {/* Modal - wrapped in its own AnimatePresence with mode="wait" for smooth transitions */}
          <AnimatePresence mode="wait">
            {/* Centering wrapper for cards without a target */}
            {!currentStep.target && (
              <motion.div
                key="centered-wrapper"
                className="fixed inset-0 flex items-center justify-center pointer-events-none"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                {renderStepCard("w-80 rounded-lg shadow-2xl overflow-hidden bg-[var(--bg-surface)] pointer-events-auto")}
              </motion.div>
            )}

            {/* Positioned modal for cards with a target */}
            {currentStep.target && bubblePosition && renderStepCard(
              "w-80 rounded-lg shadow-2xl overflow-hidden bg-[var(--bg-surface)] fixed",
              {
                top: bubblePosition.top,
                bottom: bubblePosition.bottom,
                left: bubblePosition.left,
              },
            )}
          </AnimatePresence>
        </div>
      )}
    </AnimatePresence>
  );

  return createPortal(content, document.body);
};

// Helper to reset onboarding (for testing)

// Helper to start onboarding tutorial manually
export const startOnboarding = () => {
  window.dispatchEvent(new CustomEvent('startOnboardingTutorial'));
};

