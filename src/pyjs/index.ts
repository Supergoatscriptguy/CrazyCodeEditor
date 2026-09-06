// Driver for the JS interpreter: runs code, handles effects, formats errors.
import { parse, PySyntaxError, tokenize } from './parser';
import {
  EXCEPTIONS, NativeFunc, PyClass, PyDict, PyFunction, PyInstance, PyList, PyModule, PyRaise, PyTuple, PyVal,
  reprSimple, typeName,
} from './objects';
import { Effect, Exec, HostIO, Interpreter, MODULE_BUILDERS, Scope, StopExecution, newScope } from './interp';
import { installBuiltins, seedRandom } from './stdlib';

export interface RunResult {
  ok: boolean;
  exit: number;
}

export interface RuntimeOptions {
  write(text: string, stream: 'stdout' | 'stderr'): void;
  /** Resolves with a line, or null for end of input. */
  requestInput(prompt: string): Promise<string | null>;
  /** Yields to the browser so the UI stays responsive. */
  yieldToUi(): Promise<void>;
}

const STEPS_PER_SLICE = 2000;

export class PyJsRuntime {
  readonly interp: Interpreter;
  private files = new Map<string, string>();
  private changed = new Set<string>();
  private moduleScope: Scope;
  private replScope: Scope;
  private stopping = false;

  constructor(private opts: RuntimeOptions) {
    const io: HostIO = {
      write: (text, stream) => this.opts.write(text, stream ?? 'stdout'),
      readFile: (path) => this.files.get(normalize(path)) ?? null,
      writeFile: (path, content) => {
        const p = normalize(path);
        this.files.set(p, content);
        this.changed.add(p);
      },
      listDir: (path) => {
        const prefix = path && path !== '.' ? normalize(path).replace(/\/?$/, '/') : '';
        const names = new Set<string>();
        for (const p of this.files.keys()) {
          if (!p.startsWith(prefix)) continue;
          const rest = p.slice(prefix.length);
          names.add(rest.split('/')[0]);
        }
        return [...names].sort();
      },
      exists: (path) => this.files.has(normalize(path)),
      remove: (path) => {
        this.files.delete(normalize(path));
        this.changed.add(normalize(path));
      },
      now: () => Date.now(),
    };
    this.interp = new Interpreter(io);
    installBuiltins(this.interp);
    this.interp.shouldStop = () => this.stopping;
    this.moduleScope = newScope(null, this.interp.globals, false);
    this.replScope = this.moduleScope;
  }

  get version(): string {
    return '3.12 (built-in interpreter)';
  }

  setFiles(files: Record<string, string>, deleted: string[] = []): void {
    for (const [k, v] of Object.entries(files)) this.files.set(normalize(k), v);
    for (const d of deleted) this.files.delete(normalize(d));
  }

  takeChangedFiles(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const p of this.changed) {
      const v = this.files.get(p);
      if (v !== undefined) out[p] = v;
    }
    this.changed.clear();
    return out;
  }

  stop(): void {
    this.stopping = true;
  }

  /** Fresh globals, as if the program had just started. */
  reset(): void {
    this.interp.globals = new Map();
    this.interp.modules.clear();
    this.interp.frames = [];
    this.moduleScope = newScope(null, this.interp.globals, false);
    this.replScope = this.moduleScope;
  }

  async run(code: string, filename = 'main.py'): Promise<RunResult> {
    this.stopping = false;
    this.interp.frames = [];
    this.interp.globals.set('__name__', '__main__');
    this.interp.globals.set('__file__', filename);
    seedRandom(Date.now() & 0x7fffffff);
    let ast;
    try {
      ast = parse(code);
    } catch (e) {
      if (e instanceof PySyntaxError) {
        this.opts.write(formatSyntaxError(e, code, filename), 'stderr');
        return { ok: false, exit: 1 };
      }
      throw e;
    }
    const scope = newScope(null, this.interp.globals, false);
    this.moduleScope = scope;
    this.replScope = scope;
    const self = this;
    const gen = (function* (): Exec<void> {
      self.interp.frames.push({ name: '<module>', line: 1, func: null, scope });
      try {
        yield* self.interp.execBlock(ast.body, scope);
      } catch (e) {
        self.interp.captureTraceback(e);
        throw e;
      } finally {
        self.interp.frames.pop();
      }
    })();
    return await this.drive(gen, code, filename);
  }

  /** One REPL line. Returns 'incomplete' when the block needs more input. */
  async repl(line: string, buffered: string): Promise<{ status: 'incomplete' | 'complete' | 'syntax-error'; value?: string; error?: string }> {
    const source = buffered ? buffered + '\n' + line : line;
    if (line.trim() !== '' || !buffered) {
      try {
        parse(source);
      } catch (e) {
        if (e instanceof PySyntaxError && isIncompleteError(e, source)) return { status: 'incomplete' };
        if (e instanceof PySyntaxError) return { status: 'syntax-error', error: formatSyntaxError(e, source, '<repl>') };
        throw e;
      }
    }
    let ast;
    try {
      ast = parse(source);
    } catch (e) {
      if (e instanceof PySyntaxError) return { status: 'syntax-error', error: formatSyntaxError(e, source, '<repl>') };
      throw e;
    }
    this.stopping = false;
    const scope = this.replScope;
    const body = ast.body;
    const last = body[body.length - 1];
    const showValue = last && last.type === 'Expr';
    const self = this;
    let result: PyVal = null;
    const gen = (function* (): Exec<void> {
      self.interp.frames.push({ name: '<repl>', line: 1, func: null, scope });
      try {
        for (let i = 0; i < body.length; i++) {
          if (i === body.length - 1 && showValue) result = yield* self.interp.eval(last.value, scope);
          else yield* self.interp.execStmt(body[i], scope);
        }
      } catch (e) {
        self.interp.captureTraceback(e);
        throw e;
      } finally {
        self.interp.frames.pop();
      }
    })();
    const outcome = await this.drive(gen, source, '<repl>', true);
    if (!outcome.ok) return { status: 'complete', error: outcome.errorText ?? '' };
    if (showValue && result !== null) {
      const text = await this.driveValue((function* (): Exec<string> {
        return yield* self.interp.repr(result);
      })());
      return { status: 'complete', value: text };
    }
    return { status: 'complete' };
  }

  /** Runs a generator to completion, handling effects. */
  private async drive(gen: Exec<any>, source: string, filename: string, quiet = false): Promise<RunResult & { errorText?: string }> {
    let sent: any = undefined;
    let steps = 0;
    for (;;) {
      let r: IteratorResult<Effect, any>;
      try {
        r = gen.next(sent);
      } catch (e) {
        return this.handleError(e, source, filename, quiet);
      }
      if (r.done) return { ok: true, exit: 0 };
      const eff = r.value;
      sent = undefined;
      if (eff.t === 'tick') {
        if (++steps % STEPS_PER_SLICE === 0) await this.opts.yieldToUi();
      } else if (eff.t === 'input') {
        const line = await this.opts.requestInput(eff.prompt);
        sent = line;
      } else if (eff.t === 'sleep') {
        const until = Date.now() + eff.ms;
        while (Date.now() < until && !this.stopping) await this.opts.yieldToUi();
      } else if (eff.t === 'yield') {
        // stray yield outside a generator
        sent = null;
      }
      if (this.stopping) {
        try {
          gen.return?.(null as any);
        } catch {}
        return { ok: false, exit: 130 };
      }
    }
  }

  /** Drives a short generator that cannot block (repr, str). */
  private async driveValue<T>(gen: Generator<Effect, T, any>): Promise<T> {
    let sent: any = undefined;
    for (;;) {
      const r = gen.next(sent);
      if (r.done) return r.value;
      sent = undefined;
      if (r.value.t === 'tick') continue;
      if (r.value.t === 'input') sent = await this.opts.requestInput(r.value.prompt);
    }
  }

  private handleError(e: unknown, source: string, filename: string, quiet: boolean): RunResult & { errorText?: string } {
    if (e instanceof StopExecution) return { ok: false, exit: 130 };
    if (e instanceof PyRaise) {
      if (e.value.cls.name === 'SystemExit') {
        const args = e.value.dict.get('args');
        const code = args instanceof PyTuple && args.items.length ? args.items[0] : 0n;
        if (typeof code === 'bigint') return { ok: code === 0n, exit: Number(code) };
        this.opts.write(reprSimple(code) + '\n', 'stderr');
        return { ok: false, exit: 1 };
      }
      const text = formatTraceback(e, source, filename);
      this.opts.write(text, 'stderr');
      return { ok: false, exit: 1, errorText: text };
    }
    if (e instanceof PySyntaxError) {
      const text = formatSyntaxError(e, source, filename);
      this.opts.write(text, 'stderr');
      return { ok: false, exit: 1, errorText: text };
    }
    if (e instanceof RangeError) {
      const text = 'RecursionError: maximum recursion depth exceeded\n';
      this.opts.write(text, 'stderr');
      return { ok: false, exit: 1, errorText: text };
    }
    const text = `InternalError: ${(e as Error)?.message ?? String(e)}\n`;
    this.opts.write(text, 'stderr');
    return { ok: false, exit: 1, errorText: text };
  }

  // editor support
  /** Syntax problems for the Problems panel. */
  lint(code: string): Array<{ line: number; col: number; msg: string; severity: 'error' | 'warning' }> {
    try {
      parse(code);
      return [];
    } catch (e) {
      if (e instanceof PySyntaxError) return [{ line: e.line, col: Math.max(0, e.col - 1), msg: `SyntaxError: ${e.message}`, severity: 'error' }];
      return [];
    }
  }

  /** Names available at a point, for autocomplete. */
  complete(code: string, line: number, col: number): Array<{ name: string; type: string; kind: string; desc: string }> {
    const lineText = code.split(/\r?\n/)[line - 1] ?? '';
    const before = lineText.slice(0, col);
    const dot = /([A-Za-z_][\w.]*)\.(\w*)$/.exec(before);
    const out: Array<{ name: string; type: string; kind: string; desc: string }> = [];
    const push = (name: string, v: PyVal, kind?: string) => {
      const k = kind ?? kindOf(v);
      out.push({ name, type: k === 'function' ? 'function' : k === 'class' ? 'class' : k === 'module' ? 'namespace' : 'variable', kind: k, desc: describe(name, v) });
    };
    if (dot) {
      const target = this.resolveDotted(dot[1]);
      if (target === undefined) return [];
      if (target instanceof PyModule) for (const [k, v] of target.dict) if (!k.startsWith('_')) push(k, v);
      else if (target instanceof PyClass) for (const c of target.mro) for (const [k, v] of c.dict) if (!k.startsWith('__')) push(k, v);
      else if (target instanceof PyInstance) {
        for (const [k, v] of target.dict) push(k, v);
        for (const c of target.cls.mro) for (const [k, v] of c.dict) if (!k.startsWith('__')) push(k, v);
      } else for (const name of nativeMembers(target)) push(name, null, 'function');
      return dedupe(out);
    }
    // Bare word: locals, globals, builtins, plus names assigned in this file.
    for (const [k, v] of this.moduleScope.vars) push(k, v);
    for (const [k, v] of this.interp.globals) push(k, v);
    for (const name of collectAssignedNames(code)) if (!out.some((o) => o.name === name)) out.push({ name, type: 'variable', kind: 'statement', desc: '' });
    for (const [k, v] of this.interp.builtins) if (!k.startsWith('_')) push(k, v);
    for (const name of MODULE_NAMES) if (!out.some((o) => o.name === name)) out.push({ name, type: 'namespace', kind: 'module', desc: 'module' });
    return dedupe(out);
  }

  private resolveDotted(path: string): PyVal | undefined {
    const parts = path.split('.');
    let v = this.moduleScope.vars.get(parts[0]) ?? this.interp.globals.get(parts[0]) ?? this.interp.builtins.get(parts[0]);
    if (v === undefined && MODULE_NAMES.includes(parts[0])) {
      const builder = MODULE_BUILDERS.get(parts[0]);
      if (builder) v = builder(this.interp);
    }
    for (let i = 1; i < parts.length && v !== undefined; i++) {
      if (v instanceof PyModule) v = v.dict.get(parts[i]);
      else if (v instanceof PyClass) v = v.lookup(parts[i]);
      else if (v instanceof PyInstance) v = v.dict.get(parts[i]) ?? v.cls.lookup(parts[i]);
      else return undefined;
    }
    return v;
  }

  /** Signature and docstring for one completion item. */
  detail(name: string, dotted: string | null): { sig: string; doc: string } | null {
    const v = dotted ? this.resolveDotted(dotted + '.' + name) : (this.interp.builtins.get(name) ?? this.moduleScope.vars.get(name));
    if (v === undefined || v === null) return null;
    return { sig: signatureOf(name, v), doc: v instanceof NativeFunc ? v.doc : v instanceof PyFunction ? (v.doc ?? '') : '' };
  }
}

const MODULE_NAMES = ['math', 'random', 'json', 'time', 'sys', 'os', 'string', 'itertools', 'functools', 'collections', 'statistics', 'copy', 're', 'heapq', 'bisect', 'datetime', 'typing'];

export const SUPPORTED_MODULES = MODULE_NAMES;

function normalize(path: string): string {
  return path.replace(/^\.?\//, '').replace(/^\/workspace\//, '');
}

function kindOf(v: PyVal): string {
  if (v instanceof PyFunction || v instanceof NativeFunc) return 'function';
  if (v instanceof PyClass) return 'class';
  if (v instanceof PyModule) return 'module';
  if (v === null) return 'statement';
  return 'instance';
}

function describe(name: string, v: PyVal): string {
  if (v instanceof NativeFunc) return v.doc || 'built-in';
  if (v instanceof PyFunction) return signatureOf(name, v);
  if (v instanceof PyClass) return `class ${v.name}`;
  if (v instanceof PyModule) return 'module';
  if (v === null) return '';
  return typeName(v);
}

function signatureOf(name: string, v: PyVal): string {
  if (v instanceof PyFunction) {
    const p = v.params;
    const parts = [...p.args.map((a) => a.name)];
    if (p.vararg) parts.push('*' + p.vararg);
    parts.push(...p.kwonly.map((a) => a.name));
    if (p.kwarg) parts.push('**' + p.kwarg);
    return `${name}(${parts.join(', ')})`;
  }
  if (v instanceof NativeFunc) return v.doc || `${name}(...)`;
  if (v instanceof PyClass) return `class ${v.name}`;
  return name;
}

function dedupe(items: Array<{ name: string; type: string; kind: string; desc: string }>) {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i.name) ? false : (seen.add(i.name), true)));
}

const NATIVE_MEMBERS: Record<string, string[]> = {
  str: ['upper', 'lower', 'title', 'capitalize', 'strip', 'lstrip', 'rstrip', 'split', 'rsplit', 'splitlines', 'join', 'replace', 'find', 'rfind', 'index', 'count', 'startswith', 'endswith', 'isdigit', 'isalpha', 'isalnum', 'isspace', 'isupper', 'islower', 'zfill', 'ljust', 'rjust', 'center', 'format', 'partition', 'removeprefix', 'removesuffix'],
  list: ['append', 'extend', 'insert', 'remove', 'pop', 'clear', 'index', 'count', 'sort', 'reverse', 'copy'],
  dict: ['keys', 'values', 'items', 'get', 'pop', 'popitem', 'setdefault', 'update', 'clear', 'copy'],
  set: ['add', 'remove', 'discard', 'pop', 'clear', 'copy', 'union', 'intersection', 'difference', 'symmetric_difference', 'issubset', 'issuperset', 'update'],
  tuple: ['count', 'index'],
};

function nativeMembers(v: PyVal): string[] {
  return NATIVE_MEMBERS[typeName(v)] ?? [];
}

/** Names assigned anywhere in the file, so completion works before running. */
function collectAssignedNames(code: string): string[] {
  const names = new Set<string>();
  try {
    const ast = parse(code);
    const walk = (n: any) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) return n.forEach(walk);
      if (n.type === 'Assign') collectTargets(n.targets, names);
      if (n.type === 'For') collectTargets([n.target], names);
      if (n.type === 'FunctionDef' || n.type === 'ClassDef') names.add(n.name);
      if (n.type === 'Import' || n.type === 'ImportFrom') for (const a of n.names) names.add(a.asname ?? a.name.split('.')[0]);
      for (const k of Object.keys(n)) if (k !== 'type') walk(n[k]);
    };
    walk(ast.body);
  } catch {
    // Fall back to a regex when the file does not parse yet.
    for (const m of code.matchAll(/^\s*(?:def|class)\s+(\w+)|^\s*(\w+)\s*=/gm)) names.add(m[1] ?? m[2]);
  }
  return [...names];
}

function collectTargets(targets: any[], out: Set<string>): void {
  for (const t of targets) {
    if (!t) continue;
    if (t.type === 'Name') out.add(t.id);
    else if (t.type === 'Tuple' || t.type === 'List') collectTargets(t.elts, out);
    else if (t.type === 'Starred') collectTargets([t.value], out);
  }
}

function isIncompleteError(e: PySyntaxError, source: string): boolean {
  if (/end of file|an indented block|unterminated triple-quoted/.test(e.message)) return true;
  // A trailing colon line with nothing after it.
  return /:\s*$/.test(source.trimEnd());
}

function sourceLine(source: string, line: number): string {
  return (source.split(/\r?\n/)[line - 1] ?? '').trim();
}

export function formatSyntaxError(e: PySyntaxError, source: string, filename: string): string {
  const text = sourceLine(source, e.line);
  let out = `  File "${filename}", line ${e.line}\n`;
  if (text) out += `    ${text}\n`;
  const kind = /unindent|indent/.test(e.message) ? 'IndentationError' : 'SyntaxError';
  return `Traceback (most recent call last):\n${out}${kind}: ${e.message}\n`;
}

export function excMessage(exc: PyInstance): string {
  const args = exc.dict.get('args');
  if (!(args instanceof PyTuple) || !args.items.length) return '';
  if (args.items.length === 1) {
    const v = args.items[0];
    if (exc.cls.name === 'KeyError') return reprSimple(v);
    return typeof v === 'string' ? v : reprSimple(v);
  }
  return `(${args.items.map(reprSimple).join(', ')})`;
}

function formatTraceback(e: PyRaise, source: string, filename: string): string {
  let out = 'Traceback (most recent call last):\n';
  for (const f of e.traceback) {
    out += `  File "${filename}", line ${f.line}, in ${f.name}\n`;
    const text = sourceLine(source, f.line);
    if (text) out += `    ${text}\n`;
  }
  const msg = excMessage(e.value);
  return out + e.value.cls.name + (msg ? `: ${msg}` : '') + '\n';
}
