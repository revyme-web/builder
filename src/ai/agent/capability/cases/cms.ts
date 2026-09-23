// CMS & collections — audit §5.
import type { CapabilityCase } from '../harness';
import { HOME, BLOG_SCHEMA, BLOG_ITEMS } from '../fixture';

const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
type Item = Record<string, any>;
type Schema = { name: string; slug: string; fields: { id: string; name: string; type: string; options?: string[] }[] };

/** A list container with ONE template row, the shape bind_cms_list expects. */
const LIST_PAGE = (extra = '') => `'use client';

/** @canvas { "viewports": [{ "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 }], "positions": { "desktop": { "x": 0, "y": 0 } } } */

import React from 'react';

export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', height: 'auto', display: 'flex', flexDirection: 'column' }}>
      <div data-id="posts" data-name="Posts" style={{ position: 'relative', width: '100%', height: 'auto', display: 'flex', flexDirection: 'column', gap: '16px', flex: '0 0 auto', order: '0' }}>
        <div data-id="post-row" data-name="Post" style={{ position: 'relative', width: '100%', height: 'auto', display: 'flex', flexDirection: 'column', gap: '8px', flex: '0 0 auto', order: '0' }}>
          <div data-id="post-cover" data-name="Cover" style={{ position: 'relative', width: '100%', height: '200px', flex: '0 0 auto', order: '0' }}></div>
          <h3 data-id="post-title" data-name="Title" style={{ position: 'relative', width: 'auto', height: 'auto', margin: '0px', flex: '0 0 auto', order: '1' }}>Post title</h3>
          <p data-id="post-excerpt" data-name="Excerpt" style={{ position: 'relative', width: 'auto', height: 'auto', margin: '0px', flex: '0 0 auto', order: '2' }}>Post excerpt</p>${extra}
        </div>
      </div>
    </div>
  );
}
`;

export const CMS_CASES: CapabilityCase[] = [
  {
    id: 'cms/create-collection', domain: 'cms', status: 'supported',
    feature: 'Create a collection',
    ask: 'create a Team collection',
    calls: [{ tool: 'cms_create_collection', args: { name: 'Team' } }],
    expect: (w) => must(w.json<Schema>('cms/team.schema.json').name === 'Team', 'no Team schema'),
  },
  {
    id: 'cms/rename-collection', domain: 'cms', status: 'supported',
    feature: 'Rename a collection',
    ask: 'rename the Blog collection to Articles',
    calls: [{ tool: 'cms_rename_collection', args: { collection: 'blog', name: 'Articles' } }],
    expect: (w) => must(w.json<Schema>(BLOG_SCHEMA).name === 'Articles', 'the name did not change'),
  },
  {
    id: 'cms/delete-collection', domain: 'cms', status: 'supported',
    feature: 'Delete a collection',
    ask: 'delete the blog collection',
    calls: [{ tool: 'cms_delete_collection', args: { collection: 'blog' } }],
    expect: (w) => must(w.read(BLOG_SCHEMA) === null && w.read(BLOG_ITEMS) === null, 'the collection files are still there'),
  },
  {
    id: 'cms/add-field', domain: 'cms', status: 'supported',
    feature: 'Add a field (enum with options)',
    ask: 'add a Category field with News, Guides and Releases',
    calls: [{ tool: 'cms_add_field', args: { collection: 'blog', name: 'Category', type: 'enum', options: ['News', 'Guides', 'Releases'] } }],
    expect: (w) => {
      const f = w.json<Schema>(BLOG_SCHEMA).fields.find((x) => x.name === 'Category');
      must(f && f.type === 'enum' && f.options?.length === 3, 'no Category enum field with 3 options');
    },
  },
  {
    id: 'cms/update-field', domain: 'cms', status: 'supported',
    feature: 'Update a field',
    ask: 'rename the Excerpt field to Summary',
    calls: [{ tool: 'cms_update_field', args: { collection: 'blog', field_id: 'excerpt', name: 'Summary' } }],
    expect: (w) => must(w.json<Schema>(BLOG_SCHEMA).fields.find((x) => x.id === 'excerpt')?.name === 'Summary', 'the field was not renamed'),
  },
  {
    id: 'cms/remove-field', domain: 'cms', status: 'supported',
    feature: 'Remove a field',
    ask: 'remove the date field',
    calls: [{ tool: 'cms_remove_field', args: { collection: 'blog', field_id: 'date' } }],
    expect: (w) => must(!w.json<Schema>(BLOG_SCHEMA).fields.some((x) => x.id === 'date'), 'the field is still there'),
  },
  {
    id: 'cms/add-items-bulk', domain: 'cms', status: 'supported',
    feature: 'Add many items in one call, with images',
    ask: 'add three more posts with cover images',
    calls: [{ tool: 'cms_add_items', args: { collection: 'blog', items: [
      { title: 'Roadmaps that ship', excerpt: 'How we plan.', cover: 'https://images.unsplash.com/photo-a?w=800', date: '2026-09-10' },
      { title: 'Calm releases', excerpt: 'How we ship.', cover: 'https://images.unsplash.com/photo-b?w=800', date: '2026-09-12' },
      { title: 'Reading a burndown', excerpt: 'How we measure.', cover: 'https://images.unsplash.com/photo-c?w=800', date: '2026-09-14' },
    ] } }],
    expect: (w) => {
      const items = w.json<Item[]>(BLOG_ITEMS);
      must(items.length === 5, `expected 5 items, found ${items.length}`);
      must(new Set(items.slice(2).map((i) => i.cover)).size === 3, 'the covers are not three different images');
      must(items.slice(2).every((i) => typeof i.cover === 'string' && !/^url\(/.test(i.cover)), 'a cover is wrapped in url(...)');
    },
  },
  {
    id: 'cms/update-item', domain: 'cms', status: 'supported',
    feature: 'Update an item',
    ask: 'change the first post\'s title to "Hello again"',
    calls: [{ tool: 'cms_update_item', args: { collection: 'blog', item_id: 'post-1', values: { title: 'Hello again' } } }],
    expect: (w) => {
      const items = w.json<Item[]>(BLOG_ITEMS);
      must(items.find((i) => i._id === 'post-1')?.title === 'Hello again', 'the title did not change');
      must(items.find((i) => i._id === 'post-1')?.excerpt === 'Our first post.', 'a partial update wiped another field');
    },
  },
  {
    id: 'cms/remove-item', domain: 'cms', status: 'supported',
    feature: 'Remove an item',
    ask: 'delete the second post',
    calls: [{ tool: 'cms_remove_item', args: { collection: 'blog', item_id: 'post-2' } }],
    expect: (w) => must(w.json<Item[]>(BLOG_ITEMS).map((i) => i._id).join() === 'post-1', 'post-2 is still there'),
  },
  {
    id: 'cms/translate-item', domain: 'cms', status: 'supported',
    feature: 'Translate an item field (one row per item)',
    ask: 'translate the first post\'s title to French',
    calls: [{ tool: 'cms_set_item_translation', args: { collection: 'blog', item_id: 'post-1', locale: 'fr', field: 'title', value: 'Bonjour le monde' } }],
    expect: (w) => {
      const items = w.json<Item[]>(BLOG_ITEMS);
      must(items.length === 2, 'a row was duplicated per locale');
      must(items[0]._i18n?.fr?.title === 'Bonjour le monde', 'no _i18n.fr.title on the row');
      must(items[0].title === 'Hello world', 'the base value changed');
      must(!w.json<Schema>(BLOG_SCHEMA).fields.some((f) => /lang|locale/i.test(f.name)), 'a language field was added');
    },
  },
  {
    id: 'cms/read-collection', domain: 'cms', status: 'supported',
    feature: 'Read a collection: fields AND items',
    ask: 'what posts do I have?',
    calls: [{ tool: 'cms_get_collection', args: { collection: 'blog' } }],
    expect: (w) => must(w.replies[0].data?.items?.length === 2 && w.replies[0].data?.fields?.length === 5, 'the reply lacks the items or the fields'),
  },
  {
    id: 'cms/bind-list', domain: 'cms', status: 'supported',
    feature: 'Bind a collection to a list',
    ask: 'show my blog posts in this list',
    files: { [HOME]: LIST_PAGE() },
    calls: [{ tool: 'bind_cms_list', args: { node_id: 'post-row', collection_slug: 'blog' } }],
    expect: (w) => {
      const code = w.read(HOME) ?? '';
      must(/blog\.map\(/.test(code), 'the row is not wrapped in blog.map(...)');
      must(/import blog from/.test(code), 'the collection is not imported');
    },
  },
  {
    id: 'cms/bind-text-field', domain: 'cms', status: 'supported',
    feature: 'Bind a field to text',
    ask: 'use the post title here',
    files: { [HOME]: LIST_PAGE() },
    calls: [
      { tool: 'bind_cms_list', args: { node_id: 'post-row', collection_slug: 'blog' } },
      { tool: 'bind_cms_field', args: { node_id: 'post-title', field_id: 'title', property: 'text' } },
    ],
    expect: (w) => must(/\{\w+\??\.title\}/.test(w.read(HOME) ?? ''), 'the title is not bound to {item.title}'),
  },
  {
    id: 'cms/bind-image-field', domain: 'cms', status: 'supported',
    feature: 'Bind an IMAGE field to a frame\'s fill',
    ask: 'use the post cover as this frame\'s image',
    files: { [HOME]: LIST_PAGE() },
    calls: [
      { tool: 'bind_cms_list', args: { node_id: 'post-row', collection_slug: 'blog' } },
      { tool: 'bind_cms_field', args: { node_id: 'post-cover', field_id: 'cover', property: 'backgroundImage' } },
    ],
    expect: (w) => {
      const code = w.read(HOME) ?? '';
      must(/backgroundImage:\s*`url\(\$\{\w+\??\.cover\}\)`/.test(code), 'the cover is not bound as backgroundImage: `url(${item.cover})`');
      must(/backgroundSize:\s*'cover'/.test(code), 'a bound image needs backgroundSize: cover to be visible');
    },
  },

  // ── not possible yet ──
  {
    id: 'cms/reorder-fields', domain: 'cms', status: 'supported',
    feature: 'Reorder fields',
    ask: 'put the date right after the title',
    calls: [{ tool: 'cms_reorder_fields', args: { collection: 'blog', field_ids: ['title', 'date', 'slug', 'excerpt', 'cover'] } }],
    expect: (w) => must(w.json<Schema>(BLOG_SCHEMA).fields.map((f) => f.id).join() === 'title,date,slug,excerpt,cover', `order is ${w.json<Schema>(BLOG_SCHEMA).fields.map((f) => f.id).join()}`),
  },
  {
    id: 'cms/reorder-items', domain: 'cms', status: 'supported',
    feature: 'Reorder items',
    ask: 'put the second post first',
    calls: [{ tool: 'cms_reorder_items', args: { collection: 'blog', item_ids: ['post-2', 'post-1'] } }],
    expect: (w) => must(w.json<Item[]>(BLOG_ITEMS).map((i) => i._id).join() === 'post-2,post-1', 'the items were not reordered'),
  },
  {
    id: 'cms/duplicate-collection', domain: 'cms', status: 'supported',
    feature: 'Duplicate a collection',
    ask: 'duplicate the blog collection',
    calls: [{ tool: 'cms_duplicate_collection', args: { collection: 'blog' } }],
    expect: (w) => {
      const copy = w.replies[0].data?.slug as string;
      must(copy && copy !== 'blog', 'no new slug');
      must(w.json<Item[]>(`cms/${copy}.json`).length === 2 && w.json<Schema>(`cms/${copy}.schema.json`).fields.length === 5, 'the copy is missing items or fields');
    },
  },
  {
    id: 'cms/unbind-field', domain: 'cms', status: 'supported',
    feature: 'Unbind a field back to static content',
    ask: 'stop using the CMS title here, just say "Latest"',
    files: { [HOME]: LIST_PAGE() },
    calls: [
      { tool: 'bind_cms_list', args: { node_id: 'post-row', collection_slug: 'blog' } },
      { tool: 'bind_cms_field', args: { node_id: 'post-title', field_id: 'title', property: 'text' } },
      { tool: 'unbind_cms_field', args: { node_id: 'post-title', property: 'text', value: 'Latest' } },
    ],
    expect: (w) => must(!/\{\w+\??\.title\}/.test(w.read(HOME) ?? '') && />Latest</.test(w.read(HOME) ?? ''), 'still bound, or the static text is missing'),
  },
  {
    id: 'cms/list-filter', domain: 'cms', status: 'supported',
    feature: 'Filter a list',
    ask: 'only show posts whose title contains "Hello"',
    files: { [HOME]: LIST_PAGE() },
    calls: [
      { tool: 'bind_cms_list', args: { node_id: 'post-row', collection_slug: 'blog' } },
      { tool: 'set_list_config', args: { node_id: 'posts', filters: [{ field: 'title', operator: 'contains', value: 'Hello' }] } },
    ],
    expect: (w) => must(/\.filter\(/.test(w.read(HOME) ?? '') && /Hello/.test(w.read(HOME) ?? ''), 'no filter on the list'),
  },
  {
    id: 'cms/list-filter-unknown-field', domain: 'cms', status: 'supported',
    feature: 'A filter on a field that does not exist is refused',
    ask: 'only show posts in the News category',
    files: { [HOME]: LIST_PAGE() },
    calls: [
      { tool: 'bind_cms_list', args: { node_id: 'post-row', collection_slug: 'blog' } },
      { tool: 'set_list_config', args: { node_id: 'posts', filters: [{ field: 'category', operator: 'equals', value: 'News' }] } },
    ],
    allowFailedCalls: true,
    expect: (w) => must(w.replies[1].isError && /not a field/.test(w.replies[1].text), 'not refused with the field list'),
  },
  {
    id: 'cms/list-sort', domain: 'cms', status: 'supported',
    feature: 'Sort a list',
    ask: 'newest posts first',
    files: { [HOME]: LIST_PAGE() },
    calls: [
      { tool: 'bind_cms_list', args: { node_id: 'post-row', collection_slug: 'blog' } },
      { tool: 'set_list_config', args: { node_id: 'post-row', sort: [{ field: 'date', direction: 'desc' }] } },
    ],
    expect: (w) => must(/\.sort\(/.test(w.read(HOME) ?? '') && /date/.test(w.read(HOME) ?? ''), 'no sort on the list'),
  },
  {
    id: 'cms/list-limit', domain: 'cms', status: 'supported',
    feature: 'Limit / offset a list',
    ask: 'show only the 3 latest posts',
    files: { [HOME]: LIST_PAGE() },
    calls: [
      { tool: 'bind_cms_list', args: { node_id: 'post-row', collection_slug: 'blog' } },
      { tool: 'set_list_config', args: { node_id: 'posts', sort: [{ field: 'date', direction: 'desc' }], limit: 3 } },
    ],
    expect: (w) => must(/\.slice\(0,\s*3\)/.test(w.read(HOME) ?? ''), 'no limit of 3 on the list'),
  },
  {
    id: 'cms/list-pagination', domain: 'cms', status: 'supported',
    feature: 'Pagination (load more)',
    ask: 'show 6 at a time with a load more button',
    files: { [HOME]: LIST_PAGE() },
    calls: [
      { tool: 'bind_cms_list', args: { node_id: 'post-row', collection_slug: 'blog' } },
      { tool: 'set_pagination', args: { node_id: 'posts', mode: 'loadMore', per_page: 6 } },
    ],
    expect: (w) => {
      const code = w.read(HOME) ?? '';
      must(/useState\(6\)/.test(code) || /useState\(\s*6\s*\)/.test(code), 'no visible-count state of 6');
      must(/LoadMore|Load more/i.test(code), 'no load-more control');
    },
  },
  {
    id: 'cms/list-search', domain: 'cms', status: 'supported',
    feature: 'Search field bound to a list filter',
    ask: 'add a search box for the posts',
    files: { [HOME]: LIST_PAGE() },
    calls: [
      { tool: 'bind_cms_list', args: { node_id: 'post-row', collection_slug: 'blog' } },
      { tool: 'add_list_search', args: { node_id: 'posts', field: 'title' } },
    ],
    expect: (w) => {
      const code = w.read(HOME) ?? '';
      must(/data-search-field="searchTitle"/.test(code), 'no search input bound to the page variable');
      must(/@pageVariables[\s\S]*"searchTitle"/.test(code), 'no searchTitle page variable declared');
      must(/blog[\s\S]*\.filter\([\s\S]*searchTitle/.test(code), 'the list has no filter reading the search variable');
    },
  },
  {
    id: 'cms/responsive-list-config', domain: 'cms', status: 'supported',
    feature: 'Per-breakpoint list config (filter / sort)',
    ask: 'on mobile, only show the posts that have a cover',
    files: { [HOME]: LIST_PAGE() },
    calls: [
      { tool: 'bind_cms_list', args: { node_id: 'post-row', collection_slug: 'blog' } },
      { tool: 'set_list_config', args: { node_id: 'posts', viewport: 375, filters: [{ field: 'cover', operator: 'exists' }] } },
    ],
    expect: (w) => {
      const code = w.read(HOME) ?? '';
      must(/__applyListConfig|applyListConfig/.test(code), 'the list was not upgraded to the responsive config shape');
      must(/375/.test(code) && /cover/.test(code), 'no 375px override on the cover field');
      const list = w.node('posts').collectionList;
      must(list?.responsive?.['375']?.filterGroup?.filters.some((f) => f.field === 'cover'), 'the parser does not read the mobile filter back');
    },
  },
  {
    id: 'cms/change-list-source', domain: 'cms', status: 'supported',
    feature: 'Change a list\'s source collection',
    ask: 'make this list show the team instead of the blog',
    files: { [HOME]: LIST_PAGE() },
    calls: [
      { tool: 'cms_create_collection', args: { name: 'Team' } },
      { tool: 'cms_add_field', args: { collection: 'team', name: 'Name', type: 'text' } },
      { tool: 'cms_add_field', args: { collection: 'team', name: 'Photo', type: 'image' } },
      { tool: 'bind_cms_list', args: { node_id: 'post-row', collection_slug: 'blog' } },
      { tool: 'bind_cms_field', args: { node_id: 'post-title', field_id: 'title', property: 'text' } },
      { tool: 'change_list_source', args: { node_id: 'posts', collection_slug: 'team' } },
    ],
    expect: (w) => {
      const code = w.read(HOME) ?? '';
      must(/team\.map\(/.test(code) && /import team from/.test(code), 'the list does not read the team collection');
      must(!/blog\.map\(/.test(code), 'the blog map is still there');
      must(/\.name\}/.test(code) || /\.name\b/.test(w.tag('post-title')) || /name/.test(JSON.stringify(w.replies[5].data?.field_map)), 'the title binding was not carried to the team name field');
    },
  },
  {
    id: 'cms/detail-page', domain: 'cms', status: 'supported',
    feature: 'Create the detail (slug) page for a collection',
    ask: 'give each post its own page',
    calls: [{ tool: 'create_collection_pages', args: { collection: 'blog', kind: 'detail' } }],
    expect: (w) => {
      const written = w.replies[0].data?.written as string[];
      must(written?.length === 1 && /\[slug\]/.test(written[0]), `written: ${JSON.stringify(written)}`);
      must(/@cmsPage/.test(w.read(written[0]) ?? ''), 'the detail page has no @cmsPage annotation');
    },
  },
  {
    id: 'cms/row-link', domain: 'cms', status: 'supported',
    feature: 'Link a row to its detail page',
    ask: 'make each card open its post',
    files: { [HOME]: LIST_PAGE() },
    calls: [
      { tool: 'create_collection_pages', args: { collection: 'blog', kind: 'detail' } },
      { tool: 'bind_cms_list', args: { node_id: 'post-row', collection_slug: 'blog' } },
      { tool: 'link_rows_to_pages', args: { node_id: 'post-row' } },
    ],
    expect: (w) => must(/data-cms-nav="row"/.test(w.tag('post-row')) && /href=\{`\/blog\/\$\{/.test(w.tag('post-row')), `row is not linked: ${w.tag('post-row').slice(0, 200)}`),
  },
  {
    id: 'cms/bind-instance-prop', domain: 'cms', status: 'supported',
    feature: 'Bind a component instance prop to a field',
    ask: 'feed each post\'s title into the button label',
    files: { [HOME]: LIST_PAGE(`\n          <PrimaryButton data-id="post-cta" data-name="CTA" label="Read" style={{ position: 'relative', flex: '0 0 auto', order: '3' }} />`).replace("import React from 'react';", "import React from 'react';\nimport PrimaryButton from '@/components/PrimaryButton';") },
    calls: [
      { tool: 'bind_cms_list', args: { node_id: 'post-row', collection_slug: 'blog' } },
      { tool: 'bind_cms_prop', args: { node_id: 'post-cta', component_name: 'PrimaryButton', prop: 'label', field_id: 'title' } },
    ],
    expect: (w) => must(/label=\{\w+\.title\}/.test(w.tag('post-cta')), `label is not bound: ${w.tag('post-cta').slice(0, 160)}`),
  },
  {
    id: 'cms/field-id-validated', domain: 'cms', status: 'supported',
    feature: 'A binding to a field that does not exist is refused',
    ask: '(safety) bind the title to a non-existent field',
    files: { [HOME]: LIST_PAGE() },
    calls: [
      { tool: 'bind_cms_list', args: { node_id: 'post-row', collection_slug: 'blog' } },
      { tool: 'bind_cms_field', args: { node_id: 'post-title', field_id: 'headline', property: 'text' } },
    ],
    allowFailedCalls: true,
    expect: (w) => {
      must(w.replies[1].isError && /headline/.test(w.replies[1].text) && /title/.test(w.replies[1].text), 'not refused with the field list');
      must(!/item\.headline|post\.headline/.test(w.read(HOME) ?? ''), 'the bad binding was written anyway');
    },
  },
];
