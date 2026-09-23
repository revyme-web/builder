// SkillsSection.tsx — Settings → Skills: the project's own instructions for
// the agent (code/project/skills-config.ts).
//
// A list of the project's skills — each with its /command, what it is for,
// an "Always apply" switch, edit and delete — plus the two ways to start one
// without writing it from scratch: the starter LIBRARY (copied in, then the
// user's to edit) and "Generate from my project", which asks the agent to
// write a design-system skill from the project's own tokens, text styles and
// components (it saves it with `save_skill`, on the workspace's credits).

import React, { useState } from 'react';
import { getDefaultStore, useSetAtom } from 'jotai';
import Modal from '@/design-system/Modal';
import Button from '@/design-system/Button';
import { Toggle, RowButton, ConfirmModal } from '@/editor/overlays/settings-shared';
import {
  useProjectSkills, saveProjectSkill, deleteProjectSkill, setSkillAlwaysApply, getProjectSkill,
} from '@/code/stores/project-skills-store';
import { SKILL_CONTENT_MAX, SKILL_DESCRIPTION_MAX, toSkillName, type ProjectSkill } from '@/code/project/skills-config';
import { SKILLS_LIBRARY, type LibrarySkill } from '@/ai/agent/skills-library';
import { agentQueuedRequestAtom } from '@/code/stores/agent-chat-store';
import { settingsOverlayOpenAtom } from '@/code/stores/website-settings-store';
import { aiChatDetachedAtom, aiChatSheetOpenAtom } from '@/code/stores/editor-store';
import { leftPanelAtom } from '@/code/stores/left-panel-store';
import { useIsViewer } from '@/code/stores/viewer-mode-store';
import { trace } from '@/shared/debug-trace';

/** What "Generate from my project" asks the agent. */
export const GENERATE_DESIGN_SYSTEM_REQUEST =
  'Generate my design-system skill. Read this project’s design tokens, text styles and components, and look at how the home page is laid out. ' +
  'Then save a skill named "design-system" with save_skill (always_apply true) that tells you how to build new pages and sections in THIS project’s system: ' +
  'colours by token name and what each is for, which text style to use for what, spacing and section rhythm, content widths, and which components to reuse. ' +
  'Write it as short rules in plain language, under 5,000 characters. Do not change the page.';

const field = 'w-full px-2.5 py-1.5 text-xs bg-[var(--grid-line)] border border-[var(--control-border)] [--cut-border-color:var(--control-border)] hover:border-[var(--control-border-hover)] focus:border-[var(--border-focus)] focus:[--cut-border-color:var(--border-focus)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] cut-corners cut-border focus:outline-none transition-colors';

type Draft = { name: string; description: string; content: string; alwaysApply: boolean };

function SkillEditor({ initial, previousName, onClose }: { initial: Draft; previousName?: string; onClose: () => void }) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [error, setError] = useState<string | null>(null);
  const slug = toSkillName(draft.name);
  const save = () => {
    const out = saveProjectSkill(draft, previousName);
    if ('error' in out) { setError(out.error); return; }
    onClose();
  };
  return (
    <Modal isOpen onClose={onClose} title={previousName ? `Edit /${previousName}` : 'New skill'} width={520}>
      <div className="flex flex-col gap-3 p-4" data-testid="skill-editor">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-[var(--text-secondary)]">Name — type it after a slash in the chat</span>
          <input className={field} value={draft.name} autoFocus placeholder="brand-voice" onChange={(e) => { setDraft({ ...draft, name: e.target.value }); setError(null); }} />
          {draft.name && slug !== draft.name && <span className="text-[10px] text-[var(--text-tertiary)]">Saved as /{slug || '…'}</span>}
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-[var(--text-secondary)]">Description — what it is for</span>
          <input className={field} value={draft.description} maxLength={SKILL_DESCRIPTION_MAX} placeholder="Keep new copy in our brand voice" onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="flex items-baseline justify-between text-[11px] text-[var(--text-secondary)]">
            Instructions
            <span className={draft.content.length > SKILL_CONTENT_MAX ? 'text-[var(--accent-danger,#dc2626)]' : 'text-[var(--text-tertiary)]'}>
              {draft.content.length.toLocaleString()} / {SKILL_CONTENT_MAX.toLocaleString()}
            </span>
          </span>
          <textarea
            className={`${field} min-h-[220px] resize-y font-mono leading-relaxed`}
            value={draft.content}
            placeholder={'Rules the agent follows for this kind of work.\n\n- Use only the colour tokens.\n- Headlines in sentence case.'}
            onChange={(e) => { setDraft({ ...draft, content: e.target.value }); setError(null); }}
          />
        </label>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs text-[var(--text-primary)]">Always apply</div>
            <div className="text-[11px] text-[var(--text-secondary)]">Use it on every request, not only when typed with /.</div>
          </div>
          <Toggle value={draft.alwaysApply} onChange={(v) => setDraft({ ...draft, alwaysApply: v })} />
        </div>
        {error && <p className="text-[11px] text-[var(--accent-danger,#dc2626)]" data-testid="skill-editor-error">{error}</p>}
        <div className="flex justify-end gap-2 border-t border-[var(--border-default)] pt-3">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={save} disabled={!slug || !draft.content.trim()}>Save</Button>
        </div>
      </div>
    </Modal>
  );
}

function SkillRow({ skill, readOnly, onEdit, onDelete }: { skill: ProjectSkill; readOnly: boolean; onEdit: () => void; onDelete: () => void }) {
  return (
    <li className="flex items-center gap-3 border-b border-[var(--border-light)] py-3 last:border-b-0" data-testid="skill-row" data-skill={skill.name}>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-[var(--text-primary)]">/{skill.name}</div>
        <div className="truncate text-xs text-[var(--text-secondary)]">{skill.description || `${skill.content.length.toLocaleString()} characters`}</div>
      </div>
      <label className="flex shrink-0 items-center gap-2 text-[11px] text-[var(--text-secondary)]" title="Use it on every agent request">
        Always
        {readOnly
          ? <span className="text-[var(--text-primary)]">{skill.alwaysApply ? 'on' : 'off'}</span>
          : <Toggle value={skill.alwaysApply} onChange={(v) => setSkillAlwaysApply(skill.name, v)} />}
      </label>
      {!readOnly && (
        <div className="flex shrink-0 gap-1.5">
          <RowButton onClick={onEdit}>Edit</RowButton>
          <RowButton variant="danger" onClick={onDelete}>Delete</RowButton>
        </div>
      )}
    </li>
  );
}

export default function SkillsSection() {
  const skills = useProjectSkills();
  const readOnly = useIsViewer();
  const [editing, setEditing] = useState<{ initial: Draft; previousName?: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [showLibrary, setShowLibrary] = useState(false);
  const queue = useSetAtom(agentQueuedRequestAtom);
  const setSettingsOpen = useSetAtom(settingsOverlayOpenAtom);

  const addFromLibrary = (s: LibrarySkill) => {
    const out = saveProjectSkill({ name: s.name, description: s.description, content: s.content, alwaysApply: false });
    trace.action('skills-section:add-library', { name: s.name, ok: !('error' in out) });
    // A template is only useful once filled in — open it straight away.
    if (!('error' in out) && s.placeholder) setEditing({ initial: { name: out.name, description: out.description, content: out.content, alwaysApply: out.alwaysApply }, previousName: out.name });
  };

  const generate = () => {
    trace.action('skills-section:generate-design-system');
    queue({ text: GENERATE_DESIGN_SYSTEM_REQUEST, nonce: Date.now() });
    setSettingsOpen(false);
    // Show the chat that will run it: the pop-out if the chat lives there,
    // else the docked Vibe panel.
    const store = getDefaultStore();
    if (store.get(aiChatDetachedAtom)) store.set(aiChatSheetOpenAtom, true);
    else store.set(leftPanelAtom, 'vibe');
  };

  return (
    <div data-testid="skills-section">
      <div className="flex items-start justify-between gap-3 border-b border-[var(--border-light)] pb-6">
        <div className="min-w-0">
          <h3 className="mb-1 text-sm font-semibold text-[var(--text-primary)]">Skills</h3>
          <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
            Your own instructions for the agent, saved with this project — your design system, your brand voice, the checks you run before launch.
            Type <b>/name</b> in the Vibe chat to use one; skills set to <b>Always</b> shape every request.
          </p>
        </div>
        {!readOnly && (
          <div className="flex shrink-0 gap-1.5">
            <RowButton onClick={() => setShowLibrary((v) => !v)}>{showLibrary ? 'Hide library' : 'Add from library'}</RowButton>
            <RowButton variant="accent" onClick={() => setEditing({ initial: { name: '', description: '', content: '', alwaysApply: false } })}>New skill</RowButton>
          </div>
        )}
      </div>

      {!readOnly && (
        <div className="flex items-center justify-between gap-3 border-b border-[var(--border-light)] py-4">
          <div className="min-w-0">
            <div className="text-xs font-medium text-[var(--text-primary)]">Generate from my project</div>
            <div className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
              The agent reads your tokens, text styles and components and writes a /design-system skill you can edit. Runs on your credits.
            </div>
          </div>
          <RowButton onClick={generate}>{getProjectSkill('design-system') ? 'Regenerate' : 'Generate'}</RowButton>
        </div>
      )}

      {showLibrary && (
        <div className="border-b border-[var(--border-light)] py-4" data-testid="skills-library">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">Library</p>
          <ul>
            {SKILLS_LIBRARY.map((s) => {
              const added = skills.some((k) => k.name === s.name);
              return (
                <li key={s.name} className="flex items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-[var(--text-primary)]">/{s.name}{s.placeholder && <span className="ml-1.5 text-[10px] font-normal text-[var(--text-tertiary)]">template — fill in</span>}</div>
                    <div className="truncate text-[11px] text-[var(--text-secondary)]">{s.description}</div>
                  </div>
                  <RowButton onClick={() => addFromLibrary(s)} disabled={added}>{added ? 'Added' : 'Add'}</RowButton>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {skills.length === 0 ? (
        <p className="py-6 text-sm text-[var(--text-secondary)]">No skills yet. Start from the library, generate one from your project, or write your own.</p>
      ) : (
        <ul className="py-2" data-testid="skills-list">
          {skills.map((s) => (
            <SkillRow
              key={s.name}
              skill={s}
              readOnly={readOnly}
              onEdit={() => setEditing({ initial: { name: s.name, description: s.description, content: s.content, alwaysApply: s.alwaysApply }, previousName: s.name })}
              onDelete={() => setDeleting(s.name)}
            />
          ))}
        </ul>
      )}

      {editing && <SkillEditor initial={editing.initial} previousName={editing.previousName} onClose={() => setEditing(null)} />}
      <ConfirmModal
        isOpen={!!deleting}
        title={`Delete /${deleting ?? ''}?`}
        message="The agent stops following it. Chats that used it keep their history."
        confirmText="Delete"
        onCancel={() => setDeleting(null)}
        onConfirm={() => { if (deleting) deleteProjectSkill(deleting); setDeleting(null); }}
      />
    </div>
  );
}
