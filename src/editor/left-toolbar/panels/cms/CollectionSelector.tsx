// CollectionSelector.tsx — Combobox that lists every CMS collection and
// switches the CMS editor overlay's active collection when one is picked.
//
// Mirrors the Pages panel's PageSelector: a trigger button showing the
// current collection, and a type-to-filter dropdown. Lives above the
// "Search fields" input in the editor's Fields tab so the user can flip
// between collections without leaving the schema editor. (Dropdown
// skeleton = the shared SearchableDropdown.)

import { useMemo, useCallback } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { collectionSchemasAtom } from '@/code/stores/cms-store';
import { syncUrlToCms } from '@/code/project/active-file-store';
import { CmsIcon } from '@/shared/icons';
import { trace } from '@/shared/debug-trace';
import SearchableDropdown from '../../../ui/SearchableDropdown';
import { cmsEditorCollectionAtom } from '@/code/stores/cms-editor-store';

export default function CollectionSelector() {
  const [activeSlug, setActiveSlug] = useAtom(cmsEditorCollectionAtom);
  const schemas = useAtomValue(collectionSchemasAtom);

  trace.fn('CollectionSelector.render', { activeSlug, count: schemas.size });

  const collections = useMemo(
    () =>
      [...schemas.values()]
        .map(s => ({ slug: s.slug, label: s.name || s.slug }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [schemas],
  );

  const activeLabel = useMemo(() => {
    const m = collections.find(c => c.slug === activeSlug);
    return m ? m.label : (activeSlug ?? 'Select collection');
  }, [activeSlug, collections]);

  const handleSwitch = useCallback(
    (slug: string) => {
      if (slug !== activeSlug) {
        setActiveSlug(slug);
        syncUrlToCms(slug);
        trace.action('collection-selector:switch', { from: activeSlug, to: slug });
      }
    },
    [activeSlug, setActiveSlug],
  );

  return (
    <SearchableDropdown
      items={collections}
      getKey={(c) => c.slug}
      getLabel={(c) => c.label}
      matches={(c, q) => c.label.toLowerCase().includes(q) || c.slug.toLowerCase().includes(q)}
      activeKey={activeSlug}
      triggerLabel={activeLabel}
      triggerIcon={<CmsIcon width={14} height={14} />}
      itemIcon={<CmsIcon width={12} height={12} />}
      placeholder="Search collections…"
      emptyText="No collections match."
      triggerClassName="w-full flex items-center gap-2 px-2 py-1.5 text-xs bg-white/[0.1] hover:bg-white/[0.14] rounded-md text-[var(--text-primary)] outline-none transition-colors"
      inputClassName="w-full px-2 py-1.5 text-xs bg-white/[0.1] hover:bg-white/[0.14] focus:bg-white/[0.18] rounded text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] outline-none transition-colors"
      listClassName="max-h-60 overflow-y-auto py-1"
      onSelect={(c) => handleSwitch(c.slug)}
    />
  );
}
