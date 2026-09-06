// Inline SVG icons.
const svg = (body: string, viewBox = '0 0 16 16') => `<svg width="16" height="16" viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  run: svg('<path d="M4 2.5v11l9-5.5z" fill="currentColor" stroke="none"/>'),
  stop: svg('<rect x="3.5" y="3.5" width="9" height="9" rx="1" fill="currentColor" stroke="none"/>'),
  restart: svg('<path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.5v3h-3"/>'),
  gear: svg('<circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M3.4 12.6l1.3-1.3M11.3 4.7l1.3-1.3"/>'),
  palette: svg('<rect x="1.5" y="3" width="13" height="10" rx="1.5"/><path d="M4.5 6.5l2 1.5-2 1.5M8 9.5h3.5"/>'),
  sidebar: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M6 2.5v11"/>'),
  panel: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M1.5 9.5h13"/>'),
  close: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
  chevronRight: svg('<path d="M6 3.5l4.5 4.5L6 12.5"/>'),
  chevronDown: svg('<path d="M3.5 6l4.5 4.5L12.5 6"/>'),
  file: svg('<path d="M4 1.5h5l3 3v10H4z"/><path d="M9 1.5v3h3"/>'),
  pyfile: svg('<path d="M4 1.5h5l3 3v10H4z"/><path d="M9 1.5v3h3"/><path d="M6.2 11.5v-4h1.6a1.2 1.2 0 0 1 0 2.4H6.2" stroke-width="1.3"/>'),
  folder: svg('<path d="M1.5 3.5h4.5l1.5 1.5h7v8h-13z"/>'),
  folderOpen: svg('<path d="M1.5 3.5h4.5l1.5 1.5h7v2h-13z"/><path d="M1.5 7h13l-1.5 6h-11.5z"/>'),
  newFile: svg('<path d="M4 1.5h5l3 3v10H4z"/><path d="M9 1.5v3h3"/><path d="M8 7v4M6 9h4"/>'),
  newFolder: svg('<path d="M1.5 3.5h4.5l1.5 1.5h7v8h-13z"/><path d="M8 6.5v4M6 8.5h4"/>'),
  import: svg('<path d="M8 2v8M4.5 6.5L8 10l3.5-3.5"/><path d="M2.5 12.5h11"/>'),
  export: svg('<path d="M8 10V2M4.5 5.5L8 2l3.5 3.5"/><path d="M2.5 12.5h11"/>'),
  collapse: svg('<path d="M2.5 4h11M2.5 8h11M2.5 12h11" opacity=".5"/><path d="M6 6l2-2 2 2M6 10l2 2 2-2"/>'),
  refresh: svg('<path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.5v3h-3"/>'),
  trash: svg('<path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4"/>'),
  edit: svg('<path d="M11.5 2.5l2 2-8 8H3.5v-2z"/>'),
  clear: svg('<path d="M3 3l10 10M13 3L3 13" opacity=".6"/>'),
  search: svg('<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>'),
  warning: svg('<path d="M8 2l6.5 11.5h-13z"/><path d="M8 6.5v3.5M8 12v.5"/>'),
  error: svg('<circle cx="8" cy="8" r="6"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5"/>'),
  check: svg('<path d="M3 8.5l3 3 7-7"/>'),
  info: svg('<circle cx="8" cy="8" r="6"/><path d="M8 7v4M8 5v.5"/>'),
  python: svg('<path d="M8 1.5c-2.5 0-3.5.8-3.5 2.2v1.8h3.7v.5H3.2C1.8 6 1 7.1 1 8.5S1.8 11 3.2 11h1.3V9.2c0-1.4 1.1-2.2 2.5-2.2h3c1.2 0 2-.8 2-2V3.7C12 2.3 10.5 1.5 8 1.5z"/><path d="M8 14.5c2.5 0 3.5-.8 3.5-2.2v-1.8H7.8V10h5c1.4 0 2.2-1.1 2.2-2.5S14.2 5 12.8 5h-1.3v1.8c0 1.4-1.1 2.2-2.5 2.2H6c-1.2 0-2 .8-2 2v1.3c0 1.4 1.5 2.2 4 2.2z"/>'),
};

export function icon(name: keyof typeof ICONS): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = 'icon';
  s.innerHTML = ICONS[name];
  return s;
}
