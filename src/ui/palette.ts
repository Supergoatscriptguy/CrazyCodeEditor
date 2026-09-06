// Command palette / quick open.
import { fuzzyScore } from '../util/fuzzy';

export interface PaletteItem {
  id: string;
  label: string;
  detail?: string;
  keys?: string;
  run: () => void;
}

export class Palette {
  private overlay: HTMLDivElement | null = null;

  constructor(private root: HTMLElement) {}

  get isOpen(): boolean {
    return this.overlay !== null;
  }

  close(): void {
    this.overlay?.remove();
    this.overlay = null;
  }

  open(items: PaletteItem[], opts: { placeholder?: string; initial?: string } = {}): void {
    this.close();
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    const box = document.createElement('div');
    box.className = 'palette';
    const input = document.createElement('input');
    input.placeholder = opts.placeholder ?? 'Type a command';
    input.spellcheck = false;
    input.value = opts.initial ?? '';
    const list = document.createElement('ul');
    box.append(input, list);
    overlay.appendChild(box);
    this.root.appendChild(overlay);
    this.overlay = overlay;

    let filtered: PaletteItem[] = [];
    let sel = 0;
    const render = () => {
      const q = input.value.trim();
      filtered = items
        .map((it) => ({ it, s: fuzzyScore(q, it.label) ?? (it.detail ? fuzzyScore(q, it.detail) : null) }))
        .filter((x) => x.s !== null)
        .sort((a, b) => b.s! - a.s!)
        .map((x) => x.it);
      sel = Math.min(sel, Math.max(0, filtered.length - 1));
      list.textContent = '';
      if (!filtered.length) {
        const none = document.createElement('div');
        none.className = 'none';
        none.textContent = 'No matches';
        list.appendChild(none);
        return;
      }
      filtered.slice(0, 200).forEach((it, i) => {
        const li = document.createElement('li');
        if (i === sel) li.classList.add('sel');
        const lbl = document.createElement('span');
        lbl.className = 'lbl';
        lbl.appendChild(highlight(it.label, q));
        li.appendChild(lbl);
        if (it.detail) {
          const d = document.createElement('span');
          d.className = 'det';
          d.textContent = it.detail;
          li.appendChild(d);
        }
        if (it.keys) {
          const k = document.createElement('span');
          k.className = 'keys';
          k.textContent = it.keys;
          li.appendChild(k);
        }
        li.onmousemove = () => {
          if (sel !== i) {
            sel = i;
            list.querySelectorAll('li').forEach((el, j) => el.classList.toggle('sel', j === sel));
          }
        };
        li.onclick = () => pick(i);
        list.appendChild(li);
      });
      list.querySelector('li.sel')?.scrollIntoView({ block: 'nearest' });
    };
    const pick = (i: number) => {
      const it = filtered[i];
      this.close();
      it?.run();
    };
    input.addEventListener('input', () => {
      sel = 0;
      render();
    });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'ArrowDown') {
        sel = Math.min(sel + 1, filtered.length - 1);
        render();
        e.preventDefault();
      } else if (e.key === 'ArrowUp') {
        sel = Math.max(sel - 1, 0);
        render();
        e.preventDefault();
      } else if (e.key === 'Enter') {
        pick(sel);
        e.preventDefault();
      } else if (e.key === 'Escape') {
        this.close();
        e.preventDefault();
      }
    });
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) this.close();
    });
    render();
    input.focus();
    input.select();
  }
}

function highlight(text: string, q: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  if (!q) {
    frag.textContent = text;
    return frag;
  }
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  let qi = 0;
  let run = '';
  for (let i = 0; i < text.length; i++) {
    if (qi < ql.length && lower[i] === ql[qi]) {
      if (run) frag.append(run);
      run = '';
      const b = document.createElement('b');
      b.textContent = text[i];
      frag.appendChild(b);
      qi++;
    } else run += text[i];
  }
  if (run) frag.append(run);
  return frag;
}
