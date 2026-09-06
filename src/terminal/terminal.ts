// Terminal view: ANSI colors, inline input, clickable tracebacks.
import { AnsiParser, type AnsiEvent, type Style } from './ansi';

export interface TerminalOptions {
  maxLines?: number;
  onLink?(path: string, line: number): void;
  onInterrupt?(): void;
}

const TRACEBACK_RE = /File "([^"]+)", line (\d+)/g;

export class Terminal {
  readonly el: HTMLDivElement;
  private linesEl: HTMLDivElement;
  private current: HTMLDivElement | null = null;
  private crPending = false;
  private parser = new AnsiParser();
  private stderrParser = new AnsiParser();
  private queue: Array<{ stream: 'stdout' | 'stderr' | 'system' | 'input'; text: string }> = [];
  private raf = 0;
  private maxLines: number;
  private inputEl: HTMLInputElement | null = null;
  private inputResolve: ((s: string | null) => void) | null = null;
  private history: string[] = [];
  private historyIdx = -1;
  private lineCount = 0;

  constructor(private opts: TerminalOptions = {}) {
    this.maxLines = opts.maxLines ?? 5000;
    this.el = document.createElement('div');
    this.el.className = 'term';
    this.el.tabIndex = 0;
    this.linesEl = document.createElement('div');
    this.linesEl.className = 'term-lines';
    this.el.appendChild(this.linesEl);
    this.el.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest?.('.term-link') as HTMLElement | null;
      if (a && this.opts.onLink) {
        e.preventDefault();
        this.opts.onLink(a.dataset.path!, parseInt(a.dataset.line!, 10));
        return;
      }
      if (this.inputEl && !this.el.ownerDocument.getSelection()?.toString()) this.inputEl.focus();
    });
    this.el.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 'c' && !this.el.ownerDocument.getSelection()?.toString()) {
        this.opts.onInterrupt?.();
        e.preventDefault();
      }
    });
  }

  write(stream: 'stdout' | 'stderr', text: string): void {
    this.queue.push({ stream, text });
    this.schedule();
  }

  /** Inline image (e.g. a matplotlib figure) on its own line. */
  image(png: ArrayBuffer): void {
    this.flush();
    this.endLine();
    const line = this.newLine();
    line.classList.add('term-img-line');
    const img = this.el.ownerDocument.createElement('img');
    img.className = 'term-img';
    img.alt = 'figure';
    img.src = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
    img.title = 'Click to toggle full size';
    img.onclick = () => img.classList.toggle('full');
    line.appendChild(img);
    this.endLine();
    img.onload = () => {
      if (this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < img.height + 60) this.el.scrollTop = this.el.scrollHeight;
    };
    this.trim();
  }

  /** Dim informational line, e.g. run markers. */
  system(text: string): void {
    this.queue.push({ stream: 'system', text });
    this.schedule();
  }

  clear(): void {
    this.queue = [];
    for (const img of this.linesEl.querySelectorAll('img.term-img')) URL.revokeObjectURL((img as HTMLImageElement).src);
    this.linesEl.textContent = '';
    this.current = null;
    this.lineCount = 0;
    this.parser.reset();
    this.stderrParser.reset();
  }

  get text(): string {
    return this.linesEl.innerText;
  }

  focus(): void {
    (this.inputEl ?? this.el).focus();
  }

  private schedule(): void {
    // setTimeout, not rAF: rAF doesn't fire in hidden windows
    if (this.raf) return;
    this.raf = window.setTimeout(() => {
      this.raf = 0;
      this.flush();
    }, 8);
  }

  private flush(): void {
    const atBottom = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 40;
    const q = this.queue;
    this.queue = [];
    for (const item of q) {
      if (item.stream === 'system') {
        this.endLine();
        const line = this.newLine();
        line.classList.add('term-system');
        line.textContent = item.text;
        this.endLine();
        continue;
      }
      if (item.stream === 'input') {
        const line = this.ensureLine();
        const span = document.createElement('span');
        span.className = 'term-echo';
        span.textContent = item.text;
        line.appendChild(span);
        this.endLine();
        continue;
      }
      const parser = item.stream === 'stderr' ? this.stderrParser : this.parser;
      parser.parse(item.text, (e) => this.apply(e, item.stream as 'stdout' | 'stderr'));
    }
    this.trim();
    if (atBottom) this.el.scrollTop = this.el.scrollHeight;
  }

  private apply(e: AnsiEvent, stream: 'stdout' | 'stderr'): void {
    switch (e.type) {
      case 'text': {
        const line = this.ensureLine();
        if (this.crPending) {
          line.textContent = '';
          this.crPending = false;
        }
        line.appendChild(this.span(e.text, e.style, stream));
        break;
      }
      case 'newline':
        this.ensureLine();
        this.endLine();
        break;
      case 'cr':
        this.crPending = true;
        break;
      case 'backspace': {
        const line = this.ensureLine();
        const last = line.lastChild;
        if (last && last.textContent) {
          last.textContent = last.textContent.slice(0, -1);
          if (!last.textContent) last.remove();
        }
        break;
      }
      case 'clearLine':
        if (this.current) this.current.textContent = '';
        break;
      case 'clearScreen':
        this.clear();
        break;
    }
  }

  private span(text: string, st: Style, stream: 'stdout' | 'stderr'): HTMLElement {
    const s = document.createElement('span');
    s.textContent = text;
    if (stream === 'stderr') s.classList.add('term-stderr');
    let fg = st.fg;
    let bg = st.bg;
    if (st.inverse) [fg, bg] = [bg ?? 'var(--t-fg)', fg ?? 'var(--t-bg)'];
    if (fg) s.style.color = fg.startsWith('a') ? `var(--t-${fg})` : fg;
    if (bg) s.style.backgroundColor = bg.startsWith('a') ? `var(--t-${bg})` : bg;
    if (st.bold) s.style.fontWeight = 'bold';
    if (st.dim) s.style.opacity = '0.6';
    if (st.italic) s.style.fontStyle = 'italic';
    if (st.underline) s.style.textDecoration = 'underline';
    if (st.strike) s.style.textDecoration = (s.style.textDecoration ? s.style.textDecoration + ' ' : '') + 'line-through';
    return s;
  }

  private ensureLine(): HTMLDivElement {
    if (!this.current) this.current = this.newLine();
    return this.current;
  }

  private newLine(): HTMLDivElement {
    const line = document.createElement('div');
    line.className = 'term-line';
    this.linesEl.appendChild(line);
    this.lineCount++;
    return line;
  }

  private endLine(): void {
    if (!this.current) return;
    this.linkify(this.current);
    this.current = null;
    this.crPending = false;
  }

  private linkify(line: HTMLDivElement): void {
    const text = line.textContent ?? '';
    if (!text.includes('File "')) return;
    TRACEBACK_RE.lastIndex = 0;
    const m = TRACEBACK_RE.exec(text);
    if (!m) return;
    const path = m[1];
    if (path.startsWith('/lib/') || path.startsWith('<')) return;
    line.classList.add('term-has-link');
    line.dataset.path = path;
    const a = document.createElement('span');
    a.className = 'term-link';
    a.dataset.path = path.replace(/^\/workspace\//, '');
    a.dataset.line = m[2];
    a.title = 'Open in editor';
    a.textContent = ' ↗';
    line.appendChild(a);
  }

  private trim(): void {
    while (this.lineCount > this.maxLines && this.linesEl.firstChild) {
      this.linesEl.removeChild(this.linesEl.firstChild);
      this.lineCount--;
    }
  }

  /** Shows an inline input on the current line. Resolves with the line, or null if cancelled. */
  readLine(): Promise<string | null> {
    this.flush();
    this.cancelInput();
    const line = this.ensureLine();
    const input = document.createElement('input');
    input.className = 'term-input';
    input.spellcheck = false;
    input.autocomplete = 'off';
    line.appendChild(input);
    this.inputEl = input;
    this.historyIdx = this.history.length;
    this.el.scrollTop = this.el.scrollHeight;
    input.focus();
    return new Promise((resolve) => {
      this.inputResolve = resolve;
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          const value = input.value;
          if (value) this.history.push(value);
          this.finishInput(value);
        } else if (e.key === 'ArrowUp') {
          if (this.historyIdx > 0) input.value = this.history[--this.historyIdx] ?? '';
          e.preventDefault();
        } else if (e.key === 'ArrowDown') {
          if (this.historyIdx < this.history.length) input.value = this.history[++this.historyIdx] ?? '';
          e.preventDefault();
        } else if (e.key === 'c' && e.ctrlKey) {
          this.finishInput(null);
          this.opts.onInterrupt?.();
        } else if (e.key === 'd' && e.ctrlKey) {
          this.finishInput(null);
        }
      });
    });
  }

  private finishInput(value: string | null): void {
    const input = this.inputEl;
    const resolve = this.inputResolve;
    this.inputEl = null;
    this.inputResolve = null;
    if (input) {
      const echo = document.createElement('span');
      echo.className = 'term-echo';
      echo.textContent = value ?? '^D';
      input.replaceWith(echo);
    }
    this.endLine();
    resolve?.(value);
  }

  cancelInput(): void {
    if (this.inputEl) this.finishInput(null);
  }

  get waitingForInput(): boolean {
    return this.inputEl !== null;
  }
}
