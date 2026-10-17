import { invoke, isTauri } from '@tauri-apps/api/core';

export interface Info {
  id: number;
  path: string | null;
  name: string;
  size: number;
  revision: number;
  dirty: boolean;
  paged: boolean;
  bom: boolean;
  eol: 'LF' | 'CRLF';
}
export interface Page { text: string; start: number; end: number; info: Info }
export type OpenRequest =
  | { kind: 'file'; path: string; line: number | null; col: number | null }
  | { kind: 'folder'; path: string }
  | { kind: 'stdin'; path: string }
  | { kind: 'error'; message: string };
export interface FolderEntry { name: string; path: string; isDirectory: boolean; isSymlink: boolean }
export interface FolderListing { name: string; path: string; entries: FolderEntry[]; truncated: boolean; unsupportedNames: boolean }
export interface FolderView { path: string; visible: boolean }
export interface SearchScan {
  count: number; nextOffset: number | null; previousOffset: number | null;
  nextIndex: number | null; previousIndex: number | null;
  scannedThrough: number; complete: boolean; revision: number;
}

export interface ExternalChange { changed: boolean; token: string }
export interface QuickOpen { entries: FolderEntry[]; truncated: boolean; skippedDirectories: number }
export interface ReplaceResult { page: Page; count: number }
export interface TabView {
  id: number; name: string; pageStart: number; anchor: number; head: number;
  scrollTop: number; scrollLeft: number; languageOverride: string | null; indent?: string | null; tabSize?: number | null;
}
export interface RestoredTab { info: Info; view: TabView }
export interface RestoredSession { open: RestoredTab[]; closed: RestoredTab[]; activeIndex: number; secondaryIndex: number | null; folder: FolderView | null; errors: string[] }

export const desktop = isTauri();
// A scratch buffer in browser preview; file access always belongs to Rust.
const previews = new Map<number, Page>();
let nextPreview = 0;
export async function call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (desktop) return invoke<T>(command, args);
  if (command === 'new_document') {
    const id = ++nextPreview;
    const page: Page = { text: '', start: 0, end: 0, info: { id, name: 'Untitled', path: null, size: 0, revision: 0, dirty: false, paged: false, bom: false, eol: 'LF' } };
    previews.set(id, page);
    return page as T;
  }
  if (command === 'startup_paths') return [] as T;
  if (command === 'close_document') { previews.delete(Number(args.id)); return undefined as T; }
  throw new Error('File access requires the desktop app. Run npm run tauri dev.');
}
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}
