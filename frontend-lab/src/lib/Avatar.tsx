// React port of script_lab.js's getInitials/avatarColorForName/renderAvatarHtml
// (script_lab.js:839-862) — those stay vanilla-side too (still used by the not-yet-migrated
// attendance drill-down modal, script_lab.js:1052), so this is a small, deliberate
// duplication of pure/cheap logic rather than a cross-script dependency.
const AVATAR_COLORS = ['#F87171', '#FB923C', '#FBBF24', '#34D399', '#22D3EE', '#60A5FA', '#A78BFA', '#F472B6', '#4ADE80', '#38BDF8'];

function getInitials(name: string | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] || '';
  const second = parts[1]?.[0] || '';
  return (first + second).toUpperCase() || '?';
}

function avatarColorForName(name: string | undefined): string {
  let hash = 0;
  const str = name || '';
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function Avatar({ photoPath, name, size }: { photoPath?: string; name?: string; size: number }) {
  if (photoPath) {
    return <img src={photoPath} className="employee-avatar" style={{ width: size, height: size }} />;
  }
  return (
    <div
      className="employee-avatar"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.4),
        background: avatarColorForName(name),
      }}
    >
      {getInitials(name)}
    </div>
  );
}
