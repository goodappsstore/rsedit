import { runScopeHandlers } from '@codemirror/view';
import type { EditorView, Panel } from '@codemirror/view';
import { closeSearchPanel, findNext, findPrevious, getSearchQuery, replaceAll, replaceNext, SearchQuery, selectMatches, setSearchQuery } from '@codemirror/search';

export function searchIcon(name: 'search' | 'replace' | 'up' | 'down' | 'close'): string {
  const paths = {
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
    replace: '<path d="M4 7h14m-4-4 4 4-4 4M20 17H6m4-4-4 4 4 4"/>',
    up: '<path d="m6 14 6-6 6 6"/>',
    down: '<path d="m6 10 6 6 6-6"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
  };
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}

export function createSearchPanel(view: EditorView): Panel {
  const dom = document.createElement('section');
  dom.className = 'cm-search find-panel';
  dom.setAttribute('aria-label', 'Find and replace');
  dom.innerHTML = `
    <header class="search-header">
      <span class="search-heading">${searchIcon('search')}<strong>Find & replace</strong></span>
      <span class="search-header-hint"><kbd>Enter</kbd> next <span class="search-shortcut"><kbd>⇧ Enter</kbd> previous</span></span>
      <span class="section-match-count match-count" role="status" aria-live="polite">Type to search</span>
      <button type="button" class="search-close" data-search="close" title="Close search (Escape)" aria-label="Close search">${searchIcon('close')}</button>
    </header>
    <div class="search-layout">
      <div class="search-field">
        <span class="search-field-icon">${searchIcon('search')}</span>
        <input name="search" main-field="true" aria-label="Find" placeholder="Find in file…" autocomplete="off" spellcheck="false" />
        <div class="search-options" role="group" aria-label="Search options">
          <label class="search-option" title="Match case" aria-label="Match case"><input type="checkbox" name="case" aria-label="Match case" /><span aria-hidden="true">Aa</span></label>
          <label class="search-option" title="Use regular expression" aria-label="Use regular expression"><input type="checkbox" name="re" aria-label="Use regular expression" /><span aria-hidden="true">.*</span></label>
          <label class="search-option" title="Match whole word" aria-label="Match whole word"><input type="checkbox" name="word" aria-label="Match whole word" /><span class="search-word" aria-hidden="true">ab</span></label>
        </div>
      </div>
      <div class="search-actions" role="group" aria-label="Navigate matches">
        <button type="button" class="search-arrow" data-search="previous" title="Previous match (Shift+Enter)" aria-label="Previous match">${searchIcon('up')}</button>
        <button type="button" class="search-arrow" data-search="next" title="Next match (Enter)" aria-label="Next match">${searchIcon('down')}</button>
        <button type="button" data-search="select">Select all</button>
      </div>
      <div class="search-field search-replacement">
        <span class="search-field-icon">${searchIcon('replace')}</span>
        <input name="replace" aria-label="Replace with" placeholder="Replace with…" autocomplete="off" spellcheck="false" />
      </div>
      <div class="search-actions search-replacement">
        <button type="button" data-search="replace">Replace</button>
        <button type="button" class="search-primary" data-search="replace-all">Replace all</button>
      </div>
    </div>
  `;
  const field = (name: string) => dom.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  const searchField = field('search'), replaceField = field('replace');
  const caseField = field('case'), reField = field('re'), wordField = field('word');
  const sync = () => {
    const query = getSearchQuery(view.state);
    // Avoid resetting the caret when an input event commits the same value.
    if (searchField.value !== query.search) searchField.value = query.search;
    if (replaceField.value !== query.replace) replaceField.value = query.replace;
    caseField.checked = query.caseSensitive;
    reField.checked = query.regexp;
    wordField.checked = query.wholeWord;
    searchField.setAttribute('aria-invalid', String(!!query.search && !query.valid));
    dom.dataset.query = String(!!query.search);
    dom.dataset.invalid = String(!!query.search && !query.valid);
    for (const element of dom.querySelectorAll<HTMLElement>('.search-replacement')) element.hidden = view.state.readOnly;
  };
  const commit = (event: Event) => {
    if (event instanceof InputEvent && event.isComposing) return;
    const query = new SearchQuery({
      search: searchField.value, replace: replaceField.value,
      caseSensitive: caseField.checked, regexp: reField.checked, wholeWord: wordField.checked,
      literal: getSearchQuery(view.state).literal,
    });
    if (!query.eq(getSearchQuery(view.state))) view.dispatch({ effects: setSearchQuery.of(query) });
  };
  dom.addEventListener('input', commit);
  dom.addEventListener('change', commit);
  dom.addEventListener('compositionend', commit);
  dom.addEventListener('click', event => {
    const action = (event.target as Element).closest<HTMLElement>('[data-search]')?.dataset.search;
    if (action === 'previous') findPrevious(view);
    if (action === 'next') findNext(view);
    if (action === 'select') selectMatches(view);
    if (action === 'replace') replaceNext(view);
    if (action === 'replace-all') replaceAll(view);
    if (action === 'close') { closeSearchPanel(view); view.focus(); }
  });
  dom.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (runScopeHandlers(view, event, 'search-panel')) event.preventDefault();
    else if (event.key === 'Enter' && event.target === searchField) {
      event.preventDefault();
      (event.shiftKey ? findPrevious : findNext)(view);
    } else if (event.key === 'Enter' && event.target === replaceField) {
      event.preventDefault();
      replaceNext(view);
    }
  });
  sync();
  return { dom, mount: () => { searchField.focus(); searchField.select(); }, update: sync };
}
