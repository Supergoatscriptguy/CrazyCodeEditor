// Files, drafts, tabs and tree state, persisted to IndexedDB.
import { kvGet, kvSet } from '../runtime/store';

export interface WorkspaceData {
  files: Record<string, string>;
  drafts: Record<string, string>;
  folders: string[];
  open: string[];
  active: string | null;
  expanded: string[];
  cursors: Record<string, number>;
}

export type WorkspaceEvent =
  | { type: 'files'; changed: string[]; deleted: string[] }
  | { type: 'tabs' }
  | { type: 'dirty'; path: string };

const KEY = 'workspace:default';

const WELCOME = `# Welcome to CrazyCodeEditor
# Ctrl+Enter or F5 runs this file. Ctrl+Shift+P opens the command palette.

name = input("What's your name? ")
print(f"Hello, {name}!")

import random
secret = random.randint(1, 10)
guess = int(input("Guess a number from 1 to 10: "))
if guess == secret:
    print("You got it!")
else:
    print(f"Nope, it was {secret}.")
`;

export class Workspace {
  files = new Map<string, string>();
  drafts = new Map<string, string>();
  folders = new Set<string>();
  open: string[] = [];
  active: string | null = null;
  expanded = new Set<string>();
  cursors = new Map<string, number>();
  private listeners = new Set<(e: WorkspaceEvent) => void>();
  private persistTimer: number | null = null;

  on(fn: (e: WorkspaceEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: WorkspaceEvent): void {
    for (const fn of this.listeners) fn(e);
    this.schedulePersist();
  }

  async load(): Promise<void> {
    let data: WorkspaceData | undefined;
    try {
      data = await kvGet<WorkspaceData>(KEY);
    } catch {}
    if (!data) {
      this.files.set('main.py', WELCOME);
      this.open = ['main.py'];
      this.active = 'main.py';
      return;
    }
    this.files = new Map(Object.entries(data.files ?? {}));
    this.drafts = new Map(Object.entries(data.drafts ?? {}));
    this.folders = new Set(data.folders ?? []);
    this.open = (data.open ?? []).filter((p) => this.files.has(p));
    this.active = data.active && this.files.has(data.active) ? data.active : (this.open[0] ?? null);
    this.expanded = new Set(data.expanded ?? []);
    this.cursors = new Map(Object.entries(data.cursors ?? {}));
    if (this.files.size === 0) {
      this.files.set('main.py', WELCOME);
      this.open = ['main.py'];
      this.active = 'main.py';
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer !== null) clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(() => void this.persist(), 300);
  }

  async persist(): Promise<void> {
    this.persistTimer = null;
    const data: WorkspaceData = {
      files: Object.fromEntries(this.files),
      drafts: Object.fromEntries(this.drafts),
      folders: [...this.folders],
      open: this.open,
      active: this.active,
      expanded: [...this.expanded],
      cursors: Object.fromEntries(this.cursors),
    };
    try {
      await kvSet(KEY, data);
    } catch (e) {
      console.warn('[crazy] workspace not saved', e);
    }
  }

  // files
  exists(path: string): boolean {
    return this.files.has(path) || this.folders.has(path) || [...this.files.keys()].some((p) => p.startsWith(path + '/'));
  }

  content(path: string): string {
    return this.drafts.get(path) ?? this.files.get(path) ?? '';
  }

  isDirty(path: string): boolean {
    return this.drafts.has(path) && this.drafts.get(path) !== this.files.get(path);
  }

  dirtyFiles(): string[] {
    return [...this.drafts.keys()].filter((p) => this.isDirty(p));
  }

  create(path: string, content = ''): void {
    if (this.files.has(path)) throw new Error(`${path} already exists`);
    this.files.set(path, content);
    this.ensureParents(path);
    this.emit({ type: 'files', changed: [path], deleted: [] });
  }

  createFolder(path: string): void {
    this.folders.add(path);
    this.ensureParents(path);
    this.expanded.add(path);
    this.emit({ type: 'files', changed: [], deleted: [] });
  }

  private ensureParents(path: string): void {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      this.folders.add(dir);
      this.expanded.add(dir);
    }
  }

  /** Writes a saved file directly (used for imports and program output). */
  write(path: string, content: string, opts: { keepDraft?: boolean } = {}): void {
    this.files.set(path, content);
    if (!opts.keepDraft) this.drafts.delete(path);
    this.ensureParents(path);
    this.emit({ type: 'files', changed: [path], deleted: [] });
  }

  setDraft(path: string, text: string): void {
    if (text === this.files.get(path)) this.drafts.delete(path);
    else this.drafts.set(path, text);
    this.emit({ type: 'dirty', path });
  }

  save(path: string, text?: string): string {
    const content = text ?? this.content(path);
    this.files.set(path, content);
    this.drafts.delete(path);
    this.emit({ type: 'files', changed: [path], deleted: [] });
    this.emit({ type: 'dirty', path });
    return content;
  }

  rename(from: string, to: string): void {
    if (from === to) return;
    if (this.exists(to)) throw new Error(`${to} already exists`);
    const isDir = !this.files.has(from);
    const changed: string[] = [];
    const deleted: string[] = [];
    const mapPath = (p: string) => (p === from ? to : p.startsWith(from + '/') ? to + p.slice(from.length) : null);
    for (const p of [...this.files.keys()]) {
      const np = mapPath(p);
      if (np === null) continue;
      this.files.set(np, this.files.get(p)!);
      this.files.delete(p);
      if (this.drafts.has(p)) {
        this.drafts.set(np, this.drafts.get(p)!);
        this.drafts.delete(p);
      }
      if (this.cursors.has(p)) {
        this.cursors.set(np, this.cursors.get(p)!);
        this.cursors.delete(p);
      }
      changed.push(np);
      deleted.push(p);
    }
    if (isDir) {
      for (const f of [...this.folders]) {
        const nf = mapPath(f);
        if (nf !== null) {
          this.folders.delete(f);
          this.folders.add(nf);
          if (this.expanded.delete(f)) this.expanded.add(nf);
        }
      }
      deleted.push(from);
    }
    this.open = this.open.map((p) => mapPath(p) ?? p);
    if (this.active) this.active = mapPath(this.active) ?? this.active;
    this.ensureParents(to);
    this.emit({ type: 'files', changed, deleted });
    this.emit({ type: 'tabs' });
  }

  delete(path: string): void {
    const deleted: string[] = [];
    for (const p of [...this.files.keys()]) {
      if (p === path || p.startsWith(path + '/')) {
        this.files.delete(p);
        this.drafts.delete(p);
        this.cursors.delete(p);
        deleted.push(p);
      }
    }
    for (const f of [...this.folders]) {
      if (f === path || f.startsWith(path + '/')) {
        this.folders.delete(f);
        this.expanded.delete(f);
      }
    }
    if (!this.files.has(path)) deleted.push(path);
    this.open = this.open.filter((p) => this.files.has(p));
    if (this.active && !this.files.has(this.active)) this.active = this.open[0] ?? null;
    this.emit({ type: 'files', changed: [], deleted });
    this.emit({ type: 'tabs' });
  }

  // tabs
  openFile(path: string): void {
    if (!this.files.has(path)) return;
    if (!this.open.includes(path)) this.open.push(path);
    this.active = path;
    this.emit({ type: 'tabs' });
  }

  closeFile(path: string): void {
    const i = this.open.indexOf(path);
    if (i === -1) return;
    this.open.splice(i, 1);
    if (this.active === path) this.active = this.open[Math.min(i, this.open.length - 1)] ?? null;
    this.emit({ type: 'tabs' });
  }

  setActive(path: string | null): void {
    this.active = path;
    this.emit({ type: 'tabs' });
  }

  toggleExpanded(dir: string): void {
    if (this.expanded.has(dir)) this.expanded.delete(dir);
    else this.expanded.add(dir);
    this.emit({ type: 'files', changed: [], deleted: [] });
  }

  /** All saved files plus unsaved drafts, as the program should see them. */
  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [p, c] of this.files) out[p] = this.drafts.get(p) ?? c;
    return out;
  }

  sortedPaths(): string[] {
    return [...this.files.keys()].sort();
  }
}
