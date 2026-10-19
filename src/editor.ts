import { Compartment, EditorState, Prec, StateEffect, StateField } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { Decoration, EditorView, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, rectangularSelection, placeholder } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, indentOnInput, indentUnit, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { search, searchKeymap, highlightSelectionMatches, searchPanelOpen } from '@codemirror/search';
import { tags } from '@lezer/highlight';
import type { Page } from './api';

export const languageSlot = new Compartment();
export const wrapSlot = new Compartment();
export const panelSlot = new Compartment();
export const indentSlot = new Compartment();
const selectionMatchesSlot = new Compartment();
// drawSelection paints behind syntax-colored text. Give every selected range
// a readable foreground, including secondary and rectangular selections.
const selectedText = Decoration.mark({ class: 'cm-selectedText' });
function selectionDecorations(state: EditorState): DecorationSet {
  return Decoration.set(state.selection.ranges
    .filter(range => !range.empty)
    .map(range => selectedText.range(range.from, range.to)));
}
const selectedTextField = StateField.define<DecorationSet>({
  create: selectionDecorations,
  update(decorations, transaction) {
    return transaction.docChanged || transaction.selection
      ? selectionDecorations(transaction.state) : decorations;
  },
  provide: field => EditorView.outerDecorations.from(field),
});
export const currentMatch = StateEffect.define<{ from: number; to: number } | null>();
const matchField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(matches, transaction) {
    if (transaction.docChanged) matches = Decoration.none;
    for (const effect of transaction.effects) if (effect.is(currentMatch)) {
      matches = effect.value ? Decoration.set([Decoration.mark({ class: 'cm-searchMatch cm-searchMatch-selected' }).range(effect.value.from, effect.value.to)]) : Decoration.none;
    }
    return matches;
  },
  provide: field => EditorView.decorations.from(field),
});
// Default styles first: they cover tags the custom rules below don't define
// (markdown headings, emphasis, links, ...). A separate fallback highlighter
// only applies when no other highlighter is registered, so the specs must be
// merged here; later rules win for tags defined in both lists.
const colors = HighlightStyle.define([
  ...defaultHighlightStyle.specs,
  { tag: tags.keyword, color: 'var(--syntax-keyword)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--syntax-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--syntax-number)' },
  { tag: tags.comment, color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--syntax-function)' },
  { tag: [tags.typeName, tags.className], color: 'var(--syntax-type)' },
  { tag: [tags.tagName, tags.attributeName], color: 'var(--syntax-operator)' },
  { tag: tags.operator, color: 'var(--syntax-operator)' },
]);
const theme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--font-size, 14px)', backgroundColor: 'var(--editor)', color: 'var(--text)' },
  '.cm-scroller': { overflow: 'auto', fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace", lineHeight: '1.65' },
  '.cm-content': { padding: '14px 0', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0 20px 0 12px' },
  '.cm-gutters': { backgroundColor: 'var(--editor)', color: 'var(--muted)', border: 'none', padding: '0 6px 0 12px' },
  '.cm-activeLineGutter, .cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--selection)' },
  '::selection': { backgroundColor: 'var(--selection)', color: 'var(--selection-text)' },
  '.cm-content .cm-selectedText, .cm-content .cm-selectedText *': { color: 'var(--selection-text)', backgroundColor: 'transparent' },
  '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--text)', borderColor: 'var(--border)' },
  '.cm-search': { padding: '10px 14px' },
  '.cm-search label': { marginLeft: '8px' },
  '.cm-textfield': { backgroundColor: 'var(--editor)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: '4px', padding: '5px 7px' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--raised)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: '4px', padding: '4px 8px' },
  '.cm-searchMatch': { backgroundColor: '#d5a55b35' },
  '.cm-searchMatch-selected': { backgroundColor: '#d5a55b80', outline: '1px solid var(--accent)', borderRadius: '2px' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--raised)', borderColor: 'var(--border)', color: 'var(--muted)' },
  '.cm-tooltip': { backgroundColor: 'var(--panel)', borderColor: 'var(--border)', color: 'var(--text)' },
  '&.cm-focused': { outline: 'none' },
});

export interface EditorOptions {
  wrap: boolean;
  indent: string;
  tabSize: number;
  changed: (update: ViewUpdate) => void;
  shortcuts: Extension;
}
export function makeState(page: Page, options: EditorOptions): EditorState {
  return EditorState.create({
    doc: page.text,
    extensions: [
      // Tauri gives the boot style a nonce in packaged builds. Reuse it for
      // CodeMirror's generated styles; CSP ignores unsafe-inline with a nonce.
      EditorView.cspNonce.of(document.querySelector<HTMLStyleElement>('style[nonce]')?.nonce ?? ''),
      theme, matchField, lineNumbers(), highlightSpecialChars(), history({ minDepth: 100 }),
      drawSelection(), selectedTextField, dropCursor(), rectangularSelection(),
      highlightActiveLine(), highlightActiveLineGutter(),
      EditorState.allowMultipleSelections.of(true),
      // CodeMirror represents lines internally; sliceDoc restores this separator.
      EditorState.lineSeparator.of(page.info.eol === 'CRLF' ? '\r\n' : '\n'),
      languageSlot.of([]), wrapSlot.of(options.wrap ? EditorView.lineWrapping : []),
      indentSlot.of([indentUnit.of(options.indent), EditorState.tabSize.of(options.tabSize)]),
      syntaxHighlighting(colors),
      ...(page.info.paged ? [] : [
        bracketMatching(), closeBrackets(), indentOnInput(), foldGutter(),
        selectionMatchesSlot.of(highlightSelectionMatches()),
        // Selection highlights ignore search options and can outlive a search query.
        // Let the search query alone determine highlights while its panel is open.
        EditorState.transactionExtender.of(transaction => {
          const open = searchPanelOpen(transaction.state);
          return open === searchPanelOpen(transaction.startState) ? null
            : { effects: selectionMatchesSlot.reconfigure(open ? [] : highlightSelectionMatches()) };
        }),
      ]),
      panelSlot.of([]),
      search({ top: false, scrollToMatch: range => EditorView.scrollIntoView(range, { x: 'center', y: 'center', xMargin: 32, yMargin: 40 }) }),
      Prec.highest(options.shortcuts),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...foldKeymap, ...searchKeymap, indentWithTab]),
      placeholder('Start typing, or open a file.'),
      EditorView.updateListener.of(options.changed),
      EditorView.contentAttributes.of({ 'aria-label': 'Text editor', spellcheck: 'false' }),
    ],
  });
}
export async function detectLanguage(path: string): Promise<{ name: string; extension: Extension }> {
  const { languages } = await import('@codemirror/language-data');
  const { LanguageDescription } = await import('@codemirror/language');
  const match = LanguageDescription.matchFilename(languages, path);
  if (!match) return { name: 'Plain text', extension: [] };
  return { name: match.name, extension: await match.load() };
}
