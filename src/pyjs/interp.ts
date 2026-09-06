// Tree-walking evaluator. Everything is a generator yielding Effects so the
// driver can slice execution, block on input() and stop.
import type { Node, Params } from './parser';
import { parse, PySyntaxError } from './parser';
import {
  BoundMethod, EXCEPTIONS, NativeFunc, NOT_IMPLEMENTED, OBJECT_CLASS, PyClass, PyDict, PyFile, PyFunction, PyGenerator,
  PyInstance, PyList, PyModule, PyRaise, PyRange, PySet, PySlice, PyTuple, PyVal, floatRepr, formatValue, isNum,
  keyOf, makeException, nativeBinOp, nativeCompare, nativeEq, nativeUnary, normIndex, objId, raisePy, reprSimple,
  sliceIndices, sliceSeq, strEscape, toBig, toNum, truthyNative, typeError, typeName, valueError,
} from './objects';

export type Effect =
  | { t: 'tick' }
  | { t: 'input'; prompt: string }
  | { t: 'yield'; value: PyVal }
  | { t: 'sleep'; ms: number };

export type Exec<T = PyVal> = Generator<Effect, T, any>;

/** Non-exception control flow bubbling out of a statement. */
type Signal = { k: 'return'; value: PyVal } | { k: 'break' } | { k: 'continue' } | null;

export interface Scope {
  vars: Map<string, PyVal>;
  parent: Scope | null;
  globals: Map<string, PyVal>;
  isFunction: boolean;
  globalNames: Set<string>;
  nonlocalNames: Set<string>;
}

export interface Frame {
  name: string;
  line: number;
  func: PyFunction | null;
  scope: Scope;
}

export interface HostIO {
  write(text: string, stream?: 'stdout' | 'stderr'): void;
  readFile(path: string): string | null;
  writeFile(path: string, content: string): void;
  listDir(path: string): string[];
  exists(path: string): boolean;
  remove(path: string): void;
  now(): number;
}

export class StopExecution extends Error {}

export function newScope(parent: Scope | null, globals: Map<string, PyVal>, isFunction: boolean): Scope {
  return { vars: new Map(), parent, globals, isFunction, globalNames: new Set(), nonlocalNames: new Set() };
}

export class Interpreter {
  globals = new Map<string, PyVal>();
  builtins = new Map<string, PyVal>();
  modules = new Map<string, PyModule>();
  frames: Frame[] = [];
  stopped = false;
  /** Set by the driver so a long loop can be halted between ticks. */
  shouldStop: () => boolean = () => false;

  constructor(public io: HostIO) {}

  // helpers used by builtins
  get topScope(): Scope {
    return this.frames.length ? this.frames[this.frames.length - 1].scope : newScope(null, this.globals, false);
  }

  *str(v: PyVal): Exec<string> {
    if (typeof v === 'string') return v;
    if (v instanceof PyInstance) {
      const m = yield* this.findDunder(v, '__str__');
      if (m) return asStr(yield* this.call(m, [], new Map()));
      const r = yield* this.findDunder(v, '__repr__');
      if (r) return asStr(yield* this.call(r, [], new Map()));
      if (isException(v)) return excArgsText(v, false);
    }
    return yield* this.repr(v);
  }

  *repr(v: PyVal): Exec<string> {
    if (v instanceof PyInstance) {
      const m = yield* this.findDunder(v, '__repr__');
      if (m) return asStr(yield* this.call(m, [], new Map()));
      if (isException(v)) return `${v.cls.name}(${excArgsText(v, true)})`;
      return `<${v.cls.name} object at 0x${objId(v).toString(16)}>`;
    }
    if (v instanceof PyList) {
      const parts: string[] = [];
      for (const it of v.items) parts.push(yield* this.repr(it));
      return `[${parts.join(', ')}]`;
    }
    if (v instanceof PyTuple) {
      const parts: string[] = [];
      for (const it of v.items) parts.push(yield* this.repr(it));
      return parts.length === 1 ? `(${parts[0]},)` : `(${parts.join(', ')})`;
    }
    if (v instanceof PySet) {
      if (v.size === 0) return 'set()';
      const parts: string[] = [];
      for (const it of v.values()) parts.push(yield* this.repr(it));
      return `{${parts.join(', ')}}`;
    }
    if (v instanceof PyDict) {
      const parts: string[] = [];
      for (const [k, val] of v.entries()) parts.push(`${yield* this.repr(k)}: ${yield* this.repr(val)}`);
      return `{${parts.join(', ')}}`;
    }
    return reprSimple(v);
  }

  *truthy(v: PyVal): Exec<boolean> {
    const t = truthyNative(v);
    if (t !== NOT_IMPLEMENTED) return t;
    const inst = v as PyInstance;
    const b = yield* this.findDunder(inst, '__bool__');
    if (b) return yield* this.truthy(yield* this.call(b, [], new Map()));
    const l = yield* this.findDunder(inst, '__len__');
    if (l) return Number(toBig(yield* this.call(l, [], new Map()))) !== 0;
    return true;
  }

  *eq(a: PyVal, b: PyVal): Exec<boolean> {
    const r = nativeEq(a, b);
    if (r !== NOT_IMPLEMENTED) return r;
    if (a instanceof PyInstance) {
      const m = yield* this.findDunder(a, '__eq__');
      if (m) {
        const res = yield* this.call(m, [b], new Map());
        if (res !== null) return yield* this.truthy(res);
      }
    }
    if (b instanceof PyInstance) {
      const m = yield* this.findDunder(b, '__eq__');
      if (m) {
        const res = yield* this.call(m, [a], new Map());
        if (res !== null) return yield* this.truthy(res);
      }
    }
    return a === b;
  }

  *compare(a: PyVal, b: PyVal, op: string): Exec<boolean> {
    if (op === '==') return yield* this.eq(a, b);
    if (op === '!=') return !(yield* this.eq(a, b));
    if (op === 'is') return identical(a, b);
    if (op === 'is not') return !identical(a, b);
    if (op === 'in' || op === 'not in') {
      const found = yield* this.contains(b, a);
      return op === 'in' ? found : !found;
    }
    const c = nativeCompare(a, b);
    if (c !== NOT_IMPLEMENTED) return applyCompare(c, op);
    const dunders: Record<string, string> = { '<': '__lt__', '<=': '__le__', '>': '__gt__', '>=': '__ge__' };
    if (a instanceof PyInstance) {
      const m = yield* this.findDunder(a, dunders[op]);
      if (m) return yield* this.truthy(yield* this.call(m, [b], new Map()));
    }
    typeError(`'${op}' not supported between instances of '${typeName(a)}' and '${typeName(b)}'`);
  }

  *contains(container: PyVal, item: PyVal): Exec<boolean> {
    if (typeof container === 'string') {
      if (typeof item !== 'string') typeError(`'in <string>' requires string as left operand, not ${typeName(item)}`);
      return container.includes(item);
    }
    if (container instanceof PyDict) return container.has(item);
    if (container instanceof PySet) return container.has(item);
    if (container instanceof PyList || container instanceof PyTuple) {
      for (const v of container.items) if (yield* this.eq(v, item)) return true;
      return false;
    }
    if (container instanceof PyRange) {
      if (!isNum(item)) return false;
      const n = toBig(item);
      const len = container.length;
      if (len === 0n) return false;
      const diff = n - container.start;
      return diff % container.step === 0n && diff / container.step >= 0n && diff / container.step < len;
    }
    if (container instanceof PyInstance) {
      const m = yield* this.findDunder(container, '__contains__');
      if (m) return yield* this.truthy(yield* this.call(m, [item], new Map()));
    }
    const it = yield* this.getIter(container);
    for (;;) {
      const step = yield* it.next();
      if (step.done) return false;
      if (yield* this.eq(step.value!, item)) return true;
    }
  }

  // iteration
  *getIter(v: PyVal): Exec<PyIter> {
    if (typeof v === 'string') return arrayIter([...v]);
    if (v instanceof PyList || v instanceof PyTuple) return arrayIter([...v.items]);
    if (v instanceof PySet) return arrayIter(v.values());
    if (v instanceof PyDict) return arrayIter(v.keys());
    if (v instanceof PyRange) {
      const len = v.length;
      let i = 0n;
      return {
        next: function* () {
          if (i >= len) return { done: true };
          return { done: false, value: v.at(i++) };
        },
      };
    }
    if (v instanceof PyGenerator) return generatorIter(this, v);
    if (v instanceof PyInstance) {
      const it = yield* this.findDunder(v, '__iter__');
      if (it) {
        const iterObj = yield* this.call(it, [], new Map());
        if (iterObj instanceof PyGenerator) return generatorIter(this, iterObj);
        if (iterObj instanceof PyInstance) return dunderIter(this, iterObj);
        return yield* this.getIter(iterObj);
      }
      const getitem = yield* this.findDunder(v, '__getitem__');
      if (getitem) {
        const self = this;
        let i = 0n;
        return {
          next: function* () {
            try {
              const value = yield* self.call(getitem, [i++], new Map());
              return { done: false, value };
            } catch (e) {
              if (e instanceof PyRaise && e.value.cls.name === 'IndexError') return { done: true };
              throw e;
            }
          },
        };
      }
    }
    if (v instanceof NativeFunc || v instanceof PyFunction) typeError(`'${typeName(v)}' object is not iterable`);
    typeError(`'${typeName(v)}' object is not iterable`);
  }

  *iterateAll(v: PyVal): Exec<PyVal[]> {
    const out: PyVal[] = [];
    const it = yield* this.getIter(v);
    for (;;) {
      // tick so Stop works on endless iterators
      yield { t: 'tick' };
      const step = yield* it.next();
      if (step.done) break;
      out.push(step.value!);
    }
    return out;
  }

  // attributes
  *findDunder(inst: PyInstance, name: string): Exec<PyVal | null> {
    const m = inst.cls.lookup(name);
    if (m === undefined) return null;
    return bindIfFunction(m, inst);
  }

  *getAttr(obj: PyVal, name: string): Exec<PyVal> {
    if (obj instanceof PyModule) {
      const v = obj.dict.get(name);
      if (v !== undefined) return v;
      raisePy('AttributeError', `module '${obj.name}' has no attribute '${name}'`);
    }
    if (obj instanceof PyClass) {
      if (name === '__name__') return obj.name;
      if (name === '__bases__') return new PyTuple(obj.bases as unknown as PyVal[]);
      const v = obj.lookup(name);
      if (v !== undefined) return v instanceof StaticMethod ? v.func : v instanceof ClassMethod ? new BoundMethod(obj, v.func as any) : v;
      raisePy('AttributeError', `type object '${obj.name}' has no attribute '${name}'`);
    }
    if (obj instanceof PyInstance) {
      if (name === '__class__') return obj.cls;
      if (name === '__dict__') return PyDict.from([...obj.dict.entries()] as Array<[PyVal, PyVal]>);
      const own = obj.dict.get(name);
      if (own !== undefined) return own;
      const cv = obj.cls.lookup(name);
      if (cv !== undefined) {
        if (cv instanceof Property) {
          if (!cv.getter) raisePy('AttributeError', `unreadable attribute '${name}'`);
          return yield* this.call(bindIfFunction(cv.getter, obj)!, [], new Map());
        }
        return bindIfFunction(cv, obj)!;
      }
      const getattr = obj.cls.lookup('__getattr__');
      if (getattr) return yield* this.call(bindIfFunction(getattr, obj)!, [name], new Map());
      raisePy('AttributeError', `'${obj.cls.name}' object has no attribute '${name}'`);
    }
    const native = getNativeMethod(this, obj, name);
    if (native !== undefined) return native;
    raisePy('AttributeError', `'${typeName(obj)}' object has no attribute '${name}'`);
  }

  *setAttr(obj: PyVal, name: string, value: PyVal): Exec<void> {
    if (obj instanceof PyInstance) {
      const cv = obj.cls.lookup(name);
      if (cv instanceof Property) {
        if (!cv.setter) raisePy('AttributeError', `can't set attribute '${name}'`);
        yield* this.call(bindIfFunction(cv.setter, obj)!, [value], new Map());
        return;
      }
      obj.dict.set(name, value);
      return;
    }
    if (obj instanceof PyClass) {
      obj.dict.set(name, value);
      return;
    }
    if (obj instanceof PyModule) {
      obj.dict.set(name, value);
      return;
    }
    typeError(`cannot set attribute on '${typeName(obj)}' object`);
  }

  // subscripting
  *getItem(obj: PyVal, key: PyVal): Exec<PyVal> {
    if (typeof obj === 'string') {
      if (key instanceof PySlice) return sliceSeq([...obj], key).join('');
      return obj[normIndex(key, obj.length, 'string')];
    }
    if (obj instanceof PyList || obj instanceof PyTuple) {
      if (key instanceof PySlice) {
        const items = sliceSeq(obj.items, key);
        return obj instanceof PyList ? new PyList(items) : new PyTuple(items);
      }
      return obj.items[normIndex(key, obj.items.length, typeName(obj))];
    }
    if (obj instanceof PyDict) {
      const v = obj.get(key);
      if (v === undefined) {
        if (obj.has(key)) return null;
        const inst = makeException('KeyError', '');
        inst.dict.set('args', new PyTuple([key]));
        throw new PyRaise(inst);
      }
      return v;
    }
    if (obj instanceof PyRange) {
      if (key instanceof PySlice) {
        const { start, stop, step } = sliceIndices(key, Number(obj.length));
        const out: PyVal[] = [];
        if (step > 0) for (let i = start; i < stop; i += step) out.push(obj.at(BigInt(i)));
        else for (let i = start; i > stop; i += step) out.push(obj.at(BigInt(i)));
        return new PyList(out);
      }
      return obj.at(BigInt(normIndex(key, Number(obj.length), 'range')));
    }
    if (obj instanceof PyInstance) {
      const m = yield* this.findDunder(obj, '__getitem__');
      if (m) return yield* this.call(m, [key], new Map());
    }
    typeError(`'${typeName(obj)}' object is not subscriptable`);
  }

  *setItem(obj: PyVal, key: PyVal, value: PyVal): Exec<void> {
    if (obj instanceof PyList) {
      if (key instanceof PySlice) {
        const { start, stop, step } = sliceIndices(key, obj.items.length);
        const values = yield* this.iterateAll(value);
        if (step === 1) obj.items.splice(start, Math.max(0, stop - start), ...values);
        else {
          const idx: number[] = [];
          if (step > 0) for (let i = start; i < stop; i += step) idx.push(i);
          else for (let i = start; i > stop; i += step) idx.push(i);
          if (idx.length !== values.length) valueError(`attempt to assign sequence of size ${values.length} to extended slice of size ${idx.length}`);
          idx.forEach((p, n) => (obj.items[p] = values[n]));
        }
        return;
      }
      obj.items[normIndex(key, obj.items.length, 'list')] = value;
      return;
    }
    if (obj instanceof PyDict) {
      obj.set(key, value);
      return;
    }
    if (obj instanceof PyInstance) {
      const m = yield* this.findDunder(obj, '__setitem__');
      if (m) {
        yield* this.call(m, [key, value], new Map());
        return;
      }
    }
    typeError(`'${typeName(obj)}' object does not support item assignment`);
  }

  *delItem(obj: PyVal, key: PyVal): Exec<void> {
    if (obj instanceof PyList) {
      if (key instanceof PySlice) {
        const { start, stop, step } = sliceIndices(key, obj.items.length);
        const idx: number[] = [];
        if (step > 0) for (let i = start; i < stop; i += step) idx.push(i);
        else for (let i = start; i > stop; i += step) idx.push(i);
        idx.sort((a, b) => b - a).forEach((i) => obj.items.splice(i, 1));
        return;
      }
      obj.items.splice(normIndex(key, obj.items.length, 'list'), 1);
      return;
    }
    if (obj instanceof PyDict) {
      if (!obj.delete(key)) {
        const inst = makeException('KeyError', '');
        inst.dict.set('args', new PyTuple([key]));
        throw new PyRaise(inst);
      }
      return;
    }
    if (obj instanceof PyInstance) {
      const m = yield* this.findDunder(obj, '__delitem__');
      if (m) {
        yield* this.call(m, [key], new Map());
        return;
      }
    }
    typeError(`'${typeName(obj)}' object does not support item deletion`);
  }

  // operators
  *binOp(op: string, a: PyVal, b: PyVal): Exec<PyVal> {
    const r = nativeBinOp(op, a, b);
    if (r !== NOT_IMPLEMENTED) return r;
    const names: Record<string, [string, string]> = {
      '+': ['__add__', '__radd__'], '-': ['__sub__', '__rsub__'], '*': ['__mul__', '__rmul__'],
      '/': ['__truediv__', '__rtruediv__'], '//': ['__floordiv__', '__rfloordiv__'], '%': ['__mod__', '__rmod__'],
      '**': ['__pow__', '__rpow__'], '&': ['__and__', '__rand__'], '|': ['__or__', '__ror__'],
      '^': ['__xor__', '__rxor__'], '<<': ['__lshift__', '__rlshift__'], '>>': ['__rshift__', '__rrshift__'],
      '@': ['__matmul__', '__rmatmul__'],
    };
    const pair = names[op];
    if (pair) {
      if (a instanceof PyInstance) {
        const m = yield* this.findDunder(a, pair[0]);
        if (m) {
          const res = yield* this.call(m, [b], new Map());
          if (res !== NOT_IMPLEMENTED_VALUE) return res;
        }
      }
      if (b instanceof PyInstance) {
        const m = yield* this.findDunder(b, pair[1]);
        if (m) {
          const res = yield* this.call(m, [a], new Map());
          if (res !== NOT_IMPLEMENTED_VALUE) return res;
        }
      }
    }
    typeError(`unsupported operand type(s) for ${op}: '${typeName(a)}' and '${typeName(b)}'`);
  }

  *unaryOp(op: string, v: PyVal): Exec<PyVal> {
    if (op === 'not') return !(yield* this.truthy(v));
    const r = nativeUnary(op, v);
    if (r !== NOT_IMPLEMENTED) return r;
    if (v instanceof PyInstance) {
      const name = op === '-' ? '__neg__' : op === '+' ? '__pos__' : '__invert__';
      const m = yield* this.findDunder(v, name);
      if (m) return yield* this.call(m, [], new Map());
    }
    typeError(`bad operand type for unary ${op}: '${typeName(v)}'`);
  }

  // calling
  *call(f: PyVal, args: PyVal[], kwargs: Map<string, PyVal>): Exec<PyVal> {
    if (this.shouldStop()) throw new StopExecution();
    yield { t: 'tick' };
    if (f instanceof BoundMethod) return yield* this.call(f.func, [f.self, ...args], kwargs);
    if (f instanceof NativeFunc) {
      const out = f.fn(args, kwargs);
      if (f.reentrant) return yield* (out as Exec);
      return out as PyVal;
    }
    if (f instanceof StaticMethod) return yield* this.call(f.func, args, kwargs);
    if (f instanceof PyClass) return yield* this.instantiate(f, args, kwargs);
    if (f instanceof PyFunction) {
      if (this.frames.length > 190) raisePy('RecursionError', 'maximum recursion depth exceeded');
      const scope = newScope(f.scope, f.globals, true);
      yield* this.bindParams(f, scope, args, kwargs);
      if (f.isGenerator) {
        const self = this;
        const gen = new PyGenerator(f.name, (function* (): Exec {
          const sig = yield* self.runBody(f, scope);
          return sig && sig.k === 'return' ? sig.value : null;
        })());
        return gen;
      }
      const sig = yield* this.runBody(f, scope);
      return sig && sig.k === 'return' ? sig.value : null;
    }
    if (f instanceof PyInstance) {
      const m = yield* this.findDunder(f, '__call__');
      if (m) return yield* this.call(m, args, kwargs);
    }
    typeError(`'${typeName(f)}' object is not callable`);
  }

  private *runBody(f: PyFunction, scope: Scope): Exec<Signal> {
    this.frames.push({ name: f.name, line: f.body.length ? f.body[0].line : 0, func: f, scope });
    try {
      return yield* this.execBlock(f.body, scope);
    } catch (e) {
      this.captureTraceback(e);
      throw e;
    } finally {
      this.frames.pop();
    }
  }

  /** Records the call stack the first time an exception passes a frame. */
  captureTraceback(e: unknown): void {
    if (e instanceof PyRaise && !(e as any).captured) {
      (e as any).captured = true;
      e.traceback = this.traceback();
    }
  }

  private *bindParams(f: PyFunction, scope: Scope, args: PyVal[], kwargs: Map<string, PyVal>): Exec<void> {
    const p = f.params;
    const named = new Set(p.args.map((a) => a.name));
    if (!p.vararg && args.length > p.args.length) {
      typeError(`${f.name}() takes ${p.args.length} positional argument${p.args.length === 1 ? '' : 's'} but ${args.length} ${args.length === 1 ? 'was' : 'were'} given`);
    }
    p.args.forEach((param, i) => {
      if (i < args.length) scope.vars.set(param.name, args[i]);
    });
    if (p.vararg) scope.vars.set(p.vararg, new PyTuple(args.slice(p.args.length)));
    const extra = new PyDict();
    for (const [k, v] of kwargs) {
      if (named.has(k)) {
        const idx = p.args.findIndex((a) => a.name === k);
        if (idx < args.length) typeError(`${f.name}() got multiple values for argument '${k}'`);
        scope.vars.set(k, v);
      } else if (p.kwonly.some((a) => a.name === k)) scope.vars.set(k, v);
      else if (p.kwarg) extra.set(k, v);
      else typeError(`${f.name}() got an unexpected keyword argument '${k}'`);
    }
    if (p.kwarg) scope.vars.set(p.kwarg, extra);
    const defaultsStart = p.args.length - f.defaults.length;
    p.args.forEach((param, i) => {
      if (!scope.vars.has(param.name)) {
        if (i >= defaultsStart) scope.vars.set(param.name, f.defaults[i - defaultsStart]);
        else typeError(`${f.name}() missing required positional argument: '${param.name}'`);
      }
    });
    for (const param of p.kwonly) {
      if (!scope.vars.has(param.name)) {
        if (f.kwdefaults.has(param.name)) scope.vars.set(param.name, f.kwdefaults.get(param.name)!);
        else typeError(`${f.name}() missing required keyword-only argument: '${param.name}'`);
      }
    }
  }

  *instantiate(cls: PyClass, args: PyVal[], kwargs: Map<string, PyVal>): Exec<PyVal> {
    const native = (cls as any).native as ((a: PyVal[], k: Map<string, PyVal>) => any) | undefined;
    if (native) {
      const out = native(args, kwargs);
      return (cls as any).nativeReentrant ? yield* (out as Exec) : (out as PyVal);
    }
    if (cls.mro.includes(EXCEPTIONS.get('BaseException')!)) {
      const inst = new PyInstance(cls);
      inst.dict.set('args', new PyTuple(args));
      const init = cls.lookup('__init__');
      if (init instanceof PyFunction) yield* this.call(new BoundMethod(inst, init), args, kwargs);
      return inst;
    }
    const newFn = cls.lookup('__new__');
    const inst = new PyInstance(cls);
    const init = cls.lookup('__init__');
    if (init !== undefined) yield* this.call(bindIfFunction(init, inst)!, args, kwargs);
    else if (args.length || kwargs.size) {
      if (newFn === undefined) typeError(`${cls.name}() takes no arguments`);
    }
    return inst;
  }

  // name resolution
  lookupName(scope: Scope, name: string): PyVal | undefined {
    if (scope.globalNames.has(name)) {
      const g = scope.globals.get(name);
      return g !== undefined ? g : this.builtins.get(name);
    }
    let s: Scope | null = scope;
    while (s) {
      const v = s.vars.get(name);
      if (v !== undefined) return v;
      s = s.parent;
    }
    const g = scope.globals.get(name);
    if (g !== undefined) return g;
    return this.builtins.get(name);
  }

  setName(scope: Scope, name: string, value: PyVal): void {
    if (scope.globalNames.has(name)) {
      scope.globals.set(name, value);
      return;
    }
    if (scope.nonlocalNames.has(name)) {
      let s = scope.parent;
      while (s) {
        if (s.vars.has(name)) {
          s.vars.set(name, value);
          return;
        }
        s = s.parent;
      }
    }
    scope.vars.set(name, value);
    if (!scope.isFunction && scope.globals !== scope.vars) scope.globals.set(name, value);
  }

  // statements
  *execBlock(body: Node[], scope: Scope): Exec<Signal> {
    for (const stmt of body) {
      const sig = yield* this.execStmt(stmt, scope);
      if (sig) return sig;
    }
    return null;
  }

  *execStmt(node: Node, scope: Scope): Exec<Signal> {
    if (this.frames.length) this.frames[this.frames.length - 1].line = node.line;
    if (this.shouldStop()) throw new StopExecution();
    switch (node.type) {
      case 'Expr':
        yield* this.eval(node.value, scope);
        return null;
      case 'Assign': {
        const value = yield* this.eval(node.value, scope);
        for (const t of node.targets) yield* this.assign(t, value, scope);
        return null;
      }
      case 'AnnAssign': {
        if (node.value) yield* this.assign(node.target, yield* this.eval(node.value, scope), scope);
        return null;
      }
      case 'AugAssign': {
        const current = yield* this.eval(node.target, scope);
        const rhs = yield* this.eval(node.value, scope);
        // In-place list extend keeps identity, as CPython does.
        if (node.op === '+' && current instanceof PyList) {
          const items = yield* this.iterateAll(rhs);
          current.items.push(...items);
          return null;
        }
        yield* this.assign(node.target, yield* this.binOp(node.op, current, rhs), scope);
        return null;
      }
      case 'Pass':
        return null;
      case 'Break':
        return { k: 'break' };
      case 'Continue':
        return { k: 'continue' };
      case 'Return':
        return { k: 'return', value: node.value ? yield* this.eval(node.value, scope) : null };
      case 'If': {
        if (yield* this.truthy(yield* this.eval(node.test, scope))) return yield* this.execBlock(node.body, scope);
        return yield* this.execBlock(node.orelse, scope);
      }
      case 'While': {
        let broke = false;
        while (yield* this.truthy(yield* this.eval(node.test, scope))) {
          yield { t: 'tick' };
          if (this.shouldStop()) throw new StopExecution();
          const sig = yield* this.execBlock(node.body, scope);
          if (sig?.k === 'break') {
            broke = true;
            break;
          }
          if (sig?.k === 'return') return sig;
        }
        if (!broke) return yield* this.execBlock(node.orelse, scope);
        return null;
      }
      case 'For': {
        const iterable = yield* this.eval(node.iter, scope);
        const it = yield* this.getIter(iterable);
        let broke = false;
        for (;;) {
          yield { t: 'tick' };
          if (this.shouldStop()) throw new StopExecution();
          const step = yield* it.next();
          if (step.done) break;
          yield* this.assign(node.target, step.value!, scope);
          const sig = yield* this.execBlock(node.body, scope);
          if (sig?.k === 'break') {
            broke = true;
            break;
          }
          if (sig?.k === 'return') return sig;
        }
        if (!broke) return yield* this.execBlock(node.orelse, scope);
        return null;
      }
      case 'FunctionDef': {
        let fn: PyVal = yield* this.makeFunction(node, scope);
        for (const d of [...node.decorators].reverse()) fn = yield* this.call(yield* this.eval(d, scope), [fn], new Map());
        this.setName(scope, node.name, fn);
        return null;
      }
      case 'ClassDef': {
        let cls: PyVal = yield* this.makeClass(node, scope);
        for (const d of [...node.decorators].reverse()) cls = yield* this.call(yield* this.eval(d, scope), [cls], new Map());
        this.setName(scope, node.name, cls);
        return null;
      }
      case 'Global':
        for (const n of node.names) scope.globalNames.add(n);
        return null;
      case 'Nonlocal':
        for (const n of node.names) scope.nonlocalNames.add(n);
        return null;
      case 'Delete':
        for (const t of node.targets) yield* this.deleteTarget(t, scope);
        return null;
      case 'Assert': {
        if (!(yield* this.truthy(yield* this.eval(node.test, scope)))) {
          const msg = node.msg ? yield* this.str(yield* this.eval(node.msg, scope)) : '';
          throw new PyRaise(makeException('AssertionError', msg), this.traceback());
        }
        return null;
      }
      case 'Raise': {
        if (!node.exc) raisePy('RuntimeError', 'No active exception to re-raise');
        const exc = yield* this.eval(node.exc, scope);
        let inst: PyInstance;
        if (exc instanceof PyClass) inst = (yield* this.instantiate(exc, [], new Map())) as PyInstance;
        else if (exc instanceof PyInstance) inst = exc;
        else return typeError('exceptions must derive from BaseException');
        if (node.cause) inst.dict.set('__cause__', yield* this.eval(node.cause, scope));
        throw new PyRaise(inst, this.traceback());
      }
      case 'Try':
        return yield* this.execTry(node, scope);
      case 'With':
        return yield* this.execWith(node, scope);
      case 'Import': {
        for (const { name, asname } of node.names) {
          const mod = yield* this.importModule(name);
          if (asname) this.setName(scope, asname, mod);
          else {
            const root = name.split('.')[0];
            this.setName(scope, root, root === name ? mod : yield* this.importModule(root));
          }
        }
        return null;
      }
      case 'ImportFrom': {
        const mod = yield* this.importModule(node.module);
        for (const { name, asname } of node.names) {
          if (name === '*') {
            for (const [k, v] of (mod as PyModule).dict) if (!k.startsWith('_')) this.setName(scope, k, v);
            continue;
          }
          let value = (mod as PyModule).dict.get(name);
          if (value === undefined) {
            // Might be a submodule.
            try {
              value = yield* this.importModule(`${node.module}.${name}`);
            } catch {
              raisePy('ImportError', `cannot import name '${name}' from '${node.module}'`);
            }
          }
          this.setName(scope, asname ?? name, value!);
        }
        return null;
      }
    }
    raisePy('SystemError', `unsupported statement ${node.type}`);
  }

  private *execTry(node: Node, scope: Scope): Exec<Signal> {
    let sig: Signal = null;
    try {
      sig = yield* this.execBlock(node.body, scope);
      if (!sig) sig = yield* this.execBlock(node.orelse, scope);
    } catch (e) {
      if (!(e instanceof PyRaise)) throw e;
      let handled = false;
      for (const h of node.handlers) {
        let matches = h.etype === null;
        if (h.etype) {
          const target = yield* this.eval(h.etype, scope);
          const classes = target instanceof PyTuple ? target.items : [target];
          matches = classes.some((c) => c instanceof PyClass && e.value.cls.isSubclassOf(c));
        }
        if (!matches) continue;
        handled = true;
        if (h.name) this.setName(scope, h.name, e.value);
        try {
          sig = yield* this.execBlock(h.body, scope);
        } finally {
          if (h.name) scope.vars.delete(h.name);
        }
        break;
      }
      if (!handled) {
        if (node.finalbody.length) {
          const fsig = yield* this.execBlock(node.finalbody, scope);
          if (fsig) return fsig;
        }
        throw e;
      }
    }
    if (node.finalbody.length) {
      const fsig = yield* this.execBlock(node.finalbody, scope);
      if (fsig) return fsig;
    }
    return sig;
  }

  private *execWith(node: Node, scope: Scope): Exec<Signal> {
    const [item, ...rest] = node.items;
    const ctx = yield* this.eval(item.ctx, scope);
    let entered: PyVal = ctx;
    if (ctx instanceof PyInstance) {
      const enter = yield* this.findDunder(ctx, '__enter__');
      if (!enter) typeError(`'${typeName(ctx)}' object does not support the context manager protocol`);
      entered = yield* this.call(enter, [], new Map());
    } else if (!(ctx instanceof PyFile)) {
      typeError(`'${typeName(ctx)}' object does not support the context manager protocol`);
    }
    if (item.target) yield* this.assign(item.target, entered, scope);
    const body = rest.length ? [{ ...node, items: rest }] : node.body;
    let sig: Signal = null;
    try {
      sig = yield* this.execBlock(body, scope);
    } catch (e) {
      if (ctx instanceof PyInstance) {
        const exit = yield* this.findDunder(ctx, '__exit__');
        if (exit && e instanceof PyRaise) {
          const suppress = yield* this.call(exit, [e.value.cls, e.value, null], new Map());
          if (yield* this.truthy(suppress)) return null;
        }
      } else if (ctx instanceof PyFile) closeFile(ctx);
      throw e;
    }
    if (ctx instanceof PyInstance) {
      const exit = yield* this.findDunder(ctx, '__exit__');
      if (exit) yield* this.call(exit, [null, null, null], new Map());
    } else if (ctx instanceof PyFile) closeFile(ctx);
    return sig;
  }

  private *makeFunction(node: Node, scope: Scope): Exec<PyFunction> {
    const isGen = containsYield(node.body);
    const fn = new PyFunction(node.name, node.params as Params, node.body, scope, isGen, scope.globals);
    for (const a of (node.params as Params).args) if (a.default) fn.defaults.push(yield* this.eval(a.default, scope));
    for (const a of (node.params as Params).kwonly) if (a.default) fn.kwdefaults.set(a.name, yield* this.eval(a.default, scope));
    const first = node.body[0];
    if (first && first.type === 'Expr' && first.value.type === 'Str') fn.doc = first.value.value;
    return fn;
  }

  private *makeClass(node: Node, scope: Scope): Exec<PyClass> {
    const bases: PyClass[] = [];
    for (const b of node.bases) {
      const v = yield* this.eval(b, scope);
      if (v instanceof PyClass) bases.push(v);
      else typeError(`${node.name}: base must be a class`);
    }
    if (!bases.length) bases.push(OBJECT_CLASS);
    const classScope = newScope(scope, scope.globals, true);
    yield* this.execBlock(node.body, classScope);
    const cls = new PyClass(node.name, bases, new Map(classScope.vars));
    // Methods need their defining class so zero-argument super() works.
    for (const v of classScope.vars.values()) {
      if (v instanceof PyFunction) (v as any).definingClass = cls;
      if (v instanceof StaticMethod || v instanceof ClassMethod) (v.func as any).definingClass = cls;
      if (v instanceof Property) {
        for (const f of [v.getter, v.setter]) if (f instanceof PyFunction) (f as any).definingClass = cls;
      }
    }
    return cls;
  }

  // assignment
  *assign(target: Node, value: PyVal, scope: Scope): Exec<void> {
    switch (target.type) {
      case 'Name':
        this.setName(scope, target.id, value);
        return;
      case 'Tuple':
      case 'List': {
        const items = yield* this.iterateAll(value);
        const elts: Node[] = target.elts;
        const starIdx = elts.findIndex((e) => e.type === 'Starred');
        if (starIdx === -1) {
          if (items.length !== elts.length) {
            valueError(items.length < elts.length ? `not enough values to unpack (expected ${elts.length}, got ${items.length})` : `too many values to unpack (expected ${elts.length})`);
          }
          for (let i = 0; i < elts.length; i++) yield* this.assign(elts[i], items[i], scope);
          return;
        }
        const after = elts.length - starIdx - 1;
        if (items.length < elts.length - 1) valueError(`not enough values to unpack (expected at least ${elts.length - 1}, got ${items.length})`);
        for (let i = 0; i < starIdx; i++) yield* this.assign(elts[i], items[i], scope);
        yield* this.assign(elts[starIdx].value, new PyList(items.slice(starIdx, items.length - after)), scope);
        for (let i = 0; i < after; i++) yield* this.assign(elts[starIdx + 1 + i], items[items.length - after + i], scope);
        return;
      }
      case 'Attribute':
        yield* this.setAttr(yield* this.eval(target.value, scope), target.attr, value);
        return;
      case 'Subscript':
        yield* this.setItem(yield* this.eval(target.value, scope), yield* this.evalSlice(target.slice, scope), value);
        return;
      case 'Starred':
        yield* this.assign(target.value, value, scope);
        return;
    }
    raisePy('SyntaxError', `cannot assign to ${target.type}`);
  }

  private *deleteTarget(target: Node, scope: Scope): Exec<void> {
    if (target.type === 'Name') {
      if (scope.vars.delete(target.id)) return;
      if (scope.globals.delete(target.id)) return;
      raisePy('NameError', `name '${target.id}' is not defined`);
    }
    if (target.type === 'Subscript') {
      yield* this.delItem(yield* this.eval(target.value, scope), yield* this.evalSlice(target.slice, scope));
      return;
    }
    if (target.type === 'Attribute') {
      const obj = yield* this.eval(target.value, scope);
      if (obj instanceof PyInstance) {
        if (!obj.dict.delete(target.attr)) raisePy('AttributeError', target.attr);
        return;
      }
    }
    raisePy('SyntaxError', 'cannot delete this target');
  }

  // expressions
  private *evalSlice(node: Node, scope: Scope): Exec<PyVal> {
    if (node.type === 'Slice') {
      return new PySlice(
        node.lower ? yield* this.eval(node.lower, scope) : null,
        node.upper ? yield* this.eval(node.upper, scope) : null,
        node.step ? yield* this.eval(node.step, scope) : null,
      );
    }
    return yield* this.eval(node, scope);
  }

  *eval(node: Node, scope: Scope): Exec<PyVal> {
    switch (node.type) {
      case 'Num':
        return node.value;
      case 'Str':
        return node.value;
      case 'Const':
        return node.value;
      case 'Name': {
        const v = this.lookupName(scope, node.id);
        if (v === undefined) raisePy('NameError', `name '${node.id}' is not defined`);
        return v;
      }
      case 'JoinedStr': {
        let out = '';
        for (const part of node.parts) {
          if (part.type === 'Str') out += part.value;
          else {
            const v = yield* this.eval(part.value, scope);
            out += yield* this.formatOne(v, part.conversion, part.spec, scope);
          }
        }
        return out;
      }
      case 'FormattedValue':
        return yield* this.formatOne(yield* this.eval(node.value, scope), node.conversion, node.spec, scope);
      case 'Tuple':
        return new PyTuple(yield* this.evalItems(node.elts, scope));
      case 'List':
        return new PyList(yield* this.evalItems(node.elts, scope));
      case 'Set':
        return PySet.from(yield* this.evalItems(node.elts, scope));
      case 'Dict': {
        const d = new PyDict();
        for (let i = 0; i < node.keys.length; i++) {
          if (node.keys[i] === null) {
            const other = yield* this.eval(node.values[i], scope);
            if (other instanceof PyDict) for (const [k, v] of other.entries()) d.set(k, v);
            else typeError('argument after ** must be a mapping');
            continue;
          }
          d.set(yield* this.eval(node.keys[i], scope), yield* this.eval(node.values[i], scope));
        }
        return d;
      }
      case 'BoolOp': {
        let last: PyVal = null;
        for (const v of node.values) {
          last = yield* this.eval(v, scope);
          const t = yield* this.truthy(last);
          if (node.op === 'and' ? !t : t) return last;
        }
        return last;
      }
      case 'UnaryOp':
        return yield* this.unaryOp(node.op, yield* this.eval(node.operand, scope));
      case 'BinOp':
        return yield* this.binOp(node.op, yield* this.eval(node.left, scope), yield* this.eval(node.right, scope));
      case 'Compare': {
        let left = yield* this.eval(node.left, scope);
        for (let i = 0; i < node.ops.length; i++) {
          const right = yield* this.eval(node.comparators[i], scope);
          if (!(yield* this.compare(left, right, node.ops[i]))) return false;
          left = right;
        }
        return true;
      }
      case 'IfExp':
        return (yield* this.truthy(yield* this.eval(node.test, scope))) ? yield* this.eval(node.body, scope) : yield* this.eval(node.orelse, scope);
      case 'Lambda': {
        const fn = new PyFunction('<lambda>', node.params, [{ type: 'Return', line: node.line, col: node.col, value: node.body }], scope, false, scope.globals);
        for (const a of (node.params as Params).args) if (a.default) fn.defaults.push(yield* this.eval(a.default, scope));
        return fn;
      }
      case 'NamedExpr': {
        const v = yield* this.eval(node.value, scope);
        this.setName(scope, node.name, v);
        return v;
      }
      case 'Attribute':
        return yield* this.getAttr(yield* this.eval(node.value, scope), node.attr);
      case 'Subscript':
        return yield* this.getItem(yield* this.eval(node.value, scope), yield* this.evalSlice(node.slice, scope));
      case 'Slice':
        return yield* this.evalSlice(node, scope);
      case 'Starred':
        return yield* this.eval(node.value, scope);
      case 'Call': {
        const func = yield* this.eval(node.func, scope);
        const args: PyVal[] = [];
        for (const a of node.args) {
          if (a.type === 'Starred') args.push(...(yield* this.iterateAll(yield* this.eval(a.value, scope))));
          else args.push(yield* this.eval(a, scope));
        }
        const kwargs = new Map<string, PyVal>();
        for (const kw of node.keywords) {
          if (kw.name === null) {
            const d = yield* this.eval(kw.value, scope);
            if (d instanceof PyDict) for (const [k, v] of d.entries()) kwargs.set(String(k), v);
            else typeError('argument after ** must be a mapping');
          } else kwargs.set(kw.name, yield* this.eval(kw.value, scope));
        }
        return yield* this.call(func, args, kwargs);
      }
      case 'ListComp':
        return new PyList(yield* this.comprehend(node, scope));
      case 'SetComp':
        return PySet.from(yield* this.comprehend(node, scope));
      case 'DictComp': {
        const d = new PyDict();
        yield* this.runComprehension(node.generators, 0, newScope(scope, scope.globals, true), function* (this: Interpreter, s) {
          d.set(yield* this.eval(node.key, s), yield* this.eval(node.value, s));
        }, this);
        return d;
      }
      case 'GenExp': {
        // eager; simpler
        return arrayGenerator(yield* this.comprehend(node, scope));
      }
      case 'Yield': {
        const value = node.value ? yield* this.eval(node.value, scope) : null;
        const sent = yield { t: 'yield', value };
        return sent === undefined ? null : sent;
      }
      case 'YieldFrom': {
        const it = yield* this.getIter(yield* this.eval(node.value, scope));
        let last: PyVal = null;
        for (;;) {
          const step = yield* it.next();
          if (step.done) break;
          last = yield { t: 'yield', value: step.value! };
        }
        return last;
      }
    }
    raisePy('SystemError', `unsupported expression ${node.type}`);
  }

  private *formatOne(v: PyVal, conversion: string | null, specNode: any, scope: Scope): Exec<string> {
    let value = v;
    if (conversion === 'r') return yield* this.repr(value);
    if (conversion === 's') return yield* this.str(value);
    let spec = '';
    if (specNode) spec = typeof specNode === 'string' ? specNode : '';
    if (spec.includes('{')) {
      // Nested spec such as f"{x:{width}}"
      const parsed = parse(`f"${spec.replace(/"/g, '\\"')}"`) as any;
      spec = yield* this.eval(parsed.body[0].value, scope) as any;
    }
    if (spec) {
      const out = formatValue(value, spec);
      if (out !== null) return out;
      const s = yield* this.str(value);
      const padded = formatValue(s, spec);
      return padded ?? s;
    }
    if (value instanceof PyInstance) {
      const m = yield* this.findDunder(value, '__format__');
      if (m) return asStr(yield* this.call(m, [''], new Map()));
    }
    return yield* this.str(value);
  }

  private *evalItems(nodes: Node[], scope: Scope): Exec<PyVal[]> {
    const out: PyVal[] = [];
    for (const n of nodes) {
      if (n.type === 'Starred') out.push(...(yield* this.iterateAll(yield* this.eval(n.value, scope))));
      else out.push(yield* this.eval(n, scope));
    }
    return out;
  }

  private *comprehend(node: Node, scope: Scope): Exec<PyVal[]> {
    const out: PyVal[] = [];
    yield* this.runComprehension(node.generators, 0, newScope(scope, scope.globals, true), function* (this: Interpreter, s) {
      out.push(yield* this.eval(node.elt, s));
    }, this);
    return out;
  }

  private *runComprehension(gens: Node[], i: number, scope: Scope, emit: (this: Interpreter, s: Scope) => Exec<void>, self: Interpreter): Exec<void> {
    if (i >= gens.length) {
      yield* emit.call(self, scope);
      return;
    }
    const gen = gens[i];
    const it = yield* this.getIter(yield* this.eval(gen.iter, scope));
    for (;;) {
      yield { t: 'tick' };
      const step = yield* it.next();
      if (step.done) break;
      yield* this.assign(gen.target, step.value!, scope);
      let ok = true;
      for (const cond of gen.ifs) {
        if (!(yield* this.truthy(yield* this.eval(cond, scope)))) {
          ok = false;
          break;
        }
      }
      if (ok) yield* this.runComprehension(gens, i + 1, scope, emit, self);
    }
  }

  // modules
  *importModule(name: string): Exec<PyVal> {
    const cached = this.modules.get(name);
    if (cached) return cached;
    const builder = MODULE_BUILDERS.get(name);
    if (builder) {
      const mod = builder(this);
      this.modules.set(name, mod);
      return mod;
    }
    // A file in the workspace.
    const source = this.io.readFile(name.replace(/\./g, '/') + '.py');
    if (source !== null) {
      const mod = new PyModule(name);
      this.modules.set(name, mod);
      const scope = newScope(null, mod.dict, false);
      mod.dict.set('__name__', name);
      const ast = parse(source);
      this.frames.push({ name: `<module ${name}>`, line: 1, func: null, scope });
      try {
        yield* this.execBlock(ast.body, scope);
      } finally {
        this.frames.pop();
      }
      return mod;
    }
    raisePy('ModuleNotFoundError', `No module named '${name}'`);
  }

  traceback(): Array<{ line: number; name: string }> {
    return this.frames.map((f) => ({ line: f.line, name: f.name }));
  }
}

// iterator plumbing
export interface PyIter {
  next(): Generator<Effect, { done: boolean; value?: PyVal }, any>;
}

function arrayIter(items: PyVal[]): PyIter {
  let i = 0;
  return {
    next: function* () {
      if (i >= items.length) return { done: true };
      return { done: false, value: items[i++] };
    },
  };
}

function arrayGenerator(items: PyVal[]): PyGenerator {
  const gen = new PyGenerator('<genexpr>', (function* (): Exec {
    for (const v of items) yield { t: 'yield', value: v };
    return null;
  })());
  return gen;
}

/** Drives a Python generator one step, forwarding ticks and input requests. */
export function* genSend(gen: PyGenerator, sent: PyVal): Generator<Effect, { done: boolean; value?: PyVal }, any> {
  if (gen.done) return { done: true };
  let input: any = sent;
  for (;;) {
    const r = gen.exec.next(input);
    if (r.done) {
      gen.done = true;
      return { done: true, value: r.value };
    }
    const eff = r.value as Effect;
    if (eff.t === 'yield') return { done: false, value: eff.value };
    input = yield eff;
  }
}

function generatorIter(interp: Interpreter, gen: PyGenerator): PyIter {
  return {
    next: function* () {
      return yield* genSend(gen, null);
    },
  };
}

function dunderIter(interp: Interpreter, obj: PyInstance): PyIter {
  return {
    next: function* () {
      const m = yield* interp.findDunder(obj, '__next__');
      if (!m) typeError(`iterator has no __next__`);
      try {
        return { done: false, value: yield* interp.call(m, [], new Map()) };
      } catch (e) {
        if (e instanceof PyRaise && e.value.cls.isSubclassOf(EXCEPTIONS.get('StopIteration')!)) return { done: true };
        throw e;
      }
    },
  };
}

// descriptors
export class StaticMethod {
  constructor(public func: PyVal) {}
}
export class ClassMethod {
  constructor(public func: PyVal) {}
}
export class Property {
  constructor(
    public getter: PyVal | null,
    public setter: PyVal | null = null,
  ) {}
}

export const NOT_IMPLEMENTED_VALUE = Symbol('NotImplementedValue') as unknown as PyVal;

function bindIfFunction(v: PyVal, self: PyVal): PyVal | null {
  if (v instanceof PyFunction || v instanceof NativeFunc) return new BoundMethod(self, v);
  if (v instanceof StaticMethod) return v.func;
  if (v instanceof ClassMethod) return new BoundMethod(self instanceof PyInstance ? self.cls : self, v.func as any);
  return v;
}

function identical(a: PyVal, b: PyVal): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === 'bigint' && typeof b === 'bigint') return a === b;
  if (typeof a === 'boolean' || typeof b === 'boolean') return a === b;
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  return a === b;
}

function applyCompare(c: number, op: string): boolean {
  switch (op) {
    case '<':
      return c < 0;
    case '<=':
      return c <= 0;
    case '>':
      return c > 0;
    case '>=':
      return c >= 0;
  }
  return false;
}

export function asStr(v: PyVal): string {
  if (typeof v !== 'string') typeError(`expected str, got ${typeName(v)}`);
  return v;
}

function containsYield(body: Node[]): boolean {
  let found = false;
  const walk = (n: any) => {
    if (found || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (n.type === 'Yield' || n.type === 'YieldFrom') {
      found = true;
      return;
    }
    if (n.type === 'FunctionDef' || n.type === 'Lambda' || n.type === 'ClassDef') return;
    for (const k of Object.keys(n)) if (k !== 'type' && k !== 'line' && k !== 'col') walk(n[k]);
  };
  walk(body);
  return found;
}

function isException(v: PyInstance): boolean {
  return v.cls.isSubclassOf(EXCEPTIONS.get('BaseException')!);
}

/** str(exc) is the message; repr(exc) shows the argument tuple. */
function excArgsText(v: PyInstance, forRepr: boolean): string {
  const args = v.dict.get('args');
  if (!(args instanceof PyTuple) || !args.items.length) return '';
  if (args.items.length === 1) {
    const a = args.items[0];
    if (forRepr) return reprSimple(a);
    return v.cls.name === 'KeyError' ? reprSimple(a) : typeof a === 'string' ? a : reprSimple(a);
  }
  return (forRepr ? '' : '(') + args.items.map(reprSimple).join(', ') + (forRepr ? '' : ')');
}

function closeFile(f: PyFile): void {
  if (!f.closed) {
    f.closed = true;
    f.onClose(f);
  }
}

// Wired up by stdlib.ts to avoid a circular import at module level.
export const MODULE_BUILDERS = new Map<string, (interp: Interpreter) => PyModule>();
export let getNativeMethod: (interp: Interpreter, obj: PyVal, name: string) => PyVal | undefined = () => undefined;
export function setNativeMethodResolver(fn: typeof getNativeMethod): void {
  getNativeMethod = fn;
}
export { closeFile };
