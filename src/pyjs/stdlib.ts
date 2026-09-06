// Builtins, methods on built-in types, and the bundled modules.
import {
  BoundMethod, EXCEPTIONS, NativeFunc, OBJECT_CLASS, PyClass, PyDict, PyFile, PyFunction, PyGenerator, PyInstance,
  PyList, PyModule, PyRaise, PyRange, PySet, PySlice, PyTuple, PyVal, floatRepr, formatValue, isNum, keyOf,
  makeException, normIndex, objId, raisePy, reprSimple, sliceSeq, toBig, toNum, typeError, typeName, valueError,
} from './objects';
import {
  ClassMethod, Exec, Interpreter, MODULE_BUILDERS, Property, StaticMethod, asStr, genSend, newScope,
  setNativeMethodResolver,
} from './interp';

const nf = (name: string, fn: (args: PyVal[], kwargs: Map<string, PyVal>) => PyVal, doc = '') => new NativeFunc(name, fn, false, doc);
const rf = (name: string, fn: (args: PyVal[], kwargs: Map<string, PyVal>) => Exec, doc = '') => new NativeFunc(name, fn as any, true, doc);
const arg = (args: PyVal[], i: number, def: PyVal = null): PyVal => (i < args.length ? args[i] : def);
const kw = (kwargs: Map<string, PyVal>, name: string, def: PyVal = null): PyVal => (kwargs.has(name) ? kwargs.get(name)! : def);
const num = (v: PyVal): number => {
  if (!isNum(v)) typeError(`expected a number, got ${typeName(v)}`);
  return toNum(v);
};
const int = (v: PyVal): number => Number(toBig(v));
const str = (v: PyVal): string => asStr(v);

/** Builtin types exposed as classes so isinstance() and construction both work. */
const TYPES = new Map<string, PyClass>();
function typeClass(name: string, native?: (args: PyVal[], kwargs: Map<string, PyVal>) => PyVal | Exec, reentrant = false): PyClass {
  const c = new PyClass(name, [OBJECT_CLASS]);
  (c as any).nativeName = name;
  if (native) {
    (c as any).native = native;
    (c as any).nativeReentrant = reentrant;
  }
  TYPES.set(name, c);
  return c;
}

export function isInstanceOf(v: PyVal, cls: PyVal): boolean {
  if (cls instanceof PyTuple) return cls.items.some((c) => isInstanceOf(v, c));
  if (!(cls instanceof PyClass)) typeError('isinstance() arg 2 must be a type or tuple of types');
  if (v instanceof PyInstance) return v.cls.isSubclassOf(cls);
  const nm = (cls as any).nativeName as string | undefined;
  if (!nm) return false;
  if (nm === 'object') return true;
  const t = typeName(v);
  if (nm === 'int') return t === 'int' || t === 'bool';
  if (nm === 'float') return t === 'float';
  return t === nm;
}

// sorting
function* sortValues(interp: Interpreter, items: PyVal[], keyFn: PyVal, reverse: boolean): Exec<PyVal[]> {
  const keyed: Array<{ key: PyVal; value: PyVal }> = [];
  for (const v of items) keyed.push({ key: keyFn ? yield* interp.call(keyFn, [v], new Map()) : v, value: v });
  // Merge sort: stable, and each comparison may re-enter Python.
  const merge = function* (a: typeof keyed, b: typeof keyed): Exec<typeof keyed> {
    const out: typeof keyed = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      const less = yield* interp.compare(b[j].key, a[i].key, '<');
      if (less) out.push(b[j++]);
      else out.push(a[i++]);
    }
    while (i < a.length) out.push(a[i++]);
    while (j < b.length) out.push(b[j++]);
    return out;
  };
  const sort = function* (arr: typeof keyed): Exec<typeof keyed> {
    if (arr.length <= 1) return arr;
    const mid = arr.length >> 1;
    return yield* merge(yield* sort(arr.slice(0, mid)), yield* sort(arr.slice(mid)));
  };
  const sorted = yield* sort(keyed);
  const out = sorted.map((e) => e.value);
  return reverse ? out.reverse() : out;
}

// string methods
function strMethod(interp: Interpreter, s: string, name: string): PyVal | undefined {
  const one = (args: PyVal[]) => str(arg(args, 0));
  switch (name) {
    case 'upper':
      return nf(name, () => s.toUpperCase());
    case 'lower':
      return nf(name, () => s.toLowerCase());
    case 'casefold':
      return nf(name, () => s.toLowerCase());
    case 'swapcase':
      return nf(name, () => [...s].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join(''));
    case 'capitalize':
      return nf(name, () => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s));
    case 'title':
      return nf(name, () => s.replace(/[A-Za-z]+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()));
    case 'strip':
      return nf(name, (a) => trimWith(s, a.length ? one(a) : null, true, true));
    case 'lstrip':
      return nf(name, (a) => trimWith(s, a.length ? one(a) : null, true, false));
    case 'rstrip':
      return nf(name, (a) => trimWith(s, a.length ? one(a) : null, false, true));
    case 'split':
      return nf(name, (a) => {
        const sep = arg(a, 0);
        const maxsplit = a.length > 1 ? int(a[1]) : -1;
        if (sep === null) {
          const parts = s.split(/\s+/).filter((p) => p.length);
          return new PyList(maxsplit < 0 ? parts : splitLimit(s.trim().split(/\s+/), maxsplit));
        }
        const parts = s.split(str(sep));
        return new PyList(maxsplit < 0 ? parts : splitLimit(parts, maxsplit, str(sep)));
      });
    case 'rsplit':
      return nf(name, (a) => {
        const sep = arg(a, 0);
        const parts = sep === null ? s.split(/\s+/).filter((p) => p.length) : s.split(str(sep));
        const maxsplit = a.length > 1 ? int(a[1]) : -1;
        if (maxsplit < 0 || parts.length <= maxsplit) return new PyList(parts);
        const tail = parts.slice(parts.length - maxsplit);
        const head = parts.slice(0, parts.length - maxsplit).join(sep === null ? ' ' : str(sep));
        return new PyList([head, ...tail]);
      });
    case 'splitlines':
      return nf(name, () => new PyList(s.split(/\r\n|\r|\n/).filter((p, i, arr) => !(i === arr.length - 1 && p === ''))));
    case 'join':
      return rf(name, function* (a) {
        const items = yield* interp.iterateAll(arg(a, 0));
        const parts: string[] = [];
        for (const it of items) {
          if (typeof it !== 'string') typeError(`sequence item ${parts.length}: expected str instance, ${typeName(it)} found`);
          parts.push(it);
        }
        return parts.join(s);
      });
    case 'replace':
      return nf(name, (a) => {
        const count = a.length > 2 ? int(a[2]) : -1;
        if (count < 0) return s.split(str(a[0])).join(str(a[1]));
        let out = s;
        for (let i = 0; i < count; i++) {
          if (!out.includes(str(a[0]))) break;
          out = out.replace(str(a[0]), str(a[1]));
        }
        return out;
      });
    case 'find':
      return nf(name, (a) => BigInt(s.indexOf(one(a), a.length > 1 ? int(a[1]) : 0)));
    case 'rfind':
      return nf(name, (a) => BigInt(s.lastIndexOf(one(a))));
    case 'index':
      return nf(name, (a) => {
        const i = s.indexOf(one(a));
        if (i < 0) valueError('substring not found');
        return BigInt(i);
      });
    case 'count':
      return nf(name, (a) => {
        const sub = one(a);
        if (!sub) return BigInt(s.length + 1);
        return BigInt(s.split(sub).length - 1);
      });
    case 'startswith':
      return nf(name, (a) => {
        const p = arg(a, 0);
        const start = a.length > 1 ? int(a[1]) : 0;
        const target = s.slice(start);
        return p instanceof PyTuple ? p.items.some((x) => target.startsWith(str(x))) : target.startsWith(str(p));
      });
    case 'endswith':
      return nf(name, (a) => {
        const p = arg(a, 0);
        return p instanceof PyTuple ? p.items.some((x) => s.endsWith(str(x))) : s.endsWith(str(p));
      });
    case 'isdigit':
    case 'isnumeric':
    case 'isdecimal':
      return nf(name, () => s.length > 0 && /^[0-9]+$/.test(s));
    case 'isalpha':
      return nf(name, () => s.length > 0 && /^[A-Za-z]+$/.test(s));
    case 'isalnum':
      return nf(name, () => s.length > 0 && /^[A-Za-z0-9]+$/.test(s));
    case 'isspace':
      return nf(name, () => s.length > 0 && /^\s+$/.test(s));
    case 'isupper':
      return nf(name, () => /[A-Za-z]/.test(s) && s === s.toUpperCase());
    case 'islower':
      return nf(name, () => /[A-Za-z]/.test(s) && s === s.toLowerCase());
    case 'istitle':
      return nf(name, () => s.length > 0 && s === s.replace(/[A-Za-z]+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()));
    case 'zfill':
      return nf(name, (a) => {
        const width = int(arg(a, 0));
        if (s.length >= width) return s;
        const neg = s.startsWith('-') || s.startsWith('+');
        return neg ? s[0] + s.slice(1).padStart(width - 1, '0') : s.padStart(width, '0');
      });
    case 'ljust':
      return nf(name, (a) => s.padEnd(int(arg(a, 0)), a.length > 1 ? str(a[1]) : ' '));
    case 'rjust':
      return nf(name, (a) => s.padStart(int(arg(a, 0)), a.length > 1 ? str(a[1]) : ' '));
    case 'center':
      return nf(name, (a) => {
        const width = int(arg(a, 0));
        const fill = a.length > 1 ? str(a[1]) : ' ';
        if (s.length >= width) return s;
        const total = width - s.length;
        const left = Math.floor(total / 2);
        return fill.repeat(left) + s + fill.repeat(total - left);
      });
    case 'partition':
    case 'rpartition':
      return nf(name, (a) => {
        const sep = one(a);
        const i = name === 'partition' ? s.indexOf(sep) : s.lastIndexOf(sep);
        if (i < 0) return new PyTuple(name === 'partition' ? [s, '', ''] : ['', '', s]);
        return new PyTuple([s.slice(0, i), sep, s.slice(i + sep.length)]);
      });
    case 'removeprefix':
      return nf(name, (a) => (s.startsWith(one(a)) ? s.slice(one(a).length) : s));
    case 'removesuffix':
      return nf(name, (a) => (s.endsWith(one(a)) ? s.slice(0, s.length - one(a).length) : s));
    case 'format':
      return rf(name, function* (a, kwargs) {
        let i = 0;
        const out = s.replace(/\{([^{}]*)\}|\{\{|\}\}/g, (m, inner) => {
          if (m === '{{') return '{';
          if (m === '}}') return '}';
          const [ref, spec] = String(inner).split(':');
          let v: PyVal;
          if (ref === '') v = a[i++];
          else if (/^\d+$/.test(ref)) v = a[parseInt(ref, 10)];
          else v = kwargs.get(ref) ?? null;
          if (spec) {
            const formatted = formatValue(v, spec);
            if (formatted !== null) return formatted;
          }
          return typeof v === 'string' ? v : reprSimple(v);
        });
        return out;
      });
    case 'encode':
      return nf(name, () => s);
    case 'expandtabs':
      return nf(name, (a) => s.replace(/\t/g, ' '.repeat(a.length ? int(a[0]) : 8)));
  }
  return undefined;
}

function trimWith(s: string, chars: string | null, left: boolean, right: boolean): string {
  if (chars === null) return left && right ? s.trim() : left ? s.replace(/^\s+/, '') : s.replace(/\s+$/, '');
  const set = new Set([...chars]);
  let start = 0;
  let end = s.length;
  if (left) while (start < end && set.has(s[start])) start++;
  if (right) while (end > start && set.has(s[end - 1])) end--;
  return s.slice(start, end);
}

function splitLimit(parts: string[], maxsplit: number, sep = ' '): string[] {
  if (parts.length <= maxsplit) return parts;
  return [...parts.slice(0, maxsplit), parts.slice(maxsplit).join(sep)];
}

// container methods
function listMethod(interp: Interpreter, l: PyList, name: string): PyVal | undefined {
  switch (name) {
    case 'append':
      return nf(name, (a) => (l.items.push(arg(a, 0)), null));
    case 'extend':
      return rf(name, function* (a) {
        l.items.push(...(yield* interp.iterateAll(arg(a, 0))));
        return null;
      });
    case 'insert':
      return nf(name, (a) => {
        let i = int(arg(a, 0));
        if (i < 0) i = Math.max(0, l.items.length + i);
        l.items.splice(Math.min(i, l.items.length), 0, arg(a, 1));
        return null;
      });
    case 'remove':
      return rf(name, function* (a) {
        for (let i = 0; i < l.items.length; i++) {
          if (yield* interp.eq(l.items[i], arg(a, 0))) {
            l.items.splice(i, 1);
            return null;
          }
        }
        return valueError('list.remove(x): x not in list');
      });
    case 'pop':
      return nf(name, (a) => {
        if (!l.items.length) raisePy('IndexError', 'pop from empty list');
        const i = a.length ? normIndex(a[0], l.items.length, 'list') : l.items.length - 1;
        return l.items.splice(i, 1)[0];
      });
    case 'clear':
      return nf(name, () => ((l.items.length = 0), null));
    case 'index':
      return rf(name, function* (a) {
        for (let i = 0; i < l.items.length; i++) if (yield* interp.eq(l.items[i], arg(a, 0))) return BigInt(i);
        return valueError(`${reprSimple(arg(a, 0))} is not in list`);
      });
    case 'count':
      return rf(name, function* (a) {
        let n = 0n;
        for (const v of l.items) if (yield* interp.eq(v, arg(a, 0))) n++;
        return n;
      });
    case 'sort':
      return rf(name, function* (a, kwargs) {
        l.items = yield* sortValues(interp, l.items, kw(kwargs, 'key'), !!(yield* interp.truthy(kw(kwargs, 'reverse', false))));
        return null;
      });
    case 'reverse':
      return nf(name, () => (l.items.reverse(), null));
    case 'copy':
      return nf(name, () => new PyList([...l.items]));
  }
  return undefined;
}

function dictMethod(interp: Interpreter, d: PyDict, name: string): PyVal | undefined {
  switch (name) {
    case 'keys':
      return nf(name, () => new PyList(d.keys()));
    case 'values':
      return nf(name, () => new PyList(d.values()));
    case 'items':
      return nf(name, () => new PyList(d.entries().map(([k, v]) => new PyTuple([k, v]))));
    case 'get':
      return nf(name, (a) => {
        const v = d.get(arg(a, 0));
        return v === undefined ? arg(a, 1) : v;
      });
    case 'pop':
      return nf(name, (a) => {
        const k = arg(a, 0);
        const v = d.get(k);
        if (v === undefined) {
          if (a.length > 1) return a[1];
          const inst = makeException('KeyError', '');
          inst.dict.set('args', new PyTuple([k]));
          throw new PyRaise(inst);
        }
        d.delete(k);
        return v;
      });
    case 'popitem':
      return nf(name, () => {
        const entries = d.entries();
        if (!entries.length) raisePy('KeyError', 'popitem(): dictionary is empty');
        const [k, v] = entries[entries.length - 1];
        d.delete(k);
        return new PyTuple([k, v]);
      });
    case 'setdefault':
      return nf(name, (a) => {
        const k = arg(a, 0);
        const existing = d.get(k);
        if (existing !== undefined) return existing;
        d.set(k, arg(a, 1));
        return arg(a, 1);
      });
    case 'update':
      return rf(name, function* (a, kwargs) {
        const src = arg(a, 0);
        if (src instanceof PyDict) for (const [k, v] of src.entries()) d.set(k, v);
        else if (src !== null) {
          for (const pair of yield* interp.iterateAll(src)) {
            const items = yield* interp.iterateAll(pair);
            d.set(items[0], items[1]);
          }
        }
        for (const [k, v] of kwargs) d.set(k, v);
        return null;
      });
    case 'clear':
      return nf(name, () => (d.map.clear(), null));
    case 'copy':
      return nf(name, () => PyDict.from(d.entries()));
  }
  return undefined;
}

function setMethod(interp: Interpreter, s: PySet, name: string): PyVal | undefined {
  const other = (v: PyVal): PySet => (v instanceof PySet ? v : PySet.from(v instanceof PyList || v instanceof PyTuple ? v.items : []));
  switch (name) {
    case 'add':
      return nf(name, (a) => (s.add(arg(a, 0)), null));
    case 'remove':
      return nf(name, (a) => {
        if (!s.delete(arg(a, 0))) {
          const inst = makeException('KeyError', '');
          inst.dict.set('args', new PyTuple([arg(a, 0)]));
          throw new PyRaise(inst);
        }
        return null;
      });
    case 'discard':
      return nf(name, (a) => (s.delete(arg(a, 0)), null));
    case 'pop':
      return nf(name, () => {
        const vals = s.values();
        if (!vals.length) raisePy('KeyError', 'pop from an empty set');
        s.delete(vals[0]);
        return vals[0];
      });
    case 'clear':
      return nf(name, () => (s.map.clear(), null));
    case 'copy':
      return nf(name, () => PySet.from(s.values()));
    case 'union':
      return rf(name, function* (a) {
        const out = PySet.from(s.values());
        for (const o of a) for (const v of yield* interp.iterateAll(o)) out.add(v);
        return out;
      });
    case 'intersection':
      return nf(name, (a) => PySet.from(s.values().filter((v) => a.every((o) => other(o).has(v)))));
    case 'difference':
      return nf(name, (a) => PySet.from(s.values().filter((v) => !a.some((o) => other(o).has(v)))));
    case 'symmetric_difference':
      return nf(name, (a) => {
        const o = other(arg(a, 0));
        return PySet.from([...s.values().filter((v) => !o.has(v)), ...o.values().filter((v) => !s.has(v))]);
      });
    case 'issubset':
      return nf(name, (a) => s.values().every((v) => other(arg(a, 0)).has(v)));
    case 'issuperset':
      return nf(name, (a) => other(arg(a, 0)).values().every((v) => s.has(v)));
    case 'isdisjoint':
      return nf(name, (a) => !s.values().some((v) => other(arg(a, 0)).has(v)));
    case 'update':
      return rf(name, function* (a) {
        for (const o of a) for (const v of yield* interp.iterateAll(o)) s.add(v);
        return null;
      });
  }
  return undefined;
}

function fileMethod(interp: Interpreter, f: PyFile, name: string): PyVal | undefined {
  const check = () => {
    if (f.closed) valueError('I/O operation on closed file');
  };
  switch (name) {
    case 'read':
      return nf(name, (a) => {
        check();
        const n = a.length && a[0] !== null ? int(a[0]) : -1;
        const out = n < 0 ? f.content.slice(f.pos) : f.content.slice(f.pos, f.pos + n);
        f.pos += out.length;
        return out;
      });
    case 'readline':
      return nf(name, () => {
        check();
        if (f.pos >= f.content.length) return '';
        const i = f.content.indexOf('\n', f.pos);
        const end = i === -1 ? f.content.length : i + 1;
        const out = f.content.slice(f.pos, end);
        f.pos = end;
        return out;
      });
    case 'readlines':
      return nf(name, () => {
        check();
        const rest = f.content.slice(f.pos);
        f.pos = f.content.length;
        return new PyList(splitKeepEnds(rest));
      });
    case 'write':
      return nf(name, (a) => {
        check();
        const text = str(arg(a, 0));
        f.content += text;
        return BigInt(text.length);
      });
    case 'writelines':
      return rf(name, function* (a) {
        check();
        for (const line of yield* interp.iterateAll(arg(a, 0))) f.content += str(line);
        return null;
      });
    case 'close':
      return nf(name, () => {
        if (!f.closed) {
          f.closed = true;
          f.onClose(f);
        }
        return null;
      });
    case '__enter__':
      return nf(name, () => f);
    case '__exit__':
      return nf(name, () => {
        if (!f.closed) {
          f.closed = true;
          f.onClose(f);
        }
        return null;
      });
    case 'closed':
      return f.closed;
  }
  return undefined;
}

function splitKeepEnds(s: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\n') {
      out.push(s.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < s.length) out.push(s.slice(start));
  return out;
}

/** `super()` proxy: attribute lookup starts after the defining class in the MRO. */
export class SuperProxy {
  constructor(
    public startAfter: PyClass,
    public inst: PyVal,
  ) {}
}

setNativeMethodResolver((interp, obj, name) => {
  if (typeof obj === 'string') return strMethod(interp, obj, name);
  if (obj instanceof PyList) return listMethod(interp, obj, name);
  if (obj instanceof PyDict) return dictMethod(interp, obj, name);
  if (obj instanceof PySet) return setMethod(interp, obj, name);
  if (obj instanceof PyFile) return fileMethod(interp, obj, name);
  if (obj instanceof PyTuple) {
    if (name === 'count') return rf(name, function* (a) {
      let n = 0n;
      for (const v of obj.items) if (yield* interp.eq(v, arg(a, 0))) n++;
      return n;
    });
    if (name === 'index') return rf(name, function* (a) {
      for (let i = 0; i < obj.items.length; i++) if (yield* interp.eq(obj.items[i], arg(a, 0))) return BigInt(i);
      return valueError('tuple.index(x): x not in tuple');
    });
  }
  if (obj instanceof PyGenerator) {
    if (name === '__next__' || name === 'send') {
      return rf(name, function* (a) {
        const r = yield* genSend(obj, arg(a, 0));
        if (r.done) raisePy('StopIteration', '');
        return r.value!;
      });
    }
    if (name === 'close') return nf(name, () => ((obj.done = true), null));
  }
  if (obj instanceof Property) {
    // Supports the @x.setter / @x.getter decorator pair.
    if (name === 'setter') return nf('setter', (a) => new Property(obj.getter, arg(a, 0)) as unknown as PyVal);
    if (name === 'getter') return nf('getter', (a) => new Property(arg(a, 0), obj.setter) as unknown as PyVal);
  }
  if (obj instanceof SuperProxy) {
    const mro = obj.inst instanceof PyInstance ? obj.inst.cls.mro : obj.startAfter.mro;
    const start = mro.indexOf(obj.startAfter);
    for (let i = start + 1; i < mro.length; i++) {
      const v = mro[i].dict.get(name);
      if (v !== undefined) {
        if (v instanceof PyFunction || v instanceof NativeFunc) return new BoundMethod(obj.inst, v);
        if (v instanceof StaticMethod) return v.func;
        return v;
      }
    }
    if (name === '__init__') return nf('__init__', () => null);
    raisePy('AttributeError', `'super' object has no attribute '${name}'`);
  }
  if (obj instanceof PyFunction) {
    if (name === '__name__') return obj.name;
    if (name === '__doc__') return obj.doc;
  }
  if (obj instanceof NativeFunc) {
    if (name === '__name__') return obj.name;
    if (name === '__doc__') return obj.doc;
  }
  if (obj instanceof PyRange) {
    if (name === 'start') return obj.start;
    if (name === 'stop') return obj.stop;
    if (name === 'step') return obj.step;
  }
  if (isNum(obj) && typeof obj !== 'string') {
    if (name === 'bit_length') return nf(name, () => BigInt(toBig(obj).toString(2).replace('-', '').length));
    if (name === 'is_integer') return nf(name, () => Number.isInteger(toNum(obj)));
  }
  return undefined;
});

// builtins
export function installBuiltins(interp: Interpreter): void {
  const B = interp.builtins;
  const io = interp.io;

  const intClass = typeClass('int', (a) => {
    if (!a.length) return 0n;
    const v = a[0];
    if (typeof v === 'string') {
      const base = a.length > 1 ? int(a[1]) : 10;
      const text = v.trim();
      const parsed = base === 10 ? (/^[+-]?\d+$/.test(text) ? BigInt(text) : null) : parseRadix(text, base);
      if (parsed === null) valueError(`invalid literal for int() with base ${base}: ${reprSimple(v)}`);
      return parsed;
    }
    if (typeof v === 'number') return BigInt(Math.trunc(v));
    if (typeof v === 'boolean') return v ? 1n : 0n;
    if (typeof v === 'bigint') return v;
    typeError(`int() argument must be a string or a number, not '${typeName(v)}'`);
  });
  const floatClass = typeClass('float', (a) => {
    if (!a.length) return 0;
    const v = a[0];
    if (typeof v === 'string') {
      const t = v.trim();
      const n = t === 'inf' ? Infinity : t === '-inf' ? -Infinity : t === 'nan' ? NaN : Number(t);
      if (Number.isNaN(n) && t !== 'nan') valueError(`could not convert string to float: ${reprSimple(v)}`);
      return n;
    }
    return num(v);
  });
  const strClass = typeClass('str', function* (a: PyVal[]) {
    return a.length ? yield* interp.str(a[0]) : '';
  } as any, true);
  const boolClass = typeClass('bool', function* (a: PyVal[]) {
    return a.length ? yield* interp.truthy(a[0]) : false;
  } as any, true);
  const listClass = typeClass('list', function* (a: PyVal[]) {
    return new PyList(a.length ? yield* interp.iterateAll(a[0]) : []);
  } as any, true);
  const tupleClass = typeClass('tuple', function* (a: PyVal[]) {
    return new PyTuple(a.length ? yield* interp.iterateAll(a[0]) : []);
  } as any, true);
  const setClass = typeClass('set', function* (a: PyVal[]) {
    return PySet.from(a.length ? yield* interp.iterateAll(a[0]) : []);
  } as any, true);
  typeClass('frozenset', function* (a: PyVal[]) {
    return PySet.from(a.length ? yield* interp.iterateAll(a[0]) : []);
  } as any, true);
  const dictClass = typeClass('dict', function* (a: PyVal[], kwargs: Map<string, PyVal>) {
    const d = new PyDict();
    const src = arg(a, 0);
    if (src instanceof PyDict) for (const [k, v] of src.entries()) d.set(k, v);
    else if (src !== null) {
      for (const pair of yield* interp.iterateAll(src)) {
        const items = yield* interp.iterateAll(pair);
        d.set(items[0], items[1]);
      }
    }
    for (const [k, v] of kwargs) d.set(k, v);
    return d;
  } as any, true);
  typeClass('object');
  TYPES.set('object', OBJECT_CLASS);
  (OBJECT_CLASS as any).nativeName = 'object';

  for (const [name, cls] of TYPES) B.set(name, cls);
  B.set('object', OBJECT_CLASS);
  for (const [name, cls] of EXCEPTIONS) if (name !== 'object') B.set(name, cls);

  B.set('True', true);
  B.set('False', false);
  B.set('None', null);
  B.set('__name__', '__main__');

  B.set('print', rf('print', function* (a, kwargs) {
    const sep = kwargs.has('sep') ? str(kwargs.get('sep')!) : ' ';
    const end = kwargs.has('end') ? (kwargs.get('end') === null ? '' : str(kwargs.get('end')!)) : '\n';
    const parts: string[] = [];
    for (const v of a) parts.push(yield* interp.str(v));
    io.write(parts.join(sep) + end);
    return null;
  }, 'print(*values, sep=" ", end="\\n")'));

  B.set('input', rf('input', function* (a) {
    const prompt = a.length ? yield* interp.str(a[0]) : '';
    const line = yield { t: 'input', prompt };
    if (line === null) raisePy('EOFError', 'EOF when reading a line');
    return line as string;
  }, 'input(prompt="") -> str'));

  B.set('len', rf('len', function* (a) {
    const v = arg(a, 0);
    if (typeof v === 'string') return BigInt(v.length);
    if (v instanceof PyList || v instanceof PyTuple) return BigInt(v.items.length);
    if (v instanceof PyDict || v instanceof PySet) return BigInt(v.size);
    if (v instanceof PyRange) return v.length;
    if (v instanceof PyInstance) {
      const m = yield* interp.findDunder(v, '__len__');
      if (m) return toBig(yield* interp.call(m, [], new Map()));
    }
    return typeError(`object of type '${typeName(v)}' has no len()`);
  }));

  B.set('range', nf('range', (a) => {
    const nums = a.map((v) => toBig(v));
    if (nums.length === 1) return new PyRange(0n, nums[0], 1n);
    if (nums.length === 2) return new PyRange(nums[0], nums[1], 1n);
    if (nums.length >= 3) {
      if (nums[2] === 0n) valueError('range() arg 3 must not be zero');
      return new PyRange(nums[0], nums[1], nums[2]);
    }
    return typeError('range expected at least 1 argument, got 0');
  }));

  B.set('enumerate', rf('enumerate', function* (a, kwargs) {
    const start = kwargs.has('start') ? toBig(kwargs.get('start')!) : a.length > 1 ? toBig(a[1]) : 0n;
    const items = yield* interp.iterateAll(arg(a, 0));
    return new PyList(items.map((v, i) => new PyTuple([start + BigInt(i), v])));
  }));

  B.set('zip', rf('zip', function* (a) {
    const lists: PyVal[][] = [];
    for (const it of a) lists.push(yield* interp.iterateAll(it));
    const n = lists.length ? Math.min(...lists.map((l) => l.length)) : 0;
    const out: PyVal[] = [];
    for (let i = 0; i < n; i++) out.push(new PyTuple(lists.map((l) => l[i])));
    return new PyList(out);
  }));

  B.set('map', rf('map', function* (a) {
    const fn = arg(a, 0);
    const lists: PyVal[][] = [];
    for (const it of a.slice(1)) lists.push(yield* interp.iterateAll(it));
    const n = lists.length ? Math.min(...lists.map((l) => l.length)) : 0;
    const out: PyVal[] = [];
    for (let i = 0; i < n; i++) out.push(yield* interp.call(fn, lists.map((l) => l[i]), new Map()));
    return new PyList(out);
  }));

  B.set('filter', rf('filter', function* (a) {
    const fn = arg(a, 0);
    const items = yield* interp.iterateAll(arg(a, 1));
    const out: PyVal[] = [];
    for (const v of items) {
      const keep = fn === null ? yield* interp.truthy(v) : yield* interp.truthy(yield* interp.call(fn, [v], new Map()));
      if (keep) out.push(v);
    }
    return new PyList(out);
  }));

  B.set('sorted', rf('sorted', function* (a, kwargs) {
    const items = yield* interp.iterateAll(arg(a, 0));
    return new PyList(yield* sortValues(interp, items, kw(kwargs, 'key'), yield* interp.truthy(kw(kwargs, 'reverse', false))));
  }));

  B.set('reversed', rf('reversed', function* (a) {
    return new PyList((yield* interp.iterateAll(arg(a, 0))).reverse());
  }));

  B.set('sum', rf('sum', function* (a) {
    let total: PyVal = a.length > 1 ? a[1] : 0n;
    for (const v of yield* interp.iterateAll(arg(a, 0))) total = yield* interp.binOp('+', total, v);
    return total;
  }));

  const minmax = (which: 'min' | 'max') =>
    rf(which, function* (a, kwargs) {
      const items = a.length === 1 ? yield* interp.iterateAll(a[0]) : a;
      if (!items.length) {
        if (kwargs.has('default')) return kwargs.get('default')!;
        valueError(`${which}() arg is an empty sequence`);
      }
      const keyFn = kw(kwargs, 'key');
      let best = items[0];
      let bestKey = keyFn ? yield* interp.call(keyFn, [best], new Map()) : best;
      for (const v of items.slice(1)) {
        const k = keyFn ? yield* interp.call(keyFn, [v], new Map()) : v;
        const better = yield* interp.compare(k, bestKey, which === 'min' ? '<' : '>');
        if (better) {
          best = v;
          bestKey = k;
        }
      }
      return best;
    });
  B.set('min', minmax('min'));
  B.set('max', minmax('max'));

  B.set('abs', rf('abs', function* (a) {
    const v = arg(a, 0);
    if (typeof v === 'bigint') return v < 0n ? -v : v;
    if (typeof v === 'number') return Math.abs(v);
    if (typeof v === 'boolean') return v ? 1n : 0n;
    if (v instanceof PyInstance) {
      const m = yield* interp.findDunder(v, '__abs__');
      if (m) return yield* interp.call(m, [], new Map());
    }
    return typeError(`bad operand type for abs(): '${typeName(v)}'`);
  }));

  B.set('round', nf('round', (a) => {
    const v = arg(a, 0);
    const digits = a.length > 1 ? int(a[1]) : 0;
    if (typeof v === 'bigint' && digits >= 0) return v;
    const out = roundHalfEven(num(v), Math.max(0, digits));
    return a.length > 1 ? out : BigInt(Math.round(out));
  }));

  B.set('pow', nf('pow', (a) => {
    const [x, y, z] = [arg(a, 0), arg(a, 1), arg(a, 2)];
    if (z !== null && typeof x === 'bigint' && typeof y === 'bigint') {
      let result = 1n;
      let base = x % toBig(z);
      let e = y;
      const m = toBig(z);
      while (e > 0n) {
        if (e & 1n) result = (result * base) % m;
        base = (base * base) % m;
        e >>= 1n;
      }
      return result;
    }
    if (typeof x === 'bigint' && typeof y === 'bigint' && y >= 0n) return x ** y;
    return Math.pow(num(x), num(y));
  }));

  B.set('divmod', nf('divmod', (a) => {
    const x = arg(a, 0);
    const y = arg(a, 1);
    if (typeof x === 'bigint' && typeof y === 'bigint') {
      if (y === 0n) raisePy('ZeroDivisionError', 'integer division or modulo by zero');
      let q = x / y;
      if (x % y !== 0n && x < 0n !== y < 0n) q -= 1n;
      return new PyTuple([q, x - q * y]);
    }
    const nx = num(x);
    const ny = num(y);
    return new PyTuple([Math.floor(nx / ny), nx - Math.floor(nx / ny) * ny]);
  }));

  B.set('type', nf('type', (a) => {
    const v = arg(a, 0);
    if (v instanceof PyInstance) return v.cls;
    if (v instanceof PyClass) return TYPES.get('type') ?? OBJECT_CLASS;
    return TYPES.get(typeName(v)) ?? OBJECT_CLASS;
  }));
  B.set('isinstance', nf('isinstance', (a) => isInstanceOf(arg(a, 0), arg(a, 1))));
  B.set('issubclass', nf('issubclass', (a) => {
    const c = arg(a, 0);
    const target = arg(a, 1);
    if (!(c instanceof PyClass)) typeError('issubclass() arg 1 must be a class');
    const targets = target instanceof PyTuple ? target.items : [target];
    return targets.some((t) => t instanceof PyClass && c.isSubclassOf(t));
  }));

  B.set('repr', rf('repr', function* (a) {
    return yield* interp.repr(arg(a, 0));
  }));
  B.set('hasattr', rf('hasattr', function* (a) {
    try {
      yield* interp.getAttr(arg(a, 0), str(arg(a, 1)));
      return true;
    } catch {
      return false;
    }
  }));
  B.set('getattr', rf('getattr', function* (a) {
    try {
      return yield* interp.getAttr(arg(a, 0), str(arg(a, 1)));
    } catch (e) {
      if (a.length > 2) return a[2];
      throw e;
    }
  }));
  B.set('setattr', rf('setattr', function* (a) {
    yield* interp.setAttr(arg(a, 0), str(arg(a, 1)), arg(a, 2));
    return null;
  }));
  B.set('delattr', nf('delattr', (a) => {
    const o = arg(a, 0);
    if (o instanceof PyInstance) o.dict.delete(str(arg(a, 1)));
    return null;
  }));
  B.set('dir', nf('dir', (a) => {
    const v = arg(a, 0);
    const names: string[] = [];
    if (v instanceof PyInstance) {
      names.push(...v.dict.keys());
      for (const c of v.cls.mro) names.push(...c.dict.keys());
    } else if (v instanceof PyClass) for (const c of v.mro) names.push(...c.dict.keys());
    else if (v instanceof PyModule) names.push(...v.dict.keys());
    return new PyList([...new Set(names)].sort());
  }));

  B.set('ord', nf('ord', (a) => BigInt(str(arg(a, 0)).codePointAt(0) ?? 0)));
  B.set('chr', nf('chr', (a) => String.fromCodePoint(int(arg(a, 0)))));
  B.set('hex', nf('hex', (a) => {
    const v = toBig(arg(a, 0));
    return v < 0n ? '-0x' + (-v).toString(16) : '0x' + v.toString(16);
  }));
  B.set('oct', nf('oct', (a) => {
    const v = toBig(arg(a, 0));
    return v < 0n ? '-0o' + (-v).toString(8) : '0o' + v.toString(8);
  }));
  B.set('bin', nf('bin', (a) => {
    const v = toBig(arg(a, 0));
    return v < 0n ? '-0b' + (-v).toString(2) : '0b' + v.toString(2);
  }));

  B.set('any', rf('any', function* (a) {
    for (const v of yield* interp.iterateAll(arg(a, 0))) if (yield* interp.truthy(v)) return true;
    return false;
  }));
  B.set('all', rf('all', function* (a) {
    for (const v of yield* interp.iterateAll(arg(a, 0))) if (!(yield* interp.truthy(v))) return false;
    return true;
  }));

  B.set('iter', rf('iter', function* (a) {
    const items = yield* interp.iterateAll(arg(a, 0));
    let i = 0;
    return new PyGenerator('iter', (function* (): Exec {
      while (i < items.length) yield { t: 'yield', value: items[i++] };
      return null;
    })());
  }));
  B.set('next', rf('next', function* (a) {
    const g = arg(a, 0);
    if (!(g instanceof PyGenerator)) {
      if (g instanceof PyInstance) {
        const m = yield* interp.findDunder(g, '__next__');
        if (m) return yield* interp.call(m, [], new Map());
      }
      typeError(`'${typeName(g)}' object is not an iterator`);
    }
    const r = yield* genSend(g as PyGenerator, null);
    if (r.done) {
      if (a.length > 1) return a[1];
      raisePy('StopIteration', '');
    }
    return r.value!;
  }));
  B.set('callable', nf('callable', (a) => {
    const v = arg(a, 0);
    return v instanceof PyFunction || v instanceof NativeFunc || v instanceof PyClass || v instanceof BoundMethod || (v instanceof PyInstance && v.cls.lookup('__call__') !== undefined);
  }));
  B.set('id', nf('id', (a) => {
    const v = arg(a, 0);
    return typeof v === 'object' && v !== null ? BigInt(objId(v)) : BigInt(hashString(keyOf(v)) >>> 0);
  }));
  B.set('hash', nf('hash', (a) => BigInt(hashString(keyOf(arg(a, 0))))));
  B.set('format', rf('format', function* (a) {
    const v = arg(a, 0);
    const spec = a.length > 1 ? str(a[1]) : '';
    if (!spec) return yield* interp.str(v);
    const out = formatValue(v, spec);
    if (out !== null) return out;
    const s = yield* interp.str(v);
    return formatValue(s, spec) ?? s;
  }));

  B.set('open', nf('open', (a) => {
    const path = str(arg(a, 0)).replace(/^\.\//, '');
    const mode = a.length > 1 ? str(a[1]) : 'r';
    const existing = io.readFile(path);
    if (mode.includes('r') && existing === null) raisePy('FileNotFoundError', `[Errno 2] No such file or directory: ${reprSimple(path)}`);
    const content = mode.includes('w') ? '' : (existing ?? '');
    const file = new PyFile(path, mode, content, (f) => {
      if (/[wa+]/.test(f.mode)) io.writeFile(f.path, f.content);
    });
    if (mode.includes('a')) file.pos = content.length;
    return file;
  }));

  B.set('super', rf('super', function* (a) {
    if (a.length >= 2) return new SuperProxy(a[0] as PyClass, a[1]) as unknown as PyVal;
    for (let i = interp.frames.length - 1; i >= 0; i--) {
      const f = interp.frames[i];
      const cls = f.func ? ((f.func as any).definingClass as PyClass | undefined) : undefined;
      if (cls) {
        const first = f.func!.params.args[0]?.name;
        const self = first ? f.scope.vars.get(first) ?? null : null;
        return new SuperProxy(cls, self) as unknown as PyVal;
      }
    }
    return raisePy('RuntimeError', 'super(): no arguments');
  }));

  B.set('staticmethod', nf('staticmethod', (a) => new StaticMethod(arg(a, 0)) as unknown as PyVal));
  B.set('classmethod', nf('classmethod', (a) => new ClassMethod(arg(a, 0)) as unknown as PyVal));
  const propertyClass = nf('property', (a) => new Property(arg(a, 0), arg(a, 1)) as unknown as PyVal);
  B.set('property', propertyClass);
  B.set('slice', nf('slice', (a) => (a.length === 1 ? new PySlice(null, a[0], null) : new PySlice(arg(a, 0), arg(a, 1), arg(a, 2)))));
  B.set('exit', nf('exit', () => raisePy('SystemExit', '')));
  B.set('quit', B.get('exit')!);
  B.set('help', rf('help', function* (a) {
    const v = arg(a, 0);
    if (v instanceof NativeFunc && v.doc) io.write(v.doc + '\n');
    else if (v instanceof PyFunction && v.doc) io.write(v.doc + '\n');
    else io.write('No documentation available.\n');
    return null;
  }));
}

// Python rounds on the double's true value, halves to even. Scaling by 10^n
// first gets ties wrong (2.675 * 100 == 267.5 in floating point).
function roundHalfEven(n: number, digits: number): number {
  if (!Number.isFinite(n)) return n;
  const neg = n < 0;
  const expanded = Math.abs(n).toFixed(Math.min(100, digits + 25));
  const dot = expanded.indexOf('.');
  const frac = expanded.slice(dot + 1);
  let base = BigInt(expanded.slice(0, dot) + frac.slice(0, digits));
  const rest = frac.slice(digits);
  const roundUp = /^50*$/.test(rest) ? base % 2n === 1n : rest !== '' && rest[0] >= '5';
  if (roundUp) base += 1n;
  const out = Number(base) / Math.pow(10, digits);
  return neg ? -out : out;
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

function parseRadix(text: string, base: number): bigint | null {
  const t = text.toLowerCase().replace(/^([+-]?)0[xob]/, '$1');
  try {
    const neg = t.startsWith('-');
    const digits = t.replace(/^[+-]/, '');
    if (!digits.length) return null;
    let out = 0n;
    for (const ch of digits) {
      const d = parseInt(ch, base);
      if (Number.isNaN(d)) return null;
      out = out * BigInt(base) + BigInt(d);
    }
    return neg ? -out : out;
  } catch {
    return null;
  }
}

// modules
function mod(name: string, build: (interp: Interpreter, m: PyModule) => void): void {
  MODULE_BUILDERS.set(name, (interp) => {
    const m = new PyModule(name);
    m.dict.set('__name__', name);
    build(interp, m);
    return m;
  });
}

let randomState = 123456789;
function nextRandom(): number {
  randomState = (randomState + 0x6d2b79f5) | 0;
  let t = randomState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function seedRandom(n: number): void {
  randomState = n | 0;
}

mod('math', (interp, m) => {
  const d = m.dict;
  const un = (name: string, fn: (x: number) => number) => d.set(name, nf(name, (a) => fn(num(arg(a, 0)))));
  d.set('pi', Math.PI);
  d.set('e', Math.E);
  d.set('tau', Math.PI * 2);
  d.set('inf', Infinity);
  d.set('nan', NaN);
  un('sqrt', (x) => {
    if (x < 0) valueError('math domain error');
    return Math.sqrt(x);
  });
  un('sin', Math.sin);
  un('cos', Math.cos);
  un('tan', Math.tan);
  un('asin', Math.asin);
  un('acos', Math.acos);
  un('atan', Math.atan);
  un('sinh', Math.sinh);
  un('cosh', Math.cosh);
  un('tanh', Math.tanh);
  un('exp', Math.exp);
  un('degrees', (x) => (x * 180) / Math.PI);
  un('radians', (x) => (x * Math.PI) / 180);
  un('fabs', Math.abs);
  d.set('floor', nf('floor', (a) => BigInt(Math.floor(num(arg(a, 0))))));
  d.set('ceil', nf('ceil', (a) => BigInt(Math.ceil(num(arg(a, 0))))));
  d.set('trunc', nf('trunc', (a) => BigInt(Math.trunc(num(arg(a, 0))))));
  d.set('log', nf('log', (a) => {
    const x = num(arg(a, 0));
    if (x <= 0) valueError('math domain error');
    return a.length > 1 ? Math.log(x) / Math.log(num(a[1])) : Math.log(x);
  }));
  d.set('log2', nf('log2', (a) => Math.log2(num(arg(a, 0)))));
  d.set('log10', nf('log10', (a) => Math.log10(num(arg(a, 0)))));
  d.set('pow', nf('pow', (a) => Math.pow(num(arg(a, 0)), num(arg(a, 1)))));
  d.set('atan2', nf('atan2', (a) => Math.atan2(num(arg(a, 0)), num(arg(a, 1)))));
  d.set('hypot', nf('hypot', (a) => Math.hypot(...a.map(num))));
  d.set('factorial', nf('factorial', (a) => {
    let n = toBig(arg(a, 0));
    if (n < 0n) valueError('factorial() not defined for negative values');
    let out = 1n;
    for (let i = 2n; i <= n; i++) out *= i;
    return out;
  }));
  d.set('gcd', nf('gcd', (a) => {
    let x = toBig(arg(a, 0));
    let y = toBig(arg(a, 1));
    x = x < 0n ? -x : x;
    y = y < 0n ? -y : y;
    while (y) [x, y] = [y, x % y];
    return x;
  }));
  d.set('isqrt', nf('isqrt', (a) => BigInt(Math.floor(Math.sqrt(num(arg(a, 0)))))));
  d.set('isnan', nf('isnan', (a) => Number.isNaN(num(arg(a, 0)))));
  d.set('isinf', nf('isinf', (a) => !Number.isFinite(num(arg(a, 0))) && !Number.isNaN(num(arg(a, 0)))));
  d.set('isclose', nf('isclose', (a, kwargs) => {
    const rel = kwargs.has('rel_tol') ? num(kwargs.get('rel_tol')!) : 1e-9;
    const abs = kwargs.has('abs_tol') ? num(kwargs.get('abs_tol')!) : 0;
    const x = num(arg(a, 0));
    const y = num(arg(a, 1));
    return Math.abs(x - y) <= Math.max(rel * Math.max(Math.abs(x), Math.abs(y)), abs);
  }));
  d.set('prod', rf('prod', function* (a) {
    let out: PyVal = 1n;
    for (const v of yield* interp.iterateAll(arg(a, 0))) out = yield* interp.binOp('*', out, v);
    return out;
  }));
});

mod('random', (interp, m) => {
  const d = m.dict;
  d.set('random', nf('random', () => nextRandom()));
  d.set('seed', nf('seed', (a) => {
    const v = arg(a, 0);
    seedRandom(v === null ? Date.now() : Number(toBig(isNum(v) ? v : BigInt(hashString(String(v))))));
    return null;
  }));
  d.set('randint', nf('randint', (a) => {
    const lo = toBig(arg(a, 0));
    const hi = toBig(arg(a, 1));
    return lo + BigInt(Math.floor(nextRandom() * Number(hi - lo + 1n)));
  }));
  d.set('randrange', nf('randrange', (a) => {
    const lo = a.length > 1 ? toBig(a[0]) : 0n;
    const hi = a.length > 1 ? toBig(a[1]) : toBig(a[0]);
    const step = a.length > 2 ? toBig(a[2]) : 1n;
    const n = Number((hi - lo + step - 1n) / step);
    return lo + BigInt(Math.floor(nextRandom() * n)) * step;
  }));
  d.set('choice', rf('choice', function* (a) {
    const items = yield* interp.iterateAll(arg(a, 0));
    if (!items.length) raisePy('IndexError', 'Cannot choose from an empty sequence');
    return items[Math.floor(nextRandom() * items.length)];
  }));
  d.set('choices', rf('choices', function* (a, kwargs) {
    const items = yield* interp.iterateAll(arg(a, 0));
    const k = kwargs.has('k') ? int(kwargs.get('k')!) : a.length > 1 ? int(a[1]) : 1;
    const out: PyVal[] = [];
    for (let i = 0; i < k; i++) out.push(items[Math.floor(nextRandom() * items.length)]);
    return new PyList(out);
  }));
  d.set('shuffle', nf('shuffle', (a) => {
    const l = arg(a, 0);
    if (!(l instanceof PyList)) typeError('shuffle() requires a list');
    for (let i = l.items.length - 1; i > 0; i--) {
      const j = Math.floor(nextRandom() * (i + 1));
      [l.items[i], l.items[j]] = [l.items[j], l.items[i]];
    }
    return null;
  }));
  d.set('sample', rf('sample', function* (a) {
    const items = [...(yield* interp.iterateAll(arg(a, 0)))];
    const k = int(arg(a, 1));
    if (k > items.length) valueError('Sample larger than population');
    const out: PyVal[] = [];
    for (let i = 0; i < k; i++) out.push(...items.splice(Math.floor(nextRandom() * items.length), 1));
    return new PyList(out);
  }));
  d.set('uniform', nf('uniform', (a) => {
    const lo = num(arg(a, 0));
    return lo + nextRandom() * (num(arg(a, 1)) - lo);
  }));
  d.set('gauss', nf('gauss', (a) => {
    const mu = a.length ? num(a[0]) : 0;
    const sigma = a.length > 1 ? num(a[1]) : 1;
    const u = Math.max(nextRandom(), 1e-12);
    return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * nextRandom());
  }));
});

mod('json', (interp, m) => {
  const toJson = function* (v: PyVal, indent: number, level: number): Exec<string> {
    const pad = indent ? '\n' + ' '.repeat(indent * (level + 1)) : '';
    const padEnd = indent ? '\n' + ' '.repeat(indent * level) : '';
    if (v === null) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'number') return Number.isFinite(v) ? floatRepr(v) : v > 0 ? 'Infinity' : Number.isNaN(v) ? 'NaN' : '-Infinity';
    if (typeof v === 'string') return JSON.stringify(v);
    if (v instanceof PyList || v instanceof PyTuple) {
      if (!v.items.length) return '[]';
      const parts: string[] = [];
      for (const it of v.items) parts.push(yield* toJson(it, indent, level + 1));
      return '[' + pad + parts.join(',' + (pad || ' ')) + padEnd + ']';
    }
    if (v instanceof PyDict) {
      if (!v.size) return '{}';
      const parts: string[] = [];
      for (const [k, val] of v.entries()) {
        const key = typeof k === 'string' ? k : yield* interp.str(k);
        parts.push(JSON.stringify(key) + ': ' + (yield* toJson(val, indent, level + 1)));
      }
      return '{' + pad + parts.join(',' + (pad || ' ')) + padEnd + '}';
    }
    return typeError(`Object of type ${typeName(v)} is not JSON serializable`);
  };
  const fromJson = (v: any): PyVal => {
    if (v === null) return null;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return Number.isInteger(v) ? BigInt(v) : v;
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return new PyList(v.map(fromJson));
    return PyDict.from(Object.entries(v).map(([k, val]) => [k, fromJson(val)] as [PyVal, PyVal]));
  };
  m.dict.set('dumps', rf('dumps', function* (a, kwargs) {
    const indent = kwargs.has('indent') && kwargs.get('indent') !== null ? int(kwargs.get('indent')!) : 0;
    return yield* toJson(arg(a, 0), indent, 0);
  }));
  m.dict.set('loads', nf('loads', (a) => {
    try {
      return fromJson(JSON.parse(str(arg(a, 0))));
    } catch (e: any) {
      return valueError(`Expecting value: ${e.message}`);
    }
  }));
  m.dict.set('dump', rf('dump', function* (a, kwargs) {
    const text = yield* toJson(arg(a, 0), kwargs.has('indent') ? int(kwargs.get('indent')!) : 0, 0);
    const f = arg(a, 1);
    if (f instanceof PyFile) f.content += text;
    return null;
  }));
  m.dict.set('load', nf('load', (a) => {
    const f = arg(a, 0);
    if (!(f instanceof PyFile)) typeError('load() requires a file');
    return fromJson(JSON.parse(f.content.slice(f.pos)));
  }));
});

mod('time', (interp, m) => {
  m.dict.set('time', nf('time', () => interp.io.now() / 1000));
  m.dict.set('sleep', rf('sleep', function* (a) {
    yield { t: 'sleep', ms: num(arg(a, 0)) * 1000 };
    return null;
  }));
  m.dict.set('monotonic', nf('monotonic', () => interp.io.now() / 1000));
  m.dict.set('perf_counter', nf('perf_counter', () => interp.io.now() / 1000));
  m.dict.set('strftime', nf('strftime', (a) => new Date().toISOString()));
});

mod('sys', (interp, m) => {
  m.dict.set('version', '3.12.0 (CrazyCodeEditor built-in interpreter)');
  m.dict.set('version_info', new PyTuple([3n, 12n, 0n]));
  m.dict.set('platform', 'crazy');
  m.dict.set('argv', new PyList(['main.py']));
  m.dict.set('maxsize', BigInt(Number.MAX_SAFE_INTEGER));
  m.dict.set('path', new PyList(['']));
  m.dict.set('exit', nf('exit', (a) => {
    const inst = makeException('SystemExit', '');
    inst.dict.set('args', new PyTuple(a.length ? [a[0]] : []));
    throw new PyRaise(inst);
  }));
  const stdout = new PyInstance(new PyClass('TextIO', [OBJECT_CLASS]));
  stdout.cls.dict.set('write', nf('write', (a) => {
    interp.io.write(str(arg(a, 1)));
    return BigInt(str(arg(a, 1)).length);
  }));
  stdout.cls.dict.set('flush', nf('flush', () => null));
  m.dict.set('stdout', stdout);
  m.dict.set('stderr', stdout);
});

mod('os', (interp, m) => {
  const path = new PyModule('os.path');
  path.dict.set('join', nf('join', (a) => a.map((v) => str(v)).filter((s, i) => s !== '' || i === 0).join('/').replace(/\/+/g, '/')));
  path.dict.set('exists', nf('exists', (a) => interp.io.exists(str(arg(a, 0)))));
  path.dict.set('basename', nf('basename', (a) => str(arg(a, 0)).split('/').pop() ?? ''));
  path.dict.set('dirname', nf('dirname', (a) => {
    const p = str(arg(a, 0));
    const i = p.lastIndexOf('/');
    return i === -1 ? '' : p.slice(0, i);
  }));
  path.dict.set('splitext', nf('splitext', (a) => {
    const p = str(arg(a, 0));
    const i = p.lastIndexOf('.');
    return i <= 0 ? new PyTuple([p, '']) : new PyTuple([p.slice(0, i), p.slice(i)]);
  }));
  path.dict.set('isfile', nf('isfile', (a) => interp.io.exists(str(arg(a, 0)))));
  path.dict.set('isdir', nf('isdir', (a) => interp.io.listDir(str(arg(a, 0))).length > 0));
  m.dict.set('path', path);
  MODULE_BUILDERS.set('os.path', () => path);
  m.dict.set('listdir', nf('listdir', (a) => new PyList(interp.io.listDir(a.length ? str(a[0]) : ''))));
  m.dict.set('getcwd', nf('getcwd', () => '/workspace'));
  m.dict.set('remove', nf('remove', (a) => (interp.io.remove(str(arg(a, 0))), null)));
  m.dict.set('sep', '/');
  m.dict.set('linesep', '\n');
  m.dict.set('name', 'posix');
  m.dict.set('environ', new PyDict());
});

mod('string', (interp, m) => {
  m.dict.set('ascii_lowercase', 'abcdefghijklmnopqrstuvwxyz');
  m.dict.set('ascii_uppercase', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  m.dict.set('ascii_letters', 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ');
  m.dict.set('digits', '0123456789');
  m.dict.set('hexdigits', '0123456789abcdefABCDEF');
  m.dict.set('punctuation', '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');
  m.dict.set('whitespace', ' \t\n\r\v\f');
  m.dict.set('printable', '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~ \t\n\r\v\f');
});

mod('itertools', (interp, m) => {
  const d = m.dict;
  const lazy = (name: string, make: (args: PyVal[]) => Generator<PyVal, void, unknown>) =>
    d.set(name, nf(name, (a) => {
      const it = make(a);
      return new PyGenerator(name, (function* (): Exec {
        for (;;) {
          const r = it.next();
          if (r.done) return null;
          yield { t: 'yield', value: r.value as PyVal };
        }
      })());
    }));
  lazy('count', function* (a) {
    let n = a.length ? toBig(a[0]) : 0n;
    const step = a.length > 1 ? toBig(a[1]) : 1n;
    for (;;) {
      yield n;
      n += step;
    }
  });
  lazy('repeat', function* (a) {
    const v = arg(a, 0);
    if (a.length > 1) {
      for (let i = 0; i < int(a[1]); i++) yield v;
    } else for (;;) yield v;
  });
  d.set('cycle', rf('cycle', function* (a) {
    const items = yield* interp.iterateAll(arg(a, 0));
    return new PyGenerator('cycle', (function* (): Exec {
      if (!items.length) return null;
      for (let i = 0; ; i = (i + 1) % items.length) yield { t: 'yield', value: items[i] };
    })());
  }));
  d.set('chain', rf('chain', function* (a) {
    const out: PyVal[] = [];
    for (const it of a) out.push(...(yield* interp.iterateAll(it)));
    return new PyList(out);
  }));
  d.set('islice', rf('islice', function* (a) {
    // lazy: the source may be infinite (itertools.count)
    const it = yield* interp.getIter(arg(a, 0));
    const limit = (v: PyVal) => (v === null ? Infinity : int(v));
    const start = a.length > 2 ? limit(a[1]) : 0;
    const stop = a.length > 2 ? limit(a[2]) : a.length > 1 ? limit(a[1]) : Infinity;
    const out: PyVal[] = [];
    for (let i = 0; i < stop; i++) {
      const step = yield* it.next();
      if (step.done) break;
      if (i >= start) out.push(step.value!);
    }
    return new PyList(out);
  }));
  d.set('product', rf('product', function* (a, kwargs) {
    const lists: PyVal[][] = [];
    for (const it of a) lists.push(yield* interp.iterateAll(it));
    const repeat = kwargs.has('repeat') ? int(kwargs.get('repeat')!) : 1;
    const pools: PyVal[][] = [];
    for (let i = 0; i < repeat; i++) pools.push(...lists.map((l) => [...l]));
    let result: PyVal[][] = [[]];
    for (const pool of pools) {
      const next: PyVal[][] = [];
      for (const prefix of result) for (const v of pool) next.push([...prefix, v]);
      result = next;
    }
    return new PyList(result.map((r) => new PyTuple(r)));
  }));
  d.set('permutations', rf('permutations', function* (a) {
    const items = yield* interp.iterateAll(arg(a, 0));
    const r = a.length > 1 ? int(a[1]) : items.length;
    const out: PyVal[] = [];
    const walk = (prefix: PyVal[], rest: PyVal[]) => {
      if (prefix.length === r) {
        out.push(new PyTuple(prefix));
        return;
      }
      rest.forEach((v, i) => walk([...prefix, v], [...rest.slice(0, i), ...rest.slice(i + 1)]));
    };
    walk([], items);
    return new PyList(out);
  }));
  d.set('combinations', rf('combinations', function* (a) {
    const items = yield* interp.iterateAll(arg(a, 0));
    const r = int(arg(a, 1));
    const out: PyVal[] = [];
    const walk = (start: number, prefix: PyVal[]) => {
      if (prefix.length === r) {
        out.push(new PyTuple(prefix));
        return;
      }
      for (let i = start; i < items.length; i++) walk(i + 1, [...prefix, items[i]]);
    };
    walk(0, []);
    return new PyList(out);
  }));
  d.set('accumulate', rf('accumulate', function* (a) {
    const items = yield* interp.iterateAll(arg(a, 0));
    const fn = arg(a, 1);
    const out: PyVal[] = [];
    let acc: PyVal = null;
    for (const [i, v] of items.entries()) {
      acc = i === 0 ? v : fn ? yield* interp.call(fn, [acc, v], new Map()) : yield* interp.binOp('+', acc, v);
      out.push(acc);
    }
    return new PyList(out);
  }));
  d.set('groupby', rf('groupby', function* (a) {
    const items = yield* interp.iterateAll(arg(a, 0));
    const keyFn = arg(a, 1);
    const out: PyVal[] = [];
    let currentKey: PyVal = null;
    let group: PyVal[] = [];
    for (const v of items) {
      const k = keyFn ? yield* interp.call(keyFn, [v], new Map()) : v;
      if (group.length && !(yield* interp.eq(k, currentKey))) {
        out.push(new PyTuple([currentKey, new PyList(group)]));
        group = [];
      }
      currentKey = k;
      group.push(v);
    }
    if (group.length) out.push(new PyTuple([currentKey, new PyList(group)]));
    return new PyList(out);
  }));
});

mod('functools', (interp, m) => {
  m.dict.set('reduce', rf('reduce', function* (a) {
    const fn = arg(a, 0);
    const items = yield* interp.iterateAll(arg(a, 1));
    let acc: PyVal;
    let start = 0;
    if (a.length > 2) acc = a[2];
    else {
      if (!items.length) typeError('reduce() of empty iterable with no initial value');
      acc = items[0];
      start = 1;
    }
    for (let i = start; i < items.length; i++) acc = yield* interp.call(fn, [acc, items[i]], new Map());
    return acc;
  }));
  m.dict.set('partial', nf('partial', (a, kwargs) => {
    const fn = arg(a, 0);
    const bound = a.slice(1);
    return rf('partial', function* (more, moreKw) {
      const merged = new Map(kwargs);
      for (const [k, v] of moreKw) merged.set(k, v);
      return yield* interp.call(fn, [...bound, ...more], merged);
    });
  }));
  m.dict.set('lru_cache', nf('lru_cache', () =>
    nf('decorator', (a) => {
      const fn = arg(a, 0);
      const cache = new Map<string, PyVal>();
      return rf('cached', function* (args) {
        const key = args.map((v) => keyOf(v)).join('|');
        if (cache.has(key)) return cache.get(key)!;
        const out = yield* interp.call(fn, args, new Map());
        cache.set(key, out);
        return out;
      });
    }),
  ));
  m.dict.set('cache', m.dict.get('lru_cache')!);
});

mod('collections', (interp, m) => {
  // Counter and defaultdict wrap a PyDict but keep Python's lookup behaviour.
  const counterClass = new PyClass('Counter', [OBJECT_CLASS]);
  const inner = (self: PyVal): PyDict => (self as PyInstance).dict.get('_d') as PyDict;
  counterClass.dict.set('__init__', rf('__init__', function* (a) {
    const self = a[0] as PyInstance;
    const d = new PyDict();
    self.dict.set('_d', d);
    const src = arg(a, 1);
    if (src !== null) {
      if (src instanceof PyDict) for (const [k, v] of src.entries()) d.set(k, v);
      else for (const v of yield* interp.iterateAll(src)) d.set(v, ((d.get(v) as bigint) ?? 0n) + 1n);
    }
    return null;
  }));
  counterClass.dict.set('__getitem__', nf('__getitem__', (a) => inner(a[0]).get(a[1]) ?? 0n));
  counterClass.dict.set('__setitem__', nf('__setitem__', (a) => (inner(a[0]).set(a[1], a[2]), null)));
  counterClass.dict.set('__len__', nf('__len__', (a) => BigInt(inner(a[0]).size)));
  counterClass.dict.set('__contains__', nf('__contains__', (a) => inner(a[0]).has(a[1])));
  counterClass.dict.set('__iter__', rf('__iter__', function* (a) {
    const keys = inner(a[0]).keys();
    return new PyGenerator('counter', (function* (): Exec {
      for (const k of keys) yield { t: 'yield', value: k };
      return null;
    })());
  }));
  counterClass.dict.set('__repr__', rf('__repr__', function* (a) {
    return 'Counter(' + (yield* interp.repr(inner(a[0]))) + ')';
  }));
  counterClass.dict.set('most_common', rf('most_common', function* (a) {
    const entries = inner(a[0]).entries();
    entries.sort((x, y) => Number(toBig(y[1])) - Number(toBig(x[1])));
    const n = a.length > 1 ? int(a[1]) : entries.length;
    return new PyList(entries.slice(0, n).map(([k, v]) => new PyTuple([k, v])));
  }));
  for (const name of ['keys', 'values', 'items', 'get', 'update']) {
    counterClass.dict.set(name, rf(name, function* (a, kwargs) {
      const method = yield* interp.getAttr(inner(a[0]), name);
      return yield* interp.call(method, a.slice(1), kwargs);
    }));
  }
  m.dict.set('Counter', counterClass);

  const ddClass = new PyClass('defaultdict', [OBJECT_CLASS]);
  ddClass.dict.set('__init__', rf('__init__', function* (a) {
    const self = a[0] as PyInstance;
    self.dict.set('_factory', arg(a, 1));
    self.dict.set('_d', new PyDict());
    return null;
  }));
  ddClass.dict.set('__getitem__', rf('__getitem__', function* (a) {
    const self = a[0] as PyInstance;
    const d = inner(self);
    const existing = d.get(a[1]);
    if (existing !== undefined) return existing;
    const factory = self.dict.get('_factory');
    if (!factory) raisePy('KeyError', reprSimple(a[1]));
    const v = yield* interp.call(factory, [], new Map());
    d.set(a[1], v);
    return v;
  }));
  ddClass.dict.set('__setitem__', nf('__setitem__', (a) => (inner(a[0]).set(a[1], a[2]), null)));
  ddClass.dict.set('__len__', nf('__len__', (a) => BigInt(inner(a[0]).size)));
  ddClass.dict.set('__contains__', nf('__contains__', (a) => inner(a[0]).has(a[1])));
  ddClass.dict.set('__repr__', rf('__repr__', function* (a) {
    return 'defaultdict(' + (yield* interp.repr(inner(a[0]))) + ')';
  }));
  ddClass.dict.set('__iter__', rf('__iter__', function* (a) {
    const keys = inner(a[0]).keys();
    return new PyGenerator('dd', (function* (): Exec {
      for (const k of keys) yield { t: 'yield', value: k };
      return null;
    })());
  }));
  for (const name of ['keys', 'values', 'items', 'get', 'update', 'pop']) {
    ddClass.dict.set(name, rf(name, function* (a, kwargs) {
      const method = yield* interp.getAttr(inner(a[0]), name);
      return yield* interp.call(method, a.slice(1), kwargs);
    }));
  }
  m.dict.set('defaultdict', ddClass);

  const dequeClass = new PyClass('deque', [OBJECT_CLASS]);
  const items = (self: PyVal): PyList => (self as PyInstance).dict.get('_l') as PyList;
  dequeClass.dict.set('__init__', rf('__init__', function* (a) {
    (a[0] as PyInstance).dict.set('_l', new PyList(arg(a, 1) === null ? [] : yield* interp.iterateAll(a[1])));
    return null;
  }));
  dequeClass.dict.set('append', nf('append', (a) => (items(a[0]).items.push(a[1]), null)));
  dequeClass.dict.set('appendleft', nf('appendleft', (a) => (items(a[0]).items.unshift(a[1]), null)));
  dequeClass.dict.set('pop', nf('pop', (a) => {
    const l = items(a[0]).items;
    if (!l.length) raisePy('IndexError', 'pop from an empty deque');
    return l.pop()!;
  }));
  dequeClass.dict.set('popleft', nf('popleft', (a) => {
    const l = items(a[0]).items;
    if (!l.length) raisePy('IndexError', 'pop from an empty deque');
    return l.shift()!;
  }));
  dequeClass.dict.set('__len__', nf('__len__', (a) => BigInt(items(a[0]).items.length)));
  dequeClass.dict.set('__getitem__', nf('__getitem__', (a) => items(a[0]).items[normIndex(a[1], items(a[0]).items.length, 'deque')]));
  dequeClass.dict.set('__iter__', rf('__iter__', function* (a) {
    const list = [...items(a[0]).items];
    return new PyGenerator('deque', (function* (): Exec {
      for (const v of list) yield { t: 'yield', value: v };
      return null;
    })());
  }));
  dequeClass.dict.set('__repr__', rf('__repr__', function* (a) {
    return 'deque(' + (yield* interp.repr(items(a[0]))) + ')';
  }));
  m.dict.set('deque', dequeClass);

  m.dict.set('OrderedDict', TYPES.get('dict')!);
  m.dict.set('namedtuple', rf('namedtuple', function* (a) {
    const name = str(arg(a, 0));
    const fieldsArg = arg(a, 1);
    const fields = typeof fieldsArg === 'string' ? fieldsArg.split(/[,\s]+/).filter(Boolean) : (yield* interp.iterateAll(fieldsArg)).map((v) => str(v));
    const cls = new PyClass(name, [OBJECT_CLASS]);
    cls.dict.set('_fields', new PyTuple(fields));
    cls.dict.set('__init__', nf('__init__', (args, kwargs) => {
      const self = args[0] as PyInstance;
      fields.forEach((f, i) => self.dict.set(f, i + 1 < args.length ? args[i + 1] : (kwargs.get(f) ?? null)));
      return null;
    }));
    cls.dict.set('__repr__', rf('__repr__', function* (args) {
      const self = args[0] as PyInstance;
      const parts: string[] = [];
      for (const f of fields) parts.push(`${f}=${yield* interp.repr(self.dict.get(f) ?? null)}`);
      return `${name}(${parts.join(', ')})`;
    }));
    cls.dict.set('__getitem__', nf('__getitem__', (args) => {
      const self = args[0] as PyInstance;
      return self.dict.get(fields[normIndex(args[1], fields.length, name)]) ?? null;
    }));
    cls.dict.set('__len__', nf('__len__', () => BigInt(fields.length)));
    cls.dict.set('__iter__', rf('__iter__', function* (args) {
      const self = args[0] as PyInstance;
      const vals = fields.map((f) => self.dict.get(f) ?? null);
      return new PyGenerator(name, (function* (): Exec {
        for (const v of vals) yield { t: 'yield', value: v };
        return null;
      })());
    }));
    return cls;
  }));
});

mod('statistics', (interp, m) => {
  const nums = function* (v: PyVal): Exec<number[]> {
    return (yield* interp.iterateAll(v)).map(num);
  };
  m.dict.set('mean', rf('mean', function* (a) {
    const xs = yield* nums(arg(a, 0));
    if (!xs.length) valueError('mean requires at least one data point');
    return xs.reduce((s, x) => s + x, 0) / xs.length;
  }));
  m.dict.set('median', rf('median', function* (a) {
    // Odd counts return the middle item unchanged, so ints stay ints.
    const items = (yield* interp.iterateAll(arg(a, 0))).slice().sort((p, q) => num(p) - num(q));
    if (!items.length) valueError('median requires at least one data point');
    const mid = items.length >> 1;
    return items.length % 2 ? items[mid] : (num(items[mid - 1]) + num(items[mid])) / 2;
  }));
  m.dict.set('mode', rf('mode', function* (a) {
    const xs = yield* interp.iterateAll(arg(a, 0));
    const counts = new Map<string, { v: PyVal; n: number }>();
    for (const x of xs) {
      const k = keyOf(x);
      counts.set(k, { v: x, n: (counts.get(k)?.n ?? 0) + 1 });
    }
    let best: { v: PyVal; n: number } | null = null;
    for (const c of counts.values()) if (!best || c.n > best.n) best = c;
    if (!best) valueError('no mode for empty data');
    return best.v;
  }));
  m.dict.set('stdev', rf('stdev', function* (a) {
    const xs = yield* nums(arg(a, 0));
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    return Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1));
  }));
  m.dict.set('pstdev', rf('pstdev', function* (a) {
    const xs = yield* nums(arg(a, 0));
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    return Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length);
  }));
});

mod('copy', (interp, m) => {
  const shallow = (v: PyVal): PyVal => {
    if (v instanceof PyList) return new PyList([...v.items]);
    if (v instanceof PyDict) return PyDict.from(v.entries());
    if (v instanceof PySet) return PySet.from(v.values());
    if (v instanceof PyTuple) return new PyTuple([...v.items]);
    return v;
  };
  const deep = (v: PyVal, seen = new Map<any, PyVal>()): PyVal => {
    if (seen.has(v as any)) return seen.get(v as any)!;
    if (v instanceof PyList) {
      const out = new PyList([]);
      seen.set(v, out);
      out.items = v.items.map((x) => deep(x, seen));
      return out;
    }
    if (v instanceof PyDict) {
      const out = new PyDict();
      seen.set(v, out);
      for (const [k, val] of v.entries()) out.set(deep(k, seen), deep(val, seen));
      return out;
    }
    if (v instanceof PySet) return PySet.from(v.values().map((x) => deep(x, seen)));
    if (v instanceof PyTuple) return new PyTuple(v.items.map((x) => deep(x, seen)));
    if (v instanceof PyInstance) {
      const out = new PyInstance(v.cls);
      seen.set(v, out);
      for (const [k, val] of v.dict) out.dict.set(k, deep(val, seen));
      return out;
    }
    return v;
  };
  m.dict.set('copy', nf('copy', (a) => shallow(arg(a, 0))));
  m.dict.set('deepcopy', nf('deepcopy', (a) => deep(arg(a, 0))));
});

mod('re', (interp, m) => {
  const matchClass = new PyClass('Match', [OBJECT_CLASS]);
  const dataOf = (self: PyVal) => (self as PyInstance).dict;
  const makeMatch = (mm: RegExpMatchArray, input: string): PyInstance => {
    const inst = new PyInstance(matchClass);
    inst.dict.set('_groups', new PyList(mm.map((g) => (g === undefined ? null : g))));
    inst.dict.set('_start', BigInt(mm.index ?? 0));
    inst.dict.set('_input', input);
    inst.dict.set('_named', PyDict.from(Object.entries(mm.groups ?? {}).map(([k, v]) => [k, v ?? null] as [PyVal, PyVal])));
    return inst;
  };
  matchClass.dict.set('group', nf('group', (a) => {
    const groups = dataOf(a[0]).get('_groups') as PyList;
    if (a.length <= 1) return groups.items[0];
    const idx = a[1];
    if (typeof idx === 'string') return (dataOf(a[0]).get('_named') as PyDict).get(idx) ?? null;
    return groups.items[int(idx)] ?? null;
  }));
  matchClass.dict.set('groups', nf('groups', (a) => new PyList((dataOf(a[0]).get('_groups') as PyList).items.slice(1))));
  matchClass.dict.set('groupdict', nf('groupdict', (a) => dataOf(a[0]).get('_named')!));
  matchClass.dict.set('start', nf('start', (a) => dataOf(a[0]).get('_start')!));
  matchClass.dict.set('end', nf('end', (a) => {
    const groups = dataOf(a[0]).get('_groups') as PyList;
    return toBig(dataOf(a[0]).get('_start')!) + BigInt(String(groups.items[0] ?? '').length);
  }));
  matchClass.dict.set('span', nf('span', (a) => {
    const start = toBig(dataOf(a[0]).get('_start')!);
    const groups = dataOf(a[0]).get('_groups') as PyList;
    return new PyTuple([start, start + BigInt(String(groups.items[0] ?? '').length)]);
  }));

  const toJsPattern = (p: string): string => p.replace(/\(\?P</g, '(?<').replace(/\(\?P=(\w+)\)/g, '\\k<$1>');
  const flagsOf = (v: PyVal): string => {
    const n = v === null ? 0 : Number(toBig(v));
    return (n & 2 ? 'i' : '') + (n & 8 ? 's' : '') + (n & 4 ? 'm' : '');
  };
  m.dict.set('I', 2n);
  m.dict.set('IGNORECASE', 2n);
  m.dict.set('M', 4n);
  m.dict.set('MULTILINE', 4n);
  m.dict.set('S', 8n);
  m.dict.set('DOTALL', 8n);
  const build = (pattern: PyVal, flags: PyVal, extra = '') => new RegExp(toJsPattern(str(pattern)), flagsOf(flags) + extra);
  m.dict.set('search', nf('search', (a) => {
    const mm = str(arg(a, 1)).match(build(arg(a, 0), arg(a, 2)));
    return mm ? makeMatch(mm, str(a[1])) : null;
  }));
  m.dict.set('match', nf('match', (a) => {
    const re = new RegExp('^(?:' + toJsPattern(str(arg(a, 0))) + ')', flagsOf(arg(a, 2)));
    const mm = str(arg(a, 1)).match(re);
    return mm ? makeMatch(mm, str(a[1])) : null;
  }));
  m.dict.set('fullmatch', nf('fullmatch', (a) => {
    const re = new RegExp('^(?:' + toJsPattern(str(arg(a, 0))) + ')$', flagsOf(arg(a, 2)));
    const mm = str(arg(a, 1)).match(re);
    return mm ? makeMatch(mm, str(a[1])) : null;
  }));
  m.dict.set('findall', nf('findall', (a) => {
    const re = build(arg(a, 0), arg(a, 2), 'g');
    const out: PyVal[] = [];
    for (const mm of str(arg(a, 1)).matchAll(re)) {
      if (mm.length === 1) out.push(mm[0]);
      else if (mm.length === 2) out.push(mm[1] ?? '');
      else out.push(new PyTuple(mm.slice(1).map((g) => g ?? '')));
    }
    return new PyList(out);
  }));
  m.dict.set('finditer', nf('finditer', (a) => {
    const re = build(arg(a, 0), arg(a, 2), 'g');
    const input = str(arg(a, 1));
    const matches = [...input.matchAll(re)].map((mm) => makeMatch(mm, input));
    return new PyList(matches);
  }));
  m.dict.set('sub', rf('sub', function* (a) {
    const re = build(arg(a, 0), arg(a, 3), 'g');
    const repl = arg(a, 1);
    const input = str(arg(a, 2));
    if (typeof repl === 'string') return input.replace(re, repl.replace(/\\(\d)/g, '$$$1'));
    let out = '';
    let last = 0;
    for (const mm of input.matchAll(re)) {
      out += input.slice(last, mm.index!) + (yield* interp.str(yield* interp.call(repl, [makeMatch(mm, input)], new Map())));
      last = mm.index! + mm[0].length;
    }
    return out + input.slice(last);
  }));
  m.dict.set('split', nf('split', (a) => new PyList(str(arg(a, 1)).split(build(arg(a, 0), arg(a, 3))))));
  m.dict.set('escape', nf('escape', (a) => str(arg(a, 0)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  m.dict.set('compile', nf('compile', (a) => {
    const pattern = arg(a, 0);
    const flags = arg(a, 1);
    const patternClass = new PyClass('Pattern', [OBJECT_CLASS]);
    const inst = new PyInstance(patternClass);
    for (const name of ['search', 'match', 'fullmatch', 'findall', 'finditer', 'sub', 'split']) {
      const base = m.dict.get(name) as NativeFunc;
      patternClass.dict.set(name, new NativeFunc(name, ((args: PyVal[], kwargs: Map<string, PyVal>) => {
        const rest = args.slice(1);
        const reordered = name === 'sub' ? [pattern, rest[0], rest[1], flags] : [pattern, rest[0], flags];
        return base.fn(reordered, kwargs);
      }) as any, base.reentrant));
    }
    patternClass.dict.set('pattern', pattern);
    return inst;
  }));
});

mod('heapq', (interp, m) => {
  const sortList = function* (l: PyList): Exec<void> {
    l.items = yield* sortValues(interp, l.items, null, false);
  };
  m.dict.set('heappush', rf('heappush', function* (a) {
    const l = arg(a, 0) as PyList;
    l.items.push(arg(a, 1));
    yield* sortList(l);
    return null;
  }));
  m.dict.set('heappop', rf('heappop', function* (a) {
    const l = arg(a, 0) as PyList;
    if (!l.items.length) raisePy('IndexError', 'index out of range');
    yield* sortList(l);
    return l.items.shift()!;
  }));
  m.dict.set('heapify', rf('heapify', function* (a) {
    yield* sortList(arg(a, 0) as PyList);
    return null;
  }));
  m.dict.set('nsmallest', rf('nsmallest', function* (a) {
    const n = int(arg(a, 0));
    const items = yield* interp.iterateAll(arg(a, 1));
    return new PyList((yield* sortValues(interp, items, null, false)).slice(0, n));
  }));
  m.dict.set('nlargest', rf('nlargest', function* (a) {
    const n = int(arg(a, 0));
    const items = yield* interp.iterateAll(arg(a, 1));
    return new PyList((yield* sortValues(interp, items, null, true)).slice(0, n));
  }));
});

mod('bisect', (interp, m) => {
  const find = function* (l: PyVal, x: PyVal, right: boolean): Exec<number> {
    const items = (l as PyList).items;
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const goRight = right ? !(yield* interp.compare(x, items[mid], '<')) : yield* interp.compare(items[mid], x, '<');
      if (goRight) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  m.dict.set('bisect_left', rf('bisect_left', function* (a) {
    return BigInt(yield* find(arg(a, 0), arg(a, 1), false));
  }));
  m.dict.set('bisect_right', rf('bisect_right', function* (a) {
    return BigInt(yield* find(arg(a, 0), arg(a, 1), true));
  }));
  m.dict.set('bisect', m.dict.get('bisect_right')!);
  m.dict.set('insort', rf('insort', function* (a) {
    const l = arg(a, 0) as PyList;
    l.items.splice(yield* find(l, arg(a, 1), true), 0, arg(a, 1));
    return null;
  }));
});

mod('datetime', (interp, m) => {
  const dtClass = new PyClass('datetime', [OBJECT_CLASS]);
  const fields = ['year', 'month', 'day', 'hour', 'minute', 'second'];
  const fill = (inst: PyInstance, d: Date) => {
    inst.dict.set('year', BigInt(d.getFullYear()));
    inst.dict.set('month', BigInt(d.getMonth() + 1));
    inst.dict.set('day', BigInt(d.getDate()));
    inst.dict.set('hour', BigInt(d.getHours()));
    inst.dict.set('minute', BigInt(d.getMinutes()));
    inst.dict.set('second', BigInt(d.getSeconds()));
    inst.dict.set('_ms', BigInt(d.getTime()));
    return inst;
  };
  const two = (n: bigint) => String(n).padStart(2, '0');
  dtClass.dict.set('now', new StaticMethod(nf('now', () => fill(new PyInstance(dtClass), new Date()))) as unknown as PyVal);
  dtClass.dict.set('today', dtClass.dict.get('now')!);
  dtClass.dict.set('__init__', nf('__init__', (a) => {
    const self = a[0] as PyInstance;
    fields.forEach((f, i) => self.dict.set(f, i + 1 < a.length ? toBig(a[i + 1]) : f === 'day' || f === 'month' ? 1n : 0n));
    return null;
  }));
  dtClass.dict.set('isoformat', nf('isoformat', (a) => {
    const s = a[0] as PyInstance;
    const g = (k: string) => toBig(s.dict.get(k) ?? 0n);
    return `${g('year')}-${two(g('month'))}-${two(g('day'))}T${two(g('hour'))}:${two(g('minute'))}:${two(g('second'))}`;
  }));
  dtClass.dict.set('__repr__', dtClass.dict.get('isoformat')!);
  dtClass.dict.set('__str__', dtClass.dict.get('isoformat')!);
  dtClass.dict.set('strftime', nf('strftime', (a) => {
    const s = a[0] as PyInstance;
    const g = (k: string) => toBig(s.dict.get(k) ?? 0n);
    return str(arg(a, 1))
      .replace(/%Y/g, String(g('year')))
      .replace(/%m/g, two(g('month')))
      .replace(/%d/g, two(g('day')))
      .replace(/%H/g, two(g('hour')))
      .replace(/%M/g, two(g('minute')))
      .replace(/%S/g, two(g('second')));
  }));
  m.dict.set('datetime', dtClass);
  m.dict.set('date', dtClass);
});

mod('typing', (interp, m) => {
  for (const name of ['List', 'Dict', 'Set', 'Tuple', 'Optional', 'Any', 'Union', 'Callable', 'Iterable', 'Iterator', 'Sequence']) {
    m.dict.set(name, nf(name, (a) => arg(a, 0)));
  }
});
