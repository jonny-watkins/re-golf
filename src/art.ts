export const artSvg = (type: string) => {
  const shaft =
    '<path d="M105 30 180 230" stroke="#34483a" stroke-width="8" stroke-linecap="round"/><path d="m99 27 12 1" stroke="#1c2f25" stroke-width="11" stroke-linecap="round"/>';
  const heads: Record<string, string> = {
    driver:
      '<path d="M152 225c12-29 54-39 84-17 12 9 10 28-4 35-26 14-64 8-80-18Z" fill="#274b39" stroke="#c3d4b4" stroke-width="3"/><path d="M175 218c17-8 38-7 54 1" stroke="#87a275" stroke-width="3" stroke-linecap="round"/>',
    iron: '<path d="M160 214c16-16 50-16 72-1l-9 24c-21 7-44 4-61-8l-2-15Z" fill="#aebbb0" stroke="#34483a" stroke-width="3"/><path d="m171 215 5 19m9-21 3 24m10-24 2 23m11-21-1 19" stroke="#6b7b70" stroke-width="2"/>',
    putter:
      '<path d="m158 221 61-8 10 17-64 10-7-19Z" fill="#263e31" stroke="#a9bb9e" stroke-width="3"/><path d="m168 226 53-7" stroke="#84977f" stroke-width="2"/>',
    wedge:
      '<path d="M162 215c16-17 44-16 61-1l-7 24c-19 6-37 3-53-8l-1-15Z" fill="#b9c3b9" stroke="#34483a" stroke-width="3"/><path d="m169 218 46 8m-43-1 41 8" stroke="#718174" stroke-width="2"/>',
    wood: '<path d="M153 222c10-25 43-34 69-19 12 7 11 25-2 32-22 12-53 9-67-13Z" fill="#315540" stroke="#bbd0ac" stroke-width="3"/><path d="M171 216c16-7 32-6 44 1" stroke="#8ba57d" stroke-width="3" stroke-linecap="round"/>',
    bag: '<path d="m153 92 48 0 10 138c-16 14-45 14-61 0l3-138Z" fill="#315540" stroke="#d0dbc7" stroke-width="4"/><path d="M155 105h47m-51 93h62M169 93V76h18v17" stroke="#bed0ae" stroke-width="4"/><path d="M166 122v51m15-51v51m15-51v51" stroke="#91a984" stroke-width="3"/>',
  };
  return (
    '<svg viewBox="0 0 300 270" fill="none" aria-hidden="true">' +
    '<ellipse cx="157" cy="238" rx="72" ry="12" fill="rgba(35,55,39,.1)"/>' +
    (type === 'bag' ? heads.bag : shaft + heads[type]) +
    (type === 'driver' || type === 'wood' ? '<circle cx="107" cy="42" r="10" fill="#d8e79f"/>' : '') +
    '</svg>'
  );
};
