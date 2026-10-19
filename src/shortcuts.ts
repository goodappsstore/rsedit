export type ShortcutAction =
  | 'new' | 'open' | 'open-folder' | 'save' | 'save-as' | 'close' | 'reopen' | 'quit'
  | 'find' | 'find-view' | 'palette' | 'quick-open' | 'go-to-line' | 'wrap' | 'split'
  | 'previous-tab' | 'next-tab' | 'undo' | 'redo'
  | 'increase-font-size' | 'decrease-font-size' | 'reset-font-size';

const bindings: Readonly<Partial<Record<string, ShortcutAction>>> = {
  'Mod-n': 'new',
  'Mod-o': 'open',
  'Mod-Alt-o': 'open-folder',
  'Mod-s': 'save',
  'Mod-Shift-s': 'save-as',
  'Mod-w': 'close',
  'Mod-Shift-t': 'reopen',
  'Mod-q': 'quit',
  'Mod-f': 'find',
  'Mod-Shift-p': 'palette',
  'Mod-p': 'quick-open',
  'Mod-g': 'go-to-line',
  'Mod-Shift-w': 'wrap',
  'Mod-\\': 'split',
  'Mod-Shift-[': 'previous-tab',
  'Mod-Shift-]': 'next-tab',
  'Mod-z': 'undo',
  'Mod-Shift-z': 'redo',
  'Mod-y': 'redo',
};

export function appShortcut(event: KeyboardEvent, mac: boolean): ShortcutAction | undefined {
  if (event.defaultPrevented || event.isComposing || event.getModifierState('AltGraph')) return;
  if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === 'Tab') {
    return event.shiftKey ? 'previous-tab' : 'next-tab';
  }
  if (!(mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return;
  if (!event.altKey) {
    if (event.key === '+' || event.key === '=') return 'increase-font-size';
    if (event.key === '-') return 'decrease-font-size';
    if (event.key === '0' && !event.shiftKey) return 'reset-font-size';
  }
  let key = event.key.toLowerCase();
  // Option changes letter keys on macOS (e.g. Option+F produces ƒ). Physical
  // letter fallbacks also keep shortcuts usable with non-Latin layouts.
  if (/^Key[A-Z]$/.test(event.code) && (event.altKey || !/^[a-z]$/.test(key))) {
    key = event.code.slice(3).toLowerCase();
  } else if (event.code === 'BracketLeft' || key === '{') key = '[';
  else if (event.code === 'BracketRight' || key === '}') key = ']';
  else if (event.code === 'Backslash') key = '\\';
  const shortcut = `Mod-${event.altKey ? 'Alt-' : ''}${event.shiftKey ? 'Shift-' : ''}${key}`;
  if (shortcut === (mac ? 'Mod-Alt-f' : 'Mod-h')) return 'find-view';
  return bindings[shortcut];
}
