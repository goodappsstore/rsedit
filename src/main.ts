import './style.css';
import { ChangeSet, EditorSelection, EditorState, StateEffect } from '@codemirror/state';
import type { Text } from '@codemirror/state';
import { EditorView, keymap, panels, placeholder } from '@codemirror/view';
import type { ViewUpdate } from '@codemirror/view';
import { Compartment } from '@codemirror/state';
import { openSearchPanel, closeSearchPanel, searchPanelOpen, getSearchQuery, setSearchQuery, SearchQuery, gotoLine, selectSelectionMatches } from '@codemirror/search';
import { indentUnit } from '@codemirror/language';
import { undo, redo, toggleComment, selectAll, copyLineDown, moveLineUp, moveLineDown, deleteLine } from '@codemirror/commands';
import { call, desktop, formatBytes } from './api';
import type { Info, Page, SearchScan, TabView, RestoredTab, RestoredSession, ExternalChange, QuickOpen, ReplaceResult, OpenRequest } from './api';
import { currentMatch, detectLanguage, indentSlot, languageSlot, makeState, panelSlot, wrapSlot } from './editor';
import { THEMES, applyTheme, getTheme, normalizeThemeId } from './themes';
import { createFolderPanel } from './folders';

interface Tab {
  info: Info;
  state: EditorState;
  pageStart: number;
  pageEnd: number;
  syncedDoc: Text;
  changes?: ChangeSet;
  savedDoc?: Text;
  pending: boolean;
  busy: boolean;
  language: string;
  languageGeneration: number;
  languageOverride?: string;
  previous: number[];
  scrollTop: number;
  scrollLeft: number;
  loaded: boolean;
  savedView?: TabView;
  loading?: Promise<void>;
  indent: string;
  tabSize: number;
  externalToken?: string;
}
interface Preferences { theme: string; wrap: boolean; indent: number; fontSize: number }
interface Command { label: string; shortcut?: string; run: () => void | Promise<void>; preview?: () => void }
const mac = /Mac|iPhone|iPad/.test(navigator.platform);
const mod = mac ? '⌘' : 'Ctrl+';
function readStored<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback; } catch { return fallback; }
}
const stored = readStored<Partial<Preferences>>('rsedit.preferences', {});
const preferences: Preferences = {
  theme: normalizeThemeId(stored.theme), wrap: stored.wrap !== false,
  indent: [2, 4, 8].includes(Number(stored.indent)) ? Number(stored.indent) : 4,
  fontSize: Number.isFinite(stored.fontSize) ? Math.min(28, Math.max(10, Number(stored.fontSize))) : 14,
};
let recent = readStored<unknown>('rsedit.recent', []);
let recentPaths: string[] = Array.isArray(recent) ? recent.filter((x): x is string => typeof x === 'string').slice(0, 20) : [];
const tabs: Tab[] = [];
const closedTabs: Tab[] = [];
const selectionHistory: Tab[] = [];
let historyQueue: Promise<void> = Promise.resolve();
let startupPromise: Promise<void> | undefined;
let active: Tab | undefined;
let nextUntitled = 0;
let shuttingDown = false;
let sessionReady = false;
let checkpointPromise: Promise<void> | undefined;
let checkingExternal = false;
const lockSlot = new Compartment();
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <div class="workbench">
    <aside class="folder-panel" aria-label="Folder files" hidden>
      <header class="folder-header"><span class="folder-title"></span><button data-action="refresh-folder" title="Refresh folder tree" aria-label="Refresh folder tree">↻</button><button data-action="close-folder" title="Close folder panel" aria-label="Close folder panel">×</button></header>
      <div class="folder-tree" role="tree" aria-label="Folder files"></div>
    </aside>
    <div class="folder-divider" role="separator" aria-label="Folder panel width" aria-orientation="vertical" aria-valuemin="140" aria-valuemax="600" aria-valuenow="220" tabindex="0" hidden></div>
    <div class="editor-pane">
  <div class="tabstrip">
    <nav class="tabs" aria-label="Open files" role="tablist"></nav>
    <button class="new-tab" data-action="new" title="New file" aria-label="New file">+</button>
  </div>
  <div class="notice" role="status" hidden><span></span><button aria-label="Dismiss notification">×</button></div>
  <main class="workspace">
    <div class="pagebar" hidden>
      <strong>Large-file view</strong><span class="range"></span>
      <button data-page="previous" title="Previous section">← Previous</button>
      <button data-page="next" title="Next section">Next →</button>
      <input class="byte-offset" type="number" min="0" step="1" aria-label="Go to byte offset" placeholder="Byte offset" />
      <button data-page="jump">Go</button>
    </div>
    <div class="split-row"></div>
    <section class="large-search" aria-label="Search entire large file" hidden>
      <div class="search-row"><input class="large-query" aria-label="Search entire file" placeholder="Find exact text across the whole file" maxlength="4096" /><button data-search="start">Search</button><span class="large-match-count match-count" role="status" aria-live="polite">0 matches</span><button data-search="close" aria-label="Close file search">×</button></div>
      <div class="search-row"><input class="large-replacement" aria-label="Replacement text for entire file" placeholder="Replace with (literal text)" /><button data-search="replace-all">Replace all in entire file</button></div>
      <p class="search-hint">Enter: next · Shift+Enter: previous · Escape: close search. Case-sensitive literal whole-file search and replace. Undo spans the file.</p>
      
    </section>
    <div class="search-dock"></div>
  </main>
    </div>
  </div>
  <footer class="statusbar">
    <span class="path"></span><span class="position"></span>
    <span class="recovery" role="status"></span><span class="size"></span><span class="encoding">UTF-8</span><span class="eol"></span>
    <button data-action="indent" title="Change indentation size"></button>
    <button data-action="language" title="Select syntax language"></button>
  </footer>
  <div class="overlay" hidden>
    <section class="palette" role="dialog" aria-modal="true" aria-label="Command palette">
      <header><input class="palette-query" aria-label="Filter commands" placeholder="Type a command…" autocomplete="off" /><button data-palette="close" aria-label="Close command palette">×</button></header>
      <div class="palette-list" role="listbox"></div>
      <footer>↑ ↓ to navigate · Enter to run · Esc to close</footer>
    </section>
  </div>`;
function element<T extends HTMLElement = HTMLElement>(selector: string): T { return app.querySelector<T>(selector)!; }
const tabbar = element('.tabs');
const notice = element('.notice');
const pagebar = element('.pagebar');
const largeSearch = element('.large-search');
const searchDock = element('.search-dock');
const overlay = element('.overlay');
const paletteQuery = element<HTMLInputElement>('.palette-query');
const queryInput = element<HTMLInputElement>('.large-query');
const byteOffset = element<HTMLInputElement>('.byte-offset');

function notify(message: string, error = false): void {
  notice.hidden = false;
  notice.classList.toggle('error', error);
  notice.querySelector('span')!.textContent = message;
}
async function safely(action: () => unknown | Promise<unknown>): Promise<void> {
  if (shuttingDown) return;
  try { await action(); } catch (error) { notify(String(error instanceof Error ? error.message : error), true); }
}
function storePreferences(): void {
  const theme = getTheme(preferences.theme);
  preferences.theme = theme.id;
  applyTheme(theme);
  document.documentElement.style.setProperty('--font-size', `${preferences.fontSize}px`);
  try { localStorage.setItem('rsedit.preferences', JSON.stringify(preferences)); } catch { /* Storage may be disabled. */ }
  if (desktop) void safely(() => call('set_word_wrap_menu', { enabled: preferences.wrap }));
}
function remember(path: string | null): void {
  if (!path) return;
  recentPaths = [path, ...recentPaths.filter(p => p !== path)].slice(0, 20);
  try { localStorage.setItem('rsedit.recent', JSON.stringify(recentPaths)); } catch { /* Nonessential. */ }
}
function dirty(tab: Tab): boolean {
  return !tab.info.paged && tab.savedDoc ? !tab.state.doc.eq(tab.savedDoc) : tab.pending || tab.info.dirty;
}
// Keep in sync with custom native menu accelerators in lib.rs.
const nativeShortcuts = new Set([
  'Mod-n', 'Mod-o', 'Mod-Alt-o', 'Mod-s', 'Mod-Shift-s', 'Mod-w',
  'Mod-Shift-t', 'Mod-z', 'Mod-Shift-z', 'Mod-f', 'Mod-Shift-p', 'Mod-Shift-w', 'Mod-q',
]);
// Consume native bindings in CodeMirror too, including keyboard-layout
// fallbacks whose DOM key is not a Latin letter.
const shortcuts = keymap.of([
  { key: 'Mod-z', run: () => { void safely(() => history(false)); return true; } },
  { key: 'Mod-Shift-z', run: () => { void safely(() => history(true)); return true; } },
  { key: 'Mod-y', run: () => { void safely(() => history(true)); return true; } },
  { key: 'Mod-n', run: () => { void safely(newTab); return true; } },
  { key: 'Mod-o', run: () => { void safely(openFiles); return true; } },
  { key: 'Mod-Alt-o', run: () => { void safely(folders.open); return true; } },
  { key: 'Mod-s', run: () => { void safely(() => saveTab(active)); return true; } },
  { key: 'Mod-Shift-s', run: () => { void safely(() => saveTab(active, true)); return true; } },
  { key: 'Mod-Shift-t', run: () => { void safely(reopenClosedTab); return true; } },
  { key: 'Mod-w', run: () => { void safely(() => closeTab(active)); return true; } },
  { key: 'Mod-f', run: () => { find(); return true; } },
  { key: mac ? 'Mod-Alt-f' : 'Mod-h', run: () => { openSectionSearch(); return true; } },
  { key: 'Mod-Shift-p', run: () => { showCommands(); return true; } },
  { key: 'Mod-p', run: () => { showFiles(); return true; } },
  { key: 'Mod-g', run: () => { gotoLine(view); return true; } },
  { key: 'Mod-Shift-w', run: () => { toggleWrap(); return true; } },
  { key: 'Mod-\\', run: () => { if (secondaryPane) closeSplit(); else splitRight(); return true; } },
  { key: 'Mod-Shift-[', run: () => { cycleTab(-1); return true; } },
  { key: 'Mod-Shift-]', run: () => { cycleTab(1); return true; } },
  { key: 'Ctrl-Tab', run: () => { cycleTab(1); return true; } },
  { key: 'Ctrl-Shift-Tab', run: () => { cycleTab(-1); return true; } },
  { key: 'Escape', run: () => { if (!largeSearch.hidden) { closeLargeSearch(); return true; } if (searchPanelOpen(view.state)) { closeSectionSearch(); return true; } return false; } },
].map(binding => desktop && nativeShortcuts.has(binding.key) ? { ...binding, run: () => true } : binding));
interface Pane {
  element: HTMLElement;
  host: HTMLElement;
  searchHost: HTMLElement;
  view: EditorView;
  interactionVersion: number;
  tab?: Tab;
}
const panes: Pane[] = [];
let focusedPane!: Pane;
let view!: EditorView;
const primaryPane = makePane();
element('.split-row').append(primaryPane.element);
focusedPane = primaryPane;
view = primaryPane.view;
let secondaryPane: Pane | undefined;
let splitDivider: HTMLElement | undefined;
let splitRatio = 0.5;
try {
  const stored = Number(localStorage.getItem('rsedit.splitRatio'));
  if (Number.isFinite(stored) && stored > 0.15 && stored < 0.85) splitRatio = stored;
} catch { /* Optional preference. */ }
function makePane(): Pane {
  const element = document.createElement('div');
  element.className = 'split-pane';
  const host = document.createElement('div');
  host.className = 'editor-host';
  element.append(host);
  const searchHost = document.createElement('div');
  searchHost.hidden = panes.length > 0;
  searchDock.append(searchHost);
  const pane: Pane = {
    element, host, searchHost, interactionVersion: 0,
    view: new EditorView({
      parent: host,
      state: EditorState.create({
        doc: '',
        extensions: [
          EditorState.readOnly.of(true), EditorView.editable.of(false),
          placeholder('Open a file or click a tab to show it here.'),
        ],
      }),
    }),
  };
  for (const event of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    pane.view.dom.addEventListener(event, () => { pane.interactionVersion++; }, { capture: true, passive: true });
  }
  pane.view.dom.addEventListener('focusin', () => { if (focusedPane !== pane) focusPane(pane, false); });
  searchHost.addEventListener('input', commitSectionQuery);
  searchHost.addEventListener('compositionend', commitSectionQuery);
  searchHost.addEventListener('focusin', () => { if (focusedPane !== pane) focusPane(pane, false); });
  panes.push(pane);
  return pane;
}
function paneOfTab(tab: Tab): Pane | undefined {
  return panes.find(pane => pane.tab === tab);
}
function showInPane(tab: Tab, pane: Pane): void {
  pane.interactionVersion++;
  pane.tab = tab;
  tab.state = tab.state.update({ effects: panelSlot.reconfigure(panels({ bottomContainer: pane.searchHost })) }).state;
  pane.view.setState(tab.state);
  pane.view.scrollDOM.scrollTop = tab.scrollTop;
  pane.view.scrollDOM.scrollLeft = tab.scrollLeft;
  updateSectionCount(undefined, pane);
}
function focusPane(pane: Pane, focusEditor = true): void {
  if (!panes.includes(pane)) return;
  if (active !== pane.tab) hideLargeSearch();
  focusedPane = pane;
  view = pane.view;
  active = pane.tab;
  for (const candidate of panes) candidate.searchHost.hidden = candidate !== pane;
  updateSectionCount(undefined, pane);
  pane.view.requestMeasure();
  renderTabs(); renderStatus();
  if (pane.tab && !pane.tab.loaded) void safely(() => ensureLoaded(pane.tab!));
  if (focusEditor && pane.tab) pane.view.focus();
}
function applySplitRatio(): void {
  if (!secondaryPane || !splitDivider) return;
  primaryPane.element.style.flexGrow = String(splitRatio);
  secondaryPane.element.style.flexGrow = String(1 - splitRatio);
  for (const pane of panes) pane.view.requestMeasure();
}
function storeSplitRatio(): void {
  try { localStorage.setItem('rsedit.splitRatio', String(splitRatio)); } catch { /* Optional preference. */ }
}
function makeSplitPane(): Pane {
  const row = element('.split-row');
  splitDivider = document.createElement('div');
  splitDivider.className = 'split-divider';
  splitDivider.setAttribute('role', 'separator');
  splitDivider.setAttribute('aria-label', 'Split pane width');
  splitDivider.setAttribute('aria-orientation', 'vertical');
  splitDivider.tabIndex = 0;
  const pane = makePane();
  secondaryPane = pane;
  row.append(splitDivider, pane.element);
  applySplitRatio();
  let drag: { x: number; ratio: number; pointerId: number } | undefined;
  splitDivider.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag = { x: event.clientX, ratio: splitRatio, pointerId: event.pointerId };
    splitDivider!.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing-split');
  });
  splitDivider.addEventListener('pointermove', event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const rect = row.getBoundingClientRect();
    if (rect.width > 0) {
      splitRatio = Math.min(0.85, Math.max(0.15, drag.ratio + (event.clientX - drag.x) / rect.width));
      applySplitRatio();
    }
  });
  const endDrag = (): void => {
    if (!drag) return;
    drag = undefined;
    document.body.classList.remove('resizing-split');
    storeSplitRatio();
  };
  splitDivider.addEventListener('pointerup', endDrag);
  splitDivider.addEventListener('pointercancel', endDrag);
  splitDivider.addEventListener('lostpointercapture', endDrag);
  splitDivider.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    splitRatio = Math.min(0.85, Math.max(0.15, splitRatio + (event.key === 'ArrowLeft' ? -0.05 : 0.05)));
    applySplitRatio();
    storeSplitRatio();
  });
  return pane;
}
function closeSplitPane(pane: Pane): void {
  const index = panes.indexOf(pane);
  if (index === -1 || pane === primaryPane) return;
  if (pane.tab) {
    pane.tab.scrollTop = pane.view.scrollDOM.scrollTop;
    pane.tab.scrollLeft = pane.view.scrollDOM.scrollLeft;
  }
  pane.view.destroy();
  pane.element.remove();
  pane.searchHost.remove();
  splitDivider?.remove();
  splitDivider = undefined;
  panes.splice(index, 1);
  if (pane === secondaryPane) secondaryPane = undefined;
  if (focusedPane === pane) focusPane(primaryPane, false);
  else {
    renderTabs();
    focusedPane.view.requestMeasure();
  }
}
function splitRight(): void {
  if (secondaryPane) { focusPane(secondaryPane); return; }
  const pane = makeSplitPane();
  const other = [...selectionHistory].reverse().find(candidate => candidate !== active)
    ?? tabs.find(candidate => candidate !== active);
  if (other) {
    showInPane(other, pane);
    void safely(() => ensureLoaded(other));
  }
  focusPane(pane);
  notify(other ? `Split opened with ${other.info.name}. Click either side to focus it.` : 'Split opened. Click a tab or open a file to show it here.');
}
function closeSplit(): void {
  if (!secondaryPane) { notify('No split is open.'); return; }
  closeSplitPane(secondaryPane);
}
function focusOtherPane(): void {
  if (!secondaryPane) { notify('No split is open.'); return; }
  focusPane(focusedPane === primaryPane ? secondaryPane : primaryPane);
}
function moveTabToOtherPane(): void {
  const tab = active;
  if (!tab) return;
  const source = focusedPane;
  let target = panes.find(pane => pane !== source);
  if (!target) target = makeSplitPane();
  if (target.tab) {
    const other = target.tab;
    showInPane(tab, target);
    showInPane(other, source);
    void safely(() => ensureLoaded(other));
    focusPane(target);
    return;
  }
  source.tab = undefined;
  showInPane(tab, target);
  const replacement = [...selectionHistory].reverse().find(candidate => candidate !== tab)
    ?? tabs.find(candidate => candidate !== tab);
  if (replacement) {
    showInPane(replacement, source);
    void safely(() => ensureLoaded(replacement));
  } else if (source === primaryPane) void safely(newTab);
  else closeSplitPane(source);
  focusPane(target);
}
const folders = createFolderPanel(element('.folder-panel'), element('.folder-divider'), path => safely(() => openPath(path)),
  error => notify(String(error instanceof Error ? error.message : error), true), () => view.requestMeasure(), {
  notify,
  confirmDelete,
  renamed: handleRenamed,
  deleted: handleDeleted,
});
function changed(update: ViewUpdate): void {
  const pane = panes.find(candidate => candidate.view === update.view);
  const tab = pane?.tab;
  if (!pane || !tab) return;
  tab.state = update.state;
  updateSectionCount(update, pane);
  if (update.docChanged) {
    const origin = largeOrigin;
    if (origin?.tab === tab && origin.pageStart === tab.pageStart) {
      origin.selection = origin.selection.map(update.changes);
      origin.byteOffset = tab.pageStart + new TextEncoder().encode(update.state.sliceDoc(0, origin.selection.main.head)).length;
    }
    tab.changes = (tab.changes ?? ChangeSet.empty(update.startState.doc.length)).compose(update.changes);
    tab.pending = !update.state.doc.eq(tab.syncedDoc);
    if (!tab.pending) tab.changes = undefined;
    if (sessionReady && !checkpointPromise) element('.recovery').textContent = 'Recovery pending';
    if (tab === largeFind?.tab) cancelSearch();
    if (tab === active) element('.large-match-count').textContent = 'Search changed; press Enter to search again.';
    updateDirtyMark(tab);
  }
  if ((update.selectionSet || update.docChanged) && tab === active) renderStatus();
}
function options(tab?: Pick<Tab, 'indent' | 'tabSize'>) {
  return { wrap: preferences.wrap, indent: tab?.indent ?? ' '.repeat(preferences.indent), tabSize: tab?.tabSize ?? preferences.indent, changed, shortcuts };
}
function detectIndent(text: string): { indent: string; tabSize: number } {
  let tabs = 0;
  const widths = new Map<number, number>();
  for (const line of text.slice(0, 64 * 1024).split('\n')) {
    if (/^\t[ \t]*\S/.test(line)) tabs++;
    const spaces = /^( +)\S/.exec(line)?.[1].length;
    if (spaces && spaces <= 32) widths.set(spaces, (widths.get(spaces) ?? 0) + 1);
  }
  const spaces = [...widths.values()].reduce((sum, n) => sum + n, 0);
  if (tabs > spaces) return { indent: '\t', tabSize: preferences.indent };
  const width = [8, 4, 2].find(n => widths.size > 0 && [...widths.keys()].every(w => w % n === 0)) ?? preferences.indent;
  return { indent: ' '.repeat(width), tabSize: width };
}
function lockExtension(busy: boolean) { return [EditorState.readOnly.of(busy), EditorView.editable.of(!busy)]; }
function applyEffect(tab: Tab, effects: StateEffect<unknown> | readonly StateEffect<unknown>[]): void {
  const shown = paneOfTab(tab);
  if (shown) shown.view.dispatch({ effects });
  else tab.state = tab.state.update({ effects }).state;
}
async function locked<T>(tab: Tab, action: () => Promise<T>): Promise<T> {
  if (tab.busy) throw new Error('This file has an operation in progress. You can switch to another tab.');
  tab.busy = true;
  applyEffect(tab, lockSlot.reconfigure(lockExtension(true)));
  renderStatus();
  try { return await action(); } finally {
    tab.busy = false;
    applyEffect(tab, lockSlot.reconfigure(lockExtension(!tab.loaded)));
    renderStatus(); renderTabs();
  }
}
function installPage(tab: Tab, page: Page): void {
  tab.info = page.info;
  tab.pageStart = page.start;
  tab.pageEnd = page.end;
  tab.state = makeState(page, options(tab));
  tab.state = tab.state.update({ effects: StateEffect.appendConfig.of(lockSlot.of(lockExtension(tab.busy))) }).state;
  tab.syncedDoc = tab.state.doc;
  tab.changes = undefined;
  tab.savedDoc = !page.info.dirty && !page.info.paged ? tab.state.doc : undefined;
  tab.pending = false;
  tab.loaded = true;
  tab.scrollTop = tab.scrollLeft = 0;
  const shown = paneOfTab(tab);
  if (shown) { showInPane(tab, shown); if (shown === focusedPane) shown.view.focus(); }
  void loadLanguage(tab);
  renderTabs(); renderStatus();
}
async function addPage(page: Page): Promise<void> {
  const tab: Tab = {
    info: page.info, state: makeState(page, options()), pageStart: page.start, pageEnd: page.end,
    syncedDoc: EditorState.create().doc, pending: false, busy: false,
    language: 'Plain text', languageGeneration: 0, previous: [], scrollTop: 0, scrollLeft: 0, loaded: true,
    ...detectIndent(page.text),
  };
  if (!tab.info.path) tab.info.name = `Untitled ${++nextUntitled}`;
  tab.state = tab.state.update({ effects: StateEffect.appendConfig.of(lockSlot.of(lockExtension(false))) }).state;
  tab.syncedDoc = tab.state.doc;
  tab.changes = undefined;
  tab.savedDoc = !page.info.dirty && !page.info.paged ? tab.state.doc : undefined;
  applyEffect(tab, indentSlot.reconfigure([indentUnit.of(tab.indent), EditorState.tabSize.of(tab.tabSize)]));
  tabs.push(tab);
  activate(tab);
  remember(tab.info.path);
  void loadLanguage(tab);
}
function restoredTab(entry: RestoredTab): Tab {
  const page: Page = { info: entry.info, text: '', start: entry.view.pageStart, end: entry.view.pageStart };
  const state = makeState(page, options());
  const tab: Tab = {
    info: entry.info, state: state.update({ effects: StateEffect.appendConfig.of(lockSlot.of(lockExtension(true))) }).state,
    pageStart: page.start, pageEnd: page.end, syncedDoc: state.doc, pending: false, busy: false,
    language: 'Plain text', languageGeneration: 0, languageOverride: entry.view.languageOverride ?? undefined,
    previous: [], scrollTop: entry.view.scrollTop, scrollLeft: entry.view.scrollLeft,
    loaded: false, savedView: entry.view,
    indent: entry.view.indent === '\t' ? '\t' : /^ {2}$|^ {4}$|^ {8}$/.test(entry.view.indent ?? '') ? entry.view.indent! : ' '.repeat(preferences.indent),
    tabSize: [2, 4, 8].includes(entry.view.tabSize ?? 0) ? entry.view.tabSize! : preferences.indent,
  };
  if (!tab.info.path) {
    tab.info.name = entry.view.name;
    nextUntitled = Math.max(nextUntitled, Number(/^Untitled (\d+)$/.exec(entry.view.name)?.[1] ?? 0));
  }
  return tab;
}
function captureTabView(tab: Tab): TabView {
  if (!tab.loaded && tab.savedView) return { ...tab.savedView, id: tab.info.id, name: tab.info.name, languageOverride: tab.languageOverride ?? null, indent: tab.indent, tabSize: tab.tabSize };
  const selection = tab.state.selection.main;
  const shown = paneOfTab(tab);
  return { id: tab.info.id, name: tab.info.name, pageStart: tab.pageStart, anchor: selection.anchor, head: selection.head,
    scrollTop: shown ? shown.view.scrollDOM.scrollTop : tab.scrollTop,
    scrollLeft: shown ? shown.view.scrollDOM.scrollLeft : tab.scrollLeft,
    languageOverride: tab.languageOverride ?? null, indent: tab.indent, tabSize: tab.tabSize };
}
function applySavedView(tab: Tab, saved: TabView): void {
  if (!tab.info.path) tab.info.name = saved.name;
  const length = tab.state.doc.length;
  const selection = EditorSelection.range(Math.min(saved.anchor, length), Math.min(saved.head, length));
  tab.scrollTop = saved.scrollTop; tab.scrollLeft = saved.scrollLeft;
  const shown = paneOfTab(tab);
  if (shown) {
    shown.view.dispatch({ selection });
    const restoredSelection = shown.view.state.selection;
    const restoredDoc = shown.view.state.doc;
    const interactionVersion = shown.interactionVersion;
    shown.view.requestMeasure({ read: () => null, write: () => {
      // A click, edit, scroll, or tab switch supersedes deferred restoration.
      if (paneOfTab(tab) !== shown || shown.view.state.selection !== restoredSelection || shown.view.state.doc !== restoredDoc
        || shown.interactionVersion !== interactionVersion) return;
      shown.view.scrollDOM.scrollTop = saved.scrollTop;
      shown.view.scrollDOM.scrollLeft = saved.scrollLeft;
    } });
  } else tab.state = tab.state.update({ selection }).state;
  renderTabs(); renderStatus();
}
async function ensureLoaded(tab: Tab): Promise<void> {
  if (tab.loaded) return;
  if (tab.loading) return tab.loading;
  tab.loading = locked(tab, async () => {
    const saved = tab.savedView;
    const page = await call<Page>('read_page', { id: tab.info.id, offset: saved?.pageStart ?? 0 });
    if (!saved?.indent) Object.assign(tab, detectIndent(page.text));
    installPage(tab, page);
    if (saved) applySavedView(tab, saved);
    tab.savedView = undefined;
  }).finally(() => { tab.loading = undefined; });
  return tab.loading;
}
function reopenClosedTab(): Promise<void> {
  const checkpointBeforeHistory = checkpointPromise;
  historyQueue = historyQueue.catch(() => {}).then(async () => {
    await startupPromise?.catch(() => {});
    await checkpointBeforeHistory?.catch(() => {});
    if (shuttingDown) return;
    const tab = closedTabs.at(-1);
    if (!tab) { notify('No closed files to reopen.'); return; }
    while (tab.busy) await new Promise<void>(resolve => setTimeout(resolve, 16));
    if (shuttingDown) return;
    // Leave the history entry intact if its stored file cannot be loaded.
    await ensureLoaded(tab);
    closedTabs.pop(); tabs.push(tab); activate(tab);
    void loadLanguage(tab);
  });
  return historyQueue;
}
async function newTab(): Promise<void> { await addPage(await call<Page>('new_document')); }
function activate(tab: Tab): void {
  const shown = paneOfTab(tab);
  if (shown) {
    if (shown !== focusedPane) focusPane(shown);
    else {
      view.focus();
      renderTabs(); renderStatus();
    }
    if (!tab.loaded) void safely(() => ensureLoaded(tab));
    return;
  }
  hideLargeSearch();
  const pane = focusedPane;
  if (pane.tab) {
    pane.tab.scrollTop = pane.view.scrollDOM.scrollTop;
    pane.tab.scrollLeft = pane.view.scrollDOM.scrollLeft;
  }
  active = tab;
  const historyIndex = selectionHistory.indexOf(tab);
  if (historyIndex !== -1) selectionHistory.splice(historyIndex, 1);
  selectionHistory.push(tab);
  showInPane(tab, pane);
  pane.view.requestMeasure();
  pane.view.focus();
  renderTabs(); renderStatus();
  if (!tab.loaded) void safely(() => ensureLoaded(tab));
}
function cycleTab(direction: number): void {
  if (active && tabs.length) activate(tabs[(tabs.indexOf(active) + direction + tabs.length) % tabs.length]);
}
async function loadLanguage(tab: Tab, languageName?: string): Promise<void> {
  const generation = ++tab.languageGeneration;
  if (languageName) tab.languageOverride = languageName;
  languageName = tab.languageOverride;
  try {
    let extension;
    let name;
    // Syntax parsing enormous physical lines is unnecessary work in large-file mode.
    if ((!languageName && tab.info.size > 4 * 1024 * 1024) || (!tab.info.path && !languageName) || languageName === 'Plain text' || (tab.info.paged && tab.state.doc.lines < tab.state.doc.length / 32768)) {
      extension = []; name = 'Plain text';
    } else if (languageName) {
      const { languages } = await import('@codemirror/language-data');
      const language = languages.find(l => l.name === languageName);
      extension = language ? await language.load() : [];
      name = language?.name ?? 'Plain text';
    } else {
      const detected = await detectLanguage(tab.info.path ?? tab.info.name);
      extension = detected.extension; name = detected.name;
    }
    if (!tabs.includes(tab) || generation !== tab.languageGeneration) return;
    tab.language = name;
    applyEffect(tab, languageSlot.reconfigure(extension));
    renderStatus();
  } catch (error) {
    if (generation === tab.languageGeneration) notify(`Could not load syntax highlighting: ${String(error)}`, true);
  }
}
let lastTitle = '';
function updateDirtyMark(tab: Tab): void {
  const dot = tabbar.querySelector<HTMLElement>(`[data-tab="${tab.info.id}"] .dirty-mark`);
  if (dot) {
    const unsaved = dirty(tab);
    dot.textContent = unsaved ? '●' : '';
    dot.setAttribute('aria-label', unsaved ? 'Unsaved changes' : 'Saved');
  }
  if (tab === active) updateTitle();
}
function renderTabs(): void {
  folders.select(active?.info.path ?? null);
  tabbar.replaceChildren(...tabs.map(tab => {
    const item = document.createElement('div');
    const shown = paneOfTab(tab);
    item.className = `tab-item${tab === active ? ' active' : ''}${shown && tab !== active ? ' secondary' : ''}`;
    item.dataset.tab = String(tab.info.id);
    item.setAttribute('role', 'presentation');
    const node = document.createElement('button');
    node.className = 'tab';
    node.setAttribute('role', 'tab');
    node.setAttribute('aria-selected', String(tab === active));
    node.tabIndex = tab === active ? 0 : -1;
    node.title = tab.info.path ?? tab.info.name;
    const label = document.createElement('span'); label.className = 'tab-label'; label.textContent = tab.info.name;
    const dot = document.createElement('span'); dot.className = 'dirty-mark'; dot.textContent = dirty(tab) ? '●' : ''; dot.setAttribute('aria-label', dirty(tab) ? 'Unsaved changes' : 'Saved');
    const close = document.createElement('button'); close.className = 'tab-close'; close.textContent = '×'; close.tabIndex = -1;
    close.setAttribute('aria-label', `Close ${tab.info.name}`); close.title = `Close ${tab.info.name}`;
    close.addEventListener('click', () => { void safely(() => closeTab(tab)); });
    node.append(label, dot);
    node.addEventListener('click', () => activate(tab));
    item.addEventListener('mousedown', event => { if (event.button === 1) event.preventDefault(); });
    item.addEventListener('auxclick', event => { if (event.button === 1) { event.preventDefault(); void safely(() => closeTab(tab)); } });
    item.append(node, close);
    return item;
  }));
  tabbar.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  updateTitle();
}
function updateTitle(): void {
  const title = active ? `${dirty(active) ? '• ' : ''}${active.info.name} — rsedit` : 'rsedit';
  document.title = title;
  if (desktop && title !== lastTitle) {
    lastTitle = title;
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title)).catch(() => {});
  }
}
function renderStatus(): void {
  if (!active) return;
  const tab = active;
  const selection = tab.state.selection.main;
  const line = tab.state.doc.lineAt(selection.head);
  const selected = tab.state.selection.ranges.reduce((sum, range) => sum + range.to - range.from, 0);
  element('.path').textContent = tab.busy ? 'Working… you can switch tabs' : tab.info.path ?? (desktop ? 'Unsaved file' : 'Browser preview · file access requires the desktop app');
  element('.path').title = tab.info.path ?? '';
  element('.path').classList.toggle('busy', tab.busy);
  element('.position').textContent = `${tab.info.paged ? 'Section ' : ''}Ln ${line.number}, Col ${selection.head - line.from + 1}${selected ? ` · ${selected} selected` : ''}`;
  element('.size').textContent = formatBytes(tab.info.size);
  element('.eol').textContent = tab.info.eol;
  element('[data-action=indent]').textContent = tab.indent === '\t' ? `Tabs: ${tab.tabSize}` : `Spaces: ${tab.indent.length}`;
  element('[data-action=language]').textContent = tab.language;
  pagebar.hidden = !tab.info.paged;
  if (tab.info.paged) {
    element('.range').textContent = `Bytes ${tab.pageStart.toLocaleString()}–${tab.pageEnd.toLocaleString()} of ${tab.info.size.toLocaleString()}`;
    element<HTMLButtonElement>('[data-page=previous]').disabled = tab.busy || tab.pageStart === 0;
    element<HTMLButtonElement>('[data-page=next]').disabled = tab.busy || tab.pageEnd >= tab.info.size;
    byteOffset.max = String(tab.info.size);
  }
  updateTitle();
}
const opening = new Map<string, Promise<void>>();
async function openPath(path: string): Promise<void> {
  const existing = tabs.find(t => t.info.path === path);
  if (existing) { activate(existing); await ensureLoaded(existing); return; }
  const inProgress = opening.get(path);
  if (inProgress) {
    await inProgress;
    const tab = tabs.find(t => t.info.path === path);
    if (tab) activate(tab);
    return;
  }
  const started = performance.now();
  const operation = (async () => {
    const page = await call<Page>('open_document', { path });
    const duplicate = tabs.find(t => t.info.path === page.info.path);
    if (duplicate) { await call('close_document', { id: page.info.id }); activate(duplicate); await ensureLoaded(duplicate); return; }
    await addPage(page);
    if (desktop) requestAnimationFrame(() => requestAnimationFrame(() => {
      void call('file_view_ready', { id: page.info.id, elapsedMs: performance.now() - started }).catch(() => {});
    }));
    if (page.info.paged) notify('Opened a bounded view for fast browsing. Edits save the entire file; undo spans views. Use Find for whole-file literal replacement. Line numbers and selections are view-relative.');
    else notice.hidden = true;
  })().finally(() => { opening.delete(path); });
  opening.set(path, operation);
  await operation;
}
async function openFiles(): Promise<void> {
  if (!desktop) throw new Error('Run npm run tauri dev to open files in the desktop app.');
  const { open } = await import('@tauri-apps/plugin-dialog');
  const result = await open({ multiple: true, directory: false, title: 'Open text files' });
  for (const path of typeof result === 'string' ? [result] : result ?? []) await safely(() => openPath(path));
}
let launchReady = false;
const pendingLaunchRequests: OpenRequest[] = [];
let launchQueue: Promise<void> = Promise.resolve();
async function openRequest(request: OpenRequest): Promise<void> {
  if (request.kind === 'error') throw new Error(request.message);
  if (request.kind === 'folder') { await folders.restore({ path: request.path, visible: true }); return; }
  if (request.kind === 'stdin') { await addPage(await call<Page>('open_stdin', { path: request.path })); return; }
  await openPath(request.path);
  const tab = tabs.find(tab => tab.info.path === request.path);
  if (!tab || request.line === null) return;
  await ensureLoaded(tab);
  if (!tabs.includes(tab)) return;
  activate(tab);
  if (!tab.info.paged) { goToLineNumber(request.line, request.col ?? 1); return; }
  await locked(tab, async () => {
    cancelSearch();
    await flush(tab);
    const offset = await call<number>('document_location', { id: tab.info.id, line: request.line, col: request.col ?? 1 });
    const page = await call<Page>('read_page', { id: tab.info.id, offset: Math.max(0, offset - 1024) });
    if (page.start !== tab.pageStart) tab.previous.push(tab.pageStart);
    installPage(tab, page);
    const prefix = new TextDecoder().decode(new TextEncoder().encode(page.text).subarray(0, offset - page.start));
    const position = (page.info.eol === 'CRLF' ? prefix.replaceAll('\r\n', '\n') : prefix).length;
    const selection = EditorSelection.cursor(Math.min(position, tab.state.doc.length));
    const shown = paneOfTab(tab);
    if (shown) shown.view.dispatch({ selection, effects: EditorView.scrollIntoView(selection.head, { y: 'center' }) });
    else tab.state = tab.state.update({ selection }).state;
  });
}
function enqueueLaunchRequests(requests: OpenRequest[]): Promise<void> {
  if (!launchReady) { pendingLaunchRequests.push(...requests); return Promise.resolve(); }
  launchQueue = launchQueue.catch(() => {}).then(async () => {
    for (const request of requests) await safely(() => openRequest(request));
  });
  return launchQueue;
}
// Shared CodeMirror text nodes retain their UTF-8 lengths across edits. Count
// leaf strings separately so offset conversion never copies a whole buffer.
const utf8Lengths = new WeakMap<Text, number>();
const utf8Encoder = new TextEncoder();
function utf8Length(doc: Text, crlf: boolean): number {
  let bytes = utf8Lengths.get(doc);
  if (bytes === undefined) {
    if (doc.children) {
      bytes = doc.children.reduce((sum, child) => sum + utf8Length(child, false), doc.children.length - 1);
    } else {
      bytes = 0;
      const cursor = doc.iter();
      while (!cursor.next().done) bytes += cursor.lineBreak ? 1 : utf8Encoder.encode(cursor.value).length;
    }
    utf8Lengths.set(doc, bytes);
  }
  return bytes + (crlf ? doc.lines - 1 : 0);
}
async function flush(tab: Tab, force = false): Promise<void> {
  if (!tab.pending && !force) return;
  const prior = tab.syncedDoc;
  const current = tab.state.doc;
  const crlf = tab.info.eol === 'CRLF';
  let from = 0;
  let beforeEnd = prior.length;
  let afterEnd = current.length;
  if (!force) {
    if (!tab.changes || tab.changes.empty) return;
    from = prior.length;
    beforeEnd = afterEnd = 0;
    tab.changes.iterChangedRanges((fromA, toA, _fromB, toB) => {
      from = Math.min(from, fromA);
      beforeEnd = Math.max(beforeEnd, toA);
      afterEnd = Math.max(afterEnd, toB);
    });
    // ChangeSets use UTF-16 positions. Keep complete Unicode scalars at edges.
    if (from && /[\uDC00-\uDFFF]/.test(prior.sliceString(from, from + 1) + current.sliceString(from, from + 1))) from--;
    if (/[\uDC00-\uDFFF]/.test(prior.sliceString(beforeEnd, beforeEnd + 1) + current.sliceString(afterEnd, afterEnd + 1))) { beforeEnd++; afterEnd++; }
  }
  utf8Lengths.set(prior, tab.pageEnd - tab.pageStart - (crlf ? prior.lines - 1 : 0));
  const start = tab.pageStart + (from <= prior.length / 2
    ? utf8Length(prior.slice(0, from), crlf)
    : tab.pageEnd - tab.pageStart - utf8Length(prior.slice(from), crlf));
  const end = start + utf8Length(prior.slice(from, beforeEnd), crlf);
  const text = tab.state.sliceDoc(from, afterEnd);
  const wasPaged = tab.info.paged;
  const priorSize = tab.info.size;
  const info = await call<Info>('replace_range', { id: tab.info.id, start, end, text, revision: tab.info.revision, markClean: !wasPaged && !!tab.savedDoc && current.eq(tab.savedDoc) });
  tab.info = { ...info, name: info.path ? info.name : tab.info.name };
  tab.pageEnd += info.size - priorSize;
  tab.syncedDoc = current;
  tab.changes = undefined;
  tab.pending = false;
  if (!wasPaged && info.paged) {
    const offset = utf8Length(current.slice(0, tab.state.selection.main.head), crlf);
    installPage(tab, await call<Page>('read_page', { id: info.id, offset: Math.max(0, offset - 1024) }));
    notify('This buffer now uses bounded views. Edits save the entire file; undo spans views.');
  }
}
async function saveTab(tab: Tab | undefined, saveAs = false): Promise<boolean> {
  if (!tab) return false;
  await ensureLoaded(tab);
  if (!saveAs && tab.info.path && !dirty(tab)) { notify('No unsaved changes.'); return true; }
  return locked(tab, async () => {
    let path: string | null = null;
    if (saveAs || !tab.info.path) {
      if (!desktop) throw new Error('Saving files requires the desktop app.');
      const { save } = await import('@tauri-apps/plugin-dialog');
      path = await save({ defaultPath: tab.info.path ?? tab.info.name, title: 'Save text file' });
      if (!path) return false;
      if (tabs.some(other => other !== tab && other.info.path === path)) throw new Error('This destination is already open in another tab. Choose another path.');
    }
    notify(`Saving the entire ${tab.info.name} (${formatBytes(tab.info.size)})…`);
    await flush(tab, saveAs && !tab.info.paged);
    tab.info = await call<Info>('save_document', { id: tab.info.id, path });
    tab.savedDoc = tab.info.paged ? undefined : tab.state.doc;
    remember(tab.info.path);
    void loadLanguage(tab);
    if (active === tab) notify(`Saved ${tab.info.name}.`);
    return true;
  });
}
async function approveDiscard(tab: Tab): Promise<boolean> {
  if (!dirty(tab)) return true;
  if (desktop) {
    const { confirm } = await import('@tauri-apps/plugin-dialog');
    return confirm(`Discard unsaved changes to ${tab.info.name}?`, { title: 'Unsaved changes', kind: 'warning', okLabel: 'Discard', cancelLabel: 'Keep editing' });
  }
  return window.confirm(`Discard unsaved changes to ${tab.info.name}?`);
}
async function approveClose(tab: Tab): Promise<boolean> {
  if (!dirty(tab)) return true;
  const message = `Close ${tab.info.name} with unsaved changes? You can reopen this buffer with ${mod}Shift+T.`;
  if (!desktop) return window.confirm(message);
  const { confirm } = await import('@tauri-apps/plugin-dialog');
  return confirm(message, { title: 'Unsaved changes', kind: 'warning', okLabel: 'Close tab', cancelLabel: 'Keep editing' });
}
function closeTab(tab: Tab | undefined): Promise<void> {
  if (!tab) return Promise.resolve();
  const checkpointBeforeHistory = checkpointPromise;
  historyQueue = historyQueue.catch(() => {}).then(async () => {
    await startupPromise?.catch(() => {});
    await checkpointBeforeHistory?.catch(() => {});
    if (shuttingDown || !tabs.includes(tab)) return;
    await tab.loading?.catch(() => {});
    await locked(tab, async () => {
      if (!await approveClose(tab) || !tabs.includes(tab)) return;
      const index = tabs.indexOf(tab);
      if (closedTabs.length === 50) {
        await call('close_document', { id: closedTabs[0].info.id });
        closedTabs.shift();
      }
      const shown = paneOfTab(tab);
      if (shown) {
        shown.tab = undefined;
        tab.state = shown.view.state;
        tab.scrollTop = shown.view.scrollDOM.scrollTop;
        tab.scrollLeft = shown.view.scrollDOM.scrollLeft;
        if (shown === focusedPane) hideLargeSearch();
      }
      if (active === tab) active = undefined;
      closedTabs.push(tab);
      tabs.splice(index, 1);
      const historyIndex = selectionHistory.indexOf(tab);
      if (historyIndex !== -1) selectionHistory.splice(historyIndex, 1);
      tab.languageGeneration++;
      const pickReplacement = (): Tab | undefined =>
        [...selectionHistory].reverse().find(candidate => !paneOfTab(candidate))
        ?? tabs.find(candidate => !paneOfTab(candidate));
      for (const pane of [...panes]) {
        if (pane.tab) continue;
        const replacement = pickReplacement();
        if (replacement) {
          if (pane === focusedPane) activate(replacement);
          else {
            showInPane(replacement, pane);
            void safely(() => ensureLoaded(replacement));
          }
        } else if (pane !== primaryPane) closeSplitPane(pane);
      }
      if (!primaryPane.tab) await newTab();
      renderTabs(); renderStatus();
    });
  });
  return historyQueue;
}
async function confirmDelete(message: string): Promise<boolean> {
  if (!desktop) return false;
  const { confirm } = await import('@tauri-apps/plugin-dialog');
  return confirm(message, { title: 'Delete', kind: 'warning', okLabel: 'Delete', cancelLabel: 'Cancel' });
}
function underDir(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`) || path.startsWith(`${dir}\\`);
}
async function handleRenamed(oldPath: string, newPath: string, isDirectory: boolean): Promise<void> {
  const affected = [...tabs, ...closedTabs].filter(tab =>
    tab.info.path !== null && (isDirectory ? underDir(tab.info.path, oldPath) : tab.info.path === oldPath));
  const failures: string[] = [];
  for (const tab of affected) {
    const next = isDirectory ? newPath + tab.info.path!.slice(oldPath.length) : newPath;
    try {
      const info = await call<Info>('retarget_document', { id: tab.info.id, path: next });
      tab.info = { ...info, name: info.path ? info.name : tab.info.name };
      remember(tab.info.path);
    } catch (error) {
      failures.push(`${tab.info.name}: ${String(error)}`);
    }
  }
  if (affected.length) { renderTabs(); renderStatus(); }
  if (failures.length) throw new Error(`Renamed on disk, but ${failures.length} open buffer(s) still point at the old path:\n${failures.join('\n')}`);
}
async function handleDeleted(path: string, isDirectory: boolean): Promise<void> {
  const affected = tabs.filter(tab =>
    tab.info.path !== null && (isDirectory ? underDir(tab.info.path, path) : tab.info.path === path));
  let kept = 0;
  for (const tab of [...affected]) {
    if (dirty(tab)) { kept++; continue; }
    await closeTab(tab);
  }
  if (kept) notify(`Deleted from disk. ${kept} unsaved buffer(s) kept — saving recreates the file.`);
}
async function reloadTab(tab = active): Promise<void> {
  await checkpointPromise?.catch(() => {});
  if (!tab?.info.path) return;
  await locked(tab, async () => {
    if (!await approveDiscard(tab)) return;
    let page = await call<Page>('open_document', { path: tab.info.path });
    try {
      if (page.info.paged && tab.pageStart) page = await call<Page>('read_page', { id: page.info.id, offset: tab.pageStart });
      await call('close_document', { id: tab.info.id });
    } catch (error) {
      await call('close_document', { id: page.info.id });
      throw error;
    }
    hideLargeSearch();
    const saved = captureTabView(tab);
    tab.previous = []; tab.externalToken = undefined;
    Object.assign(tab, detectIndent(page.text));
    installPage(tab, page);
    applySavedView(tab, saved);
    notify(`Reloaded ${tab.info.name} from disk.`);
  });
}
async function changePage(offset: number, selectionOffset?: number, previous = false, next = false): Promise<void> {
  const tab = active;
  if (!tab || !tab.info.paged) return;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Enter a nonnegative whole byte offset.');
  await locked(tab, async () => {
    cancelSearch();
    await flush(tab);
    const page = await call<Page>('read_page', { id: tab.info.id, offset: next ? tab.pageEnd : offset });
    if (previous) tab.previous.pop();
    else if (page.start !== tab.pageStart) tab.previous.push(tab.pageStart);
    installPage(tab, page);
    if (selectionOffset !== undefined && active === tab) {
      // Convert byte offset to CodeMirror's UTF-16 offset using only this page.
      const bytes = new TextEncoder().encode(page.text);
      const prefix = new TextDecoder().decode(bytes.subarray(0, selectionOffset - page.start));
      const length = (page.info.eol === 'CRLF' ? prefix.replaceAll('\r\n', '\n') : prefix).length;
      const position = Math.min(length, view.state.doc.length);
      view.dispatch({ selection: EditorSelection.cursor(position), effects: EditorView.scrollIntoView(position, { y: 'center' }) });
    }
  });
}
interface SearchOrigin {
  tab: Tab; pageStart: number; selection: EditorSelection; byteOffset: number;
}
interface LargeFind {
  tab: Tab; query: string; generation: number; revision: number;
  counts: Map<number, number>; total: number; complete: boolean; busy: boolean;
  offset: number | null; chunk: number; index: number;
}
const SCAN_SIZE = 64 * 1024 * 1024;
let searchGeneration = 0;
let largeFind: LargeFind | undefined;
let largeOrigin: SearchOrigin | undefined;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
function captureOrigin(): SearchOrigin {
  return { tab: active!, pageStart: active!.pageStart, selection: view.state.selection,
    byteOffset: active!.pageStart + new TextEncoder().encode(view.state.sliceDoc(0, view.state.selection.main.head)).length };
}
let sectionCountGeneration = 0;
function updateSectionCount(update?: ViewUpdate, pane?: Pane): void {
  const target = pane ?? focusedPane;
  const state = update?.state ?? target.view.state;
  if (!searchPanelOpen(state)) { sectionCountGeneration++; return; }
  const query = getSearchQuery(state);
  if (update && !update.docChanged && searchPanelOpen(update.startState) && query.eq(getSearchQuery(update.startState))) return;
  const generation = ++sectionCountGeneration;
  const tab = target.tab;
  setTimeout(() => void safely(async () => {
    if (generation !== sectionCountGeneration || target.tab !== tab) return;
    const panel = target.searchHost.querySelector('.cm-search');
    if (!panel) return;
    if (tab?.info.paged && !panel.querySelector('.search-scope')) {
      const scope = document.createElement('div');
      scope.className = 'search-scope search-hint';
      scope.textContent = 'Visible view only (including Replace all). Use whole-file search for literal replacement across the file.';
      panel.prepend(scope);
    }
    let counter = panel.querySelector<HTMLSpanElement>('.section-match-count');
    if (!counter) {
      counter = document.createElement('span'); counter.className = 'section-match-count match-count';
      counter.setAttribute('role', 'status'); panel.append(counter);
    }
    if (!query.valid) { counter.textContent = query.search ? 'Invalid regular expression' : '0 matches'; return; }
    let count = 0;
    const cursor = query.getCursor(state);
    while (!cursor.next().done) {
      count++;
      if (count % 5000 === 0) {
        counter.textContent = `${count.toLocaleString()}+ matches`;
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        if (generation !== sectionCountGeneration || active !== tab || !counter.isConnected) return;
      }
    }
    if (generation === sectionCountGeneration) counter.textContent = `${count.toLocaleString()} matches`;
  }), 0);
}
function openSectionSearch(): void {
  if (!active) return;
  if (!largeSearch.hidden) hideLargeSearch();
  openSearchPanel(view);
}
function closeSectionSearch(): void {
  closeSearchPanel(view);
  view.focus();
}
function showLargeSearch(): void {
  if (!active) return;
  if (searchPanelOpen(view.state)) closeSearchPanel(view);
  if (largeSearch.hidden) {
    largeOrigin = captureOrigin();
    element('.large-match-count').textContent = '0 matches';
  }
  largeSearch.hidden = false; queryInput.focus(); queryInput.select();
}
function find(): void {
  if (!active) return;
  if (active.info.paged) showLargeSearch();
  else openSectionSearch();
}
function cancelSearch(): void {
  searchGeneration++; largeFind = undefined;
  clearTimeout(searchTimer);
}
function hideLargeSearch(): void { cancelSearch(); if (active) applyEffect(active, currentMatch.of(null)); largeSearch.hidden = true; largeOrigin = undefined; }
function closeLargeSearch(): void {
  hideLargeSearch();
  view.focus();
}
function validSearch(session: LargeFind): boolean {
  return largeFind === session && session.generation === searchGeneration && active === session.tab
    && session.revision === session.tab.info.revision && !session.tab.pending;
}
function renderMatchCount(session: LargeFind): void {
  if (!validSearch(session)) return;
  let ordinal: number | undefined;
  if (session.offset !== null) {
    ordinal = session.index + 1;
    for (let base = 0; base < session.chunk; base += SCAN_SIZE) {
      const count = session.counts.get(base);
      if (count === undefined) { ordinal = undefined; break; }
      ordinal += count;
    }
  }
  element('.large-match-count').textContent = `${ordinal === undefined ? '' : `${ordinal} of `}${session.total.toLocaleString()}${session.complete ? '' : '+'} matches`;
}
async function scanMatches(session: LargeFind, start: number, anchor: number): Promise<SearchScan | undefined> {
  const result = await call<SearchScan>('scan_search', { id: session.tab.info.id, query: session.query, start, anchor });
  if (!validSearch(session) || result.revision !== session.revision) return;
  session.total += result.count - (session.counts.get(start) ?? 0);
  session.counts.set(start, result.count);
  renderMatchCount(session);
  return result;
}
async function countMatches(session: LargeFind): Promise<void> {
  for (let start = 0; start < session.tab.info.size; start += SCAN_SIZE) {
    if (!validSearch(session)) return;
    if (!session.counts.has(start) && !await scanMatches(session, start, 0)) return;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  if (validSearch(session)) { session.complete = true; renderMatchCount(session); }
}
async function showMatch(session: LargeFind, offset: number): Promise<void> {
  const tab = session.tab;
  const bytesLength = new TextEncoder().encode(session.query).length;
  const inputFocused = document.activeElement === queryInput;
  await locked(tab, async () => {
    if (!validSearch(session)) return;
    await flush(tab);
    if (!validSearch(session)) return;
    if (offset < tab.pageStart || offset + bytesLength > tab.pageEnd) {
      const page = await call<Page>('read_page', { id: tab.info.id, offset: Math.max(0, offset - 1024) });
      if (!validSearch(session)) return;
      installPage(tab, page);
    }
    if (!validSearch(session)) return;
    const bytes = new TextEncoder().encode(tab.state.sliceDoc());
    const prefix = new TextDecoder().decode(bytes.subarray(0, offset - tab.pageStart));
    const normalize = (text: string) => tab.info.eol === 'CRLF' ? text.replaceAll('\r\n', '\n') : text;
    const from = normalize(prefix).length;
    const to = Math.min(view.state.doc.length, from + normalize(session.query).length);
    const selection = EditorSelection.range(from, to);
    view.dispatch({ selection, effects: [currentMatch.of({ from, to }), EditorView.scrollIntoView(selection, { x: 'center', y: 'center', xMargin: 32, yMargin: 40 })] });
    if (inputFocused) queryInput.focus();
  });
}
async function navigateMatch(session: LargeFind, direction: number): Promise<void> {
  if (session.busy || !validSearch(session)) return;
  session.busy = true;
  try {
    const size = session.tab.info.size;
    if (!size) return;
    let anchor = session.offset === null ? (largeOrigin?.byteOffset ?? 0)
      : direction > 0 ? session.offset + new TextEncoder().encode(session.query).length : session.offset;
    if (direction > 0 && anchor >= size) anchor = 0;
    if (direction < 0 && anchor <= 0) anchor = size;
    let start = Math.floor((direction < 0 ? Math.max(0, anchor - 1) : anchor) / SCAN_SIZE) * SCAN_SIZE;
    for (let visited = 0; visited <= Math.ceil(size / SCAN_SIZE); visited++) {
      const result = await scanMatches(session, start, anchor);
      if (!result) return;
      const offset = direction > 0 ? result.nextOffset : result.previousOffset;
      if (offset !== null) {
        session.offset = offset; session.chunk = start;
        session.index = (direction > 0 ? result.nextIndex : result.previousIndex)!;
        await showMatch(session, offset); renderMatchCount(session); return;
      }
      start += direction * SCAN_SIZE;
      if (start < 0) { start = Math.floor((size - 1) / SCAN_SIZE) * SCAN_SIZE; anchor = size; }
      else if (start >= size) { start = 0; anchor = 0; }
      else anchor = direction > 0 ? start : Math.min(size, start + SCAN_SIZE);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  } finally { session.busy = false; }
}
async function searchLarge(direction = 1): Promise<void> {
  const tab = active;
  if (!tab?.info.paged || !queryInput.value) return;
  if (largeFind && validSearch(largeFind) && largeFind.query === queryInput.value) {
    await navigateMatch(largeFind, direction); return;
  }
  cancelSearch();
  const generation = searchGeneration;
  const query = queryInput.value;
  await locked(tab, () => flush(tab));
  if (generation !== searchGeneration || active !== tab || largeSearch.hidden) return;
  const session: LargeFind = { tab, query, generation, revision: tab.info.revision, counts: new Map(), total: 0, complete: false, busy: false, offset: null, chunk: 0, index: 0 };
  largeFind = session;
  element('.large-match-count').textContent = 'Searching…';
  void safely(() => countMatches(session));
  await navigateMatch(session, direction);
}
function toggleWrap(): void {
  preferences.wrap = !preferences.wrap;
  for (const tab of tabs) applyEffect(tab, wrapSlot.reconfigure(preferences.wrap ? EditorView.lineWrapping : []));
  storePreferences();
}
function setIndent(indent: string, tabSize: number): void {
  const tab = active;
  if (!tab) return;
  tab.indent = indent; tab.tabSize = tabSize;
  applyEffect(tab, indentSlot.reconfigure([indentUnit.of(indent), EditorState.tabSize.of(tabSize)]));
  renderStatus();
}
function changeIndent(): void {
  showPalette([
    ...[2, 4, 8].map(width => ({ label: `Use ${width} spaces for this file`, run: () => setIndent(' '.repeat(width), width) })),
    ...[2, 4, 8].map(width => ({ label: `Use literal tabs (display width ${width}) for this file`, run: () => setIndent('\t', width) })),
    { label: 'Convert leading indentation to spaces in entire file', run: () => convertIndent(false) },
    { label: 'Convert leading indentation to tabs in entire file', run: () => convertIndent(true) },
  ], 'Indentation for this file…');
}
async function history(forward: boolean): Promise<void> {
  const tab = active;
  if (!tab || tab.busy) return;
  if (!tab.info.paged) { (forward ? redo : undo)(view); return; }
  await locked(tab, async () => {
    cancelSearch(); largeOrigin = undefined;
    await flush(tab);
    const page = await call<Page>('document_history', { id: tab.info.id, redo: forward, offset: tab.pageStart, revision: tab.info.revision });
    installPage(tab, page);
  });
}
async function replaceEntireFile(): Promise<void> {
  const tab = active;
  if (!tab?.info.paged || !queryInput.value) return;
  const query = queryInput.value;
  const replacement = element<HTMLInputElement>('.large-replacement').value;
  await locked(tab, async () => {
    cancelSearch(); largeOrigin = undefined;
    notify(`Replacing literal text in the entire ${tab.info.name}. Your file is written only when you Save…`);
    await flush(tab);
    const result = await call<ReplaceResult>('replace_entire_file', { id: tab.info.id, query, replacement, revision: tab.info.revision });
    installPage(tab, result.page);
    notify(`Replaced ${result.count.toLocaleString()} matches across the entire file. Undo is available; Save writes the result.`);
  });
}
async function convertIndent(tabsMode: boolean): Promise<void> {
  const tab = active;
  if (!tab || tab.busy) return;
  const width = tab.tabSize;
  if (tab.info.paged) {
    await locked(tab, async () => {
      cancelSearch(); largeOrigin = undefined;
      notify(`Converting indentation across the entire ${tab.info.name}…`);
      await flush(tab);
      const page = await call<Page>('convert_document_indent', { id: tab.info.id, tabs: tabsMode, width, revision: tab.info.revision });
      installPage(tab, page);
      notify('Converted indentation in the entire file. Undo is available; Save writes the result.');
    });
  } else {
    const changes = [];
    for (let number = 1; number <= tab.state.doc.lines; number++) {
      const line = tab.state.doc.line(number);
      const leading = /^[ \t]+/.exec(line.text)?.[0];
      if (!leading) continue;
      let columns = 0;
      for (const char of leading) columns += char === '\t' ? width - columns % width : 1;
      const insert = tabsMode ? '\t'.repeat(Math.floor(columns / width)) + ' '.repeat(columns % width) : ' '.repeat(columns);
      if (insert !== leading) changes.push({ from: line.from, to: line.from + leading.length, insert });
    }
    view.dispatch({ changes, userEvent: 'input.indent' });
  }
  if (active === tab) setIndent(tabsMode ? '\t' : ' '.repeat(width), width);
  else { tab.indent = tabsMode ? '\t' : ' '.repeat(width); applyEffect(tab, indentSlot.reconfigure([indentUnit.of(tab.indent), EditorState.tabSize.of(width)])); }
}
function setFontSize(size: number): void {
  preferences.fontSize = Math.min(28, Math.max(10, size));
  storePreferences();
  for (const pane of panes) pane.view.requestMeasure();
}
function increaseFontSize(): void { setFontSize(preferences.fontSize + 1); }
function decreaseFontSize(): void { setFontSize(preferences.fontSize - 1); }
function resetFontSize(): void { setFontSize(14); }
function setTheme(id: string): void {
  themePreviewOriginal = undefined;
  preferences.theme = normalizeThemeId(id);
  storePreferences();
  for (const pane of panes) pane.view.requestMeasure();
}
// Live preview while the theme picker is open. Previewing only applies the
// theme visually; preferences are updated when the user confirms a choice.
let themePreviewOriginal: string | undefined;
function previewTheme(id: string): void {
  applyTheme(getTheme(normalizeThemeId(id)));
  for (const pane of panes) pane.view.requestMeasure();
}
function cancelThemePreview(): void {
  if (themePreviewOriginal === undefined) return;
  const original = themePreviewOriginal;
  themePreviewOriginal = undefined;
  previewTheme(original);
}
function nextTheme(): void {
  const index = THEMES.findIndex(theme => theme.id === preferences.theme);
  const next = THEMES[(index + 1 + THEMES.length) % THEMES.length];
  setTheme(next.id);
  notify(`Theme: ${next.label}.`);
}
function showThemes(): void {
  themePreviewOriginal = preferences.theme;
  showPalette(THEMES.map(theme => ({
    label: `${theme.id === preferences.theme ? '● ' : ''}${theme.label}`,
    run: () => setTheme(theme.id),
    preview: () => previewTheme(theme.id),
  })), 'Select theme…');
  // Highlight the current theme so opening the picker doesn't preview another one.
  paletteIndex = Math.max(0, THEMES.findIndex(theme => theme.id === themePreviewOriginal));
  renderPalette();
}

let paletteCommands: Command[] = [];
let filteredCommands: Command[] = [];
let paletteIndex = 0;
let filePalette = false;
let quickOpenGeneration = 0;
let quickOpenInFlight = false;
let quickOpenPending = false;
let quickOpenTimer: ReturnType<typeof setTimeout> | undefined;
function fuzzyScore(value: string, query: string): number | undefined {
  if (!query) return -value.length;
  value = value.toLowerCase().replaceAll('\\', '/');
  query = query.toLowerCase().replaceAll('\\', '/');
  let at = 0, score = 0, run = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === query[at]) {
      score += 20 + ++run * 8 + (index === 0 || /[/_.\- ]/.test(value[index - 1]) ? 30 : 0) - index;
      if (++at === query.length) return score - value.length;
    } else run = 0;
  }
  return undefined;
}
function commands(): Command[] {
  return [
    { label: 'New file', shortcut: `${mod}N`, run: newTab },
    { label: 'Open files…', shortcut: `${mod}O`, run: openFiles },
    { label: 'Open folder…', shortcut: `${mod}Alt+O`, run: folders.open },
    { label: 'Toggle folder panel', run: folders.toggle },
    { label: 'Refresh folder tree', run: folders.refresh },
    { label: 'Close folder panel', run: folders.close },
    { label: 'Save file', shortcut: `${mod}S`, run: async () => { await saveTab(active); } },
    { label: 'Save file as…', shortcut: `${mod}⇧S`, run: async () => { await saveTab(active, true); } },
    { label: 'Reload file from disk', run: () => reloadTab() },
    { label: 'Save all files', run: async () => { for (const tab of [...tabs]) if (dirty(tab) && !await saveTab(tab)) break; } },
    { label: 'Reopen closed file', shortcut: `${mod}⇧T`, run: reopenClosedTab },
    { label: 'Close file', shortcut: `${mod}W`, run: () => closeTab(active) },
    { label: 'Previous tab', shortcut: `${mod}⇧[`, run: () => cycleTab(-1) },
    { label: 'Next tab', shortcut: `${mod}⇧]`, run: () => cycleTab(1) },
    { label: active?.info.paged ? 'Find / replace literal text in entire file' : 'Find / replace in entire file', shortcut: `${mod}F`, run: find },
    ...(active?.info.paged ? [{ label: 'Find / replace in visible view only', shortcut: mac ? '⌘⌥F' : `${mod}H`, run: () => { openSectionSearch(); } }] : []),
    { label: active?.info.paged ? 'Go to line (visible view)' : 'Go to line', shortcut: `${mod}G`, run: () => { gotoLine(view); } },
    { label: 'Undo', shortcut: `${mod}Z`, run: () => history(false) },
    { label: 'Redo', shortcut: `${mod}⇧Z`, run: () => history(true) },
    { label: active?.info.paged ? 'Select all in visible view' : 'Select all', shortcut: `${mod}A`, run: () => { selectAll(view); } },
    { label: 'Duplicate line', shortcut: 'Alt+Shift+↓', run: () => { copyLineDown(view); } },
    { label: 'Move line up', shortcut: 'Alt+↑', run: () => { moveLineUp(view); } },
    { label: 'Move line down', shortcut: 'Alt+↓', run: () => { moveLineDown(view); } },
    { label: 'Delete line', shortcut: `${mod}⇧K`, run: () => { deleteLine(view); } },
    { label: active?.info.paged ? 'Select all occurrences in visible view' : 'Select all occurrences', shortcut: `${mod}⇧L`, run: () => { selectSelectionMatches(view); } },
    { label: 'Toggle line comment', shortcut: `${mod}/`, run: () => { toggleComment(view); } },
    { label: `${preferences.wrap ? 'Disable' : 'Enable'} word wrap`, shortcut: `${mod}⇧W`, run: toggleWrap },
    { label: `Next theme (current: ${getTheme(preferences.theme).label})`, run: nextTheme },
    { label: 'Select theme…', run: showThemes },
    { label: 'Set or convert indentation for this file…', run: changeIndent },
    { label: 'Increase font size', shortcut: `${mod}+`, run: increaseFontSize },
    { label: 'Decrease font size', shortcut: `${mod}−`, run: decreaseFontSize },
    { label: 'Reset font size', shortcut: `${mod}0`, run: resetFontSize },
    { label: 'Select syntax language…', run: showLanguages },
    { label: 'Split editor right', shortcut: `${mod}\\`, run: splitRight },
    { label: 'Focus other pane', run: focusOtherPane },
    { label: 'Move current tab to other pane', run: moveTabToOtherPane },
    { label: 'Close split', run: closeSplit },
    { label: 'Quick-open folder files and tabs…', shortcut: `${mod}P`, run: showFiles },
    ...recentPaths.map(path => ({ label: `Open recent: ${path}`, run: () => openPath(path) })),
  ];
}
function showPalette(items: Command[], placeholder = 'Type a command…'): void {
  filePalette = false; ++quickOpenGeneration; clearTimeout(quickOpenTimer);
  element('.palette footer').textContent = '↑ ↓ to navigate · Enter to run · Esc to close';
  paletteCommands = items; paletteIndex = 0;
  paletteQuery.value = ''; paletteQuery.placeholder = placeholder;
  overlay.hidden = false; renderPalette(); paletteQuery.focus();
}
function showCommands(): void { showPalette(commands()); }
function tabCommands(): Command[] {
  return tabs.map(tab => ({ label: `${dirty(tab) ? '● ' : ''}${tab.info.name}`, shortcut: tab.info.path ?? '', run: () => activate(tab) }));
}
function parseFileLine(input: string): { fileQuery: string; line?: number; col?: number } {
  const trimmed = input.trim();
  const match = /^(.*?)\s*:\s*(\d+)(?:\s*:\s*(\d+))?\s*$/.exec(trimmed);
  if (!match) return { fileQuery: trimmed };
  const line = Number(match[2]);
  const col = match[3] !== undefined ? Number(match[3]) : undefined;
  if (!Number.isSafeInteger(line) || line < 1) return { fileQuery: trimmed };
  if (col !== undefined && (!Number.isSafeInteger(col) || col < 1)) return { fileQuery: trimmed };
  return { fileQuery: match[1].trim(), line, col };
}
function goToLineNumber(line: number, col = 1): void {
  if (!active) return;
  const doc = view.state.doc;
  if (doc.lines === 0) return;
  const targetLine = Math.min(Math.max(1, Math.floor(line)), doc.lines);
  const lineInfo = doc.line(targetLine);
  const targetCol = Math.min(Math.max(1, Math.floor(col)), lineInfo.length + 1);
  const pos = lineInfo.from + (targetCol - 1);
  view.dispatch({ selection: EditorSelection.cursor(pos), effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
  view.focus();
}
async function runQuickOpenCommand(command: Command): Promise<void> {
  const parsed = parseFileLine(paletteQuery.value);
  if (parsed.line === undefined) {
    closePalette();
    await command.run();
    return;
  }
  if (!parsed.fileQuery) {
    const target = active;
    closePalette();
    if (!target) return;
    if (!target.loaded) await ensureLoaded(target);
    if (active === target) goToLineNumber(parsed.line, parsed.col ?? 1);
    return;
  }
  closePalette();
  await command.run();
  const target = active;
  if (!target) return;
  if (!target.loaded) await ensureLoaded(target);
  if (active === target) goToLineNumber(parsed.line, parsed.col ?? 1);
}
function showFiles(): void {
  showPalette(tabCommands(), 'Quick-open: file, file:line or open tab…');
  filePalette = true;
  renderPalette();
  void updateQuickOpen();
}
async function updateQuickOpen(): Promise<void> {
  if (quickOpenInFlight) { quickOpenPending = true; return; }
  const generation = ++quickOpenGeneration;
  const root = folders.capture()?.path;
  if (!filePalette || overlay.hidden) return;
  if (!root) { paletteCommands = tabCommands(); renderPalette(); return; }
  element('.palette footer').textContent = 'Searching folder on demand…';
  quickOpenInFlight = true; quickOpenPending = false;
  try {
    const results = await call<QuickOpen>('quick_open', { path: root, query: parseFileLine(paletteQuery.value).fileQuery });
    if (generation !== quickOpenGeneration || !filePalette || overlay.hidden) return;
    const open = new Set(tabs.map(tab => tab.info.path));
    paletteCommands = [...tabCommands(), ...results.entries.filter(entry => !open.has(entry.path)).map(entry => ({ label: entry.name, shortcut: '', run: () => openPath(entry.path) }))];
    element('.palette footer').textContent = `${results.truncated ? 'Partial results: scan reached 50,000 entries or 1 second. ' : ''}${results.skippedDirectories ? `${results.skippedDirectories} unreadable directories skipped. ` : ''}Excludes .git, node_modules, target and directory symlinks. ↑ ↓ · Enter · Esc`;
    renderPalette();
  } catch (error) {
    if (generation !== quickOpenGeneration || !filePalette || overlay.hidden) return;
    element('.palette footer').textContent = `Folder search failed: ${String(error)}. Open tabs are available.`;
    paletteCommands = tabCommands(); renderPalette();
  } finally {
    quickOpenInFlight = false;
    if (quickOpenPending && filePalette && !overlay.hidden) void updateQuickOpen();
  }
}
async function showLanguages(): Promise<void> {
  const tab = active;
  if (!tab) return;
  const { languages } = await import('@codemirror/language-data');
  showPalette(['Plain text', ...languages.map(l => l.name)].map(name => ({ label: name, run: () => loadLanguage(tab, name) })), 'Select a syntax language…');
}
function closePalette(): void { cancelThemePreview(); overlay.hidden = true; filePalette = false; quickOpenPending = false; ++quickOpenGeneration; clearTimeout(quickOpenTimer); view.focus(); }
function renderPalette(): void {
  const query = paletteQuery.value.toLowerCase();
  const fileQuery = filePalette ? parseFileLine(paletteQuery.value).fileQuery.toLowerCase().trim() : query;
  filteredCommands = filePalette
    ? paletteCommands.map(command => ({ command, score: fuzzyScore(`${command.label} ${command.shortcut ?? ''}`, fileQuery) }))
      .filter((item): item is { command: Command; score: number } => item.score !== undefined)
      .sort((a, b) => b.score - a.score).slice(0, 80).map(item => item.command)
    : paletteCommands.filter(command => command.label.toLowerCase().includes(query));
  paletteIndex = Math.min(paletteIndex, Math.max(0, filteredCommands.length - 1));
  element('.palette-list').replaceChildren(...filteredCommands.map((command, index) => {
    const button = document.createElement('button'); button.className = `palette-item${index === paletteIndex ? ' selected' : ''}`;
    button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(index === paletteIndex));
    const label = document.createElement('span'); label.textContent = command.label;
    const shortcut = document.createElement('small'); shortcut.textContent = command.shortcut ?? '';
    button.append(label, shortcut);
    const highlight = (): void => {
      if (index === paletteIndex) { command.preview?.(); return; }
      paletteIndex = index;
      element('.palette-list').querySelectorAll('.palette-item').forEach((item, itemIndex) => {
        item.classList.toggle('selected', itemIndex === paletteIndex);
        item.setAttribute('aria-selected', String(itemIndex === paletteIndex));
      });
      command.preview?.();
    };
    button.addEventListener('mouseenter', highlight);
    button.addEventListener('focus', highlight);
    button.addEventListener('click', () => {
      if (filePalette) void safely(() => runQuickOpenCommand(command));
      else { closePalette(); void safely(command.run); }
    });
    return button;
  }));
  element('.palette-list').querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  // Live-preview the highlighted entry (theme picker). No-op for other palettes.
  filteredCommands[paletteIndex]?.preview?.();
}

const actions: Record<string, () => void | Promise<void>> = {
  new: newTab, open: openFiles, reopen: reopenClosedTab, save: async () => { await saveTab(active); }, find,
  'open-folder': folders.open, 'toggle-folder': folders.toggle, 'refresh-folder': folders.refresh, 'close-folder': folders.close,
  palette: showCommands, wrap: toggleWrap, indent: changeIndent, language: showLanguages,
  'increase-font-size': increaseFontSize, 'decrease-font-size': decreaseFontSize, 'reset-font-size': resetFontSize,
  split: () => { if (secondaryPane) closeSplit(); else splitRight(); },
  'focus-other': focusOtherPane, 'move-to-other': moveTabToOtherPane, 'close-split': closeSplit,
};
app.addEventListener('click', event => {
  const action = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
  if (action && actions[action]) void safely(actions[action]);
});
// The default CodeMirror panel listens to keyup/change. Commit input events too,
// so paste, cut, clear, and checkbox changes immediately update the same query.
function commitSectionQuery(event: Event): void {
  if (shuttingDown || (event instanceof InputEvent && event.isComposing)) return;
  const pane = panes.find(candidate => candidate.searchHost.contains(event.target as Node)) ?? focusedPane;
  const target = pane.view;
  const panel = (event.target as HTMLElement).closest('.cm-search');
  if (!panel || !searchPanelOpen(target.state)) return;
  const field = (name: string) => panel.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  const query = new SearchQuery({
    search: field('search').value, replace: field('replace')?.value ?? getSearchQuery(target.state).replace,
    caseSensitive: field('case').checked, regexp: field('re').checked, wholeWord: field('word').checked,
  });
  if (!query.eq(getSearchQuery(target.state))) target.dispatch({ effects: setSearchQuery.of(query) });
}
notice.querySelector('button')!.addEventListener('click', () => { notice.hidden = true; });
pagebar.addEventListener('click', event => {
  const action = (event.target as HTMLElement).closest<HTMLElement>('[data-page]')?.dataset.page;
  if (!active) return;
  if (action === 'next') void safely(() => changePage(active!.pageEnd, undefined, false, true));
  if (action === 'previous') void safely(() => changePage(active!.previous.at(-1) ?? Math.max(0, active!.pageStart - 256 * 1024), undefined, true));
  if (action === 'jump') void safely(() => changePage(Number(byteOffset.value)));
});
byteOffset.addEventListener('keydown', event => { if (event.key === 'Enter') void safely(() => changePage(Number(byteOffset.value))); });
largeSearch.addEventListener('click', event => {
  const action = (event.target as HTMLElement).closest<HTMLElement>('[data-search]')?.dataset.search;
  if (action === 'start') void safely(() => searchLarge());
  if (action === 'replace-all') void safely(replaceEntireFile);
  if (action === 'close') closeLargeSearch();
});
queryInput.addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); void safely(() => searchLarge(event.shiftKey ? -1 : 1)); }
});
queryInput.addEventListener('input', () => {
  cancelSearch(); if (active) applyEffect(active, currentMatch.of(null)); element('.large-match-count').textContent = queryInput.value ? 'Searching…' : '0 matches';
  if (queryInput.value) searchTimer = setTimeout(() => void safely(() => searchLarge()), 150);
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !overlay.hidden) return;
  if (!largeSearch.hidden) { event.preventDefault(); event.stopPropagation(); closeLargeSearch(); }
  else if (searchPanelOpen(view.state)) { event.preventDefault(); event.stopPropagation(); closeSectionSearch(); }
  else {
    const other = panes.find(pane => pane !== focusedPane && searchPanelOpen(pane.view.state));
    if (other) { event.preventDefault(); event.stopPropagation(); closeSearchPanel(other.view); }
  }
}, true);
paletteQuery.addEventListener('input', () => {
  paletteIndex = 0; renderPalette();
  if (filePalette) {
    ++quickOpenGeneration; clearTimeout(quickOpenTimer);
    quickOpenTimer = setTimeout(() => { void updateQuickOpen(); }, 150);
  }
});
paletteQuery.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); closePalette(); }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault(); paletteIndex = (paletteIndex + (event.key === 'ArrowDown' ? 1 : -1) + filteredCommands.length) % (filteredCommands.length || 1); renderPalette();
  }
  if (event.key === 'Enter') { event.preventDefault(); const command = filteredCommands[paletteIndex]; if (command) { if (filePalette) void safely(() => runQuickOpenCommand(command)); else { closePalette(); void safely(command.run); } } }
});
overlay.addEventListener('click', event => { if (event.target === overlay || (event.target as HTMLElement).closest('[data-palette=close]')) closePalette(); });
overlay.addEventListener('keydown', event => {
  if (event.key !== 'Tab') return;
  const focusable = Array.from(overlay.querySelectorAll<HTMLElement>('input,button'));
  const index = focusable.indexOf(document.activeElement as HTMLElement);
  event.preventDefault(); focusable[(index + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length]?.focus();
});
// Own font shortcuts here so + (including Shift+=), =, and numpad keys work
// from the editor, search controls, folder panel, and command palette alike.
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.isComposing || event.altKey || shuttingDown
    || !(mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return;
  const action = event.key === '+' || event.key === '=' ? increaseFontSize
    : event.key === '-' ? decreaseFontSize
    : event.key === '0' && !event.shiftKey ? resetFontSize : undefined;
  if (!action) return;
  event.preventDefault();
  event.stopPropagation();
  action();
}, true);
// Native menu accelerators own these shortcuts on desktop. Some webviews also
// deliver their keydown; stop it before CodeMirror, controls, or app handlers act.
document.addEventListener('keydown', event => {
  if (!desktop || !(mac ? event.metaKey : event.ctrlKey) || (mac ? event.ctrlKey : event.metaKey)) return;
  const key = event.altKey && event.code === 'KeyO' ? 'o' : event.key.toLowerCase();
  const shortcut = `Mod-${event.altKey ? 'Alt-' : ''}${event.shiftKey ? 'Shift-' : ''}${key}`;
  if (nativeShortcuts.has(shortcut)) {
    event.preventDefault();
    event.stopPropagation();
  }
}, true);
// App shortcuts also work while folder and search controls have focus.
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || !overlay.hidden || !(mac ? event.metaKey : event.ctrlKey)) return;
  const key = event.altKey && event.code === 'KeyO' ? 'o' : event.key.toLowerCase();
  if (event.shiftKey && !event.altKey) {
    // Shifted square brackets may arrive as braces, depending on the keyboard layout.
    const direction = key === '[' || key === '{' || event.code === 'BracketLeft' ? -1
      : key === ']' || key === '}' || event.code === 'BracketRight' ? 1 : 0;
    if (direction) { event.preventDefault(); cycleTab(direction); return; }
  }
  const action = key === 'o' ? (event.altKey ? folders.open : openFiles) : key === 'n' ? newTab : key === 's' ? async () => { await saveTab(active, event.shiftKey); }
    : key === 't' && event.shiftKey ? reopenClosedTab : key === 'w' ? (event.shiftKey ? toggleWrap : () => closeTab(active)) : key === 'p' ? (event.shiftKey ? showCommands : showFiles) : undefined;
  if (action) { event.preventDefault(); void safely(action); }
});
tabbar.addEventListener('keydown', event => {
  if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); cycleTab(event.key === 'ArrowRight' ? 1 : -1); }
  if (event.key === 'Delete') { event.preventDefault(); void safely(() => closeTab(active)); }
});
window.addEventListener('beforeunload', event => { if (!desktop && tabs.some(dirty)) event.preventDefault(); });

function sessionView() {
  return { open: tabs.map(captureTabView), closed: closedTabs.map(captureTabView), active: active?.info.id ?? null, secondary: secondaryPane?.tab?.info.id ?? null, folder: folders.capture() };
}
async function persistBuffers(buffers: Tab[], alreadyLocked = false): Promise<void> {
  const failures: string[] = [];
  for (const tab of buffers) {
    if (!tab.pending) continue;
    try {
      if (alreadyLocked) await flush(tab);
      else await locked(tab, () => flush(tab));
    } catch (error) {
      failures.push(`${tab.info.name}: pending edits could not be checkpointed: ${String(error)}`);
    }
  }
  try { await call('persist_session', { view: sessionView() }); }
  catch (error) { failures.push(String(error)); }
  if (failures.length) throw new Error(failures.join('\n'));
}
function checkpoint(): Promise<void> {
  if (checkpointPromise) return checkpointPromise;
  if (!sessionReady || shuttingDown) return Promise.resolve();
  const historyBeforeCheckpoint = historyQueue;
  checkpointPromise = (async () => {
    await historyBeforeCheckpoint.catch(() => {});
    if (shuttingDown || opening.size || [...tabs, ...closedTabs].some(tab => tab.busy)) return;
    const buffers = [...tabs, ...closedTabs];
    const status = element('.recovery');
    status.textContent = 'Checkpointing…';
    try {
      await persistBuffers(buffers);
      status.textContent = [...tabs, ...closedTabs].some(tab => tab.pending) ? 'Recovery saved · newer edits pending' : 'Recovery saved';
      status.title = `Last successful recovery checkpoint: ${new Date().toLocaleTimeString()}`;
    } catch (error) {
      status.textContent = 'Recovery failed';
      notify(`Recovery needs attention. Keep the affected buffers open: ${String(error)}`, true);
    }
  })().finally(() => { checkpointPromise = undefined; });
  return checkpointPromise;
}
async function checkExternalChanges(): Promise<void> {
  if (!sessionReady || shuttingDown || checkingExternal) return;
  checkingExternal = true;
  try {
    for (const tab of [...tabs]) {
      if (!tab.info.path || tab.busy || shuttingDown || !tabs.includes(tab)) continue;
      const change = await call<ExternalChange>('check_external_change', { id: tab.info.id });
      if (!change.changed) { tab.externalToken = undefined; continue; }
      if (tab.externalToken === change.token) continue;
      tab.externalToken = change.token;
      if (!dirty(tab)) {
        await reloadTab(tab);
        continue;
      }
      if (!tabs.includes(tab) || tab.busy || shuttingDown) continue;
      activate(tab);
      showPalette([
        { label: 'Keep my edits and review the disk change later', run: () => { notify(`${tab.info.name} changed on disk. Save As can preserve fully loaded or recovered content; disk-backed views need the unchanged source. Copy visible edits before reloading.`); } },
        { label: 'Save my buffer to another file…', run: async () => { await saveTab(tab, true); } },
        { label: 'Copy visible text to a new recovery tab', run: async () => {
          const text = tab.state.sliceDoc(); await newTab(); view.dispatch({ changes: { from: 0, insert: text } });
          notify('Copied the visible text to an unsaved buffer. The original tab is still open.');
        } },
        { label: 'Reload disk file (asks before discarding edits)', run: () => reloadTab(tab) },
      ], `${tab.info.name} changed on disk — choose how to recover`);
      break;
    }
  } finally { checkingExternal = false; }
}
async function initializeDesktop(): Promise<void> {
  if (!desktop) return;
  const [{ getCurrentWindow }, { listen }] = await Promise.all([import('@tauri-apps/api/window'), import('@tauri-apps/api/event')]);
  const nativeWindow = getCurrentWindow();
  await nativeWindow.onDragDropEvent(event => {
    const payload = event.payload;
    if (payload.type === 'drop') void safely(async () => { for (const path of payload.paths) await safely(() => openPath(path)); });
  });
  await nativeWindow.onCloseRequested(async event => {
    event.preventDefault();
    if (shuttingDown) return;
    await safely(async () => {
      shuttingDown = true;
      cancelSearch();
      let lockedTabs: Tab[] = [];
      try {
        await checkpointPromise?.catch(() => {});
        await startupPromise?.catch(() => {});
        await historyQueue.catch(() => {});
        await folders.settle();
        while (opening.size || [...tabs, ...closedTabs].some(tab => tab.busy)) {
          await new Promise<void>(resolve => setTimeout(resolve, 16));
        }
        lockedTabs = [...tabs, ...closedTabs];
        for (const tab of lockedTabs) { tab.busy = true; applyEffect(tab, lockSlot.reconfigure(lockExtension(true))); }
        notify('Preserving session…');
        try {
          await persistBuffers(lockedTabs, true);
        } catch (error) {
          const { confirm } = await import('@tauri-apps/plugin-dialog');
          if (!await confirm(`Could not preserve this session: ${String(error)}\n\nQuit anyway? Edits since the last successful checkpoint will not be recovered. Save affected buffers before quitting to keep them.`, { title: 'Recovery failed', kind: 'warning', okLabel: 'Quit without recovery', cancelLabel: 'Keep editing' })) return;
        }
        // Window preferences must not trap a session whose buffers are safe.
        try { await call('persist_window_state'); }
        catch (error) { console.error('Could not preserve window preferences', error); }
        await nativeWindow.destroy();
      } catch (error) {
        throw new Error(`Could not finish preserving and closing the session. The editor remains open: ${String(error)}`);
      } finally {
        shuttingDown = false;
        for (const tab of lockedTabs) { tab.busy = false; applyEffect(tab, lockSlot.reconfigure(lockExtension(!tab.loaded))); }
      }
    });
  });
  await listen<{ id: number; done: number; total: number }>('document-progress', event => {
    const progress = event.payload;
    const tab = tabs.find(tab => tab.info.id === progress.id);
    if (tab && tab === active && tab.busy) notify(`Processing the entire file: ${progress.total ? Math.floor(progress.done / progress.total * 100) : 100}% (${formatBytes(progress.done)} of ${formatBytes(progress.total)}). You can switch tabs.`);
  });
  const drainLaunchRequests = async (): Promise<void> => {
    if (!launchReady || shuttingDown) return;
    const requests = await call<OpenRequest[]>('pending_open_requests');
    if (requests.length) await enqueueLaunchRequests(requests);
  };
  await nativeWindow.onFocusChanged(event => {
    if (event.payload) void safely(async () => { await drainLaunchRequests(); await checkExternalChanges(); });
  });
  await listen<string>('editor-menu' , event => {
    const action = event.payload;
    if (action === 'quit') void nativeWindow.close();
    else if (action === 'save-as') void safely(async () => { await saveTab(active, true); });
    else if (action === 'theme') nextTheme();
    else if (action === 'select-theme') showThemes();
    else if (action.startsWith('theme:')) setTheme(action.slice('theme:'.length));
    else if (action === 'close') void safely(() => closeTab(active));
    else if (action === 'undo') void safely(() => history(false));
    else if (action === 'redo') void safely(() => history(true));
    else if (actions[action]) void safely(actions[action]);
  });
  await listen<OpenRequest[]>('editor-open', event => { void enqueueLaunchRequests(event.payload); });
  try {
    const restored = await call<RestoredSession>('restore_session');
    sessionReady = true;
    tabs.push(...restored.open.map(restoredTab));
    closedTabs.push(...restored.closed.map(restoredTab));
    await folders.restore(restored.folder);
    while (closedTabs.length > 50) await call('close_document', { id: closedTabs.shift()!.info.id });
    if (tabs.length) {
      const selected = tabs[Math.min(restored.activeIndex, tabs.length - 1)];
      activate(selected);
      await ensureLoaded(selected);
      const second = typeof restored.secondaryIndex === 'number' ? tabs[restored.secondaryIndex] : undefined;
      if (second && second !== selected) {
        const pane = makeSplitPane();
        showInPane(second, pane);
      }
    }
    if (restored.errors.length) notify(restored.errors.join('\n'), true);
  } catch (error) {
    element('.recovery').textContent = 'Recovery unavailable';
    notify(`Could not restore the previous session: ${String(error)}. Save buffers to files before quitting.`, true);
  }
  if (!tabs.length) await newTab();
  const requests = await call<OpenRequest[]>('startup_paths');
  for (const request of requests) await safely(() => openRequest(request));
  launchReady = true;
  await enqueueLaunchRequests(pendingLaunchRequests.splice(0));
  view.focus();
  // Retry launch handoffs even if an event failed while the window stayed focused.
  setInterval(() => { void safely(drainLaunchRequests); void checkpoint(); }, 30_000);
  setTimeout(() => { void checkpoint(); void safely(checkExternalChanges); }, 1000);
}
storePreferences();
if (desktop) { startupPromise = initializeDesktop(); void safely(() => startupPromise!); }
else await safely(newTab);
