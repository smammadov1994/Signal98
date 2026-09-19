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

// ---- v0.2 app icons ----
export const BugIcon = ({ size }) => (
  <S size={size}>
    <ellipse cx="20" cy="23" rx="9" ry="11" fill="#c03030" stroke="#400000" strokeWidth="2" />
    <circle cx="20" cy="10" r="5" fill="#402020" stroke="#200000" strokeWidth="2" />
    <line x1="20" y1="13" x2="20" y2="34" stroke="#400000" strokeWidth="2" />
    {[18, 24, 30].map((y) => <path key={y} d={`M11 ${y} l-7 ${y === 24 ? 0 : y < 24 ? -4 : 4} M29 ${y} l7 ${y === 24 ? 0 : y < 24 ? -4 : 4}`} stroke="#200000" strokeWidth="2" fill="none" />)}
  </S>
);
export const ChartIcon = ({ size }) => (
  <S size={size}>
    <rect x="4" y="5" width="32" height="30" fill="#fff" stroke="#404040" strokeWidth="2" />
    <rect x="9" y="22" width="5" height="9" fill="#2a78d6" /><rect x="17" y="15" width="5" height="16" fill="#eb6834" /><rect x="25" y="10" width="5" height="21" fill="#1baf7a" />
    <line x1="7" y1="31" x2="33" y2="31" stroke="#404040" strokeWidth="1.5" />
  </S>
);
export const GlobeIcon = ({ size }) => (
  <S size={size}>
    <circle cx="20" cy="20" r="15" fill="#3a8ee6" stroke="#002060" strokeWidth="2" />
    <path d="M10 14 q5 -5 9 0 q2 4 -2 6 q-5 1 -4 6 q-4 -2 -5 -7 z M24 22 q5 -2 8 2 q-2 6 -8 8 q-2 -5 0 -10 z" fill="#35b04a" stroke="#0a5a1a" strokeWidth="1" />
    <ellipse cx="20" cy="20" rx="15" ry="6" fill="none" stroke="#002060" strokeWidth="1" opacity=".5" />
  </S>
);
export const FilmIcon = ({ size }) => (
  <S size={size}>
    <rect x="5" y="7" width="30" height="26" fill="#303030" stroke="#000" strokeWidth="2" />
    {[9, 15, 21, 27].map((y) => <g key={y}><rect x="7" y={y} width="3" height="3" fill="#fff" /><rect x="30" y={y} width="3" height="3" fill="#fff" /></g>)}
    <rect x="12" y="11" width="16" height="18" fill="#9fd0ff" />
    <path d="M17 15 l8 5 l-8 5 z" fill="#000080" />
  </S>
);
export const PeopleIcon = ({ size }) => (
  <S size={size}>
    <circle cx="14" cy="13" r="6" fill="#ffd0a0" stroke="#604020" strokeWidth="2" />
    <path d="M3 34 q0 -13 11 -13 q11 0 11 13 z" fill="#2a78d6" stroke="#002060" strokeWidth="2" />
    <circle cx="28" cy="15" r="5" fill="#ffd0a0" stroke="#604020" strokeWidth="2" />
    <path d="M21 34 q0 -11 8 -11 q8 0 8 11 z" fill="#1baf7a" stroke="#0a5a3a" strokeWidth="2" />
  </S>
);
export const GearIcon = ({ size }) => (
  <S size={size}>
    <g transform="translate(20 20)" stroke="#303030" strokeWidth="1.5">
      {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => <rect key={a} x="-3.5" y="-17" width="7" height="9" fill="#a0a0a0" transform={`rotate(${a})`} />)}
      <circle r="11" fill="#c0c0c0" strokeWidth="2" /><circle r="4.5" fill="#008080" strokeWidth="2" />
    </g>
  </S>
);
export const WrenchIcon = ({ size }) => (
  <S size={size}>
    <rect x="5" y="6" width="30" height="22" fill="#000" stroke="#c0c0c0" strokeWidth="2" />
    <path d="M9 12 l5 4 l-5 4" fill="none" stroke="#2aff5a" strokeWidth="2" /><line x1="16" y1="21" x2="24" y2="21" stroke="#2aff5a" strokeWidth="2" />
    <rect x="14" y="28" width="12" height="3" fill="#808080" /><rect x="9" y="31" width="22" height="4" fill="#a0a0a0" stroke="#404040" />
  </S>
);
