// skills-library.ts — starter skills a project can add in one click.
//
// Copied INTO the project when added (Settings → Skills → Add from library):
// from then on it is the user's to edit, like any skill they wrote. Written
// against the agent's real tools, so each one is a workflow the agent can
// actually carry out — not advice. The ones marked `placeholder` are templates
// the user fills in (a brand voice is theirs, not ours).

import type { SkillDraft } from '@/code/stores/project-skills-store';

export interface LibrarySkill extends SkillDraft {
  description: string;
  /** A template the user must fill in before it is useful. */
  placeholder?: boolean;
}

export const SKILLS_LIBRARY: LibrarySkill[] = [
  {
    name: 'seo-check',
    description: 'Review and fix page SEO: titles, descriptions, social previews, indexing, alt text.',
    content: `Review the SEO of the page the user is on (or every page, if they say "all pages").

1. Run \`get_seo\` and read what it reports for the page(s).
2. Fix, don't just report:
   - Title: 30–60 characters, unique per page, the page's topic first, the brand last ("Pricing — Acme").
   - Description: 70–160 characters, one plain sentence saying what the page offers.
   - Social: a social title and description, and a social image (1200×630) — use the site's image if the page has none.
   - Canonical and indexing: leave both at their defaults unless the page is a draft, a thank-you page or a duplicate.
   - Images: every meaningful image gets alt text describing what it shows; decorative images get empty alt.
   - One H1 per page; headings in order (no H2 → H4 jumps).
3. Use \`set_page_metadata\` for page fields and \`set_site_metadata\` for site-wide ones.
4. Finish with a short list of what you changed and anything that needs the user (e.g. a missing brand image).`,
  },
  {
    name: 'launch-check',
    description: 'Before publishing: layout on every breakpoint, links, content, SEO and accessibility.',
    content: `Run a pre-launch check of the site. Fix what you can; list what needs the user.

1. Layout: \`audit_design\` on desktop, tablet and phone. Nothing may overflow the viewport, overlap, or be cut off; fix every finding.
2. Links: every button and nav item links somewhere real — no "#" placeholders, no links to deleted pages. External links open in a new tab.
3. Content: no lorem ipsum, "TODO", placeholder names, broken images or empty sections. Copy has no obvious typos.
4. SEO: every page has a title and description (\`get_seo\`); fix the gaps.
5. Accessibility basics: alt text on images, readable contrast on text over images and colours, buttons with a clear label.
6. Close with a short checklist — ✓ passed, fixed, or needs the user.`,
  },
  {
    name: 'accessibility-check',
    description: 'Check the page for accessibility problems and fix them.',
    content: `Check the current page for accessibility and fix what you find.

- Contrast: body text at least 4.5:1 against its background, large text (24px+, or 19px+ bold) at least 3:1. Check text over images and gradients especially.
- Images: meaningful images get alt text that says what they show; decorative ones get empty alt.
- Structure: one H1; headings in order; lists are lists.
- Controls: every button and link has a clear, specific label ("See pricing", not "Click here"); tap targets at least 44×44px on phone.
- Motion: nothing essential depends on an animation, and nothing flashes.
Make the fixes directly, then list them in a sentence or two.`,
  },
  {
    name: 'brand-voice',
    description: 'Keep new copy consistent with the brand voice and terminology.',
    placeholder: true,
    content: `Write every piece of copy in this brand's voice.

VOICE — replace with yours:
- Tone: [e.g. confident, warm, never salesy]
- Person: [e.g. "we" for the company, "you" for the reader]
- Sentences: [e.g. short; one idea each; no exclamation marks]

TERMS:
- Say [our product name, exact capitalisation], never [wrong variants].
- Say [preferred term], not [avoided term].

NEVER:
- Buzzwords like "revolutionary", "seamless", "unlock", "elevate".
- Claims we cannot back with a number or a fact.`,
  },
  {
    name: 'remove-ai-writing',
    description: 'Strip AI filler from the page copy: vague claims, repetition, clichés.',
    content: `Rewrite the text on the current page to remove AI-sounding filler, keeping the meaning and the layout.

Cut or replace:
- Empty openers and closers ("In today's fast-paced world", "Look no further", "Elevate your…").
- Vague claims with no fact behind them ("cutting-edge", "seamless", "world-class", "revolutionary").
- Triplets that say one thing three ways; repeated ideas across sections.
- Em-dash chains and rhetorical questions used as headlines.
Prefer: concrete nouns, numbers, the reader's actual benefit, short sentences.
Change only text — never styles or structure. Keep headlines about the same length so the layout holds.`,
  },
  {
    name: 'design-system',
    description: 'Build new pages and sections with the project’s own tokens, text styles and components.',
    placeholder: true,
    content: `When building or restyling anything, use this project's design system — never invent new values.

- Colours: only the project's colour tokens (\`get_design_tokens\`). No raw hex values.
- Type: only the project's text styles; no one-off font sizes.
- Spacing: [e.g. multiples of 8px; sections 120px top/bottom on desktop, 64px on phone].
- Components: reuse the project's components (\`list_components\`) — buttons, cards, nav — before building new ones.
- Layout: [e.g. content max-width 1200px, centred; 12-column grid feel].

Tip: ask the agent to "generate my design-system skill" and it will fill this in from the project.`,
  },
];
