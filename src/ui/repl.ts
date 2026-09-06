// REPL panel.
import { Terminal } from '../terminal/terminal';

export class Repl {
  readonly el: HTMLDivElement;
  readonly term: Terminal;
  private input: HTMLInputElement;
  private ps: HTMLSpanElement;
  private history: string[] = [];
  private hIdx = 0;
  private busy = false;
  private continuation = false;

  constructor(private send: (line: string) => Promise<{ status: 'incomplete' | 'complete' | 'syntax-error'; value?: string; error?: string }>) {
    this.el = document.createElement('div');
    this.el.className = 'repl-wrap';
    this.term = new Terminal({ maxLines: 3000 });
    this.term.el.classList.add('repl-out');
    const line = document.createElement('div');
    line.className = 'repl-line';
    this.ps = document.createElement('span');
    this.ps.className = 'ps';
    this.ps.textContent = '>>> ';
    this.input = document.createElement('input');
    this.input.spellcheck = false;
    this.input.autocomplete = 'off';
    this.input.placeholder = 'Python expression or statement';
    line.append(this.ps, this.input);
    this.el.append(this.term.el, line);
    this.term.el.addEventListener('click', () => {
      if (!this.el.ownerDocument.getSelection()?.toString()) this.input.focus();
    });
    this.input.addEventListener('keydown', (e) => this.onKey(e));
  }

  focus(): void {
    this.input.focus();
  }

  setEnabled(on: boolean): void {
    this.input.disabled = !on;
    this.input.placeholder = on ? 'Python expression or statement' : 'Python is busy';
  }

  private async onKey(e: KeyboardEvent): Promise<void> {
    e.stopPropagation();
    if (e.key === 'ArrowUp') {
      if (this.hIdx > 0) this.input.value = this.history[--this.hIdx];
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowDown') {
      if (this.hIdx < this.history.length) this.input.value = this.history[++this.hIdx] ?? '';
      e.preventDefault();
      return;
    }
    if (e.key === 'l' && e.ctrlKey) {
      this.term.clear();
      e.preventDefault();
      return;
    }
    if (e.key !== 'Enter' || this.busy) return;
    e.preventDefault();
    const line = this.input.value;
    this.input.value = '';
    if (line.trim()) {
      this.history.push(line);
    }
    this.hIdx = this.history.length;
    this.term.write('stdout', `\x1b[32m${this.ps.textContent}\x1b[0m${line}\n`);
    this.busy = true;
    try {
      const r = await this.send(line);
      if (r.status === 'incomplete') {
        this.continuation = true;
        this.ps.textContent = '... ';
      } else {
        this.continuation = false;
        this.ps.textContent = '>>> ';
        if (r.error) this.term.write('stderr', r.error.endsWith('\n') ? r.error : r.error + '\n');
        else if (r.value) this.term.write('stdout', r.value + '\n');
      }
    } catch (err: any) {
      this.term.write('stderr', `${err?.message ?? err}\n`);
      this.ps.textContent = '>>> ';
    } finally {
      this.busy = false;
      this.input.focus();
    }
  }

  reset(): void {
    this.continuation = false;
    this.ps.textContent = '>>> ';
    this.busy = false;
  }
}
