import type { Workspace } from '../app/workspace';
import { icon } from './icons';

export class TabBar {
  readonly el: HTMLDivElement;

  constructor(
    private ws: Workspace,
    private actions: { activate(path: string): void; close(path: string): void },
  ) {
    this.el = document.createElement('div');
    this.el.className = 'tabs';
    this.el.addEventListener('wheel', (e) => {
      if (e.deltaY && !e.deltaX) {
        this.el.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    });
  }

  render(): void {
    this.el.textContent = '';
    for (const path of this.ws.open) {
      const tab = document.createElement('div');
      tab.className = 'tab' + (path === this.ws.active ? ' active' : '') + (this.ws.isDirty(path) ? ' dirty' : '');
      tab.title = path;
      tab.appendChild(icon(path.endsWith('.py') ? 'pyfile' : 'file'));
      const name = document.createElement('span');
      name.textContent = path.slice(path.lastIndexOf('/') + 1);
      tab.appendChild(name);
      const x = document.createElement('button');
      x.className = 'x';
      x.title = 'Close';
      x.appendChild(icon('close'));
      x.onclick = (e) => {
        e.stopPropagation();
        this.actions.close(path);
      };
      tab.appendChild(x);
      tab.onclick = () => this.actions.activate(path);
      tab.onauxclick = (e) => {
        if (e.button === 1) this.actions.close(path);
      };
      this.el.appendChild(tab);
    }
    this.el.querySelector('.tab.active')?.scrollIntoView({ inline: 'nearest' });
  }
}
