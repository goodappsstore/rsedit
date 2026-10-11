import './style.css';
import { EditorSelection, EditorState, StateEffect } from '@codemirror/state';
import type { Text } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import type { ViewUpdate } from '@codemirror/view';
import { Compartment } from '@codemirror/state';
import { openSearchPanel, closeSearchPanel, searchPanelOpen, getSearchQuery, setSearchQuery, SearchQuery, gotoLine } from '@codemirror/search';
import { indentUnit } from '@codemirror/language';
import { undo, redo, toggleComment, selectAll } from '@codemirror/commands';
import { call, desktop, formatBytes } from './api';
import type { Info, Page, SearchScan, TabView, RestoredTab, RestoredSession } from './api';
import { currentMatch, detectLanguage, indentSlot, languageSlot, makeState, wrapSlot } from './editor';
import { createFolderPanel } from './folders';

interface Tab {
  info: Info;
  state: EditorState;
  pageStart: number;
  pageEnd: number;
  syncedDoc: Text;
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
}
interface Preferences { theme: 'dark' | 'light'; wrap: boolean; indent: number; fontSize: number }
interface Command { label: string; shortcut?: string; run: () => void | Promise<void> }
const mac = /Mac|iPhone|iPad/.test(navigator.platform);
const mod = mac ? '⌘' : 'Ctrl+';
function readStored<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback; } catch { return fallback; }
}
const stored = readStored<Partial<Preferences>>('rsedit.preferences', {});
const preferences: Preferences = {
  theme: stored.theme === 'light' ? 'light' : 'dark', wrap: stored.wrap === true,
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
const lockSlot = new Compartment();
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <header class="toolbar">
    <div class="brand">rs<span>edit</span></div>
    <button data-action="new" title="New file">New</button>
    <button data-action="open" title="Open files">Open</button>
    <button data-action="open-folder" title="Open folder">Folder</button>
    <button data-action="save" title="Save">Save</button>
    <button data-action="find" title="Find and replace">Find</button>
    <div class="spacer"></div>
    <button data-action="palette" class="quiet" title="Command palette">Commands <small>${mod}⇧P</small></button>
    <button data-action="wrap" title="Toggle word wrap" aria-pressed="false">Wrap</button>
  </header>
  <div class="workbench">
    <aside class="folder-panel" aria-label="Folder files" hidden>
      <header class="folder-header"><span class="folder-title"></span><button data-action="refresh-folder" title="Refresh folder tree" aria-label="Refresh folder tree">↻</button><button data-action="close-folder" title="Close folder panel" aria-label="Close folder panel">×</button></header>
      <div class="folder-tree" role="tree" aria-label="Folder files"></div>
    </aside>
    <div class="folder-divider" role="separator" aria-label="Folder panel width" aria-orientation="vertical" aria-valuemin="140" aria-valuemax="600" aria-valuenow="220" tabindex="0" hidden></div>
    <div class="editor-pane">
  <nav class="tabs" aria-label="Open files" role="tablist"></nav>
  <div class="notice" role="status" hidden><span></span><button aria-label="Dismiss notification">×</button></div>
  <main class="workspace">
    <div class="pagebar" hidden>
      <strong>Large file</strong><span class="range"></span>
      <button data-page="previous" title="Previous section">← Previous</button>
      <button data-page="next" title="Next section">Next →</button>
      <input class="byte-offset" type="number" min="0" step="1" aria-label="Go to byte offset" placeholder="Byte offset" />
      <button data-page="jump">Go</button>
    </div>
    <section class="large-search" aria-label="Search entire large file" hidden>
      <div class="search-row"><input class="large-query" aria-label="Search entire file" placeholder="Find exact text across the whole file" maxlength="4096" /><button data-search="start">Search</button><span class="match-count" role="status" aria-live="polite">0 matches</span><button data-search="close" aria-label="Close file search">×</button></div>
      <p class="search-hint">Enter: next · Shift+Enter: previous · Escape: restore position. Case-sensitive whole-file search.</p>
      
    </section>
    <div class="editor-host"></div>
  </main>
    </div>
  </div>
  <footer class="statusbar">
    <span class="path"></span><span class="position"></span>
    <span class="size"></span><span class="encoding">UTF-8</span><span class="eol"></span>
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
  document.documentElement.dataset.theme = preferences.theme;
  document.documentElement.style.setProperty('--font-size', `${preferences.fontSize}px`);
  try { localStorage.setItem('rsedit.preferences', JSON.stringify(preferences)); } catch { /* Storage may be disabled. */ }
  element('[data-action=wrap]').setAttribute('aria-pressed', String(preferences.wrap));
}
function remember(path: string | null): void {
  if (!path) return;
  recentPaths = [path, ...recentPaths.filter(p => p !== path)].slice(0, 20);
  try { localStorage.setItem('rsedit.recent', JSON.stringify(recentPaths)); } catch { /* Nonessential. */ }
}
function dirty(tab: Tab): boolean { return tab.pending || tab.info.dirty; }
const shortcuts = keymap.of([
  { key: 'Mod-n', run: () => { void safely(newTab); return true; } },
  { key: 'Mod-o', run: () => { void safely(openFiles); return true; } },
  { key: 'Mod-Alt-o', run: () => { void safely(folders.open); return true; } },
  { key: 'Mod-s', run: () => { void safely(() => saveTab(active)); return true; } },
  { key: 'Mod-Shift-s', run: () => { void safely(() => saveTab(active, true)); return true; } },
  { key: 'Mod-Shift-t', run: () => { void safely(reopenClosedTab); return true; } },
  { key: 'Mod-w', run: () => { void safely(() => closeTab(active)); return true; } },
  { key: 'Mod-f', run: () => { find(); return true; } },
  { key: 'Mod-h', run: () => { openSectionSearch(); return true; } },
  { key: 'Mod-Shift-p', run: () => { showCommands(); return true; } },
  { key: 'Mod-p', run: () => { showFiles(); return true; } },
  { key: 'Mod-g', run: () => { gotoLine(view); return true; } },
  { key: 'Mod-Shift-w', run: () => { toggleWrap(); return true; } },
  { key: 'Ctrl-Tab', run: () => { cycleTab(1); return true; } },
  { key: 'Ctrl-Shift-Tab', run: () => { cycleTab(-1); return true; } },
  { key: 'Mod-=', run: () => { zoom(1); return true; } },
  { key: 'Mod--', run: () => { zoom(-1); return true; } },
  { key: 'Mod-0', run: () => { preferences.fontSize = 14; storePreferences(); view.requestMeasure(); return true; } },
  { key: 'Escape', run: () => { if (!largeSearch.hidden) { void safely(resetLargeSearch); return true; } if (searchPanelOpen(view.state)) { resetSectionSearch(); return true; } return false; } },
]);
const view = new EditorView({ parent: element('.editor-host'), extensions: [EditorState.readOnly.of(true), EditorView.editable.of(false)] });
const folders = createFolderPanel(element('.folder-panel'), element('.folder-divider'), path => safely(() => openPath(path)),
  error => notify(String(error instanceof Error ? error.message : error), true), () => view.requestMeasure());
function changed(update: ViewUpdate): void {
  if (!active) return;
  active.state = update.state;
  updateSectionCount(update);
  if (update.docChanged) {
    for (const origin of [largeOrigin, sectionOrigin]) if (origin?.tab === active && origin.pageStart === active.pageStart) {
      origin.selection = origin.selection.map(update.changes);
      origin.byteOffset = active.pageStart + new TextEncoder().encode(update.state.sliceDoc(0, origin.selection.main.head)).length;
    }
    active.pending = !update.state.doc.eq(active.syncedDoc);
    cancelSearch();
    element('.match-count').textContent = 'Search changed; press Enter to search again.';
    renderTabs();
  }
  if (update.selectionSet || update.docChanged) renderStatus();
}
function options() { return { wrap: preferences.wrap, indent: preferences.indent, changed, shortcuts }; }
function lockExtension(busy: boolean) { return [EditorState.readOnly.of(busy), EditorView.editable.of(!busy)]; }
function applyEffect(tab: Tab, effects: StateEffect<unknown> | readonly StateEffect<unknown>[]): void {
  if (active === tab) view.dispatch({ effects });
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
  tab.state = makeState(page, options());
  tab.state = tab.state.update({ effects: StateEffect.appendConfig.of(lockSlot.of(lockExtension(tab.busy))) }).state;
  tab.syncedDoc = tab.state.doc;
  tab.pending = false;
  tab.loaded = true;
  tab.scrollTop = tab.scrollLeft = 0;
  if (active === tab) { view.setState(tab.state); view.focus(); updateSectionCount(); }
  void loadLanguage(tab);
  renderTabs(); renderStatus();
}
async function addPage(page: Page): Promise<void> {
  const tab: Tab = {
    info: page.info, state: makeState(page, options()), pageStart: page.start, pageEnd: page.end,
    syncedDoc: EditorState.create().doc, pending: false, busy: false,
    language: 'Plain text', languageGeneration: 0, previous: [], scrollTop: 0, scrollLeft: 0, loaded: true,
  };
  if (!tab.info.path) tab.info.name = `Untitled ${++nextUntitled}`;
  tab.state = tab.state.update({ effects: StateEffect.appendConfig.of(lockSlot.of(lockExtension(false))) }).state;
  tab.syncedDoc = tab.state.doc;
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
  };
  if (!tab.info.path) {
    tab.info.name = entry.view.name;
    nextUntitled = Math.max(nextUntitled, Number(/^Untitled (\d+)$/.exec(entry.view.name)?.[1] ?? 0));
  }
  return tab;
}
function captureTabView(tab: Tab): TabView {
  if (!tab.loaded && tab.savedView) return { ...tab.savedView, id: tab.info.id, name: tab.info.name, languageOverride: tab.languageOverride ?? null };
  const selection = tab.state.selection.main;
  return { id: tab.info.id, name: tab.info.name, pageStart: tab.pageStart, anchor: selection.anchor, head: selection.head,
    scrollTop: active === tab ? view.scrollDOM.scrollTop : tab.scrollTop,
    scrollLeft: active === tab ? view.scrollDOM.scrollLeft : tab.scrollLeft,
    languageOverride: tab.languageOverride ?? null };
}
function applySavedView(tab: Tab, saved: TabView): void {
  if (!tab.info.path) tab.info.name = saved.name;
  const length = tab.state.doc.length;
  const selection = EditorSelection.range(Math.min(saved.anchor, length), Math.min(saved.head, length));
  tab.scrollTop = saved.scrollTop; tab.scrollLeft = saved.scrollLeft;
  if (active === tab) {
    view.dispatch({ selection });
    view.requestMeasure({ read: () => null, write: () => {
      if (active === tab) { view.scrollDOM.scrollTop = tab.scrollTop; view.scrollDOM.scrollLeft = tab.scrollLeft; }
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
    installPage(tab, page);
    if (saved) applySavedView(tab, saved);
    tab.savedView = undefined;
  }).finally(() => { tab.loading = undefined; });
  return tab.loading;
}
function reopenClosedTab(): Promise<void> {
  historyQueue = historyQueue.catch(() => {}).then(async () => {
    await startupPromise?.catch(() => {});
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
  if (active === tab) { view.focus(); if (!tab.loaded) void safely(() => ensureLoaded(tab)); return; }
  if (active) {
    active.state = view.state;
    active.scrollTop = view.scrollDOM.scrollTop;
    active.scrollLeft = view.scrollDOM.scrollLeft;
  }
  hideLargeSearch();
  sectionOrigin = undefined;
  active = tab;
  const historyIndex = selectionHistory.indexOf(tab);
  if (historyIndex !== -1) selectionHistory.splice(historyIndex, 1);
  selectionHistory.push(tab);
  view.setState(tab.state);
  updateSectionCount();
  view.scrollDOM.scrollTop = tab.scrollTop;
  view.scrollDOM.scrollLeft = tab.scrollLeft;
  view.requestMeasure();
  view.focus();
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
    if ((!tab.info.path && !languageName) || languageName === 'Plain text' || (tab.info.paged && tab.state.doc.lines < tab.state.doc.length / 32768)) {
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
function renderTabs(): void {
  folders.select(active?.info.path ?? null);
  tabbar.replaceChildren(...tabs.map(tab => {
    const node = document.createElement('button');
    node.className = `tab${tab === active ? ' active' : ''}`;
    node.setAttribute('role', 'tab');
    node.setAttribute('aria-selected', String(tab === active));
    node.tabIndex = tab === active ? 0 : -1;
    node.title = tab.info.path ?? tab.info.name;
    const label = document.createElement('span'); label.className = 'tab-label'; label.textContent = tab.info.name;
    const dot = document.createElement('span'); dot.className = 'dirty-mark'; dot.textContent = dirty(tab) ? '●' : ''; dot.setAttribute('aria-label', dirty(tab) ? 'Unsaved changes' : 'Saved');
    const close = document.createElement('span'); close.className = 'tab-close'; close.textContent = '×'; close.setAttribute('aria-hidden', 'true');
    close.addEventListener('click', event => { event.stopPropagation(); void safely(() => closeTab(tab)); });
    node.append(label, dot, close);
    node.addEventListener('click', () => activate(tab));
    node.addEventListener('auxclick', event => { if (event.button === 1) { event.preventDefault(); void safely(() => closeTab(tab)); } });
    return node;
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
  element('[data-action=indent]').textContent = `Spaces: ${preferences.indent}`;
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
const opening = new Set<string>();
async function openPath(path: string): Promise<void> {
  const existing = tabs.find(t => t.info.path === path);
  if (existing) { activate(existing); return; }
  if (opening.has(path)) return;
  opening.add(path);
  try {
    const page = await call<Page>('open_document', { path });
    const duplicate = tabs.find(t => t.info.path === page.info.path);
    if (duplicate) { await call('close_document', { id: page.info.id }); activate(duplicate); return; }
    await addPage(page);
    if (page.info.paged) notify('Large-file mode: editable sections, bounded memory. Undo and line numbers apply to the current section.');
    else notice.hidden = true;
  } finally { opening.delete(path); }
}
async function openFiles(): Promise<void> {
  if (!desktop) throw new Error('Run npm run tauri dev to open files in the desktop app.');
  const { open } = await import('@tauri-apps/plugin-dialog');
  const result = await open({ multiple: true, directory: false, title: 'Open text files' });
  for (const path of typeof result === 'string' ? [result] : result ?? []) await safely(() => openPath(path));
}
async function flush(tab: Tab, force = false): Promise<void> {
  if (!tab.pending && !force) return;
  const text = tab.state.sliceDoc();
  const info = await call<Info>('replace_range', { id: tab.info.id, start: tab.pageStart, end: tab.pageEnd, text, revision: tab.info.revision });
  tab.info = { ...info, name: info.path ? info.name : tab.info.name };
  tab.pageEnd = tab.pageStart + new TextEncoder().encode(text).length;
  tab.syncedDoc = tab.state.doc;
  tab.pending = false;
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
    await flush(tab, saveAs && !tab.info.paged);
    tab.info = await call<Info>('save_document', { id: tab.info.id, path });
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
  historyQueue = historyQueue.catch(() => {}).then(async () => {
    await startupPromise?.catch(() => {});
    if (shuttingDown || !tabs.includes(tab)) return;
    await tab.loading?.catch(() => {});
    await locked(tab, async () => {
      if (!await approveClose(tab) || !tabs.includes(tab)) return;
      const index = tabs.indexOf(tab);
      if (closedTabs.length === 50) {
        await call('close_document', { id: closedTabs[0].info.id });
        closedTabs.shift();
      }
      if (active === tab) {
        hideLargeSearch();
        tab.state = view.state;
        tab.scrollTop = view.scrollDOM.scrollTop;
        tab.scrollLeft = view.scrollDOM.scrollLeft;
      }
      closedTabs.push(tab);
      tabs.splice(index, 1);
      const historyIndex = selectionHistory.indexOf(tab);
      if (historyIndex !== -1) selectionHistory.splice(historyIndex, 1);
      tab.languageGeneration++;
      if (active === tab) {
        active = undefined;
        if (tabs.length) activate(selectionHistory.at(-1) ?? tabs[Math.min(index, tabs.length - 1)]);
        else await newTab();
      }
      renderTabs(); renderStatus();
    });
  });
  return historyQueue;
}
async function reloadTab(): Promise<void> {
  const tab = active;
  if (!tab?.info.path) return;
  await locked(tab, async () => {
    if (!await approveDiscard(tab)) return;
    const page = await call<Page>('open_document', { path: tab.info.path });
    await call('close_document', { id: tab.info.id });
    tab.previous = [];
    installPage(tab, page);
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
  scrollTop: number; scrollLeft: number;
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
let sectionOrigin: SearchOrigin | undefined;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
function captureOrigin(): SearchOrigin {
  return { tab: active!, pageStart: active!.pageStart, selection: view.state.selection,
    byteOffset: active!.pageStart + new TextEncoder().encode(view.state.sliceDoc(0, view.state.selection.main.head)).length,
    scrollTop: view.scrollDOM.scrollTop, scrollLeft: view.scrollDOM.scrollLeft };
}
let sectionCountGeneration = 0;
function updateSectionCount(update?: ViewUpdate): void {
  const state = update?.state ?? view.state;
  if (!searchPanelOpen(state)) { sectionCountGeneration++; return; }
  const query = getSearchQuery(state);
  if (update && !update.docChanged && searchPanelOpen(update.startState) && query.eq(getSearchQuery(update.startState))) return;
  const generation = ++sectionCountGeneration;
  const tab = active;
  setTimeout(() => void safely(async () => {
    if (generation !== sectionCountGeneration || active !== tab) return;
    const panel = element('.editor-host').querySelector('.cm-search');
    if (!panel) return;
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
  if (!searchPanelOpen(view.state)) sectionOrigin = captureOrigin();
  openSearchPanel(view);
}
function restoreViewport(origin: SearchOrigin): void {
  if (active !== origin.tab) return;
  const ranges = origin.selection.ranges.map(range => EditorSelection.range(Math.min(range.anchor, view.state.doc.length), Math.min(range.head, view.state.doc.length)));
  view.dispatch({ selection: EditorSelection.create(ranges, origin.selection.mainIndex), effects: currentMatch.of(null) });
  view.requestMeasure({ read: () => null, write: () => {
    if (active === origin.tab) { view.scrollDOM.scrollTop = origin.scrollTop; view.scrollDOM.scrollLeft = origin.scrollLeft; }
  } });
  view.focus();
}
function resetSectionSearch(): void {
  const origin = sectionOrigin; sectionOrigin = undefined;
  closeSearchPanel(view);
  if (origin) restoreViewport(origin);
}
function showLargeSearch(): void {
  if (!active) return;
  if (searchPanelOpen(view.state)) { closeSearchPanel(view); sectionOrigin = undefined; }
  if (largeSearch.hidden) {
    largeOrigin = captureOrigin();
    element('.match-count').textContent = '0 matches';
  }
  largeSearch.hidden = false; queryInput.focus(); queryInput.select();
}
function find(): void {
  if (!active) return;
  if (active.info.paged && largeSearch.hidden && !searchPanelOpen(view.state)) showLargeSearch();
  else openSectionSearch();
}
function cancelSearch(): void {
  searchGeneration++; largeFind = undefined;
  clearTimeout(searchTimer);
}
function hideLargeSearch(): void { cancelSearch(); if (active) applyEffect(active, currentMatch.of(null)); largeSearch.hidden = true; largeOrigin = undefined; }
async function resetLargeSearch(): Promise<void> {
  const origin = largeOrigin;
  hideLargeSearch();
  if (!origin || active !== origin.tab) return;
  const generation = searchGeneration;
  // Escape may arrive while a match's section is still loading.
  while (origin.tab.busy) {
    await new Promise<void>(resolve => setTimeout(resolve, 16));
    if (active !== origin.tab || generation !== searchGeneration) return;
  }
  if (origin.tab.pageStart !== origin.pageStart) await changePage(origin.pageStart);
  restoreViewport(origin);
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
  element('.match-count').textContent = `${ordinal === undefined ? '' : `${ordinal} of `}${session.total.toLocaleString()}${session.complete ? '' : '+'} matches`;
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
  element('.match-count').textContent = 'Searching…';
  void safely(() => countMatches(session));
  await navigateMatch(session, direction);
}
function toggleWrap(): void {
  preferences.wrap = !preferences.wrap;
  for (const tab of tabs) applyEffect(tab, wrapSlot.reconfigure(preferences.wrap ? EditorView.lineWrapping : []));
  storePreferences();
}
function changeIndent(): void {
  preferences.indent = preferences.indent === 2 ? 4 : preferences.indent === 4 ? 8 : 2;
  for (const tab of tabs) applyEffect(tab, indentSlot.reconfigure([indentUnit.of(' '.repeat(preferences.indent)), EditorState.tabSize.of(preferences.indent)]));
  storePreferences(); renderStatus();
}
function zoom(delta: number): void { preferences.fontSize = Math.min(28, Math.max(10, preferences.fontSize + delta)); storePreferences(); view.requestMeasure(); }
function toggleTheme(): void { preferences.theme = preferences.theme === 'dark' ? 'light' : 'dark'; storePreferences(); view.requestMeasure(); }

let paletteCommands: Command[] = [];
let filteredCommands: Command[] = [];
let paletteIndex = 0;
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
    { label: 'Reload file from disk', run: reloadTab },
    { label: 'Save all files', run: async () => { for (const tab of [...tabs]) if (dirty(tab) && !await saveTab(tab)) break; } },
    { label: 'Reopen closed file', shortcut: `${mod}⇧T`, run: reopenClosedTab },
    { label: 'Close file', shortcut: `${mod}W`, run: () => closeTab(active) },
    { label: 'Find / replace in current section', shortcut: `${mod}F`, run: () => { openSectionSearch(); } },
    ...(active?.info.paged ? [{ label: 'Search entire file', run: showLargeSearch }] : []),
    { label: 'Go to line (current section)', shortcut: `${mod}G`, run: () => { gotoLine(view); } },
    { label: 'Undo', shortcut: `${mod}Z`, run: () => { undo(view); } },
    { label: 'Redo', shortcut: `${mod}⇧Z`, run: () => { redo(view); } },
    { label: 'Select all (current section)', shortcut: `${mod}A`, run: () => { selectAll(view); } },
    { label: 'Toggle line comment', shortcut: `${mod}/`, run: () => { toggleComment(view); } },
    { label: `${preferences.wrap ? 'Disable' : 'Enable'} word wrap`, shortcut: `${mod}⇧W`, run: toggleWrap },
    { label: `Switch to ${preferences.theme === 'dark' ? 'light' : 'dark'} theme`, run: toggleTheme },
    { label: 'Change indentation: 2 / 4 / 8 spaces', run: changeIndent },
    { label: 'Increase font size', shortcut: `${mod}+`, run: () => zoom(1) },
    { label: 'Decrease font size', shortcut: `${mod}−`, run: () => zoom(-1) },
    { label: 'Select syntax language…', run: showLanguages },
    { label: 'Switch file…', shortcut: `${mod}P`, run: showFiles },
    ...recentPaths.map(path => ({ label: `Open recent: ${path}`, run: () => openPath(path) })),
  ];
}
function showPalette(items: Command[], placeholder = 'Type a command…'): void {
  paletteCommands = items; paletteIndex = 0;
  paletteQuery.value = ''; paletteQuery.placeholder = placeholder;
  overlay.hidden = false; renderPalette(); paletteQuery.focus();
}
function showCommands(): void { showPalette(commands()); }
function showFiles(): void {
  showPalette(tabs.map(tab => ({ label: `${dirty(tab) ? '● ' : ''}${tab.info.name}`, shortcut: tab.info.path ?? '', run: () => activate(tab) })), 'Switch to a file…');
}
async function showLanguages(): Promise<void> {
  const tab = active;
  if (!tab) return;
  const { languages } = await import('@codemirror/language-data');
  showPalette(['Plain text', ...languages.map(l => l.name)].map(name => ({ label: name, run: () => loadLanguage(tab, name) })), 'Select a syntax language…');
}
function closePalette(): void { overlay.hidden = true; view.focus(); }
function renderPalette(): void {
  const query = paletteQuery.value.toLowerCase();
  filteredCommands = paletteCommands.filter(command => command.label.toLowerCase().includes(query));
  paletteIndex = Math.min(paletteIndex, Math.max(0, filteredCommands.length - 1));
  element('.palette-list').replaceChildren(...filteredCommands.map((command, index) => {
    const button = document.createElement('button'); button.className = `palette-item${index === paletteIndex ? ' selected' : ''}`;
    button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(index === paletteIndex));
    const label = document.createElement('span'); label.textContent = command.label;
    const shortcut = document.createElement('small'); shortcut.textContent = command.shortcut ?? '';
    button.append(label, shortcut);
    button.addEventListener('click', () => { closePalette(); void safely(command.run); });
    return button;
  }));
  element('.palette-list').querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
}

const actions: Record<string, () => void | Promise<void>> = {
  new: newTab, open: openFiles, reopen: reopenClosedTab, save: async () => { await saveTab(active); }, find,
  'open-folder': folders.open, 'toggle-folder': folders.toggle, 'refresh-folder': folders.refresh, 'close-folder': folders.close,
  palette: showCommands, wrap: toggleWrap, indent: changeIndent, language: showLanguages,
};
app.addEventListener('click', event => {
  const action = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
  if (action && actions[action]) void safely(actions[action]);
});
// The default CodeMirror panel listens to keyup/change. Commit input events too,
// so paste, cut, clear, and checkbox changes immediately update the same query.
function commitSectionQuery(event: Event): void {
  if (shuttingDown || (event instanceof InputEvent && event.isComposing)) return;
  const panel = (event.target as HTMLElement).closest('.cm-search');
  if (!panel || !searchPanelOpen(view.state)) return;
  const field = (name: string) => panel.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  const query = new SearchQuery({
    search: field('search').value, replace: field('replace')?.value ?? getSearchQuery(view.state).replace,
    caseSensitive: field('case').checked, regexp: field('re').checked, wholeWord: field('word').checked,
  });
  if (!query.eq(getSearchQuery(view.state))) view.dispatch({ effects: setSearchQuery.of(query) });
}
element('.editor-host').addEventListener('input', commitSectionQuery);
element('.editor-host').addEventListener('compositionend', commitSectionQuery);
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
  if (action === 'close') void safely(resetLargeSearch);
});
queryInput.addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); void safely(() => searchLarge(event.shiftKey ? -1 : 1)); }
});
queryInput.addEventListener('input', () => {
  cancelSearch(); if (active) applyEffect(active, currentMatch.of(null)); element('.match-count').textContent = queryInput.value ? 'Searching…' : '0 matches';
  if (queryInput.value) searchTimer = setTimeout(() => void safely(() => searchLarge()), 150);
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !overlay.hidden) return;
  if (!largeSearch.hidden) { event.preventDefault(); event.stopPropagation(); void safely(resetLargeSearch); }
  else if (searchPanelOpen(view.state)) { event.preventDefault(); event.stopPropagation(); resetSectionSearch(); }
}, true);
paletteQuery.addEventListener('input', () => { paletteIndex = 0; renderPalette(); });
paletteQuery.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); closePalette(); }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault(); paletteIndex = (paletteIndex + (event.key === 'ArrowDown' ? 1 : -1) + filteredCommands.length) % (filteredCommands.length || 1); renderPalette();
  }
  if (event.key === 'Enter') { event.preventDefault(); const command = filteredCommands[paletteIndex]; if (command) { closePalette(); void safely(command.run); } }
});
overlay.addEventListener('click', event => { if (event.target === overlay || (event.target as HTMLElement).closest('[data-palette=close]')) closePalette(); });
overlay.addEventListener('keydown', event => {
  if (event.key !== 'Tab') return;
  const focusable = Array.from(overlay.querySelectorAll<HTMLElement>('input,button'));
  const index = focusable.indexOf(document.activeElement as HTMLElement);
  event.preventDefault(); focusable[(index + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length]?.focus();
});
// App shortcuts also work while toolbar and search controls have focus.
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || !overlay.hidden || !(mac ? event.metaKey : event.ctrlKey)) return;
  const key = event.key.toLowerCase();
  const action = key === 'o' ? (event.altKey ? folders.open : openFiles) : key === 'n' ? newTab : key === 's' ? async () => { await saveTab(active, event.shiftKey); }
    : key === 't' && event.shiftKey ? reopenClosedTab : key === 'w' ? () => closeTab(active) : key === 'p' ? (event.shiftKey ? showCommands : showFiles) : undefined;
  if (action) { event.preventDefault(); void safely(action); }
});
tabbar.addEventListener('keydown', event => {
  if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); cycleTab(event.key === 'ArrowRight' ? 1 : -1); }
  if (event.key === 'Delete') { event.preventDefault(); void safely(() => closeTab(active)); }
});
window.addEventListener('beforeunload', event => { if (!desktop && tabs.some(dirty)) event.preventDefault(); });

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
    await safely(async () => {
      shuttingDown = true;
      cancelSearch();
      let lockedTabs: Tab[] = [];
      try {
        await startupPromise?.catch(() => {});
        await historyQueue.catch(() => {});
        await folders.settle();
        while (opening.size || [...tabs, ...closedTabs].some(tab => tab.busy)) {
          await new Promise<void>(resolve => setTimeout(resolve, 16));
        }
        lockedTabs = [...tabs, ...closedTabs];
        for (const tab of lockedTabs) { tab.busy = true; applyEffect(tab, lockSlot.reconfigure(lockExtension(true))); }
        notify('Preserving session…');
        for (const tab of lockedTabs) await flush(tab);
        await call('persist_session', { view: { open: tabs.map(captureTabView), closed: closedTabs.map(captureTabView), active: active?.info.id ?? null, folder: folders.capture() } });
        await nativeWindow.destroy();
      } catch (error) {
        throw new Error(`Could not finish preserving and closing the session. The editor remains open: ${String(error)}`);
      } finally {
        shuttingDown = false;
        for (const tab of lockedTabs) { tab.busy = false; applyEffect(tab, lockSlot.reconfigure(lockExtension(!tab.loaded))); }
      }
    });
  });
  await listen<string>('editor-menu', event => {
    const action = event.payload;
    if (action === 'quit') void nativeWindow.close();
    else if (action === 'save-as') void safely(async () => { await saveTab(active, true); });
    else if (action === 'theme') toggleTheme();
    else if (action === 'close') void safely(() => closeTab(active));
    else if (action === 'undo') { undo(view); }
    else if (action === 'redo') { redo(view); }
    else if (actions[action]) void safely(actions[action]);
  });
  await listen<string[]>('editor-open', event => { void safely(async () => { for (const path of event.payload) await safely(() => openPath(path)); }); });
  try {
    const restored = await call<RestoredSession>('restore_session');
    tabs.push(...restored.open.map(restoredTab));
    closedTabs.push(...restored.closed.map(restoredTab));
    await folders.restore(restored.folder);
    while (closedTabs.length > 50) await call('close_document', { id: closedTabs.shift()!.info.id });
    if (tabs.length) {
      const selected = tabs[Math.min(restored.activeIndex, tabs.length - 1)];
      activate(selected);
      await ensureLoaded(selected);
    }
    if (restored.errors.length) notify(restored.errors.join('\n'), true);
  } catch (error) { notify(`Could not restore the previous session: ${String(error)}`, true); }
  if (!tabs.length) await newTab();
  const paths = await call<string[]>('startup_paths');
  for (const path of paths) await safely(() => openPath(path));
}
storePreferences();
if (desktop) { startupPromise = initializeDesktop(); void safely(() => startupPromise!); }
else await safely(newTab);
