export interface ThemeSyntax {
  keyword: string;
  string: string;
  number: string;
  comment: string;
  function: string;
  type: string;
  operator: string;
}

export interface Theme {
  id: string;
  label: string;
  kind: 'dark' | 'light';
  editor: string;
  panel: string;
  raised: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  selection: string;
  selectionText?: string;
  activeLine: string;
  danger: string;
  syntax: ThemeSyntax;
}

export const DEFAULT_THEME_ID = 'rsedit-dark';

export const THEMES: Theme[] = [
  {
    id: 'rsedit-dark',
    label: 'Rsedit Dark',
    kind: 'dark',
    editor: '#181a1e',
    panel: '#202329',
    raised: '#2b3038',
    text: '#d5dae2',
    muted: '#89929f',
    border: '#333943',
    accent: '#e1ac69',
    selection: '#384c68',
    activeLine: '#ffffff04',
    danger: '#ec9a95',
    syntax: {
      keyword: '#c7a0d5',
      string: '#a6c58b',
      number: '#dfb57c',
      comment: '#818997',
      function: '#91b8de',
      type: '#e1c991',
      operator: '#a9bddd',
    },
  },
  {
    id: 'rsedit-light',
    label: 'Rsedit Light',
    kind: 'light',
    editor: '#faf9f6',
    panel: '#f0efec',
    raised: '#e6e5e1',
    text: '#292e36',
    muted: '#707884',
    border: '#d7d7d3',
    accent: '#93612c',
    selection: '#c8dcf3',
    activeLine: '#00000003',
    danger: '#b63832',
    syntax: {
      keyword: '#83539a',
      string: '#426b2d',
      number: '#9a631f',
      comment: '#727981',
      function: '#366d9a',
      type: '#85632c',
      operator: '#466985',
    },
  },
  {
    id: 'monokai',
    label: 'Monokai',
    kind: 'dark',
    editor: '#272822',
    panel: '#1e1f1c',
    raised: '#3e3d32',
    text: '#f8f8f2',
    muted: '#90908a',
    border: '#49483e',
    accent: '#e6db74',
    selection: '#49483e',
    activeLine: '#ffffff08',
    danger: '#f92672',
    syntax: {
      keyword: '#f92672',
      string: '#e6db74',
      number: '#ae81ff',
      comment: '#75715e',
      function: '#a6e22e',
      type: '#66d9ef',
      operator: '#fd971f',
    },
  },
  {
    id: 'dracula',
    label: 'Dracula',
    kind: 'dark',
    editor: '#282a36',
    panel: '#21222c',
    raised: '#44475a',
    text: '#f8f8f2',
    muted: '#8a93b8',
    border: '#44475a',
    accent: '#bd93f9',
    selection: '#44475a',
    activeLine: '#44475a44',
    danger: '#ff5555',
    syntax: {
      keyword: '#ff79c6',
      string: '#f1fa8c',
      number: '#bd93f9',
      comment: '#6272a4',
      function: '#50fa7b',
      type: '#8be9fd',
      operator: '#ffb86c',
    },
  },
  {
    id: 'nord',
    label: 'Nord',
    kind: 'dark',
    editor: '#2e3440',
    panel: '#272c36',
    raised: '#434c5e',
    text: '#eceff4',
    muted: '#8a97ad',
    border: '#434c5e',
    accent: '#88c0d0',
    selection: '#434c5e',
    activeLine: '#ffffff05',
    danger: '#bf616a',
    syntax: {
      keyword: '#81a1c1',
      string: '#a3be8c',
      number: '#b48ead',
      comment: '#6b7891',
      function: '#88c0d0',
      type: '#ebcb8b',
      operator: '#8fbcbb',
    },
  },
  {
    id: 'solarized-dark',
    label: 'Solarized Dark',
    kind: 'dark',
    editor: '#002b36',
    panel: '#00212b',
    raised: '#073642',
    text: '#839496',
    muted: '#6e8a90',
    border: '#073642',
    accent: '#b58900',
    selection: '#073642',
    selectionText: '#a8b6b7',
    activeLine: '#ffffff06',
    danger: '#dc322f',
    syntax: {
      keyword: '#d33682',
      string: '#859900',
      number: '#cb4b16',
      comment: '#586e75',
      function: '#268bd2',
      type: '#b58900',
      operator: '#2aa198',
    },
  },
  {
    id: 'solarized-light',
    label: 'Solarized Light',
    kind: 'light',
    editor: '#fdf6e3',
    panel: '#eee8d5',
    raised: '#e3dac3',
    text: '#586e75',
    muted: '#839496',
    border: '#e0d6b8',
    accent: '#9a7d00',
    selection: '#e2d5ae',
    selectionText: '#3d4c51',
    activeLine: '#00000005',
    danger: '#dc322f',
    syntax: {
      keyword: '#d33682',
      string: '#859900',
      number: '#cb4b16',
      comment: '#93a1a1',
      function: '#268bd2',
      type: '#9a7d00',
      operator: '#2aa198',
    },
  },
  {
    id: 'one-dark',
    label: 'One Dark',
    kind: 'dark',
    editor: '#282c34',
    panel: '#21252b',
    raised: '#353b45',
    text: '#abb2bf',
    muted: '#767c87',
    border: '#3a3f4b',
    accent: '#61afef',
    selection: '#3e4451',
    activeLine: '#ffffff05',
    danger: '#e06c75',
    syntax: {
      keyword: '#c678dd',
      string: '#98c379',
      number: '#d19a66',
      comment: '#5c6370',
      function: '#61afef',
      type: '#e5c07b',
      operator: '#56b6c2',
    },
  },
  {
    id: 'gruvbox-dark',
    label: 'Gruvbox Dark',
    kind: 'dark',
    editor: '#282828',
    panel: '#1d2021',
    raised: '#3c3836',
    text: '#ebdbb2',
    muted: '#a89984',
    border: '#3c3836',
    accent: '#fabd2f',
    selection: '#504945',
    activeLine: '#ffffff05',
    danger: '#fb4934',
    syntax: {
      keyword: '#fb4934',
      string: '#b8bb26',
      number: '#d3869b',
      comment: '#928374',
      function: '#83a598',
      type: '#fabd2f',
      operator: '#fe8019',
    },
  },
  {
    id: 'tokyo-night',
    label: 'Tokyo Night',
    kind: 'dark',
    editor: '#1a1b26',
    panel: '#16161e',
    raised: '#24283b',
    text: '#c0caf5',
    muted: '#7a85b3',
    border: '#292e42',
    accent: '#7aa2f7',
    selection: '#33467c',
    activeLine: '#ffffff05',
    danger: '#f7768e',
    syntax: {
      keyword: '#bb9af7',
      string: '#9ece6a',
      number: '#ff9e64',
      comment: '#565f89',
      function: '#7aa2f7',
      type: '#e0af68',
      operator: '#7dcfff',
    },
  },
];

export function getTheme(id: string): Theme {
  return THEMES.find(theme => theme.id === id) ?? THEMES[0];
}

export function normalizeThemeId(value: unknown): string {
  if (typeof value === 'string') {
    if (THEMES.some(theme => theme.id === value)) return value;
    // Migrate the previous dark/light preference.
    if (value === 'light') return 'rsedit-light';
    if (value === 'dark') return 'rsedit-dark';
  }
  return DEFAULT_THEME_ID;
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.dataset.theme = theme.kind;
  root.dataset.themeName = theme.id;
  root.style.setProperty('color-scheme', theme.kind);
  root.style.setProperty('--editor', theme.editor);
  root.style.setProperty('--panel', theme.panel);
  root.style.setProperty('--raised', theme.raised);
  root.style.setProperty('--text', theme.text);
  root.style.setProperty('--muted', theme.muted);
  root.style.setProperty('--border', theme.border);
  root.style.setProperty('--accent', theme.accent);
  root.style.setProperty('--selection', theme.selection);
  root.style.setProperty('--selection-text', theme.selectionText ?? theme.text);
  root.style.setProperty('--active-line', theme.activeLine);
  root.style.setProperty('--danger', theme.danger);
  root.style.setProperty('--syntax-keyword', theme.syntax.keyword);
  root.style.setProperty('--syntax-string', theme.syntax.string);
  root.style.setProperty('--syntax-number', theme.syntax.number);
  root.style.setProperty('--syntax-comment', theme.syntax.comment);
  root.style.setProperty('--syntax-function', theme.syntax.function);
  root.style.setProperty('--syntax-type', theme.syntax.type);
  root.style.setProperty('--syntax-operator', theme.syntax.operator);
}
