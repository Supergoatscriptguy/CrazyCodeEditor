// File explorer.
import type { Workspace } from '../app/workspace';
import { icon } from './icons';

export interface TreeActions {
  open(path: string): void;
  newFile(dir: string): void;
  newFolder(dir: string): void;
  rename(path: string): void;
  delete(path: string): void;
  run(path: string): void;
}

interface Node {
  name: string;
  path: string;
  isDir: boolean;
  children: Node[];
}

export class FileTree {
  readonly el: HTMLDivElement;

  constructor(
    private ws: Workspace,
    private actions: TreeActions,
    private contextMenu: (x: number, y: number, items: Array<{ label: string; run: () => void; danger?: boolean } | 'sep'>) => void,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'tree';
    this.el.addEventListener('contextmenu', (e) => {
      if ((e.target as HTMLElement).closest('.tree-row')) return;
      e.preventDefault();
      this.contextMenu(e.clientX, e.clientY, [
        { label: 'New File', run: () => this.actions.newFile('') },
        { label: 'New Folder', run: () => this.actions.newFolder('') },
      ]);
    });
  }

  private build(): Node {
    const root: Node = { name: '', path: '', isDir: true, children: [] };
    const dirs = new Map<string, Node>([['', root]]);
    const ensureDir = (path: string): Node => {
      let n = dirs.get(path);
      if (n) return n;
      const i = path.lastIndexOf('/');
      const parent = ensureDir(i === -1 ? '' : path.slice(0, i));
      n = { name: path.slice(i + 1), path, isDir: true, children: [] };
      parent.children.push(n);
      dirs.set(path, n);
      return n;
    };
    for (const f of this.ws.folders) ensureDir(f);
    for (const p of this.ws.files.keys()) {
      const i = p.lastIndexOf('/');
      const parent = ensureDir(i === -1 ? '' : p.slice(0, i));
      parent.children.push({ name: p.slice(i + 1), path: p, isDir: false, children: [] });
    }
    const sort = (n: Node) => {
      n.children.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })));
      n.children.forEach(sort);
    };
    sort(root);
    return root;
  }

  render(): void {
    const root = this.build();
    this.el.textContent = '';
    if (!root.children.length) {
      const empty = document.createElement('div');
      empty.className = 'tree-empty';
      empty.textContent = 'No files yet. Right-click here or use the buttons above to create one.';
      this.el.appendChild(empty);
      return;
    }
    const walk = (n: Node, depth: number) => {
      for (const c of n.children) {
        this.el.appendChild(this.row(c, depth));
        if (c.isDir && this.ws.expanded.has(c.path)) walk(c, depth + 1);
      }
    };
    walk(root, 0);
  }

  private row(n: Node, depth: number): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'tree-row' + (n.isDir ? ' folder' : '') + (this.ws.active === n.path ? ' active' : '');
    row.style.paddingLeft = `${8 + depth * 14}px`;
    row.dataset.path = n.path;
    row.title = n.path;
    const chev = document.createElement('span');
    chev.className = 'chev';
    if (n.isDir) chev.appendChild(icon(this.ws.expanded.has(n.path) ? 'chevronDown' : 'chevronRight'));
    row.appendChild(chev);
    row.appendChild(icon(n.isDir ? (this.ws.expanded.has(n.path) ? 'folderOpen' : 'folder') : n.name.endsWith('.py') ? 'pyfile' : 'file'));
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = n.name;
    row.appendChild(name);
    if (!n.isDir && this.ws.isDirty(n.path)) {
      const d = document.createElement('span');
      d.className = 'dirty';
      d.title = 'Unsaved changes';
      row.appendChild(d);
    }
    row.onclick = () => {
      if (n.isDir) this.ws.toggleExpanded(n.path);
      else this.actions.open(n.path);
    };
    row.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const dir = n.isDir ? n.path : n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : '';
      const items: Array<{ label: string; run: () => void; danger?: boolean } | 'sep'> = [];
      if (!n.isDir && n.path.endsWith('.py')) items.push({ label: 'Run', run: () => this.actions.run(n.path) }, 'sep');
      items.push({ label: 'New File', run: () => this.actions.newFile(dir) }, { label: 'New Folder', run: () => this.actions.newFolder(dir) }, 'sep', { label: 'Rename', run: () => this.actions.rename(n.path) }, { label: 'Delete', run: () => this.actions.delete(n.path), danger: true });
      this.contextMenu(e.clientX, e.clientY, items);
    };
    return row;
  }
}
