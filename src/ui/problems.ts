import type { Diagnostic } from '@codemirror/lint';
import { icon } from './icons';

export interface Problem {
  path: string;
  line: number;
  col: number;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
}

export class ProblemsView {
  readonly el: HTMLDivElement;
  private byFile = new Map<string, Problem[]>();

  constructor(private goto: (path: string, line: number, col: number) => void) {
    this.el = document.createElement('div');
    this.el.className = 'problems';
    this.render();
  }

  set(path: string, diags: Diagnostic[], docLineAt: (pos: number) => { line: number; col: number }): void {
    const list = diags.map((d) => {
      const lc = docLineAt(d.from);
      return { path, line: lc.line, col: lc.col, severity: d.severity, message: d.message } as Problem;
    });
    if (list.length) this.byFile.set(path, list);
    else this.byFile.delete(path);
    this.render();
  }

  remove(path: string): void {
    this.byFile.delete(path);
    this.render();
  }

  counts(): { errors: number; warnings: number } {
    let errors = 0;
    let warnings = 0;
    for (const list of this.byFile.values()) for (const p of list) p.severity === 'error' ? errors++ : warnings++;
    return { errors, warnings };
  }

  private render(): void {
    this.el.textContent = '';
    if (!this.byFile.size) {
      const e = document.createElement('div');
      e.className = 'prob-empty';
      e.textContent = 'No problems detected.';
      this.el.appendChild(e);
      return;
    }
    for (const [path, list] of [...this.byFile].sort()) {
      const head = document.createElement('div');
      head.className = 'prob-file';
      head.textContent = `${path}  (${list.length})`;
      this.el.appendChild(head);
      for (const p of list) {
        const row = document.createElement('div');
        row.className = `prob-row ${p.severity}`;
        row.appendChild(icon(p.severity === 'error' ? 'error' : 'warning'));
        const msg = document.createElement('span');
        msg.textContent = p.message;
        row.appendChild(msg);
        const pos = document.createElement('span');
        pos.className = 'pos';
        pos.textContent = `Ln ${p.line}, Col ${p.col}`;
        row.appendChild(pos);
        row.onclick = () => this.goto(p.path, p.line, p.col);
        this.el.appendChild(row);
      }
    }
  }
}
