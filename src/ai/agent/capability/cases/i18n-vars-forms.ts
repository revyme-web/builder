// Localization, page variables, interactions & forms — audit §9.
import type { CapabilityCase } from '../harness';
import { HOME } from '../fixture';

const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

export const I18N_VARS_FORMS_CASES: CapabilityCase[] = [
  {
    id: 'i18n-vars-forms/variable-and-interaction', domain: 'i18n-vars-forms', status: 'supported',
    feature: 'A page variable set by a click',
    ask: 'clicking the first card should open the menu',
    calls: [
      { tool: 'set_page_variable', args: { name: 'menuOpen', type: 'boolean', value: 'false' } },
      { tool: 'set_page_interaction', args: { node_id: 'card-1', trigger: 'click', variable: 'menuOpen', value: 'true' } },
    ],
    expect: (w) => {
      const code = w.read(HOME) ?? '';
      must(/useState\(false\)/.test(code) && /setMenuOpen/.test(code), 'no menuOpen useState + setter');
      must(/onClick=\{\(\) => setMenuOpen\(true\)\}/.test(w.tag('card-1')), 'card-1 has no onClick setting menuOpen');
    },
  },
  {
    id: 'i18n-vars-forms/hover-interaction', domain: 'i18n-vars-forms', status: 'supported',
    feature: 'Enter / leave interactions',
    ask: 'track whether the mouse is over the hero',
    calls: [
      { tool: 'set_page_variable', args: { name: 'heroHot', type: 'boolean', value: 'false' } },
      { tool: 'set_page_interaction', args: { node_id: 'hero', trigger: 'mouseEnter', variable: 'heroHot', value: 'true' } },
      { tool: 'set_page_interaction', args: { node_id: 'hero', trigger: 'mouseLeave', variable: 'heroHot', value: 'false' } },
    ],
    expect: (w) => {
      const tag = w.tag('hero');
      must(/onMouseEnter=/.test(tag) && /onMouseLeave=/.test(tag), 'enter / leave handlers missing');
    },
  },
  {
    id: 'i18n-vars-forms/number-variable', domain: 'i18n-vars-forms', status: 'supported',
    feature: 'A number variable',
    ask: 'add a counter to the page',
    calls: [{ tool: 'set_page_variable', args: { name: 'count', type: 'number', value: '0' } }],
    expect: (w) => must(/"name": "count"[\s\S]*"type": "number"/.test(w.read(HOME) ?? ''), 'count is not declared'),
  },
  {
    id: 'i18n-vars-forms/form-wired', domain: 'i18n-vars-forms', status: 'supported',
    feature: 'A form that actually submits',
    ask: 'add a contact form with an email field',
    calls: [
      { tool: 'add_node', args: { parent_id: 'hero', tag: 'form', id: 'contact-form', name: 'Contact form', styles: { display: 'flex', flexDirection: 'column', gap: '12px', width: '360px' } } },
      { tool: 'add_node', args: { parent_id: 'contact-form', tag: 'input', id: 'contact-email', styles: { width: '100%', height: '40px' }, attrs: { type: 'email', name: 'email', placeholder: 'you@example.com' } } },
      { tool: 'add_node', args: { parent_id: 'contact-form', tag: 'button', id: 'contact-submit', text: 'Send', styles: { height: '40px' }, attrs: { type: 'submit' } } },
      { tool: 'set_form_destination', args: { node_id: 'contact-form', emails: [{ recipient: 'hello@example.com', subject: 'New enquiry' }], antispam: 'block' } },
    ],
    expect: (w) => {
      const code = w.read(HOME) ?? '';
      must(/onSubmit=\{async \(e\) =>/.test(w.tag('contact-form')), 'the form has no submit handler — it would navigate away (audit gap 3)');
      must(/useState\('idle'\)/.test(code) && /setFormStateContactform/.test(code), 'the lifecycle hook the handler references is not declared');
      must(/fetch\("\/api\/form"/.test(code) || /\/api\/form/.test(code), 'the handler does not post to the form relay');
      must(/name="email"/.test(w.tag('contact-email')), 'the field lost its name');
    },
  },
  {
    id: 'i18n-vars-forms/form-destination', domain: 'i18n-vars-forms', status: 'supported',
    feature: 'Where a form sends its submissions',
    ask: 'send the form to hello@example.com',
    calls: [
      { tool: 'add_node', args: { parent_id: 'hero', tag: 'form', id: 'contact-form', styles: { display: 'flex', flexDirection: 'column', gap: '12px' } } },
      { tool: 'set_form_destination', args: { node_id: 'contact-form', emails: [{ recipient: 'hello@example.com', subject: 'New enquiry' }], antispam: 'block' } },
    ],
    expect: (w) => must(/data-form=/.test(w.tag('contact-form')) && /hello@example\.com/.test(w.read(HOME) ?? ''), 'no data-form destination'),
  },

  // ── not possible yet ──
  {
    id: 'i18n-vars-forms/add-locale', domain: 'i18n-vars-forms', status: 'supported',
    feature: 'Add a language to the site',
    ask: 'make the site available in French',
    calls: [{ tool: 'set_locales', args: { add: [{ code: 'fr', label: 'French' }] } }],
    expect: (w) => {
      const cfg = w.json<{ locales: { code: string }[] }>('i18n/config.json');
      must(cfg.locales.some((l) => l.code === 'fr'), 'fr is not configured');
      must(w.read('messages/fr.json') !== null, 'no fr message dictionary');
    },
  },
  {
    id: 'i18n-vars-forms/bad-locale', domain: 'i18n-vars-forms', status: 'supported',
    feature: 'A malformed locale code is refused',
    ask: 'add "French" as a language',
    calls: [{ tool: 'set_locales', args: { add: [{ code: 'French', label: 'French' }] } }],
    allowFailedCalls: true,
    expect: (w) => must(w.replies[0].isError && /ISO/.test(w.replies[0].text), 'not refused with the code rule'),
  },
  {
    id: 'i18n-vars-forms/translate-text', domain: 'i18n-vars-forms', status: 'supported',
    feature: 'Translate a text node',
    ask: 'translate the headline to French',
    calls: [
      { tool: 'set_locales', args: { add: [{ code: 'fr', label: 'French' }] } },
      { tool: 'list_texts', args: { file_path: HOME } },
      { tool: 'translate_texts', args: { locale: 'fr', items: [{ file_path: HOME, node_id: 'hero-title', text: 'Planifiez, construisez et livrez' }] } },
    ],
    expect: (w) => {
      must(w.replies[1].data?.texts?.some((t: { node_id: string }) => t.node_id === 'hero-title'), 'list_texts does not list the headline');
      must(w.replies[2].data?.written === 1, `written: ${w.replies[2].text.slice(0, 200)}`);
      must(/Planifiez/.test(w.read('messages/fr.json') ?? ''), 'the French text is not in messages/fr.json');
      must(/Plan, build and release/.test(w.read('messages/en.json') ?? '') || /Plan, build and release/.test(w.read(HOME) ?? ''), 'the default text was lost');
    },
  },
  {
    id: 'i18n-vars-forms/translate-rich-text', domain: 'i18n-vars-forms', status: 'supported',
    feature: 'Translate rich text without losing its marks',
    ask: 'translate the styled headline',
    calls: [
      { tool: 'set_rich_text', args: { node_id: 'hero-title', html: 'Plan, build and <strong>release</strong>' } },
      { tool: 'set_locales', args: { add: [{ code: 'fr', label: 'French' }] } },
      { tool: 'translate_texts', args: { locale: 'fr', items: [{ file_path: HOME, node_id: 'hero-title', text: 'Planifiez, construisez et <strong>livrez</strong>' }] } },
    ],
    expect: (w) => {
      must(w.replies[2].data?.written === 1, `written: ${w.replies[2].text.slice(0, 200)}`);
      const fr = w.read('messages/fr.json') ?? '';
      must(/livrez/.test(fr), 'the French text is not stored');
      must(/<strong>|strong/.test(fr), 'the bold mark was dropped in translation (audit V1)');
    },
  },
  {
    id: 'i18n-vars-forms/translate-attribute', domain: 'i18n-vars-forms', status: 'supported',
    feature: 'Translate a placeholder / alt / aria',
    ask: 'translate the email placeholder to French',
    calls: [
      { tool: 'set_locales', args: { add: [{ code: 'fr', label: 'French' }] } },
      { tool: 'add_node', args: { parent_id: 'hero', tag: 'form', id: 'contact-form', name: 'Contact form', styles: { display: 'flex', flexDirection: 'column', gap: '12px', width: '360px' } } },
      { tool: 'set_form_destination', args: { node_id: 'contact-form', emails: [{ recipient: 'hello@example.com', subject: 'New enquiry' }], antispam: 'block' } },
      { tool: 'add_form_field', args: { parent_id: 'contact-form', type: 'email', name: 'email', label: 'Email', placeholder: 'you@example.com' } },
      { tool: 'translate_attribute', args: { node_id: '$control', attr: 'placeholder', locale: 'fr', text: 'vous@exemple.fr' } },
    ],
    expect: (w) => {
      must(/vous@exemple\.fr/.test(w.read('messages/fr.json') ?? ''), 'the French placeholder is not in messages/fr.json');
      must(/you@example\.com/.test(w.read('messages/en.json') ?? '') || /you@example\.com/.test(w.read(HOME) ?? ''), 'the default placeholder was lost');
    },
  },
  {
    id: 'i18n-vars-forms/translate-instance-prop', domain: 'i18n-vars-forms', status: 'supported',
    feature: 'Translate a component instance\'s text prop',
    ask: 'translate the button label',
    calls: [
      { tool: 'set_locales', args: { add: [{ code: 'fr', label: 'French' }] } },
      { tool: 'list_texts', args: { file_path: HOME } },
    ],
    expect: (w) => {
      const row = w.replies[1].data?.texts?.find((t: { instance_prop?: { prop: string } }) => t.instance_prop?.prop === 'label');
      must(row, `the instance label prop is not listed as translatable: ${w.replies[1].text.slice(0, 300)}`);
    },
  },
  {
    id: 'i18n-vars-forms/locale-switcher', domain: 'i18n-vars-forms', status: 'supported',
    feature: 'Add a language switcher',
    ask: 'add a language menu to the hero',
    calls: [
      { tool: 'set_locales', args: { add: [{ code: 'fr', label: 'French' }] } },
      { tool: 'add_language_switcher', args: { parent_id: 'hero' } },
    ],
    expect: (w) => {
      must(w.read('components/LocaleSwitcher.tsx') !== null, 'the switcher component was not installed');
      must(/<LocaleSwitcher\b/.test(w.read(HOME) ?? ''), 'no <LocaleSwitcher> on the page');
    },
  },
  { id: 'i18n-vars-forms/conditional-render', domain: 'i18n-vars-forms', status: 'missing', feature: 'Show a node only when a variable is true', ask: 'show the menu only when menuOpen', gap: 'by design: the dialect has no page-variable mount gate (oracle CONDITIONAL_RENDER_UNSUPPORTED) — the builder expresses it as an overlay (create_overlay) or a component variant + set_variant_visibility + add_connection' },
  {
    id: 'i18n-vars-forms/native-field', domain: 'i18n-vars-forms', status: 'supported',
    feature: 'Add a native field with its label',
    ask: 'add a name field, a message box and a newsletter checkbox to the form',
    calls: [
      { tool: 'add_node', args: { parent_id: 'hero', tag: 'form', id: 'contact-form', name: 'Contact form', styles: { display: 'flex', flexDirection: 'column', gap: '12px', width: '360px' } } },
      { tool: 'set_form_destination', args: { node_id: 'contact-form', emails: [{ recipient: 'hello@example.com', subject: 'New enquiry' }], antispam: 'block' } },
      { tool: 'add_form_field', args: { parent_id: 'contact-form', type: 'text', name: 'name', label: 'Your name', required: true } },
      { tool: 'add_form_field', args: { parent_id: 'contact-form', type: 'textarea', name: 'message', label: 'Message' } },
      { tool: 'add_form_field', args: { parent_id: 'contact-form', type: 'checkbox', name: 'newsletter', label: 'Send me the newsletter' } },
      { tool: 'add_form_field', args: { parent_id: 'contact-form', type: 'select', name: 'topic', label: 'Topic', options: ['Sales', 'Support'] } },
    ],
    expect: (w) => {
      const code = w.read(HOME) ?? '';
      must(/<input[^>]*name="name"[^>]*required/.test(code) || /<input[^>]*required[^>]*name="name"/.test(code), 'no required name input');
      must(/<textarea[^>]*name="message"/.test(code), 'no message textarea');
      must(/<input[^>]*type="checkbox"[^>]*name="newsletter"/.test(code) || /<input[^>]*name="newsletter"[^>]*type="checkbox"/.test(code), 'no newsletter checkbox');
      must(/<select[^>]*name="topic"[\s\S]*<option[^>]*value="Sales"/.test(code), 'no topic select with options');
      must((code.match(/<label\b/g) ?? []).length >= 4, 'fields are missing their labels');
      must(/htmlFor=/.test(code), 'labels are not linked to their controls');
    },
  },
  {
    id: 'i18n-vars-forms/native-field-outside-form', domain: 'i18n-vars-forms', status: 'supported',
    feature: 'A field outside a form is refused',
    ask: '(safety) add an email input to the hero (no form)',
    calls: [{ tool: 'add_form_field', args: { parent_id: 'hero', type: 'email', name: 'email', label: 'Email' } }],
    allowFailedCalls: true,
    expect: (w) => must(w.replies[0].isError && /not inside a <form>/.test(w.replies[0].text), 'not refused with the form reason'),
  },
  {
    id: 'i18n-vars-forms/pseudo-state', domain: 'i18n-vars-forms', status: 'supported',
    feature: 'Style :focus / :checked / :hover',
    ask: 'give the email input a blue border when focused and grey placeholder text',
    calls: [
      { tool: 'add_node', args: { parent_id: 'hero', tag: 'form', id: 'contact-form', name: 'Contact form', styles: { display: 'flex', flexDirection: 'column', gap: '12px', width: '360px' } } },
      { tool: 'set_form_destination', args: { node_id: 'contact-form', emails: [{ recipient: 'hello@example.com', subject: 'New enquiry' }], antispam: 'block' } },
      { tool: 'add_form_field', args: { parent_id: 'contact-form', type: 'email', name: 'email', label: 'Email', placeholder: 'you@example.com' } },
      { tool: 'set_pseudo_style', args: { node_id: '$control', pseudo: 'focus', styles: { borderColor: '#2563eb', outline: 'none' } } },
      { tool: 'set_pseudo_style', args: { node_id: '$control', pseudo: 'placeholder', styles: { color: '#9ca3af' } } },
      { tool: 'set_pseudo_style', args: { node_id: 'hero-title', pseudo: 'hover', styles: { color: '#2563eb' } } },
    ],
    expect: (w) => {
      const code = w.read(HOME) ?? '';
      must(/:focus\s*\{[^}]*border-color:\s*#2563eb/.test(code), 'no :focus rule');
      must(/::placeholder\s*\{[^}]*color:\s*#9ca3af/.test(code), 'no ::placeholder rule');
      must(/\[data-id="hero-title"\]:hover\s*\{[^}]*color:\s*#2563eb/.test(code), 'no :hover rule on the title');
    },
  },
  {
    id: 'i18n-vars-forms/form-states', domain: 'i18n-vars-forms', status: 'supported',
    feature: 'Map form states (loading / success) to button variants',
    ask: 'show a spinner on the button while sending and "Sent" after',
    calls: [
      { tool: 'add_node', args: { parent_id: 'hero', tag: 'form', id: 'contact-form', name: 'Contact form', styles: { display: 'flex', flexDirection: 'column', gap: '12px', width: '360px' } } },
      { tool: 'set_form_destination', args: { node_id: 'contact-form', emails: [{ recipient: 'hello@example.com', subject: 'New enquiry' }], antispam: 'block' } },
      { tool: 'add_form_field', args: { parent_id: 'contact-form', type: 'email', name: 'email', label: 'Email' } },
      { tool: 'add_submit_button', args: { parent_id: 'contact-form', label: 'Send' } },
      { tool: 'set_form', args: { node_id: '$button', states: { loading: 'loading', success: 'success' } } },
    ],
    expect: (w) => {
      const code = w.read(HOME) ?? '';
      must(w.read('components/FormSubmit.tsx') !== null, 'the Form Submit master was not materialized');
      must(/<FormSubmit\b/.test(code), 'no FormSubmit instance in the form');
      must(/data-form-state=/.test(code), 'no form-state mapping on the button');
      must(/formStateContactform|formState[A-Z]\w* === 'loading'/.test(code), 'the button does not read the form lifecycle state');
    },
  },
];
