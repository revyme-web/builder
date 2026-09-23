// src/ai/agent/tools/verify-effect.ts
//
// `verify_effect` — a HEADLESS verdict on whether a REQUEST (not just a tool
// call) actually landed in the active file: "does the testimonials section
// exist AND does every expected text leaf have non-empty content?". Structure
// without content does not satisfy a request — the P4/P5 gap documented in
// artifacts/audit-p4-p5-p3: the agent built frames but forgot to fill them,
// and no verdict ever told it the user's request was (not) satisfied.
//
// The engine is a PURE role-based structural scan of the generated JSX code:
// no canvas, no bridge, no parser round-trip — it mirrors the `satisfies`
// predicates the N1 bench harness proves (scripts/eval-agent/n1-scenarios.ts:
// scanElements / elementRole / isFilled / descendantsOf, section = role
// starting with the concept, cards = indexed `-N` ids, content = isFilled).
// The bench owns those predicates for MEASURING runs; this module owns their
// equivalent for the agent's own ACTION → VERIFY → CORRECT → VERIFY → DONE
// loop.  Both product and bench now consume the SHARED scanner at
// src/code/parsing/element-scanner.ts — the single source of truth for
// element extraction.
//
// The verdict is INFORMATIVE, never a gate: it answers "structure exists but
// content is missing" vs "request not yet satisfied" in actionable terms
// (missing[] + feedback). It never judges design — no grid, color, wrapper
// count or taste rules. Decorative / voluntary spacers (spacer/placeholder/
// decoration/slot roles) are never treated as content and never flagged.
//
// Since the N1-REL functional audit, the engine is also FUNCTIONALLY aware for
// interactive roles (faq/accordion/tabs/toggle, cta/button, form, modal/overlay,
// explicitly-requested motion): when the request or hints name one of them, a
// REAL activation token must exist in the section markup — onClick/useState/variants
// for a toggle, href/onClick for a CTA, onSubmit for a form, whileInView/whileHover/
// data-loop for motion. A decorative "FAQ" built from "+" icons or a colored
// static CTA div is FAKE and does not satisfy. Each such check is classified
// { wired | fake | noop | mis-scoped | absent } in the new `states` field;
// `satisfied` is false unless every required mechanism is wired. This
// exactly mirrors the hasLiveModal / hasRealForm / motion-prop checks the N1
// bench proves for functionally-correct output.
//
// The same engine feeds the batch result (`effect` block) when a batch
// declares the `request` it fulfils — one exported function, no duplication.
//
// Contract:
//   verifyEffect(code, request, hints?) → EffectVerdict
//     { satisfied, checks: [{label, present, filled, count, required, state?}],
//       missing: string[], feedback: string, concept, scope,
//       states: [{label, state}] }
//   checks[] gains one entry per REQUIRED MECHANISM (interactive roles) with a
//   `state` classification; `states` is the flat per-check mechanism verdict.
//   missing entries are actionable ("FAQ is visual-only: no toggle/handler
//   found — build the toggle with an onClick handler or a 2-state variant",
//   "CTA is static: add an href or onClick"); `feedback` is ONE agent-readable
//   line for the CORRECT step.

import { z } from 'zod';
import type { AgentTool, AgentToolResult } from '@/ai/agent';
import { resolveToolFile, readToolFile } from '@/ai/agent/workspace';
import { trace } from '@/shared/debug-trace';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';

// ─── IDS mode: local Babel traverse — why not the canonical parser? ─────────
// `parseJSXToNodes` (src/code/parsing/parser.ts) is importable (no cycle into
// ai/agent/tools) but its CanvasNode strips handler props (onClick etc.) — the
// IDS `mechanism` check must inspect onClick/href emptiness via AST attrs
// (inert `() => {}` vs real `() => setX()` / `href="#"` vs `href="/pricing"`)
// without regex on source. A minimal local traverse preserves that wiring and
// keeps the IDS path headless + single-parse. See buildIdsMap / hasRealMechanism.
const traverseIds = (typeof _traverse === 'function' ? _traverse : (_traverse as any).default) as typeof _traverse;

// ─── Pure JSX scan — imported from shared scanner ───────────────────────────

import {
  type ScannedElement,
  scanElements,
  elementRole,
  elementText,
  isFilled,
  descendantsOf,
} from '@/code/parsing/element-scanner';

export { type ScannedElement, scanElements, elementRole, elementText, isFilled, descendantsOf };

// ─── Verification spec (pure) ───────────────────────────────────────────────

/** Roles that are NEVER content: voluntary spacers, placeholders, decoration,
 *  slots. A spacer is not a content leaf and is never flagged.
 *  Parser-based check (no regex source of truth): substring includes. */
const EXCLUDED_ROLE_SUBSTRINGS = ['spacer', 'placeholder', 'decor', 'slot'] as const;

function isExcludedRole(role: string): boolean {
  const low = role.toLowerCase();
  return EXCLUDED_ROLE_SUBSTRINGS.some((s) => low.includes(s));
}

/** One text-leaf requirement inside a card, e.g. role matches /quote|text|body/
 *  and the leaf must be non-empty. */
export interface KeyTextSpec {
  label: string;
  re: RegExp;
}

/** How many cards/items the request asks for. `exact: true` (the request says
 *  "exactly N") makes the count a hard equality; otherwise only `min` is
 *  enforced, `max` is a soft report. */
export interface CountSpec {
  min: number;
  max: number;
  exact: boolean;
}

/** The derived request contract the engine verifies against. */
export interface VerifySpec {
  /** Singularized concept, e.g. 'testimonial' — the section's role must
   *  start with it (± the plural 's'). */
  concept: string;
  /** Display label, e.g. 'testimonials' — used in feedback lines. */
  label: string;
  /** Role matchers for cards: the concept plus any extra expected_roles
   *  markers ("tier" next to "pricing", "quote" next to "testimonial"). */
  cardMatchers: RegExp[];
  count: CountSpec | null;
  /** What the counted cards are called, e.g. 'cards' / 'tiers' / 'items'. */
  unitLabel: string;
  /** Text-leaf requirements, checked inside every card. */
  keyTexts: KeyTextSpec[];
  /** When non-null, the section (or, for motion, the whole file) must carry a
   *  REAL activation token — decorative structure without one does not satisfy
   *  an interactive request. Null for non-interactive concepts. */
  mechanism: MechanismSpec | null;
}

/** Model-supplied hints: sharpen the request-derived spec without changing
 *  the engine. All optional — the request text alone must suffice. */
export interface VerifyHints {
  expected_roles?: string[];
  expected_count?: number;
  key_texts?: string[];
  /** Mechanism tokens that must appear for an interactive role (e.g.
   *  ['onClick', 'useState'] / ['href'] / ['onSubmit']). When set, the
   *  mechanism check is forced even if the request text does not name an
   *  interactive role. */
  expected_mechanism?: string[];
  node_ids?: string[];
  checks?: Array<'exists' | 'filled' | 'mechanism'>;
}

/** Functional state of one mechanism check. An interactive request is only
 *  satisfied when the state is `wired`. */
export type MechanismState = 'wired' | 'fake' | 'noop' | 'mis-scoped' | 'absent';

/** What a REQUIRED mechanism looks like for one interactive role.
 *  Parser-based: no RegExp source of truth. The engine inspects the AST
 *  (data-id/data-name roles + JSX attributes) for real/inert/partial evidence.
 *  `kind` selects the predicate; `expectedTokens` carries the forced contract. */
export interface MechanismSpec {
  /** Human label used in checks / states / feedback, e.g. 'FAQ toggle'. */
  label: string;
  /** Discriminant for the parser-based predicate. */
  kind: 'toggle' | 'cta' | 'form' | 'overlay' | 'motion' | 'interactive' | 'expected';
  /** For `expected` kind: tokens that must appear as attribute/tag evidence. */
  expectedTokens?: string[];
  /** Where the mechanism tokens are searched: 'section' = the concept's own
   *  markup (opening tag + descendants); 'whole' = the whole file (motion may
   *  land on any element of the page). */
  scanScope: 'section' | 'whole';
  /** True when the concept is a built DOM thing (a species). A species present
   *  with zero mechanism is FAKE; a pure property (motion) absent is ABSENT. */
  species: boolean;
  /** `partialRe` alone classifies as mis-scoped (not noop/fake) when the
   *  request asks for a scroll/appear effect. */
  misScopeOnScroll?: boolean;
  /** Actionable one-line how-to for the CORRECT step. */
  fixHint: string;
}

/** One line of `states[]` — the mechanism classification of a check. */
export interface MechanismVerdict {
  label: string;
  state: MechanismState;
  /** The spec's how-to, carried for feedback/missing authoring. */
  fixHint: string;
}

/** One line of the checks[] array — the verdict's atomic facts. */
export interface VerifyCheck {
  label: string;
  present: boolean;
  filled: number;
  count: number;
  required: string;
  /** Mechanism checks only: the {wired|fake|noop|mis-scoped|absent}
   *  classification. Absent on plain content checks. */
  state?: MechanismState;
}

/** The STRUCTURED verdict — the shape the tool and the batch return. */
export interface EffectVerdict {
  satisfied: boolean;
  checks: VerifyCheck[];
  /** Actionable, agent-readable: what to correct next. */
  missing: string[];
  /** ONE line for the CORRECT step ("structure exists but 1 quote is empty…"). */
  feedback: string;
  /** Per-check mechanism classifications for interactive roles ([] when the
   *  request names no interactive role). */
  states: MechanismVerdict[];
  /** The concept the request was verified against ('' when undecidable). */
  concept: string;
  /** Which file was scanned ('' = engine-level call with no scope). */
  scope: string;
  /** The request named nothing checkable ("adjust the accent colours") — the
   *  verdict is "could not tell", not "the effect is missing". `satisfied`
   *  stays false so the model is told to name the entity / pass
   *  expected_roles, but the done-guard must never refuse a finish on it
   *  (it ended a finished accent-colour run in red, 2026-09-23). */
  inconclusive?: boolean;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 'testimonials' → 'testimonial' (only a trailing plural 's'). */
function singularOf(word: string): string {
  const w = word.trim().toLowerCase();
  return /s$/.test(w) && !/ss$/.test(w) ? w.slice(0, -1) : w;
}

/** 'testimonial' → 'testimonials'. */
function pluralOf(word: string): string {
  const w = word.trim().toLowerCase();
  return /s$/.test(w) ? w : `${w}s`;
}

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

function resolveNumber(word: string): number | null {
  const w = word.toLowerCase();
  if (/^\d+$/.test(w)) return parseInt(w, 10);
  return WORD_NUMBERS[w] ?? null;
}

/** The counted-thing noun, e.g. 'cards' — first unit word in the request. */
const UNIT_WORD_RE = /\b(cards?|tiers?|quotes?|posts?|items?|entries?|rows?|columns?)\b/i;

function requestUnitLabel(request: string): string | null {
  const m = request.match(UNIT_WORD_RE);
  return m ? m[1].toLowerCase() : null;
}

/** Parse how many the request asks for: explicit hint wins; then "exactly N";
 *  then every number (digits + word numbers) — "two or three" → 2-3, "2-3"
 *  → 2-3. Width noise (375px, 1440) is filtered by a plausibility cap. */
function parsedCount(request: string, explicit?: number): CountSpec | null {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit >= 1) {
    return { min: explicit, max: explicit, exact: true };
  }
  const exact = request.match(/\bexactly\s+(\d+|[a-z]+)/i);
  if (exact) {
    const n = resolveNumber(exact[1]);
    if (n !== null && n >= 1 && n <= 30) return { min: n, max: n, exact: true };
  }
  const nums: number[] = [];
  for (const m of request.matchAll(/\b(\d+)\b/g)) nums.push(parseInt(m[1], 10));
  for (const [w, n] of Object.entries(WORD_NUMBERS)) {
    if (new RegExp(`\\b${w}\\b`, 'i').test(request)) nums.push(n);
  }
  const plausible = nums.filter((n) => n >= 1 && n <= 30);
  if (plausible.length === 0) return null;
  return { min: Math.min(...plausible), max: Math.max(...plausible), exact: false };
}

/** Request-prose → text-leaf requirements: which markers must be non-empty
 *  inside each card. Order matters: the FIRST key is the content key a card
 *  may also carry as its own direct text. */
function requestKeyTexts(request: string): KeyTextSpec[] {
  const out: KeyTextSpec[] = [];
  if (/quote/i.test(request)) out.push({ label: 'quote', re: /quote|text|body/i });
  if (/\bname of (?:the )?person|author|attribution|\bsaid/i.test(request)) {
    out.push({ label: 'author/name', re: /\b(?:author|name|by)\b/i });
  }
  if (/title|heading|headline/i.test(request)) out.push({ label: 'title', re: /title|heading|headline/i });
  if (/description|excerpt/i.test(request)) out.push({ label: 'description', re: /description|desc|excerpt|text|body|content/i });
  if (/price|amount|cost/i.test(request)) out.push({ label: 'price', re: /price|amount|cost/i });
  return out;
}

/** A model-supplied key_texts hint → a working KeyTextSpec (canonical markers
 *  map to their whole families so "author" also matches data-name="Name"). */
function keyTextFromHint(label: string): KeyTextSpec {
  const l = label.trim().toLowerCase();
  if (l === 'quote') return { label: 'quote', re: /quote|text|body/i };
  if (l === 'text' || l === 'body') return { label: 'text', re: /quote|text|body/i };
  if (l === 'author' || l === 'name' || l === 'by') return { label: 'author/name', re: /\b(?:author|name|by)\b/i };
  if (l === 'title' || l === 'heading' || l === 'headline') return { label: 'title', re: /title|heading|headline/i };
  if (l === 'description' || l === 'desc' || l === 'excerpt') return { label: 'description', re: /description|desc|excerpt|text|body|content/i };
  if (l === 'price') return { label: 'price', re: /price|amount|cost/i };
  return { label: l, re: new RegExp(escapeRegExp(l), 'i') };
}

// ─── Mechanism requirements (interactive roles) ─────────────────────────────
//
// An interactive request must land as a WORKING mechanism, not just a look.
// Each role declares the tokens that prove a real activation path. The
// builder's own generators produce exactly these tokens: addPageInteractionInCode
// emits `onClick={() => setX(v)}`, overlay-gen emits `data-overlay-trigger='…'`,
// generator-motion emits whileInView/whileHover/data-loop, form submit / set_form
// emits a `<form … onSubmit={…} data-form='…'>`.
//
// Parser-based: no RegExp source of truth. Predicates inspect the AST nodes
// (attributes + tags) for real/inert/partial evidence. The `kind` selects the
// predicate; see evaluateMechanismAST.

const TOGGLE_MECHANISM: MechanismSpec = {
  label: 'FAQ/accordion toggle',
  kind: 'toggle',
  scanScope: 'section',
  species: true,
  fixHint:
    'build the toggle with an onClick/onTap handler that flips state (addPageInteraction) or a 2-state variant (set_variant) — a visual-only "+" or chevron carries no mechanism.',
};

const CTA_MECHANISM: MechanismSpec = {
  label: 'CTA mechanism',
  kind: 'cta',
  scanScope: 'section',
  species: true,
  fixHint:
    'add an href or an onClick (or create_overlay to open a modal / a component instance with variants) — a styled div that goes nowhere is static.',
};

const FORM_MECHANISM: MechanismSpec = {
  label: 'form submit',
  kind: 'form',
  scanScope: 'section',
  species: true,
  fixHint:
    'wire the submit: a real onSubmit that prevents default and sends the data (set_form or apply_file_edit) — a <form> that cannot submit is a no-op.',
};

const OVERLAY_MECHANISM: MechanismSpec = {
  label: 'overlay/modal mechanism',
  kind: 'overlay',
  scanScope: 'section',
  species: true,
  fixHint:
    'give a trigger a real open condition: create_overlay, or an onClick/onTap that flips the overlay state — a modal that can never open is static.',
};

const MOTION_MECHANISM: MechanismSpec = {
  label: 'motion',
  kind: 'motion',
  scanScope: 'whole',
  species: false,
  misScopeOnScroll: true,
  fixHint:
    'add a real motion prop (whileInView/whileHover/whileTap via set_motion_preset) or a motion.* element with a target — a bare animate= does nothing on scroll — add a real motion prop (whileInView/whileHover/whileTap via set_motion_preset) or a motion.* element with a target — a bare animate= does not react to the viewer.',
};

const INTERACTIVE_MECHANISM: MechanismSpec = {
  label: 'interactive mechanism',
  kind: 'interactive',
  scanScope: 'section',
  species: true,
  fixHint:
    'add a real mechanism — an onClick/useState toggle, an href, an onSubmit, or a motion prop — so the element actually reacts, navigates or submits.',
};

/** Single-entity nouns the concept may be resolved to when the request names
 *  no "X section" — the known non-interactive corpus words plus the
 *  interactive role words above. */
const KNOWN_ENTITY_WORDS = [
  'footer', 'hero', 'header', 'navbar', 'nav', 'banner', 'gallery',
  'faq', 'accordion', 'tabs', 'toggle', 'disclosure',
  'cta', 'button', 'form', 'modal', 'overlay', 'motion', 'interactive',
];

// ─── CONCEPT SYNONYMS (P2.3b — additif, explicit et extensible) ─────────────
// Mapping canonical singular concept → synonym list (singular, lowercased).
// Exemples: testimonials↔[reviews,quotes], hero↔[banner,header], faq↔[accordion],
// gallery↔[grid,photos], pricing↔[tarifs,plans], footer↔[bas/bottom], etc.
// Extensible: ajouter une entrée canonical → [synonymes...] sans toucher la détection.
// Normalisation: clés/valeurs en singulier minuscule; le `s?` du matching gère le pluriel.
// Bidirectionnel: getConceptSynonymGroup(word) renvoie [canonical, ...synonyms] quelle que soit l'entrée.
export const CONCEPT_SYNONYMS: Record<string, string[]> = {
  testimonial: ['review', 'quote'],
  hero: ['banner', 'header', 'jumbotron'],
  faq: ['accordion', 'disclosure', 'tabs', 'toggle'],
  gallery: ['grid', 'photos', 'photo', 'image', 'images', 'carousel'],
  pricing: ['price', 'plan', 'tariff', 'tarifs', 'plans', 'tier'],
  footer: ['bottom', 'foot', 'bas'],
  header: ['navbar', 'nav', 'navigation', 'top', 'banner'],
  cta: ['button', 'action', 'call-to-action'],
  form: ['contact', 'input', 'fields'],
  modal: ['overlay', 'dialog', 'popup', 'lightbox'],
  // Ajouter ici de nouvelles paires : canonical (singulier) → [synonymes...]
};

/** Retourne le groupe de synonymes du concept (bidirectionnel) — [canonical, ...synonyms]. */
export function getConceptSynonymGroup(concept: string): string[] {
  const c = concept.trim().toLowerCase();
  const singular = singularOf(c);
  if (CONCEPT_SYNONYMS[singular]) return [singular, ...CONCEPT_SYNONYMS[singular]];
  for (const [canonical, syns] of Object.entries(CONCEPT_SYNONYMS)) {
    const lowerSyns = syns.map((s) => s.toLowerCase());
    if (lowerSyns.includes(singular) || lowerSyns.includes(c)) {
      return [canonical, ...CONCEPT_SYNONYMS[canonical]];
    }
  }
  return [singular];
}

/** Detect the mechanism an interactive request demands. Explicit
 *  `expected_mechanism` tokens win (a forced contract); otherwise the request
 *  + concept words select the role spec. */
function detectMechanism(request: string, concept: string, explicit?: string[]): MechanismSpec | null {
  const tokens = (explicit ?? []).map((t) => t.trim()).filter(Boolean);
  if (tokens.length > 0) {
    return {
      label: 'expected mechanism',
      kind: 'expected',
      expectedTokens: tokens,
      scanScope: 'section',
      species: true,
      fixHint: `add at least one of the required mechanism tokens: ${tokens.join(', ')} (e.g. an onClick handler, an href, an onSubmit, or a motion prop).`,
    };
  }
  const text = `${request} ${concept}`.toLowerCase();
  const has = (re: RegExp) => re.test(text);
  if (has(/\b(faq|accordion|disclosure|tabs|toggle)\b/)) return TOGGLE_MECHANISM;
  if (has(/\b(cta|button)\b/)) return CTA_MECHANISM;
  if (has(/\bform\b/)) return FORM_MECHANISM;
  if (has(/\b(modal|overlay)\b/)) return OVERLAY_MECHANISM;
  if (has(/\b(motion|animation|animate|appear|entrance)\b/)) return MOTION_MECHANISM;
  if (has(/\binteractive\b/)) return INTERACTIVE_MECHANISM;
  return null;
}

/** True when the request asks for a scroll-into-view / appear effect — the
 *  case where a bare `animate=` is mis-scoped next to a whileInView bar. */
const WANT_SCROLL_RE = /(?:scroll|appear|entrance|reveal|fade\s+in|into\s+view|in\s+view|au\s+scroll)/i;

function mechanismFeedback(v: MechanismVerdict): string {
  switch (v.state) {
    case 'fake':
      return `${capitalize(v.label)} is visual-only: no real mechanism found — ${v.fixHint}`;
    case 'noop':
      return `${capitalize(v.label)} is not wired: an empty handler or href="#" does nothing — ${v.fixHint}`;
    case 'mis-scoped':
      return `Motion is mis-scoped: a bare animate= does nothing on scroll — ${v.fixHint}`;
    case 'absent':
      return `No ${v.label} in the file — ${v.fixHint}`;
    default:
      return `${v.fixHint}`;
  }
}

function mechanismMissing(v: MechanismVerdict): string {
  return mechanismFeedback(v);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The concept the request talk about: the first expected_role, else the noun
 *  before "section" ("testimonials section" → testimonial, "pricing section"
 *  → pricing), else a known single-entity word ("add a footer", "the CTA",
 *  "a contact form"). Null when undecidable — the caller asks for expected_roles. */
function requestConcept(request: string): string | null {
  let m = request.match(/([A-Za-z][A-Za-z-]*)\s+section\b/i);
  if (m) return singularOf(m[1]);
  m = request.match(/(?:add|create|build|insert|include|make|need|want)\s+(?:a |an )?([A-Za-z][A-Za-z-]*)/i);
  if (m) {
    const word = m[1].toLowerCase();
    if (KNOWN_ENTITY_WORDS.includes(word)) return word;
  }
  // Last resort: a known single-entity noun anywhere in the request ("the CTA
  // opens a modal", "I want a contact form", "add an accordion to the page").
  m = request.match(new RegExp(`\\b(${KNOWN_ENTITY_WORDS.join('|')})\\b`, 'i'));
  if (m) return singularOf(m[1]);
  return null;
}

/** Derive the full verification spec from the request + optional hints.
 *  Returns null when no concept is decidable (the request names no entity). */
export function deriveSpec(request: string, hints: VerifyHints = {}): VerifySpec | null {
  const roles = (hints.expected_roles ?? []).map((r) => r.trim()).filter(Boolean);
  const concept = roles[0] ? singularOf(roles[0]) : requestConcept(request);
  if (!concept) return null;

  const conceptRe = new RegExp(`\\b${escapeRegExp(concept)}s?\\b`, 'i');
  const cardMatchers = [conceptRe, ...roles.slice(1).map((r) => new RegExp(escapeRegExp(r), 'i'))];

  const hintedKeys = (hints.key_texts ?? []).map((k) => k.trim()).filter(Boolean).map(keyTextFromHint);
  const proseKeys = requestKeyTexts(request);
  const roleKeys = roles.slice(1).map(keyTextFromHint);
  const keyTexts = hintedKeys.length > 0 ? hintedKeys : proseKeys.length > 0 ? proseKeys : roleKeys;

  return {
    concept,
    label: roles[0] ? roles[0].toLowerCase() : pluralOf(concept),
    cardMatchers,
    count: parsedCount(request, hints.expected_count),
    unitLabel: requestUnitLabel(request) ?? 'items',
    keyTexts,
    mechanism: detectMechanism(request, concept, hints.expected_mechanism),
  };
}

// ─── The verdict engine (pure) ──────────────────────────────────────────────

function countString(count: CountSpec | null): string {
  if (!count) return '≥1';
  if (count.exact) return String(count.min);
  return count.max > count.min ? `${count.min}-${count.max}` : String(count.min);
}

function mechanismCheck(v: MechanismVerdict): VerifyCheck {
  return {
    label: v.label,
    present: v.state !== 'absent',
    filled: v.state === 'wired' ? 1 : 0,
    count: 1,
    required: '1',
    state: v.state,
  };
}

// ─── IDS mode (P2.3a — additif, ne touche pas au moteur regex) ────────────
//
// ADDITIF UNIQUEMENT: toute la logique node_ids vit ici. Le moteur regex
// existant a été supprimé en P2.3b2; seule la porte IDS → concept-AST reste.
// Parse local minimal (Babel) plutôt que le parseur canonique
// `parseJSXToNodes`: celui-ci dépouille les handler props (onClick)
// nécessaires au check `mechanism` (inert `() => {}` vs réel `() => setX()` et
// `href="#"` vs `href="/pricing"`). Le traverse local conserve le wiring via
// les attrs AST, sans regex sur le code source, et reste headless + 1 parse.

function buildIdsMap(code: string): { map: Map<string, any>; dynamics: string[] } {
  const map = new Map<string, any>();
  const dynamics: string[] = [];
  try {
    const ast = parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
    traverseIds(ast, {
      JSXElement(path: any) {
        const opening = path.node.openingElement;
        const attrs = opening.attributes as any[];
        const idAttr = attrs.find(
          (a: any) => a.type === 'JSXAttribute' && a.name?.name === 'data-id' && a.value?.type === 'StringLiteral',
        );
        if (idAttr) {
          const id = (idAttr.value as any).value as string;
          if (id && !map.has(id)) map.set(id, path.node);
        } else {
          // P6 (iv): a data-id that is NOT a static literal is invisible to
          // IDS matching — record it so the verdict can name it.
          const dynAttr = attrs.find(
            (a: any) => a.type === 'JSXAttribute' && a.name?.name === 'data-id' && a.value,
          );
          if (dynAttr && dynamics.length < 3) {
            const s = (dynAttr.start as number | undefined) ?? null;
            const e = (dynAttr.end as number | undefined) ?? null;
            dynamics.push(s !== null && e !== null && e > s ? code.slice(s, e).trim().slice(0, 48) : 'data-id={…}');
          }
        }
      },
    });
  } catch {
    // parse error → vide, chaque id sera reporté manquant
  }
  return { map, dynamics };
}

function elementTextIds(el: any): string {
  let out = '';
  const walk = (node: any): void => {
    for (const c of (node.children ?? []) as any[]) {
      if (c.type === 'JSXText') out += c.value;
      else if (c.type === 'JSXExpressionContainer') {
        const e = c.expression;
        if (!e || e.type === 'JSXEmptyExpression') continue;
        if (e.type === 'StringLiteral') out += e.value;
        else if (e.type === 'TemplateLiteral') {
          for (const q of (e.quasis ?? []) as any[]) out += q.value.cooked ?? q.value.raw ?? '';
        }
      } else if (c.type === 'JSXElement') {
        walk(c);
      }
    }
  };
  walk(el);
  return out;
}

// ─── P6 (iv) — text honesty: static text is not the only content ──────────
// Pre-P6 `elementTextIds` above saw literal text only, so three large,
// legitimate families read as EMPTY (false negatives):
//   • dynamic expressions — `{quote}`, `{item.title}`, `{cond && 'x'}` (THE
//     canonical CMS/prop pattern `<p>{item.quote}</p>`);
//   • component instances — `<Hero title="Hello" />` carries text in PROPS;
//   • textish props — `<input placeholder="Email" />`, `<img alt="…" />`.
// A headless engine cannot decide a runtime branch, so any non-trivial
// expression counts as content (documented residual: a branch that renders
// nothing at runtime still reads as filled). Provably-empty expressions
// (`{null}`, `{undefined}`, `{false}`, `{true}`, `{''}`) stay empty.

/** True when a JSX child expression provably renders nothing. */
function isEmptyExpressionIds(e: any): boolean {
  if (!e) return true;
  switch (e.type) {
    case 'JSXEmptyExpression':
      return true;
    case 'NullLiteral':
      return true;
    case 'Identifier':
      return e.name === 'undefined';
    case 'BooleanLiteral':
      return true; // true AND false both render nothing in JSX
    case 'StringLiteral':
      return (e.value as string).trim() === '';
    case 'TemplateLiteral':
      return (
        (e.quasis ?? []).every((q: any) => ((q.value.cooked ?? q.value.raw ?? '') as string).trim() === '') &&
        (e.expressions?.length ?? 0) === 0
      );
    case 'NumericLiteral':
      return false; // {0} renders "0"
    default:
      return false; // refs, member/call/conditional/logical → dynamic content
  }
}

/** True when the element's subtree carries a non-trivial (dynamic) expression. */
function elementHasDynamicTextIds(el: any): boolean {
  let found = false;
  const walk = (node: any): void => {
    if (found) return;
    for (const c of (node.children ?? []) as any[]) {
      if (c.type === 'JSXExpressionContainer') {
        if (!isEmptyExpressionIds(c.expression)) {
          // StringLiteral/TemplateLiteral-with-text are static (handled by
          // elementTextIds) — only non-trivial expressions count as dynamic.
          const e = c.expression;
          if (e && e.type !== 'StringLiteral' && e.type !== 'TemplateLiteral' && e.type !== 'NumericLiteral') {
            found = true;
            return;
          }
        }
      } else if (c.type === 'JSXElement') {
        walk(c);
      }
      if (found) return;
    }
  };
  walk(el);
  return found;
}

/** Attributes that carry human text on elements without children text —
 *  instance props (`<Hero title="Hello" />`), inputs (`placeholder`,
 *  `value`), images (`alt`), labels (`title`, `aria-label`). A non-empty
 *  literal OR a dynamic expression both count as content. */
const TEXTISH_ATTRS = new Set(['title', 'value', 'placeholder', 'alt', 'aria-label']);

function elementPropTextIds(el: any): string {
  let out = '';
  const attrs = (el.openingElement?.attributes ?? []) as any[];
  for (const a of attrs) {
    if (a.type !== 'JSXAttribute' || a.name?.type !== 'JSXIdentifier') continue;
    if (!TEXTISH_ATTRS.has(a.name.name as string)) continue;
    const v = a.value;
    if (!v) continue;
    if (v.type === 'StringLiteral') out += v.value as string;
    else if (v.type === 'JSXExpressionContainer' && !isEmptyExpressionIds(v.expression)) out += '\u0000dynamic\u0000';
  }
  return out;
}

/** The filled predicate every text check uses: static text, dynamic
 *  expressions, or textish props — whichever carries content. */
function elementTextFilledIds(el: any): boolean {
  if (elementTextIds(el).trim().length > 0) return true;
  if (elementHasDynamicTextIds(el)) return true;
  if (elementPropTextIds(el).trim().length > 0) return true;
  return false;
}

function isHandlerAttrIds(name: string): boolean {
  return /^on(?:Click|Tap|Change|Submit|PointerDown|MouseDown)$/.test(name);
}

function isEmptyHandlerIds(expr: any): boolean {
  if (!expr) return false;
  if (expr.type === 'ArrowFunctionExpression' || expr.type === 'FunctionExpression') {
    const body = expr.body;
    if (body?.type === 'BlockStatement') return body.body.length === 0;
    return false;
  }
  return false;
}

function hasRealMechanismIds(el: any): boolean {
  const attrs = el.openingElement?.attributes ?? [];
  for (const attr of attrs as any[]) {
    if (attr.type !== 'JSXAttribute' || attr.name?.type !== 'JSXIdentifier') continue;
    const name = attr.name.name as string;
    if (isHandlerAttrIds(name)) {
      if (!attr.value) continue;
      if (attr.value.type === 'StringLiteral') {
        if ((attr.value.value as string).trim() !== '') return true;
      } else if (attr.value.type === 'JSXExpressionContainer') {
        const expr = attr.value.expression;
        if (!expr || expr.type === 'JSXEmptyExpression') continue;
        if (isEmptyHandlerIds(expr)) continue;
        if (expr.type === 'Identifier' && expr.name === 'undefined') continue;
        return true;
      }
    } else if (name === 'href') {
      let hrefVal: string | null = null;
      let isExpr = false;
      let exprType: string | null = null;
      let exprName: string | null = null;
      if (attr.value?.type === 'StringLiteral') hrefVal = attr.value.value as string;
      else if (attr.value?.type === 'JSXExpressionContainer') {
        const expr = attr.value.expression as any;
        if (expr?.type === 'StringLiteral') hrefVal = expr.value as string;
        else if (expr?.type === 'JSXEmptyExpression') continue;
        else if (expr) {
          isExpr = true;
          exprType = expr.type as string;
          if (expr.type === 'Identifier') exprName = expr.name as string;
        }
      }
      if (hrefVal !== null) {
        const trimmed = hrefVal.trim();
        if (trimmed !== '' && trimmed !== '#') return true;
        continue;
      }
      if (isExpr) {
        if (exprType === 'Identifier' && exprName === 'undefined') continue;
        return true;
      }
    }
  }
  return false;
}

function hasInertMechanismIds(el: any): boolean {
  const attrs = el.openingElement?.attributes ?? [];
  for (const attr of attrs as any[]) {
    if (attr.type !== 'JSXAttribute' || attr.name?.type !== 'JSXIdentifier') continue;
    const name = attr.name.name as string;
    if (isHandlerAttrIds(name)) {
      if (attr.value?.type === 'JSXExpressionContainer') {
        const expr = (attr.value as any).expression;
        if (isEmptyHandlerIds(expr)) return true;
      }
    } else if (name === 'href') {
      let hrefVal: string | null = null;
      if (attr.value?.type === 'StringLiteral') hrefVal = attr.value.value as string;
      else if (attr.value?.type === 'JSXExpressionContainer' && (attr.value.expression as any)?.type === 'StringLiteral')
        hrefVal = (attr.value.expression as any).value as string;
      if (hrefVal !== null && hrefVal.trim() === '#') return true;
      if (hrefVal !== null && hrefVal.trim() === '') return true;
    }
  }
  return false;
}

function getMechanismStateIds(el: any | null): MechanismState {
  if (!el) return 'absent';
  if (hasRealMechanismIds(el)) return 'wired';
  if (hasInertMechanismIds(el)) return 'noop';
  return 'fake';
}

export function verifyEffectIds(
  code: string,
  _request: string,
  hints: VerifyHints,
  scope = '',
): EffectVerdict {
  const nodeIds = (hints.node_ids ?? []).filter((id) => typeof id === 'string' && id.trim() !== '');
  const rawChecks = hints.checks ?? ['exists'];
  const checksRequested = (rawChecks.length > 0 ? rawChecks : ['exists']) as Array<'exists' | 'filled' | 'mechanism'>;
  trace.fn('verify:mode', { mode: 'ids', ids: nodeIds.length });
  if (nodeIds.length === 0) {
    return {
      satisfied: false,
      checks: [],
      missing: ['No node_ids provided for IDS verification.'],
      feedback: 'No node_ids provided for IDS verification.',
      states: [],
      concept: 'node-ids',
      scope,
    };
  }
  if (!code || !code.trim()) {
    const checks: VerifyCheck[] = [];
    const missing: string[] = [];
    const states: MechanismVerdict[] = [];
    for (const id of nodeIds) {
      for (const kind of checksRequested) {
        if (kind === 'exists') {
          checks.push({ label: `${id} exists`, present: false, filled: 0, count: 0, required: '1' });
          missing.push(`Missing node '${id}' — no element with data-id="${id}" found.`);
        } else if (kind === 'filled') {
          checks.push({ label: `${id} filled`, present: false, filled: 0, count: 0, required: '1' });
          missing.push(`Missing node '${id}' — cannot check filled, element not found.`);
        } else if (kind === 'mechanism') {
          checks.push({ label: `${id} mechanism`, present: false, filled: 0, count: 0, required: '1', state: 'absent' });
          states.push({ label: id, state: 'absent', fixHint: 'add a real href or an onClick with a handler — empty arrow or href="#" is inert.' });
          missing.push(`Missing node '${id}' — cannot check mechanism, element not found.`);
        }
      }
    }
    return { satisfied: false, checks, missing, feedback: missing[0] ?? 'The active file is empty — there is nothing to verify yet.', concept: 'node-ids', scope, states };
  }
  const { map: idMap, dynamics } = buildIdsMap(code);
  const checks: VerifyCheck[] = [];
  const missing: string[] = [];
  const states: MechanismVerdict[] = [];
  // P6 (iv): name dynamic identities once when anything is missing — the
  // requested static id may live behind a `data-id={…}`.
  const dynamicHint =
    dynamics.length > 0
      ? ` Note: the file has dynamic data-id(s) invisible to verification (${dynamics.join(', ')}) — prefer static kebab-case data-ids.`
      : '';
  let dynamicHintUsed = false;
  for (const id of nodeIds) {
    const el = idMap.get(id) ?? null;
    const exists = !!el;
    for (const kind of checksRequested) {
      if (kind === 'exists') {
        checks.push({ label: `${id} exists`, present: exists, filled: exists ? 1 : 0, count: exists ? 1 : 0, required: '1' });
        if (!exists) {
          const hint = !dynamicHintUsed ? dynamicHint : '';
          dynamicHintUsed = true;
          missing.push(`Missing node '${id}' — no element with data-id="${id}" found.${hint}`);
        }
      } else if (kind === 'filled') {
        // P6 (iv): static text OR dynamic expressions OR textish props —
        // `{quote}` / `<Hero title="Hi" />` / `placeholder=` all count.
        const filled = exists ? elementTextFilledIds(el) : false;
        checks.push({ label: `${id} filled`, present: filled, filled: filled ? 1 : 0, count: 1, required: '1' });
        if (!exists) missing.push(`Missing node '${id}' — cannot check filled, element not found.`);
        else if (!filled) missing.push(`${id} is empty — add the text content.`);
      } else if (kind === 'mechanism') {
        const state = getMechanismStateIds(el);
        checks.push({ label: `${id} mechanism`, present: state !== 'absent', filled: state === 'wired' ? 1 : 0, count: 1, required: '1', state });
        states.push({ label: id, state, fixHint: state === 'wired' ? '' : 'add a real href or an onClick with a handler — empty arrow or href="#" is inert.' });
        if (state !== 'wired') {
          if (state === 'absent') missing.push(`Missing node '${id}' — cannot check mechanism, element not found.`);
          else if (state === 'noop') missing.push(`${id} mechanism is not wired: empty handler or href="#" does nothing — add a real href or onClick handler.`);
          else if (state === 'fake') missing.push(`${id} is static: add an href or onClick to make it interactive.`);
          else missing.push(`${id} mechanism is ${state} — add a real wiring.`);
        }
      }
    }
  }
  const satisfied = missing.length === 0;
  const feedback = satisfied
    ? `Request satisfied: ${nodeIds.length} node(s) verified (${checksRequested.join(', ')}).`
    : missing[0];
  return { satisfied, checks, missing, feedback, states, concept: 'node-ids', scope };
}

// ─── Concept-AST mode (P2.3b — parser-based, moteur regex supprimé en P2.3b2) ───
// Toute la logique concept-AST vit ici. Le moteur regex historique a été
// supprimé (P2.3b2) : le routage IDS → concept-AST est la seule porte ; si le
// concept est irrésoluble, le verdict `no-concept` existant est retourné.
// Parse local minimal (Babel) réutilisant le même parseur que le chemin IDS
// (pas de parse canonique qui strip les handlers). Un seul parse par appel via
// parseASTOnce — la détection et l'évaluation partagent les mêmes nodes (pas de
// double parse).
//
// Détection: deriveSpec (réutilise KNOWN_ENTITY_WORDS + patterns "X section")
// + table CONCEPT_SYNONYMS explicite et extensible ci-dessus. Le groupe
// synonymique est bidirectionnel: "reviews" ↔ "testimonial", "banner" ↔ "hero",
// etc. La section est trouvée sur l'AST (traverse Babel) dont le rôle
// (data-id/data-name lowercased) commence par le concept OU un synonyme.
// Cartes/textes-clés/mécanisme: même logique que le chemin IDS mais appliquée
// aux éléments AST trouvés (elementTextIds / hasRealMechanismIds), avec les
// hints expected_roles / expected_count / key_texts conservés.

function parseASTOnce(code: string): any | null {
  try {
    return parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
  } catch {
    return null;
  }
}

interface ASTNodeInfo {
  node: any;
  id: string | null;
  name: string | null;
  role: string;
  start: number;
  end: number;
  /** P6 (iv): raw source of a DYNAMIC data-id/data-name
   *  (`data-id={item.id}`) — invisible to id matching, surfaced in missing. */
  dynamicIdExpr: string | null;
}

function collectASTNodes(ast: any, code = ''): ASTNodeInfo[] {
  const out: ASTNodeInfo[] = [];
  if (!ast) return out;
  traverseIds(ast, {
    JSXElement(path: any) {
      const node = path.node;
      const attrs = (node.openingElement?.attributes ?? []) as any[];
      let id: string | null = null;
      let name: string | null = null;
      let dynamicIdExpr: string | null = null;
      for (const a of attrs) {
        if (a.type !== 'JSXAttribute' || a.name?.type !== 'JSXIdentifier') continue;
        if (a.name.name === 'data-id' || a.name.name === 'data-name') {
          if (a.value?.type === 'StringLiteral') {
            if (a.name.name === 'data-id') id = a.value.value as string;
            else name = a.value.value as string;
          } else if (a.value && code && dynamicIdExpr === null) {
            // Dynamic identity (`data-id={x}`, template) — not matchable,
            // but worth naming in the verdict instead of silent absence.
            const s = (a.start as number | undefined) ?? null;
            const e = (a.end as number | undefined) ?? null;
            dynamicIdExpr =
              s !== null && e !== null && e > s
                ? code.slice(s, e).trim().slice(0, 48)
                : `${a.name.name}={…}`;
          }
        }
      }
      const role = `${id ?? ''} ${name ?? ''}`.toLowerCase();
      const start = (node.start as number | undefined) ?? 0;
      const end = (node.end as number | undefined) ?? start;
      out.push({ node, id, name, role, start, end, dynamicIdExpr });
    },
  });
  out.sort((a, b) => a.start - b.start);
  return out;
}

function descendantsOfAST(all: ASTNodeInfo[], parent: ASTNodeInfo): ASTNodeInfo[] {
  return all.filter((c) => c !== parent && c.start >= parent.start && c.end <= parent.end);
}

/**
 * P6 (iv) — term match on a role, tolerant to PREFIXED ids. Pre-P6 only the
 * `^term` anchor matched, so `data-id="page-testimonials"` (concept as a
 * hyphenated SUFFIX) never matched `testimonial`. Now a term also matches as
 * a full hyphen-separated segment of the id's first token
 * (`page-testimonials` → segments [page, testimonials] → hit), plural-aware.
 * Still no substring matching (`mytestimonials` stays a miss).
 */
function roleMatchesTerm(role: string, term: string): boolean {
  const t = term.toLowerCase();
  if (new RegExp(`^${escapeRegExp(t)}s?(?:\\s|$|-)`, 'i').test(role)) return true;
  const first = role.split(' ')[0].toLowerCase();
  return first
    .split('-')
    .some((seg) => seg === t || seg === `${t}s`);
}

function findSectionAST(nodes: ASTNodeInfo[], spec: VerifySpec, group: string[]): ASTNodeInfo | undefined {
  const terms = group.length ? group : [spec.concept];
  return nodes.find((n) => terms.some((t) => roleMatchesTerm(n.role, t)));
}

function cardElementsAST(all: ASTNodeInfo[], section: ASTNodeInfo, spec: VerifySpec, group: string[]): ASTNodeInfo[] {
  const inside = descendantsOfAST(all, section).filter((e) => !isExcludedRole(e.role));
  const expandedMatchers = [...spec.cardMatchers];
  for (const syn of group) {
    if (syn.toLowerCase() === spec.concept.toLowerCase()) continue;
    expandedMatchers.push(new RegExp(`\\b${escapeRegExp(syn)}s?\\b`, 'i'));
  }
  const matches = (e: ASTNodeInfo) => expandedMatchers.some((re) => re.test(e.role));
  const numbered = inside.filter((e) => matches(e) && /-\d+$/.test(e.id ?? ''));
  let candidates: ASTNodeInfo[];
  if (numbered.length > 0) {
    candidates = numbered;
  } else {
    candidates = inside.filter(
      (e) =>
        matches(e) &&
        spec.keyTexts.length > 0 &&
        descendantsOfAST(all, e).some((x) => spec.keyTexts.some((k) => k.re.test(x.role))),
    );
  }
  return candidates.filter((c) => !candidates.some((o) => o !== c && o.start <= c.start && o.end >= c.end));
}

function keyStatusAST(
  card: ASTNodeInfo,
  all: ASTNodeInfo[],
  key: KeyTextSpec,
  isFirstKey: boolean,
): KeyStatus {
  const leaves = [card, ...descendantsOfAST(all, card)].filter(
    (e) => !isExcludedRole(e.role) && key.re.test(e.role),
  );
  // P6 (iv): dynamic/prop content counts — `{item.quote}` is filled.
  if (leaves.some((l) => elementTextFilledIds(l.node))) return 'filled';
  if (leaves.length > 0) return 'empty';
  if (isFirstKey && elementTextFilledIds(card.node)) return 'filled';
  return 'missing';
}

type KeyStatus = 'filled' | 'empty' | 'missing';

// ─── AST mechanism helpers (parser-based, no RegExp source of truth) ───────

function getTagName(node: ASTNodeInfo): string {
  const nameNode: any = node.node.openingElement?.name;
  if (!nameNode) return '';
  if (nameNode.type === 'JSXIdentifier') return nameNode.name as string;
  if (nameNode.type === 'JSXMemberExpression') {
    const obj: any = nameNode.object;
    const prop: any = nameNode.property;
    if (obj?.type === 'JSXIdentifier' && prop?.type === 'JSXIdentifier') {
      return `${obj.name}.${prop.name}`;
    }
  }
  return '';
}

function hasAttr(node: ASTNodeInfo, attrName: string): boolean {
  const attrs: any[] = node.node.openingElement?.attributes ?? [];
  const low = attrName.toLowerCase();
  return attrs.some((a: any) => a.type === 'JSXAttribute' && a.name?.type === 'JSXIdentifier' && a.name.name.toLowerCase() === low);
}

function hasAttrContains(node: ASTNodeInfo, substr: string): boolean {
  const low = substr.toLowerCase();
  const attrs: any[] = node.node.openingElement?.attributes ?? [];
  return attrs.some((a: any) => a.type === 'JSXAttribute' && a.name?.type === 'JSXIdentifier' && a.name.name.toLowerCase().includes(low));
}

function isMotionRealNode(node: ASTNodeInfo): boolean {
  if (hasAttr(node, 'whileInView') || hasAttr(node, 'whileHover') || hasAttr(node, 'whileTap') || hasAttr(node, 'data-scroll-fx') || hasAttr(node, 'data-loop')) return true;
  const tag = getTagName(node);
  if (tag.startsWith('motion.')) return true;
  return false;
}

function isMotionPartialNode(node: ASTNodeInfo): boolean {
  return hasAttr(node, 'animate') || hasAttr(node, 'initial');
}

function isFormTagNode(node: ASTNodeInfo): boolean {
  return getTagName(node).toLowerCase() === 'form';
}

function hasOnSubmitReal(node: ASTNodeInfo): boolean {
  const attrs: any[] = node.node.openingElement?.attributes ?? [];
  for (const a of attrs as any[]) {
    if (a.type !== 'JSXAttribute' || a.name?.type !== 'JSXIdentifier' || a.name.name !== 'onSubmit') continue;
    if (!a.value) continue;
    if (a.value.type === 'StringLiteral') {
      if ((a.value.value as string).trim() !== '') return true;
      continue;
    }
    if (a.value.type === 'JSXExpressionContainer') {
      const expr: any = a.value.expression;
      if (!expr || expr.type === 'JSXEmptyExpression') continue;
      if (isEmptyHandlerIds(expr)) continue;
      if (expr.type === 'Identifier' && expr.name === 'undefined') continue;
      return true;
    }
  }
  return false;
}

function hasOnSubmitInert(node: ASTNodeInfo): boolean {
  const attrs: any[] = node.node.openingElement?.attributes ?? [];
  for (const a of attrs as any[]) {
    if (a.type !== 'JSXAttribute' || a.name?.type !== 'JSXIdentifier' || a.name.name !== 'onSubmit') continue;
    if (a.value?.type === 'JSXExpressionContainer') {
      const expr: any = a.value.expression;
      if (isEmptyHandlerIds(expr)) return true;
    }
  }
  return false;
}

function isToggleRealNode(node: ASTNodeInfo): boolean {
  if (hasRealMechanismIds(node.node)) return true;
  if (hasAttrContains(node, 'data-overlay')) return true;
  if (hasAttr(node, 'variants') || hasAttr(node, 'initialVariant') || hasAttr(node, 'setVariant') || hasAttr(node, 'animate')) return true;
  return false;
}

function isCTARealNode(node: ASTNodeInfo): boolean {
  if (hasRealMechanismIds(node.node)) return true;
  if (hasAttrContains(node, 'data-overlay')) return true;
  if (hasAttr(node, 'variants') || hasAttr(node, 'initialVariant') || hasAttr(node, 'setVariant') || hasAttr(node, 'whileHover')) return true;
  if (hasAttrContains(node, 'submit')) return true;
  return false;
}

function isOverlayRealNode(node: ASTNodeInfo): boolean {
  if (hasAttrContains(node, 'data-overlay')) return true;
  const tag = getTagName(node);
  if (tag === 'AnimatePresence') return true;
  // useState(false) is not an attribute; ignored — attribute-based check suffices for fixtures
  if (hasRealMechanismIds(node.node)) return true;
  return false;
}

function isInteractiveRealNode(node: ASTNodeInfo): boolean {
  if (hasRealMechanismIds(node.node)) return true;
  if (hasAttrContains(node, 'data-overlay')) return true;
  if (hasAttr(node, 'variants') || hasAttr(node, 'initialVariant') || hasAttr(node, 'setVariant')) return true;
  if (isMotionRealNode(node)) return true;
  if (isFormTagNode(node) || hasAttrContains(node, 'data-form')) return true;
  if (hasAttr(node, 'onSubmit')) return true;
  return false;
}

function evaluateMechanismAST(
  allNodes: ASTNodeInfo[],
  section: ASTNodeInfo | undefined,
  mech: MechanismSpec,
  request: string,
): MechanismVerdict {
  const scopeNodes: ASTNodeInfo[] = mech.scanScope === 'whole' ? allNodes : section ? [section, ...descendantsOfAST(allNodes, section)] : [];
  if (!section && mech.scanScope === 'section') {
    return { label: mech.label, state: 'absent', fixHint: mech.fixHint };
  }

  let hasReal = false;
  let hasPartial = false;
  let hasInert = false;

  for (const n of scopeNodes) {
    switch (mech.kind) {
      case 'toggle':
        if (!hasReal && isToggleRealNode(n)) hasReal = true;
        if (!hasInert && hasInertMechanismIds(n.node)) hasInert = true;
        break;
      case 'cta':
        if (!hasReal && isCTARealNode(n)) hasReal = true;
        if (!hasInert && hasInertMechanismIds(n.node)) hasInert = true;
        break;
      case 'form':
        if (!hasReal && hasOnSubmitReal(n)) hasReal = true;
        if (!hasPartial && (isFormTagNode(n) || hasAttrContains(n, 'data-form'))) hasPartial = true;
        if (!hasInert && hasOnSubmitInert(n)) hasInert = true;
        // also consider generic empty handler as inert for form
        if (!hasInert && hasInertMechanismIds(n.node)) hasInert = true;
        break;
      case 'overlay':
        if (!hasReal && isOverlayRealNode(n)) hasReal = true;
        if (!hasInert && hasInertMechanismIds(n.node)) hasInert = true;
        break;
      case 'motion':
        if (!hasReal && isMotionRealNode(n)) hasReal = true;
        if (!hasPartial && isMotionPartialNode(n)) hasPartial = true;
        if (!hasInert && hasInertMechanismIds(n.node)) hasInert = true;
        break;
      case 'interactive':
        if (!hasReal && isInteractiveRealNode(n)) hasReal = true;
        if (!hasInert && hasInertMechanismIds(n.node)) hasInert = true;
        break;
      case 'expected': {
        const tokens = mech.expectedTokens ?? [];
        const lowTokens = tokens.map((t) => t.toLowerCase());
        // check each token
        for (const tok of lowTokens) {
          // attribute name contains token
          const attrs: any[] = n.node.openingElement?.attributes ?? [];
          for (const a of attrs as any[]) {
            if (a.type !== 'JSXAttribute' || a.name?.type !== 'JSXIdentifier') continue;
            const aname: string = a.name.name as string;
            if (aname.toLowerCase().includes(tok)) {
              if (isHandlerAttrIds(aname)) {
                if (a.value?.type === 'JSXExpressionContainer' && isEmptyHandlerIds(a.value.expression)) {
                  hasInert = true;
                } else if (a.value) {
                  // need to check real: non-empty handler or href not '#'
                  if (aname.toLowerCase() === 'href') {
                    let hrefVal: string | null = null;
                    if (a.value?.type === 'StringLiteral') hrefVal = a.value.value as string;
                    else if (a.value?.type === 'JSXExpressionContainer' && (a.value.expression as any)?.type === 'StringLiteral') hrefVal = (a.value.expression as any).value as string;
                    if (hrefVal !== null) {
                      const t2 = hrefVal.trim();
                      if (t2 !== '' && t2 !== '#') hasReal = true;
                      else hasInert = true;
                    } else if (a.value?.type === 'JSXExpressionContainer') {
                      const expr: any = a.value.expression;
                      if (expr && expr.type !== 'JSXEmptyExpression' && !(expr.type === 'Identifier' && expr.name === 'undefined')) {
                        if (!isEmptyHandlerIds(expr)) hasReal = true;
                      }
                    }
                  } else {
                    // handler real if not empty
                    const expr = a.value.type === 'JSXExpressionContainer' ? a.value.expression : null;
                    if (expr && !isEmptyHandlerIds(expr)) hasReal = true;
                    else if (a.value.type === 'StringLiteral' && (a.value.value as string).trim() !== '') hasReal = true;
                  }
                }
              } else if (aname.toLowerCase() === 'href') {
                let hrefVal: string | null = null;
                if (a.value?.type === 'StringLiteral') hrefVal = a.value.value as string;
                else if (a.value?.type === 'JSXExpressionContainer' && (a.value.expression as any)?.type === 'StringLiteral')
                  hrefVal = (a.value.expression as any).value as string;
                if (hrefVal !== null) {
                  const t2 = hrefVal.trim();
                  if (t2 !== '' && t2 !== '#') hasReal = true;
                  else hasInert = true;
                } else if (a.value) {
                  hasReal = true;
                }
              } else {
                hasReal = true;
              }
            }
          }
          // tag contains token
          const tag = getTagName(n).toLowerCase();
          if (tag.includes(tok)) hasReal = true;
        }
        // generic inert detection for expected (dead handler / href #) if token is handler/href related
        if (!hasInert && hasInertMechanismIds(n.node)) {
          // only count inert if token list includes a handler/href token that matches the inert attr
          const inertAttrs: any[] = n.node.openingElement?.attributes ?? [];
          for (const a of inertAttrs as any[]) {
            if (a.type !== 'JSXAttribute' || a.name?.type !== 'JSXIdentifier') continue;
            const aname: string = a.name.name as string;
            const lowAn = aname.toLowerCase();
            const matchesToken = lowTokens.some((t) => lowAn.includes(t) || t.includes(lowAn));
            // check if this attr is inert
            if (isHandlerAttrIds(aname) && a.value?.type === 'JSXExpressionContainer' && isEmptyHandlerIds(a.value.expression)) {
              if (matchesToken || lowTokens.includes('onclick') || lowTokens.includes('onClick')) hasInert = true;
            }
            if (aname.toLowerCase() === 'href') {
              let hrefVal: string | null = null;
              if (a.value?.type === 'StringLiteral') hrefVal = a.value.value as string;
              else if (a.value?.type === 'JSXExpressionContainer' && (a.value.expression as any)?.type === 'StringLiteral')
                hrefVal = (a.value.expression as any).value as string;
              if (hrefVal !== null && (hrefVal.trim() === '#' || hrefVal.trim() === '')) {
                if (matchesToken || lowTokens.includes('href')) hasInert = true;
              }
            }
          }
        }
        break;
      }
      default:
        break;
    }
    if (hasReal) break; // real dominates
  }

  let state: MechanismState;
  if (hasReal) {
    state = 'wired';
  } else if (hasPartial) {
    state = mech.misScopeOnScroll ? (WANT_SCROLL_RE.test(request) ? 'mis-scoped' : 'fake') : 'noop';
  } else if (hasInert) {
    state = 'noop';
  } else {
    state = mech.species ? 'fake' : 'absent';
  }
  // For expected with no section but whole? Already handled absent above. For expected with section missing, we already returned absent.
  // For motion with scanScope whole, if no real but no section, still evaluate whole file; absent handled via species false above.
  // Edge: motion with whole scope and no section should not be forced absent; our early absent only for section scope.
  // So for motion whole, we correctly compute hasReal etc over allNodes.

  return { label: mech.label, state, fixHint: mech.fixHint };
}

function discoverConceptViaAST(request: string, hints: VerifyHints, nodes: ASTNodeInfo[]): string | null {
  if (hints.expected_roles?.[0]) {
    const c = singularOf(hints.expected_roles[0].trim().toLowerCase());
    const group = getConceptSynonymGroup(c);
    const has = nodes.some((n) => group.some((t) => roleMatchesTerm(n.role, t)));
    if (has) return c;
  }
  const words = (request.toLowerCase().match(/\b[a-z][a-z-]*\b/g) ?? []).map((w) => singularOf(w));
  for (const node of nodes) {
    const firstToken = node.role.split(' ')[0].split('-')[0].trim().toLowerCase();
    const nodeConcept = singularOf(firstToken);
    if (!nodeConcept) continue;
    const nodeGroup = getConceptSynonymGroup(nodeConcept);
    for (const w of words) {
      const wGroup = getConceptSynonymGroup(w);
      const intersect = wGroup.some((v) => nodeGroup.includes(v)) || nodeGroup.includes(w) || wGroup.includes(nodeConcept);
      // also handle "block/section/area/component/container/wrapper" hint: if request contains nodeConcept or synonym anywhere
      if (intersect) return nodeGroup[0];
    }
  }
  // Also try phrase "X block" / "X section" etc — capture word before those nouns
  const sectionLike = request.match(/([A-Za-z][A-Za-z-]*)\s+(?:section|block|area|component|container|wrapper)\b/i);
  if (sectionLike) {
    const w = singularOf(sectionLike[1].trim().toLowerCase());
    const group = getConceptSynonymGroup(w);
    if (nodes.some((n) => group.some((t) => roleMatchesTerm(n.role, t)))) return group[0];
  }
  return null;
}

function canResolveConceptAST(code: string, request: string, hints: VerifyHints): boolean {
  if (!code || !code.trim()) return false;
  const spec = deriveSpec(request, hints);
  const ast = parseASTOnce(code);
  const nodes = ast ? collectASTNodes(ast) : [];
  if (nodes.length === 0) return false;
  if (spec) {
    const group = getConceptSynonymGroup(spec.concept);
    if (findSectionAST(nodes, spec, group)) return true;
    return false;
  }
  const discovered = discoverConceptViaAST(request, hints, nodes);
  return !!discovered;
}

/** Concept-AST engine — même shape de sortie que le moteur regex, mais tout
 *  sur l'AST (traverse Babel local) : section/cartes/textes-clés/mécanisme
 *  via elementTextIds / hasRealMechanismIds. Réutilise deriveSpec pour
 *  concept/count/keyTexts/mechanism et CONCEPT_SYNONYMS pour élargir la
 *  recherche de section/cartes. Ne re-parse pas deux fois (parseASTOnce + un
 *  seul collect). */
export function verifyEffectConceptAST(
  code: string,
  request: string,
  hints: VerifyHints = {},
  scope = '',
): EffectVerdict {
  let spec = deriveSpec(request, hints);
  let ast = parseASTOnce(code);
  let nodes = ast ? collectASTNodes(ast, code) : [];
  if (!spec) {
    const discovered = discoverConceptViaAST(request, hints, nodes);
    if (discovered) {
      const synthHints: VerifyHints = { ...hints, expected_roles: [discovered, ...(hints.expected_roles?.slice(1) ?? [])] };
      spec = deriveSpec(request, synthHints);
    }
  }
  if (!spec) {
    trace.fn('verify:mode', { mode: 'concept-ast', result: 'no-concept', request });
    return {
      satisfied: false,
      checks: [],
      missing: ['No verifiable entity — the request names no "X section" (or pass expected_roles, e.g. ["testimonials", "quote", "author"]).'],
      feedback: 'Cannot verify the request — name the entity in the request or pass expected_roles.',
      inconclusive: true,
      concept: '',
      scope,
      states: [],
    };
  }
  if (!code || !code.trim()) {
    trace.fn('verify:mode', { mode: 'concept-ast', concept: spec.concept, result: 'empty-code' });
    return {
      satisfied: false,
      checks: [],
      missing: ['The active file is empty — there is nothing to verify yet.'],
      feedback: 'The active file is empty — build the content first, then verify again.',
      concept: spec.concept,
      scope,
      states: [],
    };
  }
  if (nodes.length === 0) {
    // parse failed -> treat as no section (fallback will handle, but give AST verdict)
    trace.fn('verify:mode', { mode: 'concept-ast', concept: spec.concept, result: 'no-section-parse-fail' });
    const mechanism = spec.mechanism ? evaluateMechanismAST(nodes, undefined, spec.mechanism, request) : null;
    const sectionCheck: VerifyCheck = { label: `${spec.label} section`, present: false, filled: 0, count: 0, required: '1' };
    const checks: VerifyCheck[] = [sectionCheck, ...(mechanism ? [mechanismCheck(mechanism)] : [])];
    const missing = [`No ${spec.label} section found (expected an element whose data-id/data-name starts with "${spec.label}").`];
    if (mechanism) missing.push(mechanismMissing(mechanism));
    const mechBlocks = mechanism && mechanism.state !== 'wired';
    return {
      satisfied: false,
      checks,
      missing,
      feedback: mechBlocks ? mechanismFeedback(mechanism!) : `No ${spec.label} section found yet — create it and fill it, then verify again.`,
      concept: spec.concept,
      scope,
      states: mechanism ? [mechanism] : [],
    };
  }
  const group = getConceptSynonymGroup(spec.concept);
  const section = findSectionAST(nodes, spec, group);
  const mechanism = spec.mechanism ? evaluateMechanismAST(nodes, section, spec.mechanism, request) : null;
  const sectionCheck: VerifyCheck = {
    label: `${spec.label} section`,
    present: !!section,
    filled: section ? 1 : 0,
    count: section ? 1 : 0,
    required: '1',
  };
  if (!section) {
    trace.fn('verify:mode', { mode: 'concept-ast', concept: spec.concept, result: 'no-section' });
    const checks: VerifyCheck[] = [sectionCheck, ...(mechanism ? [mechanismCheck(mechanism)] : [])];
    const missing = [`No ${spec.label} section found (expected an element whose data-id/data-name starts with "${spec.label}").`];
    // P6 (iv): dynamic identities are invisible to matching — name them
    // instead of letting the section silently "not exist".
    const dynamics = nodes.map((n) => n.dynamicIdExpr).filter((d): d is string => d !== null).slice(0, 3);
    if (dynamics.length > 0) {
      missing.push(
        `Note: the file has dynamic data-id(s) invisible to verification (${dynamics.join(', ')}) — prefer static kebab-case data-ids so sections stay verifiable.`,
      );
    }
    if (mechanism) missing.push(mechanismMissing(mechanism));
    const mechBlocks = mechanism && mechanism.state !== 'wired';
    return {
      satisfied: false,
      checks,
      missing,
      feedback: mechBlocks ? mechanismFeedback(mechanism!) : `No ${spec.label} section found yet — create it and fill it, then verify again.`,
      concept: spec.concept,
      scope,
      states: mechanism ? [mechanism] : [],
    };
  }
  const cards = cardElementsAST(nodes, section, spec, group);
  const requiresCards = spec.count !== null || spec.keyTexts.length > 0;
  const keyTallies: Array<{ key: KeyTextSpec; filledCount: number; empties: ASTNodeInfo[]; misses: ASTNodeInfo[] }> = spec.keyTexts.map((key, idx) => {
    const statuses = cards.map((c) => keyStatusAST(c, nodes, key, idx === 0));
    return {
      key,
      filledCount: statuses.filter((s) => s === 'filled').length,
      empties: statuses.map((s, i) => ({ s, card: cards[i] })).filter((x) => x.s === 'empty').map((x) => x.card),
      misses: statuses.map((s, i) => ({ s, card: cards[i] })).filter((x) => x.s === 'missing').map((x) => x.card),
    };
  });
  const missing: string[] = [];
  if (spec.count && cards.length < spec.count.min) {
    missing.push(`${spec.label} section exists but has ${cards.length}/${spec.count.min} ${spec.unitLabel} — add ${spec.count.min - cards.length} more.`);
  } else if (spec.count?.exact && cards.length > spec.count.max) {
    missing.push(`${spec.label} section has ${cards.length}/${spec.count.max} ${spec.unitLabel} — the request asked for exactly ${spec.count.max}.`);
  } else if (requiresCards && cards.length === 0) {
    missing.push(`${spec.label} section exists but has no ${spec.unitLabel} in it yet.`);
  }
  for (const t of keyTallies) {
    for (const card of t.empties) missing.push(`${card.id} ${t.key.label} is empty — add the ${t.key.label} text.`);
    for (const card of t.misses) missing.push(`${card.id} has no ${t.key.label} marker — add the ${t.key.label} text.`);
  }
  if (mechanism && mechanism.state !== 'wired') missing.push(mechanismMissing(mechanism));
  const checks: VerifyCheck[] = [sectionCheck];
  if (mechanism) checks.push(mechanismCheck(mechanism));
  if (requiresCards) {
    const withKeyIssues = keyTallies.reduce((acc, t) => acc + t.empties.length + t.misses.length, 0);
    checks.push({
      label: `${spec.label} ${spec.unitLabel}`,
      present: cards.length > 0,
      filled: cards.length - withKeyIssues,
      count: cards.length,
      required: countString(spec.count),
    });
  }
  for (const t of keyTallies) {
    checks.push({
      label: `${spec.unitLabel} ${t.key.label}`,
      present: true,
      filled: t.filledCount,
      count: cards.length,
      required: 'every card',
    });
  }
  let satisfied = true;
  if (spec.count) {
    satisfied &&= spec.count.exact ? cards.length === spec.count.min : cards.length >= spec.count.min;
  }
  if (requiresCards) {
    satisfied &&= cards.length > 0;
    for (const t of keyTallies) satisfied &&= t.filledCount === cards.length;
  }
  if (mechanism) satisfied &&= mechanism.state === 'wired';
  const states: MechanismVerdict[] = mechanism ? [mechanism] : [];
  // feedback: reuse composeFeedback logic adapted to AST cards (ids are same shape)
  let feedback: string;
  if (satisfied) {
    feedback = `Request satisfied: ${spec.label} section with ${cards.length} filled ${spec.unitLabel}.`;
  } else if (mechanism && mechanism.state !== 'wired') {
    feedback = mechanismFeedback(mechanism);
  } else if (spec.count && cards.length < spec.count.min) {
    feedback = `${spec.label} section exists but has ${cards.length}/${spec.count.min} ${spec.unitLabel} — add ${spec.count.min - cards.length} more.`;
  } else if (spec.count?.exact && cards.length > spec.count.max) {
    feedback = `${spec.label} section has ${cards.length}/${spec.count.max} ${spec.unitLabel} — the request asked for exactly ${spec.count.max}.`;
  } else if (cards.length === 0) {
    feedback = `${spec.label} section exists but has no ${spec.unitLabel} in it yet — build them, then verify again.`;
  } else {
    const empties = keyTallies.reduce((acc, t) => acc + t.empties.length, 0);
    if (empties > 0) {
      const first = keyTallies.find((t) => t.empties.length > 0);
      const label = first?.key.label ?? 'content';
      const plural = empties > 1;
      feedback = `Structure exists but ${empties} ${label}${plural ? 's are' : ' is'} empty — fill ${plural ? 'them' : 'it'}, then verify again.`;
    } else {
      const miss = keyTallies.find((t) => t.misses.length > 0);
      if (miss) {
        feedback = `Structure exists but ${miss.misses[0].id} has no ${miss.key.label} marker — add the ${miss.key.label} text.`;
      } else {
        feedback = 'Request not yet satisfied — see missing for what to correct.';
      }
    }
  }
  trace.fn('verify:mode', { mode: 'concept-ast', concept: spec.concept, cards: cards.length, keyTexts: spec.keyTexts.length, mechanism: mechanism?.state ?? null, satisfied });
  return { satisfied, checks, missing, feedback, states, concept: spec.concept, scope };
}

/** The engine. Pure over the code string — headless, deterministic. Never
 *  throws; every non-verifiable input (no concept, empty code) yields an
 *  informative not-satisfied verdict instead. */
export function verifyEffect(
  code: string,
  request: string,
  hints: VerifyHints = {},
  scope = '',
): EffectVerdict {
  if (hints?.node_ids?.length) return verifyEffectIds(code, request, hints, scope);
  if (canResolveConceptAST(code, request, hints)) {
    return verifyEffectConceptAST(code, request, hints, scope);
  }
  // No regex fallback — parser-based only. If concept-AST cannot resolve,
  // return the existing `no-concept` verdict (same shape/message as before).
  const spec = deriveSpec(request, hints);
  if (!spec) {
    trace.fn('verify:mode', { mode: 'concept-ast', result: 'no-concept', request });
    return {
      satisfied: false,
      checks: [],
      missing: [
        'No verifiable entity — the request names no "X section" (or pass expected_roles, e.g. ["testimonials", "quote", "author"]).',
      ],
      feedback: 'Cannot verify the request — name the entity in the request or pass expected_roles.',
      inconclusive: true,
      concept: '',
      scope,
      states: [],
    };
  }
  // concept decidable but no AST section found → delegate to concept-AST for a
  // consistent "no-section" verdict (parser-based, no regex).
  return verifyEffectConceptAST(code, request, hints, scope);
}

// ─── The tool ───────────────────────────────────────────────────────────────


function ok(data: unknown): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function fail(message: string): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

export const verifyEffectTool: AgentTool = {
  name: 'verify_effect',
  description:
    'VERIFIES whether a REQUEST actually landed in the active file — headless, reads the file code (no canvas, no parser). Runs a role-based structural scan (data-id / data-name): finds the section the request talks about, counts its cards/items, checks every expected text leaf is non-empty, AND — for INTERACTIVE requests (FAQ/accordion/tabs, CTA/button, form, modal/overlay, or explicit motion/appear/hover) — requires a REAL mechanism (an onClick/useState toggle, an href, an onSubmit, whileInView/whileHover/data-loop). Returns { satisfied, checks: [{label, present, filled, count, required, state?}], missing: [actionable], feedback: "…", states: [{label, state}] } — state is one of wired | fake | noop | mis-scoped | absent. e.g. feedback "FAQ/accordion toggle is visual-only: no real mechanism found — build the toggle with an onClick/onTap handler that flips state (addPageInteraction) or a 2-state variant (set_variant) — a visual-only + or chevron carries no mechanism." A decorative FAQ with "+" icons or a styled CTA div WITHOUT any handler/href is NOT satisfied. Pass ONE request per call (one section/entity), in the user\'s wording, e.g. verify_effect(request: "Add a testimonials section with 2-3 cards, each with a quote and the name of the person", expected_roles: ["testimonials", "quote", "author"]) — expected_roles[0] is the section concept, the rest are content markers. Optional hints: expected_count (how many cards/items the request asks for), key_texts (the text-leaf roles that must be filled inside each card — "quote", "author", "title", "description"), expected_mechanism (tokens a required interactive mechanism must include — e.g. ["onClick", "useState"], ["href"], ["onSubmit"], ["whileInView"]; auto-detected from the request when omitted). Without hints the request text alone is parsed (X section, numbers, quote/author/title/description words, interactive-role words). Decorative spacers are never content and never flagged; decoration is never a mechanis... (line truncated to 2000 chars)',
  inputSchema: {
    request: z.string().describe('The user request to verify, in the user\'s wording, e.g. "Add a testimonials section with 2-3 cards, each with a quote and the name of the person"'),
    expected_roles: z
      .array(z.string())
      .optional()
      .describe('Role markers (data-id/data-name substrings) for the requested entity. The first is the section concept, the rest are content markers — e.g. ["testimonials", "quote", "author"].'),
    expected_count: z
      .number()
      .optional()
      .describe('How many cards/items the request asks for — e.g. 3. The request text is parsed when omitted.'),
    key_texts: z
      .array(z.string())
      .optional()
      .describe('Text-leaf roles that must be FILLED inside each card — e.g. ["quote", "author"]. Derived from the request when omitted.'),
    expected_mechanism: z
      .array(z.string())
      .optional()
      .describe('Mechanism tokens the section must carry for an INTERACTIVE request — e.g. ["onClick", "useState"], ["href"], ["onSubmit"], ["whileInView"]. Forced when set; auto-detected from the request when omitted (FAQ/accordion/tabs/toggle, CTA/button, form, modal/overlay, motion/appear/hover/interactive).'),
    node_ids: z
      .array(z.string())
      .optional()
      .describe('When present and non-empty, IDS mode: verify these data-ids via AST (instead of concept/regex). See verifyEffectIds.'),
    checks: z
      .array(z.enum(['exists', 'filled', 'mechanism']))
      .optional()
      .describe('Per-node checks for IDS mode — subset of exists/filled/mechanism, defaults to ["exists"] when node_ids is set.'),
  },
  category: 'meta',
  async execute(args, ctx) {
    const request = typeof args.request === 'string' ? args.request.trim() : '';
    if (!request) return fail('Missing request.');
    const activePath = resolveToolFile(ctx);
    const code = readToolFile(ctx, activePath) ?? '';
    const hints: VerifyHints = {
      expected_roles: (args.expected_roles as string[] | undefined)?.filter((r) => typeof r === 'string') ?? undefined,
      expected_count: typeof args.expected_count === 'number' ? args.expected_count : undefined,
      key_texts: (args.key_texts as string[] | undefined)?.filter((k) => typeof k === 'string') ?? undefined,
      expected_mechanism: (args.expected_mechanism as string[] | undefined)?.filter((t) => typeof t === 'string') ?? undefined,
      node_ids: (args.node_ids as string[] | undefined)?.filter((r) => typeof r === 'string') ?? undefined,
      checks: (args.checks as Array<'exists' | 'filled' | 'mechanism'> | undefined)?.filter((c) => c === 'exists' || c === 'filled' || c === 'mechanism') as Array<'exists' | 'filled' | 'mechanism'> | undefined,
    };
    trace.action('agent-tool:verify_effect', { request, file: activePath, codeBytes: code.length, hints });
    const verdict = verifyEffect(code, request, hints, activePath);
    return ok(verdict);
  },
};
