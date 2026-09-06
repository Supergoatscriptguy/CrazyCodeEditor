// UI and terminal themes, applied as CSS custom properties.

export interface UiTheme {
  name: string;
  dark: boolean;
  c: {
    bg: string; // editor background
    bgAlt: string; // sidebar / panels
    bgBar: string; // toolbars, tab strip
    bgHover: string;
    border: string;
    fg: string;
    fgMuted: string;
    accent: string;
    accentFg: string;
    selection: string;
    lineHighlight: string;
    gutter: string;
    cursor: string;
    error: string;
    warning: string;
    info: string;
    success: string;
    matchingBracket: string;
  };
  s: {
    keyword: string;
    control: string;
    string: string;
    number: string;
    comment: string;
    function: string;
    className: string;
    variable: string;
    builtin: string;
    operator: string;
    decorator: string;
    type: string;
    constant: string;
    self: string;
  };
}

export interface TerminalTheme {
  name: string;
  bg: string;
  fg: string;
  cursor: string;
  selection: string;
  dim: string;
  ansi: string[]; // 16 colors: 0-7 normal, 8-15 bright
}

export const UI_THEMES: UiTheme[] = [
  {
    name: 'Dark+',
    dark: true,
    c: { bg: '#1f1f1f', bgAlt: '#181818', bgBar: '#181818', bgHover: '#2a2d2e', border: '#2b2b2b', fg: '#cccccc', fgMuted: '#8b8b8b', accent: '#0078d4', accentFg: '#ffffff', selection: '#264f78', lineHighlight: '#282828', gutter: '#6e7681', cursor: '#aeafad', error: '#f14c4c', warning: '#cca700', info: '#3794ff', success: '#89d185', matchingBracket: '#4b4b4b' },
    s: { keyword: '#569cd6', control: '#c586c0', string: '#ce9178', number: '#b5cea8', comment: '#6a9955', function: '#dcdcaa', className: '#4ec9b0', variable: '#9cdcfe', builtin: '#dcdcaa', operator: '#d4d4d4', decorator: '#dcdcaa', type: '#4ec9b0', constant: '#4fc1ff', self: '#569cd6' },
  },
  {
    name: 'Light+',
    dark: false,
    c: { bg: '#ffffff', bgAlt: '#f8f8f8', bgBar: '#f3f3f3', bgHover: '#e8e8e8', border: '#e5e5e5', fg: '#3b3b3b', fgMuted: '#717171', accent: '#005fb8', accentFg: '#ffffff', selection: '#add6ff', lineHighlight: '#f5f5f5', gutter: '#6e7681', cursor: '#000000', error: '#e51400', warning: '#bf8803', info: '#1a85ff', success: '#388a34', matchingBracket: '#c9c9c9' },
    s: { keyword: '#0000ff', control: '#af00db', string: '#a31515', number: '#098658', comment: '#008000', function: '#795e26', className: '#267f99', variable: '#001080', builtin: '#795e26', operator: '#000000', decorator: '#795e26', type: '#267f99', constant: '#0070c1', self: '#0000ff' },
  },
  {
    name: 'One Dark',
    dark: true,
    c: { bg: '#282c34', bgAlt: '#21252b', bgBar: '#21252b', bgHover: '#2c313a', border: '#181a1f', fg: '#abb2bf', fgMuted: '#7f848e', accent: '#528bff', accentFg: '#ffffff', selection: '#3e4451', lineHighlight: '#2c313c', gutter: '#636d83', cursor: '#528bff', error: '#e06c75', warning: '#e5c07b', info: '#61afef', success: '#98c379', matchingBracket: '#515a6b' },
    s: { keyword: '#c678dd', control: '#c678dd', string: '#98c379', number: '#d19a66', comment: '#5c6370', function: '#61afef', className: '#e5c07b', variable: '#e06c75', builtin: '#56b6c2', operator: '#56b6c2', decorator: '#61afef', type: '#e5c07b', constant: '#d19a66', self: '#e5c07b' },
  },
  {
    name: 'Dracula',
    dark: true,
    c: { bg: '#282a36', bgAlt: '#21222c', bgBar: '#191a21', bgHover: '#343746', border: '#191a21', fg: '#f8f8f2', fgMuted: '#6272a4', accent: '#bd93f9', accentFg: '#282a36', selection: '#44475a', lineHighlight: '#44475a75', gutter: '#6272a4', cursor: '#f8f8f2', error: '#ff5555', warning: '#ffb86c', info: '#8be9fd', success: '#50fa7b', matchingBracket: '#6272a4' },
    s: { keyword: '#ff79c6', control: '#ff79c6', string: '#f1fa8c', number: '#bd93f9', comment: '#6272a4', function: '#50fa7b', className: '#8be9fd', variable: '#f8f8f2', builtin: '#8be9fd', operator: '#ff79c6', decorator: '#50fa7b', type: '#8be9fd', constant: '#bd93f9', self: '#bd93f9' },
  },
  {
    name: 'Monokai',
    dark: true,
    c: { bg: '#272822', bgAlt: '#1e1f1c', bgBar: '#1e1f1c', bgHover: '#3e3d32', border: '#1e1f1c', fg: '#f8f8f2', fgMuted: '#75715e', accent: '#a6e22e', accentFg: '#272822', selection: '#49483e', lineHighlight: '#3e3d32', gutter: '#90908a', cursor: '#f8f8f0', error: '#f92672', warning: '#e6db74', info: '#66d9ef', success: '#a6e22e', matchingBracket: '#75715e' },
    s: { keyword: '#f92672', control: '#f92672', string: '#e6db74', number: '#ae81ff', comment: '#75715e', function: '#a6e22e', className: '#a6e22e', variable: '#f8f8f2', builtin: '#66d9ef', operator: '#f92672', decorator: '#a6e22e', type: '#66d9ef', constant: '#ae81ff', self: '#fd971f' },
  },
  {
    name: 'Solarized Dark',
    dark: true,
    c: { bg: '#002b36', bgAlt: '#073642', bgBar: '#073642', bgHover: '#0a4050', border: '#00212b', fg: '#93a1a1', fgMuted: '#586e75', accent: '#268bd2', accentFg: '#fdf6e3', selection: '#073642', lineHighlight: '#073642', gutter: '#586e75', cursor: '#93a1a1', error: '#dc322f', warning: '#b58900', info: '#268bd2', success: '#859900', matchingBracket: '#586e75' },
    s: { keyword: '#859900', control: '#859900', string: '#2aa198', number: '#d33682', comment: '#586e75', function: '#268bd2', className: '#b58900', variable: '#93a1a1', builtin: '#cb4b16', operator: '#859900', decorator: '#cb4b16', type: '#b58900', constant: '#6c71c4', self: '#6c71c4' },
  },
  {
    name: 'Solarized Light',
    dark: false,
    c: { bg: '#fdf6e3', bgAlt: '#eee8d5', bgBar: '#eee8d5', bgHover: '#e4ddc8', border: '#d9d2c0', fg: '#657b83', fgMuted: '#93a1a1', accent: '#268bd2', accentFg: '#fdf6e3', selection: '#eee8d5', lineHighlight: '#eee8d5', gutter: '#93a1a1', cursor: '#657b83', error: '#dc322f', warning: '#b58900', info: '#268bd2', success: '#859900', matchingBracket: '#c8c1ad' },
    s: { keyword: '#859900', control: '#859900', string: '#2aa198', number: '#d33682', comment: '#93a1a1', function: '#268bd2', className: '#b58900', variable: '#657b83', builtin: '#cb4b16', operator: '#859900', decorator: '#cb4b16', type: '#b58900', constant: '#6c71c4', self: '#6c71c4' },
  },
  {
    name: 'Nord',
    dark: true,
    c: { bg: '#2e3440', bgAlt: '#272c36', bgBar: '#272c36', bgHover: '#3b4252', border: '#22262e', fg: '#d8dee9', fgMuted: '#7b88a1', accent: '#88c0d0', accentFg: '#2e3440', selection: '#434c5e', lineHighlight: '#3b4252', gutter: '#4c566a', cursor: '#d8dee9', error: '#bf616a', warning: '#ebcb8b', info: '#81a1c1', success: '#a3be8c', matchingBracket: '#4c566a' },
    s: { keyword: '#81a1c1', control: '#81a1c1', string: '#a3be8c', number: '#b48ead', comment: '#616e88', function: '#88c0d0', className: '#8fbcbb', variable: '#d8dee9', builtin: '#88c0d0', operator: '#81a1c1', decorator: '#d08770', type: '#8fbcbb', constant: '#b48ead', self: '#81a1c1' },
  },
  {
    name: 'Gruvbox Dark',
    dark: true,
    c: { bg: '#282828', bgAlt: '#1d2021', bgBar: '#1d2021', bgHover: '#3c3836', border: '#1d2021', fg: '#ebdbb2', fgMuted: '#928374', accent: '#fe8019', accentFg: '#282828', selection: '#504945', lineHighlight: '#3c3836', gutter: '#7c6f64', cursor: '#ebdbb2', error: '#fb4934', warning: '#fabd2f', info: '#83a598', success: '#b8bb26', matchingBracket: '#665c54' },
    s: { keyword: '#fb4934', control: '#fb4934', string: '#b8bb26', number: '#d3869b', comment: '#928374', function: '#fabd2f', className: '#8ec07c', variable: '#ebdbb2', builtin: '#fe8019', operator: '#fe8019', decorator: '#8ec07c', type: '#fabd2f', constant: '#d3869b', self: '#83a598' },
  },
];

export const TERMINAL_THEMES: TerminalTheme[] = [
  { name: 'Dark+', bg: '#181818', fg: '#cccccc', cursor: '#ffffff', selection: '#264f78', dim: '#8b8b8b', ansi: ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5', '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff'] },
  { name: 'Light+', bg: '#ffffff', fg: '#3b3b3b', cursor: '#000000', selection: '#add6ff', dim: '#8b8b8b', ansi: ['#000000', '#cd3131', '#00bc00', '#949800', '#0451a5', '#bc05bc', '#0598bc', '#555555', '#666666', '#cd3131', '#14ce14', '#b5ba00', '#0451a5', '#bc05bc', '#0598bc', '#a5a5a5'] },
  { name: 'One Dark', bg: '#282c34', fg: '#abb2bf', cursor: '#528bff', selection: '#3e4451', dim: '#5c6370', ansi: ['#282c34', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf', '#5c6370', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff'] },
  { name: 'Dracula', bg: '#282a36', fg: '#f8f8f2', cursor: '#f8f8f2', selection: '#44475a', dim: '#6272a4', ansi: ['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2', '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff'] },
  { name: 'Monokai', bg: '#272822', fg: '#f8f8f2', cursor: '#f8f8f0', selection: '#49483e', dim: '#75715e', ansi: ['#272822', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f8f8f2', '#75715e', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f9f8f5'] },
  { name: 'Solarized Dark', bg: '#002b36', fg: '#839496', cursor: '#93a1a1', selection: '#073642', dim: '#586e75', ansi: ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5', '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3'] },
  { name: 'Solarized Light', bg: '#fdf6e3', fg: '#657b83', cursor: '#657b83', selection: '#eee8d5', dim: '#93a1a1', ansi: ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5', '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3'] },
  { name: 'Nord', bg: '#2e3440', fg: '#d8dee9', cursor: '#d8dee9', selection: '#434c5e', dim: '#4c566a', ansi: ['#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0', '#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4'] },
  { name: 'Gruvbox Dark', bg: '#282828', fg: '#ebdbb2', cursor: '#ebdbb2', selection: '#504945', dim: '#928374', ansi: ['#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984', '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2'] },
  { name: 'Campbell', bg: '#0c0c0c', fg: '#cccccc', cursor: '#ffffff', selection: '#ffffff40', dim: '#767676', ansi: ['#0c0c0c', '#c50f1f', '#13a10e', '#c19c00', '#0037da', '#881798', '#3a96dd', '#cccccc', '#767676', '#e74856', '#16c60c', '#f9f1a5', '#3b78ff', '#b4009e', '#61d6d6', '#f2f2f2'] },
  { name: 'Classic Green', bg: '#050805', fg: '#33ff33', cursor: '#33ff33', selection: '#1f5f1f', dim: '#1f8f1f', ansi: ['#0a0a0a', '#ff5555', '#33ff33', '#ffff55', '#5599ff', '#ff55ff', '#55ffff', '#33ff33', '#555555', '#ff7777', '#77ff77', '#ffff77', '#77aaff', '#ff77ff', '#77ffff', '#aaffaa'] },
  { name: 'Amber', bg: '#0b0803', fg: '#ffb000', cursor: '#ffb000', selection: '#5a3d00', dim: '#8a6200', ansi: ['#0a0a0a', '#ff5555', '#ffb000', '#ffd866', '#ffb000', '#ff8800', '#ffcc55', '#ffb000', '#555555', '#ff7777', '#ffc040', '#ffe58a', '#ffc040', '#ffa040', '#ffdd88', '#ffe0a0'] },
];

export function uiTheme(name: string): UiTheme {
  return UI_THEMES.find((t) => t.name === name) ?? UI_THEMES[0];
}

export function terminalTheme(name: string): TerminalTheme {
  return TERMINAL_THEMES.find((t) => t.name === name) ?? TERMINAL_THEMES[0];
}

export function applyUiTheme(el: HTMLElement, t: UiTheme): void {
  for (const [k, v] of Object.entries(t.c)) el.style.setProperty(`--${k}`, v);
  for (const [k, v] of Object.entries(t.s)) el.style.setProperty(`--s-${k}`, v);
  el.style.setProperty('color-scheme', t.dark ? 'dark' : 'light');
}

export function applyTerminalTheme(el: HTMLElement, t: TerminalTheme): void {
  el.style.setProperty('--t-bg', t.bg);
  el.style.setProperty('--t-fg', t.fg);
  el.style.setProperty('--t-cursor', t.cursor);
  el.style.setProperty('--t-sel', t.selection);
  el.style.setProperty('--t-dim', t.dim);
  t.ansi.forEach((c, i) => el.style.setProperty(`--t-a${i}`, c));
}
