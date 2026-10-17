import { call, desktop } from './api';
import type { FolderEntry, FolderListing, FolderView } from './api';

export interface FolderHooks {
  notify: (message: string) => void;
  confirmDelete: (message: string) => Promise<boolean>;
  renamed: (oldPath: string, newPath: string, isDirectory: boolean) => Promise<void>;
  deleted: (path: string, isDirectory: boolean) => Promise<void>;
}

interface DirState {
  expand: () => void;
  isExpanded: () => boolean;
  isLoaded: () => boolean;
  container: () => HTMLElement;
  reload: () => Promise<void>;
  markStale: () => void;
}

export function createFolderPanel(
  panel: HTMLElement, divider: HTMLElement,
  openFile: (path: string) => Promise<void>,
  reportError: (error: unknown) => void,
  resized: () => void,
  hooks: FolderHooks,
) {
  const tree = panel.querySelector<HTMLElement>('.folder-tree')!;
  const title = panel.querySelector<HTMLElement>('.folder-title')!;
  const header = panel.querySelector<HTMLElement>('.folder-header')!;
  let rootPath: string | undefined;
  let pendingRoot: Promise<void> | undefined;
  let generation = 0;
  let activePath: string | null = null;
  let menu: HTMLElement | undefined;
  const expanded = new Set<string>();
  const dirs = new Map<string, DirState>();
  let width = 220;
  try {
    const stored = Number(localStorage.getItem('rsedit.folderWidth'));
    if (Number.isFinite(stored) && stored >= 140) width = stored;
  } catch { /* Optional preference. */ }

  function setWidth(value: number): void {
    const available = panel.parentElement!.clientWidth;
    width = Math.round(Math.max(140, Math.min(value, 600, Math.max(140, available - 200))));
    panel.style.width = `${width}px`;
    divider.setAttribute('aria-valuenow', String(width));
    divider.setAttribute('aria-valuemax', String(Math.min(600, Math.max(140, available - 200))));
    resized();
  }
  function show(visible: boolean): void {
    panel.hidden = divider.hidden = !visible;
    if (visible) setWidth(width);
    resized();
  }
  function closeMenu(): void {
    menu?.remove();
    menu = undefined;
  }
  function select(path: string | null): void {
    if (activePath === path) return;
    activePath = path;
    for (const row of tree.querySelectorAll<HTMLElement>('[data-file]')) {
      row.classList.toggle('selected', row.dataset.file === path);
      row.setAttribute('aria-selected', String(row.dataset.file === path));
    }
  }
  function parentDir(path: string): string | undefined {
    const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    if (slash <= 0) return undefined;
    return path.slice(0, slash);
  }
  function forgetSubtree(path: string): void {
    const prefixSlash = `${path}/`;
    const prefixBack = `${path}\\`;
    const matches = (candidate: string): boolean =>
      candidate === path || candidate.startsWith(prefixSlash) || candidate.startsWith(prefixBack);
    for (const candidate of [...expanded]) if (matches(candidate)) expanded.delete(candidate);
    for (const candidate of [...dirs.keys()]) if (matches(candidate)) dirs.delete(candidate);
  }
  function buildRows(host: HTMLElement, entries: FolderEntry[], depth: number, truncated: boolean, unsupportedNames: boolean): void {
    host.replaceChildren(...entries.map(entry => row(entry, depth)));
    if (truncated) host.append(message(`Showing ${entries.length.toLocaleString()} entries; folder listing limit reached. Use quick-open to find other files.`, depth));
    else if (!entries.length && !unsupportedNames) host.append(message('Empty folder', depth));
    if (unsupportedNames) host.append(message('Some names are not UTF-8. Manage those entries in the system file manager.', depth));
    // Restore previously expanded folders after a refresh.
    for (const button of host.querySelectorAll<HTMLButtonElement>(':scope > .folder-node > .tree-row[data-dir]')) {
      if (button.dataset.dir && expanded.has(button.dataset.dir)) button.click();
    }
  }
  function row(entry: FolderEntry, depth: number): HTMLElement {
    const node = document.createElement('div');
    node.className = 'folder-node';
    const button = document.createElement('button');
    button.className = 'tree-row';
    button.style.paddingLeft = `${10 + depth * 14}px`;
    button.title = entry.path;
    button.setAttribute('role', 'treeitem');
    button.setAttribute('aria-level', String(depth + 1));
    button.dataset.name = entry.name;
    button.dataset.symlink = String(entry.isSymlink);
    const marker = document.createElement('span'); marker.className = 'tree-marker'; marker.setAttribute('aria-hidden', 'true');
    marker.textContent = entry.isDirectory ? '▸' : '·';
    const name = document.createElement('span'); name.className = 'tree-name'; name.textContent = entry.name;
    button.append(marker, name);
    node.append(button);
    if (!entry.isDirectory) {
      button.dataset.file = entry.path;
      button.classList.toggle('selected', entry.path === activePath);
      button.setAttribute('aria-selected', String(entry.path === activePath));
      button.addEventListener('click', () => { void openFile(entry.path).catch(reportError); });
      return node;
    }
    button.dataset.dir = entry.path;
    button.setAttribute('aria-expanded', 'false');
    const children = document.createElement('div'); children.setAttribute('role', 'group'); children.hidden = true;
    node.append(children);
    let isExpanded = false;
    let loaded = false;
    let loading = false;
    async function loadChildren(): Promise<void> {
      if (loading) return;
      loading = true; button.setAttribute('aria-busy', 'true');
      const pendingGeneration = generation;
      try {
        const listing = await call<FolderListing>('read_directory', { path: entry.path });
        if (pendingGeneration !== generation || !node.isConnected) return;
        buildRows(children, listing.entries, depth + 1, listing.truncated, listing.unsupportedNames);
        loaded = true;
      } catch (error) {
        if (pendingGeneration !== generation || !node.isConnected) return;
        setExpanded(false);
        reportError(error);
      } finally {
        loading = false; button.removeAttribute('aria-busy');
      }
    }
    function setExpanded(next: boolean): void {
      isExpanded = next;
      children.hidden = !next;
      button.setAttribute('aria-expanded', String(next));
      marker.textContent = next ? '▾' : '▸';
      if (next) {
        expanded.add(entry.path);
        if (!loaded) void loadChildren();
      } else expanded.delete(entry.path);
    }
    dirs.set(entry.path, {
      expand: () => { if (!isExpanded) setExpanded(true); },
      isExpanded: () => isExpanded,
      isLoaded: () => loaded,
      container: () => children,
      reload: async () => { if (node.isConnected) await loadChildren(); else dirs.delete(entry.path); },
      markStale: () => { loaded = false; },
    });
    button.addEventListener('click', () => setExpanded(!isExpanded));
    return node;
  }
  function message(text: string, depth = 0): HTMLElement {
    const node = document.createElement('div'); node.className = 'tree-message'; node.textContent = text;
    node.style.paddingLeft = `${10 + depth * 14}px`;
    return node;
  }
  function load(path: string, visible = true): Promise<void> {
    const request = ++generation;
    closeMenu();
    pendingRoot = call<FolderListing>('read_directory', { path }).then(listing => {
      if (request !== generation) return;
      rootPath = listing.path;
      dirs.clear();
      title.textContent = listing.name; title.title = listing.path;
      tree.setAttribute('aria-label', listing.path);
      buildRows(tree, listing.entries, 0, listing.truncated, listing.unsupportedNames);
      show(visible);
    });
    return pendingRoot;
  }
  async function refreshParent(path: string): Promise<void> {
    const parent = parentDir(path);
    if (!parent || parent === rootPath) {
      if (rootPath) await load(rootPath, !panel.hidden);
      return;
    }
    const state = dirs.get(parent);
    if (!state) {
      if (rootPath) await load(rootPath, !panel.hidden);
      return;
    }
    if (state.isExpanded()) await state.reload();
    else state.markStale();
  }
  async function restore(saved: FolderView | null): Promise<void> {
    if (!saved) return;
    // Retain the path even if a disconnected drive or missing folder cannot load.
    // Refresh can retry it, and a later checkpoint must not forget it.
    rootPath = saved.path;
    title.textContent = saved.path; title.title = saved.path;
    tree.setAttribute('aria-label', saved.path);
    tree.replaceChildren(message('Loading folder…'));
    show(saved.visible);
    const request = generation + 1;
    try { await load(saved.path, saved.visible); }
    catch (error) {
      if (request !== generation) return;
      tree.replaceChildren(message('Folder unavailable. Refresh to retry.'));
      reportError(`Could not restore folder ${saved.path}: ${String(error)}`);
    }
  }
  async function open(): Promise<void> {
    if (!desktop) throw new Error('Opening folders requires the desktop app.');
    const { open } = await import('@tauri-apps/plugin-dialog');
    const result = await open({ directory: true, multiple: false, title: 'Open folder' });
    if (typeof result === 'string') await load(result);
  }
  function findRow(path: string): { node: HTMLElement; button: HTMLButtonElement } | undefined {
    const buttons = tree.querySelectorAll<HTMLButtonElement>('.tree-row[data-file], .tree-row[data-dir]');
    for (const button of buttons) {
      if (button.dataset.file === path || button.dataset.dir === path) {
        const node = button.closest<HTMLElement>('.folder-node');
        if (node) return { node, button };
      }
    }
    return undefined;
  }
  function nameInputRow(paddingLeft: string, initial: string, placeholder: string): { row: HTMLElement; input: HTMLInputElement } {
    const row = document.createElement('div');
    row.className = 'tree-input-row';
    row.style.paddingLeft = paddingLeft;
    const input = document.createElement('input');
    input.className = 'tree-input';
    input.value = initial;
    input.placeholder = placeholder;
    input.setAttribute('aria-label', placeholder);
    input.maxLength = 255;
    row.append(input);
    return { row, input };
  }
  function selectStem(input: HTMLInputElement): void {
    input.focus();
    const dot = input.value.lastIndexOf('.');
    if (dot > 0) input.setSelectionRange(0, dot);
    else input.select();
  }
  function validName(name: string): string | undefined {
    const trimmed = name.trim();
    if (!trimmed || trimmed === '.' || trimmed === '..' || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) {
      reportError(`Invalid file name: ${name.trim() || name}`);
      return undefined;
    }
    return trimmed;
  }
  async function createIn(parent: string, kind: 'file' | 'folder'): Promise<void> {
    if (!desktop) throw new Error('Managing files requires the desktop app.');
    let host: HTMLElement;
    let paddingLeft: string;
    if (parent === rootPath) {
      host = tree;
      paddingLeft = '10px';
    } else {
      const state = dirs.get(parent);
      if (!state) throw new Error('The folder is no longer available.');
      state.expand();
      for (let attempt = 0; attempt < 150 && !state.isLoaded(); attempt++) {
        await new Promise<void>(resolve => setTimeout(resolve, 20));
      }
      if (!state.isLoaded()) throw new Error('Could not load the folder.');
      host = state.container();
      const first = host.querySelector<HTMLElement>(':scope > .folder-node > .tree-row');
      paddingLeft = first?.style.paddingLeft ?? '24px';
    }
    host.querySelector('.tree-input-row')?.remove();
    const placeholder = kind === 'file' ? 'New file name' : 'New folder name';
    const { row, input } = nameInputRow(paddingLeft, '', placeholder);
    host.prepend(row);
    input.focus();
    let committing = false;
    const cancel = (): void => { if (!committing) row.remove(); };
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        const name = validName(input.value);
        if (!name) { input.focus(); return; }
        committing = true;
        input.disabled = true;
        void (async () => {
          try {
            const created = await call<string>(kind === 'file' ? 'create_file' : 'create_folder', { parent, name });
            await refreshParent(created);
            hooks.notify(`Created ${name}.`);
            if (kind === 'file') await openFile(created);
          } catch (error) {
            committing = false;
            input.disabled = false;
            reportError(error);
            input.focus();
          }
        })();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        row.remove();
      } else if (event.key !== 'Tab') event.stopPropagation();
    });
    input.addEventListener('blur', () => { setTimeout(cancel, 0); });
  }
  async function renameEntry(entry: FolderEntry): Promise<void> {
    if (!desktop) throw new Error('Managing files requires the desktop app.');
    const found = findRow(entry.path);
    if (!found) throw new Error('The file is no longer visible. Refresh the folder tree.');
    document.querySelectorAll('.tree-input-row').forEach(row => row.remove());
    const { row, input } = nameInputRow(found.button.style.paddingLeft || '10px', entry.name, `Rename ${entry.name}`);
    found.node.before(row);
    found.node.style.display = 'none';
    const restore = (): void => { row.remove(); found.node.style.display = ''; };
    selectStem(input);
    let committing = false;
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        const name = validName(input.value);
        if (!name) { input.focus(); return; }
        if (name === entry.name) { restore(); return; }
        committing = true;
        input.disabled = true;
        void (async () => {
          try {
            const wasExpanded = expanded.has(entry.path);
            const next = await call<string>('rename_path', { from: entry.path, name });
            forgetSubtree(entry.path);
            if (entry.isDirectory && wasExpanded) expanded.add(next);
            await hooks.renamed(entry.path, next, entry.isDirectory).catch(reportError);
            await refreshParent(next);
            hooks.notify(`Renamed to ${name}.`);
          } catch (error) {
            reportError(error);
            restore();
          }
        })();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        restore();
      } else if (event.key !== 'Tab') event.stopPropagation();
    });
    input.addEventListener('blur', () => { setTimeout(() => { if (!committing) restore(); }, 0); });
  }
  async function deleteEntry(entry: FolderEntry): Promise<void> {
    if (!desktop) throw new Error('Managing files requires the desktop app.');
    const confirmed = await hooks.confirmDelete(entry.isSymlink
      ? `Permanently delete the link ${entry.name}? Its target will be kept. This cannot be undone.`
      : entry.isDirectory
      ? `Permanently delete ${entry.name} and everything inside it? This cannot be undone.`
      : `Permanently delete ${entry.name}? This cannot be undone.`);
    if (!confirmed) return;
    await call('delete_path', { path: entry.path });
    forgetSubtree(entry.path);
    await hooks.deleted(entry.path, entry.isDirectory).catch(reportError);
    await refreshParent(entry.path);
    hooks.notify(`Deleted ${entry.name}.`);
  }
  async function copyPath(path: string): Promise<void> {
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(path);
      else throw new Error('Clipboard unavailable.');
    } catch {
      const area = document.createElement('textarea');
      area.value = path;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.append(area);
      area.select();
      try {
        if (!document.execCommand('copy')) throw new Error('Copy failed.');
      } finally {
        area.remove();
      }
    }
    hooks.notify('Copied path to clipboard.');
  }
  function openMenu(x: number, y: number, items: { label: string; run: () => Promise<void> | void }[]): void {
    closeMenu();
    menu = document.createElement('div');
    menu.className = 'tree-menu';
    menu.setAttribute('role', 'menu');
    for (const item of items) {
      const button = document.createElement('button');
      button.className = 'tree-menu-item';
      button.setAttribute('role', 'menuitem');
      button.textContent = item.label;
      button.addEventListener('click', () => { closeMenu(); void Promise.resolve(item.run()).catch(reportError); });
      menu.append(button);
    }
    document.body.append(menu);
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - height - 4))}px`;
    menu.querySelector<HTMLElement>('button')?.focus();
  }
  function entryFromButton(button: HTMLButtonElement): FolderEntry | undefined {
    const path = button.dataset.file ?? button.dataset.dir;
    const name = button.dataset.name;
    if (!path || !name) return undefined;
    return { name, path, isDirectory: button.dataset.dir !== undefined, isSymlink: button.dataset.symlink === 'true' };
  }
  function menuForEntry(entry: FolderEntry, x: number, y: number): void {
    if (entry.isDirectory) {
      openMenu(x, y, [
        { label: 'New File', run: () => createIn(entry.path, 'file') },
        { label: 'New Folder', run: () => createIn(entry.path, 'folder') },
        { label: 'Rename', run: () => renameEntry(entry) },
        { label: 'Delete', run: () => deleteEntry(entry) },
        { label: 'Copy Path', run: () => copyPath(entry.path) },
        { label: 'Reveal in File Manager', run: () => call('reveal_in_file_manager', { path: entry.path }) },
      ]);
    } else {
      openMenu(x, y, [
        { label: 'Open', run: () => openFile(entry.path) },
        { label: 'Rename', run: () => renameEntry(entry) },
        { label: 'Delete', run: () => deleteEntry(entry) },
        { label: 'Copy Path', run: () => copyPath(entry.path) },
        { label: 'Reveal in File Manager', run: () => call('reveal_in_file_manager', { path: entry.path }) },
      ]);
    }
  }
  function menuForRoot(x: number, y: number): void {
    if (!rootPath) return;
    const root = rootPath;
    openMenu(x, y, [
      { label: 'New File', run: () => createIn(root, 'file') },
      { label: 'New Folder', run: () => createIn(root, 'folder') },
      { label: 'Copy Path', run: () => copyPath(root) },
      { label: 'Reveal in File Manager', run: () => call('reveal_in_file_manager', { path: root }) },
    ]);
  }
  panel.addEventListener('contextmenu', event => {
    if (panel.hidden || !rootPath) return;
    event.preventDefault();
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.tree-row');
    if (button) {
      const entry = entryFromButton(button);
      if (entry) menuForEntry(entry, event.clientX, event.clientY);
    } else menuForRoot(event.clientX, event.clientY);
  });
  header.addEventListener('contextmenu', event => {
    if (panel.hidden || !rootPath) return;
    event.preventDefault();
    event.stopPropagation();
    menuForRoot(event.clientX, event.clientY);
  });
  document.addEventListener('pointerdown', event => {
    if (menu && !(event.target as HTMLElement).closest('.tree-menu')) closeMenu();
  }, true);
  document.addEventListener('keydown', event => {
    if (menu && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
    }
  }, true);
  tree.addEventListener('keydown', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.tree-row');
    if (!button) return;
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      const entry = entryFromButton(button);
      const rect = button.getBoundingClientRect();
      if (entry) menuForEntry(entry, rect.left + 24, rect.bottom + 2);
      return;
    }
    const visible = Array.from(tree.querySelectorAll<HTMLButtonElement>('.tree-row')).filter(row => !row.closest('[hidden]'));
    const index = visible.indexOf(button);
    let target: HTMLButtonElement | undefined;
    if (event.key === 'ArrowDown') target = visible[Math.min(index + 1, visible.length - 1)];
    else if (event.key === 'ArrowUp') target = visible[Math.max(0, index - 1)];
    else if (event.key === 'Home') target = visible[0];
    else if (event.key === 'End') target = visible.at(-1);
    else if (event.key === 'ArrowRight') {
      if (button.getAttribute('aria-expanded') === 'false') button.click();
      else if (button.getAttribute('aria-expanded') === 'true') target = visible[index + 1];
    } else if (event.key === 'ArrowLeft') {
      if (button.getAttribute('aria-expanded') === 'true') button.click();
      else target = button.parentElement?.parentElement?.closest('.folder-node')?.querySelector<HTMLButtonElement>('.tree-row') ?? undefined;
    } else return;
    event.preventDefault(); target?.focus();
  });
  function saveWidth(): void {
    try { localStorage.setItem('rsedit.folderWidth', String(width)); } catch { /* Optional preference. */ }
  }
  let drag: { x: number; width: number; pointerId: number } | undefined;
  divider.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag = { x: event.clientX, width, pointerId: event.pointerId };
    divider.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing-folder');
  });
  divider.addEventListener('pointermove', event => {
    if (drag && drag.pointerId === event.pointerId) setWidth(drag.width + event.clientX - drag.x);
  });
  function endDrag(): void {
    if (!drag) return;
    drag = undefined; document.body.classList.remove('resizing-folder'); saveWidth();
  }
  divider.addEventListener('pointerup', endDrag);
  divider.addEventListener('pointercancel', endDrag);
  divider.addEventListener('lostpointercapture', endDrag);
  divider.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault(); setWidth(width + (event.key === 'ArrowLeft' ? -10 : 10)); saveWidth();
  });
  window.addEventListener('resize', () => { if (!panel.hidden) setWidth(width); });
  return {
    open, select, restore,
    capture: (): FolderView | null => rootPath ? { path: rootPath, visible: !panel.hidden } : null,
    settle: async () => { await pendingRoot?.catch(() => {}); },
    refresh: async () => { if (rootPath) await load(rootPath, !panel.hidden); },
    toggle: async () => { if (!rootPath) await open(); else show(panel.hidden); },
    close: () => { ++generation; rootPath = undefined; dirs.clear(); expanded.clear(); closeMenu(); tree.replaceChildren(); show(false); },
  };
}
