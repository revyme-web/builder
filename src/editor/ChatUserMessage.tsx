// ChatUserMessage.tsx — one user-authored AI-chat message, rendered with the
// sender's profile (avatar + name) above the bubble.
//
// Same authorship treatment as the comment thread: the author is resolved
// against the live collaborator list so a teammate's messages show their
// current avatar/color, falling back to the stored stamp when they aren't a
// known collaborator (and to "You" for the signed-in user).

import { useAtomValue } from 'jotai';
import { userAtom } from '@/backend/user-store';
import { useCollaboratorColors, resolveCollaboratorAvatar } from '@/code/stores/collaborator-colors-store';
import UserAvatar from './UserAvatar';

interface Props {
  content: string;
  authorId?: string;
  authorName?: string;
  authorAvatar?: string;
  /** Bubble background class — defaults to the editor accent. The plugin /
   *  code-component chats pass their own purple. */
  accentClass?: string;
}

export default function ChatUserMessage({
  content, authorId, authorName, authorAvatar, accentClass = 'bg-[var(--accent)]',
}: Props) {
  const currentUser = useAtomValue(userAtom);
  const collaboratorColors = useCollaboratorColors();

  const isMe = !authorId || authorId === 'local-user' || authorId === currentUser?.id;
  const displayName = isMe ? 'You' : (authorName ?? 'Unknown');
  const avatarUrl = authorId
    ? resolveCollaboratorAvatar(collaboratorColors, authorId, authorAvatar, currentUser)
    : (authorAvatar ?? null);
  const avatarColor = (authorId ? collaboratorColors.get(authorId)?.color : undefined) ?? 'var(--accent)';

  return (
    <div className="flex justify-end">
      <div className="flex flex-col items-end gap-1 max-w-[90%]">
        {/* Author row — avatar + name, mirrored to the right edge. */}
        <div className="flex items-center gap-1.5 flex-row-reverse">
          <UserAvatar name={displayName} avatarUrl={avatarUrl} color={avatarColor} size={18} />
          <span className="text-[10px] font-medium text-[var(--text-secondary)]">{displayName}</span>
        </div>
        <div className={`rounded-lg px-2.5 py-1.5 text-white ${accentClass}`}>
          <p className="text-[11px] leading-relaxed break-words whitespace-pre-wrap">{content}</p>
        </div>
      </div>
    </div>
  );
}
