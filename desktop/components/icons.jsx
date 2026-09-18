// tiny win98-ish svg icons
const S = ({ children, size = 40 }) => (
  <svg className="glyph" width={size} height={size} viewBox="0 0 40 40" style={{ width: size, height: size }}>
    {children}
  </svg>
);

export const FolderIcon = ({ size }) => (
  <S size={size}>
    <path d="M3 10 h10 l3 4 h21 v20 h-34 z" fill="#ffd24d" stroke="#8a6d00" strokeWidth="2" />
    <path d="M3 14 h34 v20 h-34 z" fill="#ffe58a" stroke="#8a6d00" strokeWidth="2" />
    <rect x="3" y="14" width="34" height="4" fill="#fff" opacity=".55" />
  </S>
);

export const StreamIcon = ({ size }) => (
  <S size={size}>
    <rect x="4" y="6" width="32" height="24" fill="#1a1a2e" stroke="#c0c0c0" strokeWidth="2" />
    <path d="M8 24 l6 -8 l5 5 l6 -10 l7 13" fill="none" stroke="#4ade80" strokeWidth="2.5" />
    <rect x="14" y="30" width="12" height="3" fill="#808080" />
    <rect x="8" y="33" width="24" height="3" fill="#808080" />
  </S>
);

export const BellIcon = ({ size }) => (
  <S size={size}>
    <path d="M20 5 c-7 0 -9 8 -9 14 l-3 6 h24 l-3 -6 c0 -6 -2 -14 -9 -14" fill="#ffd24d" stroke="#8a6d00" strokeWidth="2" />
    <circle cx="20" cy="29" r="3.5" fill="#c0c0c0" stroke="#606060" strokeWidth="2" />
    <rect x="18.5" y="3" width="3" height="4" fill="#808080" />
  </S>
);

export const BinIcon = ({ size, full }) => (
  <S size={size}>
    <path d="M10 12 h20 l-2 22 h-16 z" fill={full ? "#9db3c8" : "#c0c0c0"} stroke="#404040" strokeWidth="2" />
    <rect x="7" y="8" width="26" height="4" fill="#808080" stroke="#404040" />
    <rect x="16" y="4" width="8" height="4" fill="#808080" stroke="#404040" />
    {[14, 20, 26].map(x => <line key={x} x1={x} y1="14" x2={x} y2="32" stroke="#808080" strokeWidth="1.5" />)}
    {full && <path d="M12 12 l3 -6 M20 12 l0 -7 M28 12 l-3 -6" stroke="#fff" strokeWidth="2" />}
  </S>
);

export const NotepadIcon = ({ size }) => (
  <S size={size}>
    <rect x="9" y="4" width="22" height="30" fill="#fff" stroke="#404040" strokeWidth="2" />
    {[10, 14, 18, 22, 26].map(y => <line key={y} x1="13" y1={y} x2="27" y2={y} stroke="#808080" strokeWidth="1.5" />)}
    <rect x="9" y="4" width="22" height="5" fill="#000080" />
  </S>
);

export const WinLogo = ({ size = 22 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" style={{ width: size, height: size }}>
    <path d="M3 4 l8 -1.5 v8.5 h-8 z" fill="#ff0000" />
    <path d="M12.5 2.2 l8.5 -1.7 v10.5 h-8.5 z" fill="#00a000" />
    <path d="M3 13 h8 v8.5 l-8 -1.5 z" fill="#0000ff" />
    <path d="M12.5 13 h8.5 v10.5 l-8.5 -1.7 z" fill="#ffff00" />
  </svg>
);

export const TitleGlyph = ({ size = 16 }) => <FolderIcon size={size} />;

// ---- aliases used by the desktop page ----
export const Folder = FolderIcon;
export const Stream = StreamIcon;
export const Bell = BellIcon;
export const FileText = NotepadIcon;
export const Trash = ({ size, empty }) => <BinIcon size={size} full={!empty} />;
export const Exe = ({ size = 40 }) => (
  <S size={size}>
    <rect x="6" y="6" width="28" height="28" fill="#c0c0c0" stroke="#404040" strokeWidth="2" />
    <rect x="10" y="10" width="20" height="20" fill="#000080" />
    <path d="M15 25 l10 -10 M25 25 l-10 -10" stroke="#ffffff" strokeWidth="2.5" />
  </S>
);
