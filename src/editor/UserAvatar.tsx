// UserAvatar.tsx — small circular user avatar: the profile image, or the
// name's first initial on a colored disc. Same look as the comment-thread
// avatars (CommentChatPopup / CommentsListPanel).

interface Props {
  name: string;
  avatarUrl?: string | null;
  /** Disc background when there is no image. */
  color?: string;
  /** Diameter in px. */
  size?: number;
}

export default function UserAvatar({ name, avatarUrl, color, size = 20 }: Props) {
  return (
    <div
      className="rounded-full flex items-center justify-center shrink-0 overflow-hidden"
      style={{
        width: size,
        height: size,
        backgroundColor: avatarUrl ? 'transparent' : (color ?? 'var(--grid-line)'),
      }}
    >
      {avatarUrl ? (
        <img src={avatarUrl} alt={name} className="w-full h-full object-cover" />
      ) : (
        <span
          className="font-semibold text-white leading-none"
          style={{ fontSize: Math.round(size * 0.46) }}
        >
          {(name || '?').charAt(0).toUpperCase()}
        </span>
      )}
    </div>
  );
}
