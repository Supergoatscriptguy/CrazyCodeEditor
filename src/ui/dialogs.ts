// Modal dialogs and toasts. (window.prompt may be disabled by the host.)

export class Dialogs {
  private toasts: HTMLDivElement;
  private openCount = 0;

  constructor(private root: HTMLElement) {
    this.toasts = document.createElement('div');
    this.toasts.className = 'toasts';
    root.appendChild(this.toasts);
  }

  get isOpen(): boolean {
    return this.openCount > 0;
  }

  private overlay(): { overlay: HTMLDivElement; card: HTMLDivElement; close: () => void } {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    const card = document.createElement('div');
    card.className = 'card';
    overlay.appendChild(card);
    this.root.appendChild(overlay);
    this.openCount++;
    const close = () => {
      overlay.remove();
      this.openCount--;
    };
    return { overlay, card, close };
  }

  prompt(title: string, opts: { message?: string; value?: string; placeholder?: string; ok?: string; validate?: (v: string) => string | null; selectRange?: [number, number] } = {}): Promise<string | null> {
    return new Promise((resolve) => {
      const { card, close } = this.overlay();
      card.innerHTML = `<div class="card-head"></div><div class="card-body"><div class="dialog-msg"></div><input class="dialog-input" type="text" spellcheck="false"><div class="dialog-err"></div></div><div class="card-foot"><button class="btn cancel">Cancel</button><button class="btn primary ok"></button></div>`;
      card.querySelector('.card-head')!.textContent = title;
      card.querySelector('.dialog-msg')!.textContent = opts.message ?? '';
      const input = card.querySelector('input')!;
      const err = card.querySelector('.dialog-err')!;
      const ok = card.querySelector('.ok') as HTMLButtonElement;
      ok.textContent = opts.ok ?? 'OK';
      input.value = opts.value ?? '';
      input.placeholder = opts.placeholder ?? '';
      const finish = (v: string | null) => {
        close();
        resolve(v);
      };
      const submit = () => {
        const v = input.value.trim();
        const problem = opts.validate ? opts.validate(v) : v ? null : 'Enter a value';
        if (problem) {
          err.textContent = problem;
          input.focus();
          return;
        }
        finish(v);
      };
      input.addEventListener('input', () => (err.textContent = ''));
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') submit();
        if (e.key === 'Escape') finish(null);
      });
      ok.onclick = submit;
      (card.querySelector('.cancel') as HTMLButtonElement).onclick = () => finish(null);
      input.focus();
      if (opts.selectRange) input.setSelectionRange(opts.selectRange[0], opts.selectRange[1]);
      else input.select();
    });
  }

  confirm(title: string, message: string, opts: { ok?: string; danger?: boolean } = {}): Promise<boolean> {
    return new Promise((resolve) => {
      const { card, close } = this.overlay();
      card.innerHTML = `<div class="card-head"></div><div class="card-body"><div class="dialog-msg"></div></div><div class="card-foot"><button class="btn cancel">Cancel</button><button class="btn ok"></button></div>`;
      card.querySelector('.card-head')!.textContent = title;
      card.querySelector('.dialog-msg')!.textContent = message;
      const ok = card.querySelector('.ok') as HTMLButtonElement;
      ok.textContent = opts.ok ?? 'OK';
      ok.classList.add(opts.danger ? 'danger' : 'primary');
      const finish = (v: boolean) => {
        close();
        resolve(v);
      };
      ok.onclick = () => finish(true);
      (card.querySelector('.cancel') as HTMLButtonElement).onclick = () => finish(false);
      card.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') finish(false);
        if (e.key === 'Enter') finish(true);
      });
      ok.focus();
    });
  }

  /** Generic modal: caller fills the card. Returns a close function. */
  modal(title: string, build: (body: HTMLDivElement, foot: HTMLDivElement, close: () => void) => void, opts: { wide?: boolean } = {}): () => void {
    const { card, close } = this.overlay();
    if (opts.wide) card.classList.add('wide');
    card.innerHTML = `<div class="card-head"></div><div class="card-body"></div><div class="card-foot"></div>`;
    card.querySelector('.card-head')!.textContent = title;
    const body = card.querySelector('.card-body') as HTMLDivElement;
    const foot = card.querySelector('.card-foot') as HTMLDivElement;
    card.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') close();
    });
    build(body, foot, close);
    return close;
  }

  toast(text: string, kind: 'info' | 'error' | 'warning' | 'success' = 'info', ms = 4000): void {
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.textContent = text;
    this.toasts.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  contextMenu(x: number, y: number, items: Array<{ label: string; run: () => void; danger?: boolean } | 'sep'>): void {
    const menu = document.createElement('div');
    menu.className = 'ctx';
    for (const it of items) {
      if (it === 'sep') {
        menu.appendChild(document.createElement('hr'));
        continue;
      }
      const b = document.createElement('button');
      b.textContent = it.label;
      if (it.danger) b.style.color = 'var(--error)';
      b.onclick = () => {
        cleanup();
        it.run();
      };
      menu.appendChild(b);
    }
    const doc = this.root.ownerDocument;
    const cleanup = () => {
      menu.remove();
      this.root.removeEventListener('pointerdown', onDown, true);
      doc.removeEventListener('keydown', onKey, true);
    };
    const onDown = (e: Event) => {
      if (!menu.contains(e.target as Node)) cleanup();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cleanup();
    };
    this.root.appendChild(menu);
    const r = this.root.getBoundingClientRect();
    menu.style.left = `${Math.min(x - r.left, r.width - menu.offsetWidth - 4)}px`;
    menu.style.top = `${Math.min(y - r.top, r.height - menu.offsetHeight - 4)}px`;
    setTimeout(() => {
      this.root.addEventListener('pointerdown', onDown, true);
      doc.addEventListener('keydown', onKey, true);
    });
  }
}
