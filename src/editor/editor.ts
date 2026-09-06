// CodeMirror setup: keymap, completion, hover, lint, theme.
import { EditorState, Compartment, Prec, type Extension } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor,
  rectangularSelection, crosshairCursor, highlightSpecialChars, hoverTooltip, type Tooltip,
} from '@codemirror/view';
import {
  defaultKeymap, history, historyKeymap, indentWithTab, toggleComment, moveLineUp, moveLineDown, copyLineDown, copyLineUp,
  deleteLine, indentMore, indentLess,
} from '@codemirror/commands';
import { python } from '@codemirror/lang-python';
import { indentUnit, foldGutter, foldKeymap, bracketMatching, syntaxHighlighting, HighlightStyle, indentOnInput } from '@codemirror/language';
import {
  autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, snippet, startCompletion, acceptCompletion,
  type CompletionContext, type CompletionResult, type Completion,
} from '@codemirror/autocomplete';
import { linter, lintGutter, lintKeymap, type Diagnostic } from '@codemirror/lint';
import { search, searchKeymap, highlightSelectionMatches, openSearchPanel, selectNextOccurrence } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';
import { SNIPPETS } from './snippets';
import type { Settings } from '../app/settings';
import type { UiTheme } from '../app/themes';

export interface LspClient {
  complete(code: string, line: number, col: number, path: string): Promise<Array<{ name: string; type: string; kind: string; desc: string }>>;
  detail(code: string, line: number, col: number, path: string, name: string): Promise<{ sig: string; doc: string } | null>;
  hover(code: string, line: number, col: number, path: string): Promise<{ name: string; kind: string; desc: string; sig: string; doc: string; module: string } | null>;
  lint(code: string, path: string): Promise<Array<{ line: number; col: number; endLine?: number; endCol?: number; msg: string; severity: 'error' | 'warning' }>>;
  ready: boolean;
}

export interface EditorCommands {
  run(): void;
  save(): void;
  format(): void;
  gotoDefinition(): void;
}

export interface EditorEvents {
  onChange(path: string, text: string): void;
  onCursor(line: number, col: number): void;
  onDiagnostics(path: string, diags: Diagnostic[]): void;
}

export class Editor {
  readonly view: EditorView;
  private states = new Map<string, EditorState>();
  private themeC = new Compartment();
  private tabC = new Compartment();
  private wrapC = new Compartment();
  private completionC = new Compartment();
  private lintC = new Compartment();
  private path: string | null = null;
  private settings: Settings;

  constructor(
    parent: HTMLElement,
    private lsp: LspClient,
    private commands: EditorCommands,
    private events: EditorEvents,
    settings: Settings,
    theme: UiTheme,
  ) {
    this.settings = settings;
    this.view = new EditorView({ parent, state: this.makeState('', theme) });
  }

  get currentPath(): string | null {
    return this.path;
  }

  private baseExtensions(theme: UiTheme): Extension[] {
    const s = this.settings;
    return [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      python(),
      indentUnit.of('    '),
      this.tabC.of(EditorState.tabSize.of(s.tabSize)),
      this.wrapC.of(s.wordWrap ? EditorView.lineWrapping : []),
      this.completionC.of(this.completionExt(s.autocomplete)),
      this.lintC.of(this.lintExt(s.lint)),
      this.themeC.of(makeTheme(theme)),
      hoverTooltip((view, pos) => this.hover(view, pos), { hoverTime: 350 }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && this.path) this.events.onChange(this.path, u.state.doc.toString());
        if (u.selectionSet || u.docChanged) {
          const head = u.state.selection.main.head;
          const line = u.state.doc.lineAt(head);
          this.events.onCursor(line.number, head - line.from + 1);
        }
      }),
      Prec.highest(
        keymap.of([
          { key: 'Tab', run: acceptCompletion },
          { key: 'Mod-Enter', run: () => (this.commands.run(), true) },
          { key: 'F5', run: () => (this.commands.run(), true) },
          { key: 'Mod-s', run: () => (this.commands.save(), true) },
          { key: 'Shift-Alt-f', run: () => (this.commands.format(), true) },
          { key: 'F12', run: () => (this.commands.gotoDefinition(), true) },
          { key: 'Mod-/', run: toggleComment },
          { key: 'Alt-ArrowUp', run: moveLineUp },
          { key: 'Alt-ArrowDown', run: moveLineDown },
          { key: 'Shift-Alt-ArrowUp', run: copyLineUp },
          { key: 'Shift-Alt-ArrowDown', run: copyLineDown },
          { key: 'Mod-d', run: selectNextOccurrence },
          { key: 'Shift-Mod-k', run: deleteLine },
          { key: 'Mod-]', run: indentMore },
          { key: 'Mod-[', run: indentLess },
          { key: 'Mod-Space', run: startCompletion },
          { key: 'Mod-f', run: openSearchPanel },
        ]),
      ),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, ...lintKeymap, indentWithTab]),
    ];
  }

  private makeState(doc: string, theme: UiTheme): EditorState {
    return EditorState.create({ doc, extensions: this.baseExtensions(theme) });
  }

  // documents
  open(path: string, text: string, theme: UiTheme, cursor?: number): void {
    if (this.path) this.states.set(this.path, this.view.state);
    let state = this.states.get(path);
    if (!state || state.doc.toString() !== text) state = this.makeState(text, theme);
    this.path = path;
    this.view.setState(state);
    if (cursor !== undefined && cursor <= state.doc.length) {
      this.view.dispatch({ selection: { anchor: cursor }, scrollIntoView: true });
    }
    this.view.focus();
  }

  forget(path: string): void {
    this.states.delete(path);
  }

  renamePath(from: string, to: string): void {
    const s = this.states.get(from);
    if (s) {
      this.states.delete(from);
      this.states.set(to, s);
    }
    if (this.path === from) this.path = to;
  }

  clear(): void {
    this.path = null;
    this.view.setState(this.makeState('', this.currentTheme));
  }

  private currentTheme!: UiTheme;

  get text(): string {
    return this.view.state.doc.toString();
  }

  setText(text: string): void {
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text } });
  }

  /** Replaces the document while keeping the cursor on the same line. */
  replaceAll(text: string): void {
    const state = this.view.state;
    const head = state.selection.main.head;
    const lineNo = state.doc.lineAt(head).number;
    this.view.dispatch({ changes: { from: 0, to: state.doc.length, insert: text } });
    const doc = this.view.state.doc;
    const line = doc.line(Math.min(lineNo, doc.lines));
    this.view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
  }

  gotoLine(line: number, col = 1): void {
    const doc = this.view.state.doc;
    const l = doc.line(Math.max(1, Math.min(line, doc.lines)));
    const pos = Math.min(l.from + Math.max(0, col - 1), l.to);
    this.view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    this.view.focus();
  }

  get cursorOffset(): number {
    return this.view.state.selection.main.head;
  }

  get cursorLineCol(): { line: number; col: number } {
    const head = this.view.state.selection.main.head;
    const line = this.view.state.doc.lineAt(head);
    return { line: line.number, col: head - line.from };
  }

  focus(): void {
    this.view.focus();
  }

  // settings
  applySettings(s: Settings, theme: UiTheme): void {
    this.settings = s;
    this.currentTheme = theme;
    this.view.dispatch({
      effects: [
        this.tabC.reconfigure(EditorState.tabSize.of(s.tabSize)),
        this.wrapC.reconfigure(s.wordWrap ? EditorView.lineWrapping : []),
        this.completionC.reconfigure(this.completionExt(s.autocomplete)),
        this.lintC.reconfigure(this.lintExt(s.lint)),
        this.themeC.reconfigure(makeTheme(theme)),
      ],
    });
    // Cached states of other tabs are rebuilt lazily on open.
    this.states.clear();
  }

  // completion
  private completionExt(mode: Settings['autocomplete']): Extension {
    return autocompletion({
      activateOnTyping: mode !== 'off',
      override: [(ctx) => this.completeSnippets(ctx, mode), (ctx) => this.completeJedi(ctx, mode)],
      icons: true,
      selectOnOpen: true,
      maxRenderedOptions: 60,
      defaultKeymap: true,
    });
  }

  private completeSnippets(ctx: CompletionContext, mode: Settings['autocomplete']): CompletionResult | null {
    const word = ctx.matchBefore(/\w+/);
    if (!word) return null;
    if (mode === 'dot' && !ctx.explicit) return null;
    const before = ctx.state.doc.sliceString(Math.max(0, word.from - 1), word.from);
    if (before === '.') return null; // member access: names only
    return { from: word.from, options: SNIPPETS, validFor: /^\w*$/ };
  }

  private async completeJedi(ctx: CompletionContext, mode: Settings['autocomplete']): Promise<CompletionResult | null> {
    if (!this.lsp.ready || !this.path) return null;
    const word = ctx.matchBefore(/\w*/);
    const from = word ? word.from : ctx.pos;
    const afterDot = ctx.state.doc.sliceString(Math.max(0, from - 1), from) === '.';
    if (!ctx.explicit) {
      if (mode === 'dot' && !afterDot) return null;
      if (!afterDot && (!word || word.text.length < 1)) return null;
    }
    // Skip inside strings and comments.
    const lineText = ctx.state.doc.lineAt(ctx.pos).text;
    const upToCursor = lineText.slice(0, ctx.pos - ctx.state.doc.lineAt(ctx.pos).from);
    if (/#/.test(upToCursor.replace(/(["'])(?:\\.|(?!\1).)*\1/g, ''))) return null;
    const quotes = (upToCursor.match(/["']/g) ?? []).length;
    if (quotes % 2 === 1 && !afterDot) return null;

    const code = ctx.state.doc.toString();
    const line = ctx.state.doc.lineAt(ctx.pos);
    const path = this.path;
    let items: Awaited<ReturnType<LspClient['complete']>>;
    try {
      items = await this.lsp.complete(code, line.number, ctx.pos - line.from, path);
    } catch {
      return null;
    }
    if (ctx.aborted) return null;
    const next = ctx.state.doc.sliceString(ctx.pos, ctx.pos + 1);
    const options: Completion[] = [];
    for (const it of items) {
      if (it.kind === 'keyword') continue; // provided by snippets
      const callable = (it.kind === 'function' || it.kind === 'class') && next !== '(';
      options.push({
        label: it.name,
        type: it.type,
        detail: it.kind === 'module' ? 'module' : it.desc && it.desc !== it.name ? shorten(it.desc, 40) : undefined,
        apply: callable ? snippet(`${it.name}(\${})`) : undefined,
        info: () => this.completionInfo(code, line.number, ctx.pos - line.from, path, it.name),
      });
    }
    return { from, options, validFor: /^\w*$/ };
  }

  private async completionInfo(code: string, line: number, col: number, path: string, name: string): Promise<Node | null> {
    try {
      const d = await this.lsp.detail(code, line, col, path, name);
      if (!d || (!d.sig && !d.doc)) return null;
      const el = document.createElement('div');
      el.className = 'cm-doc';
      if (d.sig) {
        const sig = document.createElement('div');
        sig.className = 'cm-doc-sig';
        sig.textContent = d.sig;
        el.appendChild(sig);
      }
      if (d.doc) {
        const doc = document.createElement('pre');
        doc.className = 'cm-doc-body';
        doc.textContent = d.doc;
        el.appendChild(doc);
      }
      return el;
    } catch {
      return null;
    }
  }

  // hover
  private async hover(view: EditorView, pos: number): Promise<Tooltip | null> {
    if (!this.lsp.ready || !this.path) return null;
    const word = view.state.wordAt(pos);
    if (!word) return null;
    const line = view.state.doc.lineAt(pos);
    let h: Awaited<ReturnType<LspClient['hover']>>;
    try {
      h = await this.lsp.hover(view.state.doc.toString(), line.number, pos - line.from, this.path);
    } catch {
      return null;
    }
    if (!h || (!h.sig && !h.doc && !h.desc)) return null;
    return {
      pos: word.from,
      end: word.to,
      above: true,
      create: () => {
        const dom = document.createElement('div');
        dom.className = 'cm-doc cm-hover';
        const head = document.createElement('div');
        head.className = 'cm-doc-sig';
        head.textContent = h!.sig || h!.desc || h!.name;
        dom.appendChild(head);
        if (h!.module && h!.module !== '__main__') {
          const m = document.createElement('div');
          m.className = 'cm-doc-module';
          m.textContent = `${h!.kind} · ${h!.module}`;
          dom.appendChild(m);
        }
        if (h!.doc) {
          const body = document.createElement('pre');
          body.className = 'cm-doc-body';
          body.textContent = h!.doc;
          dom.appendChild(body);
        }
        return { dom };
      },
    };
  }

  // lint
  private lintExt(enabled: boolean): Extension {
    if (!enabled) return [];
    return [
      linter(
        async (view) => {
          if (!this.lsp.ready || !this.path) return [];
          const code = view.state.doc.toString();
          let items: Awaited<ReturnType<LspClient['lint']>>;
          try {
            items = await this.lsp.lint(code, this.path);
          } catch {
            return [];
          }
          const doc = view.state.doc;
          const diags: Diagnostic[] = [];
          for (const d of items) {
            if (d.line < 1 || d.line > doc.lines) continue;
            const line = doc.line(d.line);
            const from = Math.min(line.from + d.col, line.to);
            let to: number;
            if (d.endLine && d.endCol !== undefined && d.endLine <= doc.lines) {
              const el = doc.line(d.endLine);
              to = Math.min(el.from + d.endCol, el.to);
            } else {
              const rest = line.text.slice(d.col);
              const m = rest.match(/^\w+/);
              to = from + (m ? m[0].length : Math.max(1, rest.length));
            }
            if (to <= from) to = Math.min(from + 1, line.to);
            diags.push({ from, to, severity: d.severity, message: d.msg });
          }
          if (this.path) this.events.onDiagnostics(this.path, diags);
          return diags;
        },
        { delay: 500 },
      ),
      lintGutter(),
    ];
  }
}

function shorten(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// theme
export function makeTheme(th: UiTheme): Extension {
  const c = th.c;
  const s = th.s;
  const view = EditorView.theme(
    {
      '&': { color: c.fg, backgroundColor: c.bg, height: '100%' },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': { fontFamily: 'var(--mono)', fontSize: 'var(--editor-font-size)', lineHeight: '1.5' },
      '.cm-content': { caretColor: c.cursor, padding: '6px 0 6px 6px' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: c.cursor },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: c.selection },
      '.cm-activeLine': { backgroundColor: c.lineHighlight },
      '.cm-activeLineGutter': { backgroundColor: c.lineHighlight },
      // hairline where the code starts
      '.cm-gutters': { backgroundColor: c.bg, color: c.gutter, border: 'none', borderRight: `1px solid ${c.border}` },
      '.cm-gutter.cm-lineNumbers': { minWidth: '32px' },
      '.cm-lineNumbers .cm-gutterElement': { padding: '0 6px 0 10px', minWidth: '28px' },
      '.cm-foldGutter .cm-gutterElement': { padding: '0 4px' },
      '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: c.matchingBracket, outline: 'none' },
      '.cm-selectionMatch': { backgroundColor: c.selection + '80' },
      '.cm-searchMatch': { backgroundColor: c.warning + '55', outline: `1px solid ${c.warning}` },
      '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: c.accent + '80' },
      '.cm-panels': { backgroundColor: c.bgBar, color: c.fg, borderBottom: `1px solid ${c.border}` },
      '.cm-panel input, .cm-panel button, .cm-panel select': { background: c.bg, color: c.fg, border: `1px solid ${c.border}`, borderRadius: '3px', font: 'inherit' },
      '.cm-panel button': { cursor: 'pointer' },
      '.cm-panel.cm-search label': { marginRight: '8px' },
      '.cm-tooltip': { backgroundColor: c.bgAlt, color: c.fg, border: `1px solid ${c.border}`, borderRadius: '4px', boxShadow: '0 4px 16px rgba(0,0,0,.35)' },
      '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--mono)', fontSize: 'var(--editor-font-size)', maxHeight: '300px' },
      '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '2px 8px' },
      '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: c.accent, color: c.accentFg },
      '.cm-tooltip.cm-completionInfo': { padding: '8px', maxWidth: '480px', maxHeight: '320px', overflow: 'auto' },
      '.cm-completionDetail': { color: c.fgMuted, fontStyle: 'normal', marginLeft: '8px' },
      '.cm-completionIcon': { width: '1.2em', opacity: '.8' },
      '.cm-tooltip-lint': { padding: '4px 8px' },
      '.cm-diagnostic-error': { borderLeftColor: c.error },
      '.cm-diagnostic-warning': { borderLeftColor: c.warning },
      '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: `underline wavy ${c.error}`, textUnderlineOffset: '3px' },
      '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: `underline wavy ${c.warning}`, textUnderlineOffset: '3px' },
      '.cm-lint-marker-error': { content: 'none' },
      '.cm-snippetField': { backgroundColor: c.accent + '33', outline: `1px solid ${c.accent}66` },
      '.cm-doc-sig': { fontFamily: 'var(--mono)', fontWeight: '600', marginBottom: '4px', whiteSpace: 'pre-wrap' },
      '.cm-doc-module': { color: c.fgMuted, fontSize: '11px', marginBottom: '4px' },
      '.cm-doc-body': { margin: '0', fontFamily: 'var(--mono)', fontSize: '12px', whiteSpace: 'pre-wrap', color: c.fg, opacity: '.9', maxHeight: '240px', overflow: 'auto' },
      '.cm-hover': { padding: '8px', maxWidth: '520px' },
    },
    { dark: th.dark },
  );
  const highlight = HighlightStyle.define([
    { tag: [t.keyword, t.modifier, t.definitionKeyword, t.operatorKeyword], color: s.keyword },
    { tag: [t.controlKeyword, t.moduleKeyword], color: s.control },
    { tag: [t.string, t.special(t.string)], color: s.string },
    { tag: [t.number, t.integer, t.float], color: s.number },
    { tag: [t.comment, t.lineComment, t.blockComment, t.docString], color: s.comment, fontStyle: 'italic' },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: s.function },
    { tag: [t.definition(t.variableName)], color: s.function },
    { tag: [t.className, t.definition(t.className), t.typeName], color: s.className },
    { tag: [t.variableName, t.propertyName, t.attributeName], color: s.variable },
    { tag: [t.standard(t.variableName)], color: s.builtin },
    { tag: [t.operator, t.punctuation, t.bracket], color: s.operator },
    { tag: [t.meta, t.annotation], color: s.decorator },
    { tag: [t.bool, t.null, t.atom, t.constant(t.variableName)], color: s.constant },
    { tag: t.self, color: s.self, fontStyle: 'italic' },
    { tag: t.invalid, color: c.error },
    { tag: t.escape, color: s.constant },
  ]);
  return [view, syntaxHighlighting(highlight)];
}
