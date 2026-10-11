import { call, desktop } from './api';
import type { FolderEntry, FolderListing, FolderView } from './api';

export function createFolderPanel(
  panel: HTMLElement, divider: HTMLElement,
  openFile: (path: string) => Promise<void>,
  reportError: (error: unknown) => void,
  resized: () => void,
) {
  const tree = panel.querySelector<HTMLElement>('.folder-tree')!;
  const title = panel.querySelector<HTMLElement>('.folder-title')!;
  let rootPath: string | undefined;
  let pendingRoot: Promise<void> | undefined;
  let generation = 0;
  let activePath: string | null = null;
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
  function select(path: string | null): void {
    if (activePath === path) return;
    activePath = path;
    for (const row of tree.querySelectorAll<HTMLElement>('[data-file]')) {
      row.classList.toggle('selected', row.dataset.file === path);
      row.setAttribute('aria-selected', String(row.dataset.file === path));
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
    button.setAttribute('aria-expanded', 'false');
    const children = document.createElement('div'); children.setAttribute('role', 'group'); children.hidden = true;
    node.append(children);
    let loaded = false;
    let loading = false;
    button.addEventListener('click', () => {
      const expanded = children.hidden;
      children.hidden = !expanded;
      button.setAttribute('aria-expanded', String(expanded));
      marker.textContent = expanded ? '▾' : '▸';
      if (!expanded || loaded || loading) return;
      loading = true; button.setAttribute('aria-busy', 'true');
      const pendingGeneration = generation;
      void call<FolderListing>('read_directory', { path: entry.path }).then(listing => {
        if (pendingGeneration !== generation || !node.isConnected) return;
        children.replaceChildren(...listing.entries.map(child => row(child, depth + 1)));
        if (!listing.entries.length) children.append(message('Empty folder', depth + 1));
        loaded = true;
      }).catch(error => {
        if (pendingGeneration !== generation || !node.isConnected) return;
        children.hidden = true; button.setAttribute('aria-expanded', 'false'); marker.textContent = '▸';
        reportError(error);
      }).finally(() => { loading = false; button.removeAttribute('aria-busy'); });
    });
    return node;
  }
  function message(text: string, depth = 0): HTMLElement {
    const node = document.createElement('div'); node.className = 'tree-message'; node.textContent = text;
    node.style.paddingLeft = `${10 + depth * 14}px`;
    return node;
  }
  function load(path: string, visible = true): Promise<void> {
    const request = ++generation;
    pendingRoot = call<FolderListing>('read_directory', { path }).then(listing => {
      if (request !== generation) return;
      rootPath = listing.path;
      title.textContent = listing.name; title.title = listing.path;
      tree.setAttribute('aria-label', listing.path);
      tree.replaceChildren(...listing.entries.map(entry => row(entry, 0)));
      if (!listing.entries.length) tree.append(message('Empty folder'));
      show(visible);
    });
    return pendingRoot;
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
  tree.addEventListener('keydown', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.tree-row');
    if (!button) return;
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
    refresh: async () => { if (rootPath) await load(rootPath); },
    toggle: async () => { if (!rootPath) await open(); else show(panel.hidden); },
    close: () => { ++generation; rootPath = undefined; tree.replaceChildren(); show(false); },
  };
}
