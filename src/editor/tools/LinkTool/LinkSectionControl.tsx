// LinkSectionControl.tsx — Dropdown for selecting an anchor/section on the linked page.
// For same-page links (href="#section"), reads anchors from the current active file.

import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { ToolSelect, ControlLabel } from '../../controls';
import { getAnchorsForPage, slugToPageFile } from './LinkUrlControl';
import { activeFilePathAtom, getPageSlug } from '@/code/project/active-file-store';
import { trace } from '@/shared/debug-trace';

interface LinkSectionControlProps {
  /** The page slug from the href (e.g. "/about" or "/" for same-page) */
  pageSlug: string;
  /** Current section/anchor value */
  value: string;
  /** Called with the anchor name (without #) */
  onChange: (section: string) => void;
}

export default function LinkSectionControl({ pageSlug, value, onChange }: LinkSectionControlProps) {
  const activeFilePath = useAtomValue(activeFilePathAtom);

  const anchors = useMemo(() => {
    // Resolve which page's anchors to list. A BARE `#section` (empty slug)
    // means "same page" → the active file. An explicit slug (incl. "/" for
    // home) resolves to that page's FILE — NOT the active file. The old
    // `pageSlug === '/'` shortcut broke on a component master: there the
    // active file is the component, so a "/" link read the master's anchors
    // (none) instead of the home page's. Fall back to the active file only
    // when the slug genuinely IS the active page.
    const activeSlug = getPageSlug(activeFilePath);
    const filePath = !pageSlug
      ? activeFilePath
      : (slugToPageFile(pageSlug) ?? (pageSlug === activeSlug ? activeFilePath : null));
    if (!filePath) return [];
    return getAnchorsForPage(filePath);
  }, [pageSlug, activeFilePath]);

  trace.fn('LinkSectionControl:render', { pageSlug, value, anchorCount: anchors.length });

  if (anchors.length === 0) return null;

  const options = [
    { value: '', label: 'None' },
    ...anchors.map(a => ({ value: a, label: `#${a}` })),
  ];

  return (
    <div className="flex items-center justify-between w-full">
      <ControlLabel label="Section" property="__link-section" plain />
      <div className="flex items-center gap-2 w-full">
        <ToolSelect
          value={value}
          onChange={(val) => {
            trace.action('link-section:change', { from: value, to: val });
            onChange(val);
          }}
          options={options}
        />
      </div>
    </div>
  );
}
