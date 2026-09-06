// Runtime values. None -> null, bool -> boolean, int -> bigint, float -> number,
// str -> string; everything else is a class below. Dunder dispatch is in interp.ts.

export type PyVal = null | boolean | bigint | number | string | PyObj;
export type PyObj = PyList | PyTuple | PyDict | PySet | PyRange | PySlice | PyFunction | NativeFunc | BoundMethod | PyClass | PyInstance | PyModule | PyGenerator | PyFile;

let nextId = 1;
const ids = new WeakMap<object, number>();
export function objId(o: object): number {
  let v = ids.get(o);
  if (v === undefined) {
    v = nextId++;
    ids.set(o, v);
  }
  return v;
}

export class PyList {
  constructor(public items: PyVal[] = []) {}
}
export class PyTuple {
  constructor(public items: PyVal[] = []) {}
}
export class PySlice {
  constructor(
    public lower: PyVal,
    public upper: PyVal,
    public step: PyVal,
  ) {}
}
export class PyRange {
  constructor(
    public start: bigint,
    public stop: bigint,
    public step: bigint,
  ) {}
  get length(): bigint {
    const { start, stop, step } = this;
    if (step > 0n) return stop > start ? (stop - start + step - 1n) / step : 0n;
    return start > stop ? (start - stop + (-step) - 1n) / -step : 0n;
  }
  at(i: bigint): bigint {
    return this.start + i * this.step;
  }
}

/** Ordered mapping, keyed the way Python hashes values. */
export class PyDict {
  map = new Map<string, { key: PyVal; value: PyVal }>();
  get size(): number {
    return this.map.size;
  }
  get(key: PyVal): PyVal | undefined {
    return this.map.get(keyOf(key))?.value;
  }
  has(key: PyVal): boolean {
    return this.map.has(keyOf(key));
  }
  set(key: PyVal, value: PyVal): void {
    const k = keyOf(key);
    const existing = this.map.get(k);
    if (existing) existing.value = value;
    else this.map.set(k, { key, value });
  }
  delete(key: PyVal): boolean {
    return this.map.delete(keyOf(key));
  }
  keys(): PyVal[] {
    return [...this.map.values()].map((e) => e.key);
  }
  values(): PyVal[] {
    return [...this.map.values()].map((e) => e.value);
  }
  entries(): Array<[PyVal, PyVal]> {
    return [...this.map.values()].map((e) => [e.key, e.value] as [PyVal, PyVal]);
  }
  static from(pairs: Array<[PyVal, PyVal]>): PyDict {
    const d = new PyDict();
    for (const [k, v] of pairs) d.set(k, v);
    return d;
  }
}

export class PySet {
  map = new Map<string, PyVal>();
  get size(): number {
    return this.map.size;
  }
  has(v: PyVal): boolean {
    return this.map.has(keyOf(v));
  }
  add(v: PyVal): void {
    this.map.set(keyOf(v), v);
  }
  delete(v: PyVal): boolean {
    return this.map.delete(keyOf(v));
  }
  values(): PyVal[] {
    return [...this.map.values()];
  }
  static from(vals: PyVal[]): PySet {
    const s = new PySet();
    for (const v of vals) s.add(v);
    return s;
  }
}

export interface Params {
  args: Array<{ name: string; default: any }>;
  vararg: string | null;
  kwonly: Array<{ name: string; default: any }>;
  kwarg: string | null;
}

export class PyFunction {
  /** Filled in by the interpreter when the def is executed. */
  defaults: PyVal[] = [];
  kwdefaults = new Map<string, PyVal>();
  doc: string | null = null;
  constructor(
    public name: string,
    public params: Params,
    public body: any[],
    public scope: any,
    public isGenerator: boolean,
    public globals: Map<string, PyVal>,
  ) {}
}

export class NativeFunc {
  constructor(
    public name: string,
    public fn: (args: PyVal[], kwargs: Map<string, PyVal>) => PyVal | Generator<any, PyVal, any>,
    /** True when fn is a generator function that needs driving by the interpreter. */
    public reentrant = false,
    public doc = '',
  ) {}
}

export class BoundMethod {
  constructor(
    public self: PyVal,
    public func: PyFunction | NativeFunc,
  ) {}
}

export class PyClass {
  mro: PyClass[] = [];
  constructor(
    public name: string,
    public bases: PyClass[],
    public dict: Map<string, PyVal> = new Map(),
  ) {
    this.mro = linearize(this);
  }
  lookup(name: string): PyVal | undefined {
    for (const c of this.mro) {
      const v = c.dict.get(name);
      if (v !== undefined) return v;
    }
    return undefined;
  }
  isSubclassOf(other: PyClass): boolean {
    return this.mro.includes(other);
  }
}

/** Depth-first left-to-right linearisation; good enough without full C3. */
function linearize(cls: PyClass): PyClass[] {
  const out: PyClass[] = [cls];
  for (const base of cls.bases) {
    for (const c of base.mro.length ? base.mro : [base]) if (!out.includes(c)) out.push(c);
  }
  return out;
}

export class PyInstance {
  dict = new Map<string, PyVal>();
  constructor(public cls: PyClass) {}
}

export class PyModule {
  constructor(
    public name: string,
    public dict: Map<string, PyVal> = new Map(),
  ) {}
}

export class PyGenerator {
  done = false;
  started = false;
  /** The interpreter's suspended execution, driven by next()/send(). */
  constructor(
    public name: string,
    public exec: Generator<any, PyVal, any>,
  ) {}
}

/** A file opened on the editor's virtual filesystem. */
export class PyFile {
  pos = 0;
  closed = false;
  constructor(
    public path: string,
    public mode: string,
    public content: string,
    public onClose: (f: PyFile) => void,
  ) {}
}

// exceptions
/** Thrown through JavaScript to unwind; carries the Python exception object. */
export class PyRaise extends Error {
  constructor(
    public value: PyInstance,
    public traceback: Array<{ line: number; name: string }> = [],
  ) {
    super('PyRaise');
  }
}

const EXC_TREE: Record<string, string[]> = {
  BaseException: ['Exception', 'KeyboardInterrupt', 'SystemExit', 'GeneratorExit'],
  Exception: ['ArithmeticError', 'AssertionError', 'AttributeError', 'BufferError', 'EOFError', 'ImportError', 'LookupError', 'MemoryError', 'NameError', 'OSError', 'ReferenceError', 'RuntimeError', 'StopIteration', 'StopAsyncIteration', 'SyntaxError', 'SystemError', 'TypeError', 'ValueError', 'Warning'],
  ArithmeticError: ['FloatingPointError', 'OverflowError', 'ZeroDivisionError'],
  ImportError: ['ModuleNotFoundError'],
  LookupError: ['IndexError', 'KeyError'],
  NameError: ['UnboundLocalError'],
  OSError: ['FileNotFoundError', 'FileExistsError', 'IsADirectoryError', 'NotADirectoryError', 'PermissionError'],
  RuntimeError: ['NotImplementedError', 'RecursionError'],
  SyntaxError: ['IndentationError'],
  ValueError: ['UnicodeError'],
  Warning: ['DeprecationWarning', 'RuntimeWarning', 'UserWarning'],
};

export const EXCEPTIONS = new Map<string, PyClass>();
{
  const objectClass = new PyClass('object', []);
  EXCEPTIONS.set('object', objectClass);
  const make = (name: string, base: PyClass) => {
    const c = new PyClass(name, [base]);
    EXCEPTIONS.set(name, c);
    for (const child of EXC_TREE[name] ?? []) make(child, c);
    return c;
  };
  make('BaseException', objectClass);
}

export const OBJECT_CLASS = EXCEPTIONS.get('object')!;

export function makeException(name: string, message: string): PyInstance {
  const cls = EXCEPTIONS.get(name) ?? EXCEPTIONS.get('Exception')!;
  const inst = new PyInstance(cls);
  inst.dict.set('args', new PyTuple(message === '' ? [] : [message]));
  return inst;
}

export function raisePy(name: string, message: string): never {
  throw new PyRaise(makeException(name, message));
}

export const typeError: (m: string) => never = (m) => raisePy('TypeError', m);
export const valueError: (m: string) => never = (m) => raisePy('ValueError', m);

// type names
export function typeName(v: PyVal): string {
  if (v === null) return 'NoneType';
  switch (typeof v) {
    case 'boolean':
      return 'bool';
    case 'bigint':
      return 'int';
    case 'number':
      return 'float';
    case 'string':
      return 'str';
  }
  if (v instanceof PyList) return 'list';
  if (v instanceof PyTuple) return 'tuple';
  if (v instanceof PyDict) return 'dict';
  if (v instanceof PySet) return 'set';
  if (v instanceof PyRange) return 'range';
  if (v instanceof PySlice) return 'slice';
  if (v instanceof PyFunction || v instanceof NativeFunc) return 'function';
  if (v instanceof BoundMethod) return 'method';
  if (v instanceof PyClass) return 'type';
  if (v instanceof PyModule) return 'module';
  if (v instanceof PyGenerator) return 'generator';
  if (v instanceof PyFile) return 'TextIOWrapper';
  if (v instanceof PyInstance) return v.cls.name;
  return 'object';
}

// hashing
export function keyOf(v: PyVal): string {
  if (v === null) return 'N';
  switch (typeof v) {
    case 'boolean':
      return 'i:' + (v ? '1' : '0');
    case 'bigint':
      return 'i:' + v.toString();
    case 'number':
      return Number.isInteger(v) && Math.abs(v) < 1e21 ? 'i:' + BigInt(v).toString() : 'f:' + v;
    case 'string':
      return 's:' + v;
  }
  if (v instanceof PyTuple) return 't:' + v.items.map(keyOf).join('');
  if (v instanceof PyList) typeError("unhashable type: 'list'");
  if (v instanceof PyDict) typeError("unhashable type: 'dict'");
  if (v instanceof PySet) typeError("unhashable type: 'set'");
  return 'o:' + objId(v as object);
}

// numbers
export const isInt = (v: PyVal): v is bigint => typeof v === 'bigint';
export const isNum = (v: PyVal): v is bigint | number | boolean => typeof v === 'bigint' || typeof v === 'number' || typeof v === 'boolean';
export const toNum = (v: PyVal): number => (typeof v === 'bigint' ? Number(v) : typeof v === 'boolean' ? (v ? 1 : 0) : (v as number));
export const toBig = (v: PyVal): bigint => (typeof v === 'bigint' ? v : typeof v === 'boolean' ? (v ? 1n : 0n) : BigInt(Math.trunc(v as number)));
/** True when both operands should be handled with exact integer arithmetic. */
const bothInt = (a: PyVal, b: PyVal) => (typeof a === 'bigint' || typeof a === 'boolean') && (typeof b === 'bigint' || typeof b === 'boolean');

export function floorDivBig(a: bigint, b: bigint): bigint {
  if (b === 0n) raisePy('ZeroDivisionError', 'integer division or modulo by zero');
  let q = a / b;
  if (a % b !== 0n && a < 0n !== b < 0n) q -= 1n;
  return q;
}

export function modBig(a: bigint, b: bigint): bigint {
  if (b === 0n) raisePy('ZeroDivisionError', 'integer modulo by zero');
  const r = a % b;
  return r !== 0n && r < 0n !== b < 0n ? r + b : r;
}

const NOT_IMPLEMENTED = Symbol('NotImplemented');
export { NOT_IMPLEMENTED };

/** Arithmetic on built-in types. Returns NOT_IMPLEMENTED when a dunder is needed. */
export function nativeBinOp(op: string, a: PyVal, b: PyVal): PyVal | typeof NOT_IMPLEMENTED {
  if (op === '+') {
    if (typeof a === 'string' && typeof b === 'string') return a + b;
    if (a instanceof PyList && b instanceof PyList) return new PyList([...a.items, ...b.items]);
    if (a instanceof PyTuple && b instanceof PyTuple) return new PyTuple([...a.items, ...b.items]);
    if (typeof a === 'string' && !(typeof b === 'string')) typeError(`can only concatenate str (not "${typeName(b)}") to str`);
  }
  if (op === '*') {
    const rep = (seq: PyVal[], n: PyVal) => {
      const count = Number(toBig(n));
      const out: PyVal[] = [];
      for (let i = 0; i < count; i++) out.push(...seq);
      return out;
    };
    if (typeof a === 'string' && isInt(b)) return Number(b) > 0 ? a.repeat(Number(b)) : '';
    if (isInt(a) && typeof b === 'string') return Number(a) > 0 ? b.repeat(Number(a)) : '';
    if (a instanceof PyList && isNum(b) && !(typeof b === 'number')) return new PyList(rep(a.items, b));
    if (isNum(a) && !(typeof a === 'number') && b instanceof PyList) return new PyList(rep(b.items, a));
    if (a instanceof PyTuple && isNum(b) && !(typeof b === 'number')) return new PyTuple(rep(a.items, b));
  }
  if (op === '%' && typeof a === 'string') return printfFormat(a, b);
  if (op === '|' && a instanceof PySet && b instanceof PySet) return PySet.from([...a.values(), ...b.values()]);
  if (op === '&' && a instanceof PySet && b instanceof PySet) return PySet.from(a.values().filter((v) => b.has(v)));
  if (op === '-' && a instanceof PySet && b instanceof PySet) return PySet.from(a.values().filter((v) => !b.has(v)));
  if (op === '^' && a instanceof PySet && b instanceof PySet) return PySet.from([...a.values().filter((v) => !b.has(v)), ...b.values().filter((v) => !a.has(v))]);
  if (op === '|' && a instanceof PyDict && b instanceof PyDict) return PyDict.from([...a.entries(), ...b.entries()]);

  if (!isNum(a) || !isNum(b)) return NOT_IMPLEMENTED;
  if (bothInt(a, b)) {
    const x = toBig(a);
    const y = toBig(b);
    switch (op) {
      case '+':
        return x + y;
      case '-':
        return x - y;
      case '*':
        return x * y;
      case '//':
        return floorDivBig(x, y);
      case '%':
        return modBig(x, y);
      case '/':
        if (y === 0n) raisePy('ZeroDivisionError', 'division by zero');
        return Number(x) / Number(y);
      case '**':
        if (y < 0n) return Math.pow(Number(x), Number(y));
        return x ** y;
      case '&':
        return x & y;
      case '|':
        return x | y;
      case '^':
        return x ^ y;
      case '<<':
        return x << y;
      case '>>':
        return x >> y;
    }
    return NOT_IMPLEMENTED;
  }
  const x = toNum(a);
  const y = toNum(b);
  switch (op) {
    case '+':
      return x + y;
    case '-':
      return x - y;
    case '*':
      return x * y;
    case '/':
      if (y === 0) raisePy('ZeroDivisionError', 'float division by zero');
      return x / y;
    case '//':
      if (y === 0) raisePy('ZeroDivisionError', 'float floor division by zero');
      return Math.floor(x / y);
    case '%': {
      if (y === 0) raisePy('ZeroDivisionError', 'float modulo');
      const r = x % y;
      return r !== 0 && r < 0 !== y < 0 ? r + y : r;
    }
    case '**':
      return Math.pow(x, y);
  }
  return NOT_IMPLEMENTED;
}

export function nativeUnary(op: string, v: PyVal): PyVal | typeof NOT_IMPLEMENTED {
  if (op === '-') {
    if (typeof v === 'bigint') return -v;
    if (typeof v === 'boolean') return v ? -1n : 0n;
    if (typeof v === 'number') return -v;
    return NOT_IMPLEMENTED;
  }
  if (op === '+') return isNum(v) ? (typeof v === 'boolean' ? toBig(v) : v) : NOT_IMPLEMENTED;
  if (op === '~') {
    if (typeof v === 'bigint') return ~v;
    if (typeof v === 'boolean') return ~toBig(v);
    return NOT_IMPLEMENTED;
  }
  return NOT_IMPLEMENTED;
}

/** Structural equality for built-ins; instances are handled in interp.ts. */
export function nativeEq(a: PyVal, b: PyVal): boolean | typeof NOT_IMPLEMENTED {
  if (a === b) return true;
  if (isNum(a) && isNum(b)) return bothInt(a, b) ? toBig(a) === toBig(b) : toNum(a) === toNum(b);
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  if (a === null || b === null) return a === b;
  if (a instanceof PyList && b instanceof PyList) return seqEq(a.items, b.items);
  if (a instanceof PyTuple && b instanceof PyTuple) return seqEq(a.items, b.items);
  if (a instanceof PySet && b instanceof PySet) return a.size === b.size && a.values().every((v) => b.has(v));
  if (a instanceof PyDict && b instanceof PyDict) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a.entries()) {
      if (!b.has(k)) return false;
      const r = nativeEq(v, b.get(k)!);
      if (r === NOT_IMPLEMENTED) return NOT_IMPLEMENTED;
      if (!r) return false;
    }
    return true;
  }
  if (a instanceof PyInstance || b instanceof PyInstance) return NOT_IMPLEMENTED;
  return false;
}

function seqEq(a: PyVal[], b: PyVal[]): boolean | typeof NOT_IMPLEMENTED {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const r = nativeEq(a[i], b[i]);
    if (r === NOT_IMPLEMENTED) return NOT_IMPLEMENTED;
    if (!r) return false;
  }
  return true;
}

/** -1 / 0 / 1, or NOT_IMPLEMENTED when the types are not orderable natively. */
export function nativeCompare(a: PyVal, b: PyVal): number | typeof NOT_IMPLEMENTED {
  if (isNum(a) && isNum(b)) {
    if (bothInt(a, b)) {
      const x = toBig(a);
      const y = toBig(b);
      return x < y ? -1 : x > y ? 1 : 0;
    }
    const x = toNum(a);
    const y = toNum(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  const aItems = a instanceof PyList ? a.items : a instanceof PyTuple ? a.items : null;
  const bItems = b instanceof PyList ? b.items : b instanceof PyTuple ? b.items : null;
  if (aItems && bItems) {
    for (let i = 0; i < Math.min(aItems.length, bItems.length); i++) {
      const c = nativeCompare(aItems[i], bItems[i]);
      if (c === NOT_IMPLEMENTED) return NOT_IMPLEMENTED;
      if (c !== 0) return c;
    }
    return aItems.length - bItems.length === 0 ? 0 : aItems.length < bItems.length ? -1 : 1;
  }
  return NOT_IMPLEMENTED;
}

export function truthyNative(v: PyVal): boolean | typeof NOT_IMPLEMENTED {
  if (v === null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'bigint') return v !== 0n;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v) ? true : v !== 0;
  if (typeof v === 'string') return v.length > 0;
  if (v instanceof PyList || v instanceof PyTuple) return v.items.length > 0;
  if (v instanceof PyDict || v instanceof PySet) return v.size > 0;
  if (v instanceof PyRange) return v.length > 0n;
  if (v instanceof PyInstance) return NOT_IMPLEMENTED;
  return true;
}

// text
export function floatRepr(n: number): string {
  if (Number.isNaN(n)) return 'nan';
  if (n === Infinity) return 'inf';
  if (n === -Infinity) return '-inf';
  const abs = Math.abs(n);
  if (n !== 0 && (abs >= 1e16 || abs < 1e-4)) {
    return n.toExponential().replace(/e([+-])(\d)$/, 'e$10$2');
  }
  if (Number.isInteger(n)) return n.toFixed(1);
  return String(n);
}

export function strEscape(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    if (ch === quote || ch === '\\') out += '\\' + ch;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else if (ch < ' ') out += '\\x' + ch.charCodeAt(0).toString(16).padStart(2, '0');
    else out += ch;
  }
  return out + quote;
}

/** repr for values that cannot re-enter Python. interp.ts handles the rest. */
export function reprSimple(v: PyVal): string {
  if (v === null) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return floatRepr(v);
  if (typeof v === 'string') return strEscape(v);
  if (v instanceof PyClass) return `<class '${v.name}'>`;
  if (v instanceof PyModule) return `<module '${v.name}'>`;
  if (v instanceof PyFunction) return `<function ${v.name}>`;
  if (v instanceof NativeFunc) return `<built-in function ${v.name}>`;
  if (v instanceof BoundMethod) return `<bound method ${v.func.name}>`;
  if (v instanceof PyGenerator) return `<generator object ${v.name}>`;
  if (v instanceof PyFile) return `<file '${v.path}' mode '${v.mode}'>`;
  if (v instanceof PyRange) return `range(${v.start}, ${v.stop}${v.step === 1n ? '' : ', ' + v.step})`;
  if (v instanceof PySlice) return `slice(${reprSimple(v.lower)}, ${reprSimple(v.upper)}, ${reprSimple(v.step)})`;
  if (v instanceof PyInstance) return `<${v.cls.name} object>`;
  if (v instanceof PyList) return `[${v.items.map(reprSimple).join(', ')}]`;
  if (v instanceof PyTuple) return v.items.length === 1 ? `(${reprSimple(v.items[0])},)` : `(${v.items.map(reprSimple).join(', ')})`;
  if (v instanceof PySet) return v.size === 0 ? 'set()' : `{${v.values().map(reprSimple).join(', ')}}`;
  if (v instanceof PyDict) return `{${v.entries().map(([k, val]) => `${reprSimple(k)}: ${reprSimple(val)}`).join(', ')}}`;
  return String(v);
}

/** Implements the format mini-language used by format() and f-strings. */
export function formatValue(value: PyVal, spec: string): string {
  if (!spec) return null as any; // caller falls back to str()
  const m = /^(?:(.)?([<>^=]))?([+\- ])?(#)?(0)?(\d+)?(,|_)?(?:\.(\d+))?([bcdeEfFgGnosxX%])?$/.exec(spec);
  if (!m) valueError(`Invalid format specifier '${spec}'`);
  const [, fillRaw, alignRaw, sign, alt, zero, widthRaw, group, precRaw, typeRaw] = m;
  const width = widthRaw ? parseInt(widthRaw, 10) : 0;
  const prec = precRaw ? parseInt(precRaw, 10) : undefined;
  const type = typeRaw ?? '';
  let body: string;
  let isNumeric = isNum(value) && typeof value !== 'string';

  if (type === 's' || (!type && !isNumeric)) {
    body = typeof value === 'string' ? value : (null as any);
    if (body === null) return null as any; // caller stringifies then re-applies padding
    if (prec !== undefined) body = body.slice(0, prec);
  } else if (isNumeric) {
    const num = value;
    if ('bodxX'.includes(type)) {
      const i = toBig(num);
      const neg = i < 0n;
      const abs = neg ? -i : i;
      const base = type === 'b' ? 2 : type === 'o' ? 8 : type === 'd' || type === '' ? 10 : 16;
      let digits = abs.toString(base);
      if (type === 'X') digits = digits.toUpperCase();
      if (group && base === 10) digits = groupDigits(digits, group);
      const prefix = alt ? (type === 'b' ? '0b' : type === 'o' ? '0o' : type === 'x' ? '0x' : type === 'X' ? '0X' : '') : '';
      body = (neg ? '-' : sign === '+' ? '+' : sign === ' ' ? ' ' : '') + prefix + digits;
    } else if (type === 'c') {
      body = String.fromCodePoint(Number(toBig(num)));
    } else {
      const n = toNum(num);
      const p = prec ?? 6;
      if (type === 'f' || type === 'F') body = Math.abs(n).toFixed(p);
      else if (type === 'e' || type === 'E') {
        body = Math.abs(n).toExponential(p);
        if (type === 'E') body = body.toUpperCase();
        body = body.replace(/e([+-])(\d)$/i, (mm, s2, d) => (type === 'E' ? 'E' : 'e') + s2 + '0' + d);
      } else if (type === '%') body = (Math.abs(n) * 100).toFixed(p) + '%';
      else if (type === 'g' || type === 'G') {
        body = Number(Math.abs(n).toPrecision(prec ?? 6)).toString();
        if (type === 'G') body = body.toUpperCase();
      } else {
        // No type: int keeps exact form, float uses repr
        body = typeof num === 'bigint' || typeof num === 'boolean' ? toBig(num).toString().replace('-', '') : floatRepr(Math.abs(n));
      }
      if (group) {
        const dot = body.indexOf('.');
        const intPart = dot === -1 ? body : body.slice(0, dot);
        const rest = dot === -1 ? '' : body.slice(dot);
        body = groupDigits(intPart, group) + rest;
      }
      const negative = n < 0 || Object.is(n, -0);
      body = (negative ? '-' : sign === '+' ? '+' : sign === ' ' ? ' ' : '') + body;
    }
  } else {
    return null as any;
  }

  const align = alignRaw ?? (isNumeric ? '>' : '<');
  const fill = fillRaw ?? (zero && isNumeric ? '0' : ' ');
  if (body.length >= width) return body;
  const pad = width - body.length;
  if (align === '>') {
    if (zero && !fillRaw && /^[+\- ]/.test(body)) return body[0] + fill.repeat(pad) + body.slice(1);
    return fill.repeat(pad) + body;
  }
  if (align === '<') return body + fill.repeat(pad);
  if (align === '=') {
    const signChar = /^[+\- ]/.test(body) ? body[0] : '';
    return signChar + fill.repeat(pad) + body.slice(signChar.length);
  }
  const left = Math.floor(pad / 2);
  return fill.repeat(left) + body + fill.repeat(pad - left);
}

function groupDigits(digits: string, sep: string): string {
  const s = sep === '_' ? '_' : ',';
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, s);
}

/** Old-style "%s" formatting, enough for the common cases. */
function printfFormat(fmt: string, arg: PyVal): string {
  const args = arg instanceof PyTuple ? arg.items : [arg];
  let i = 0;
  return fmt.replace(/%(?:\((\w+)\))?([-+ 0#]*)(\d+)?(?:\.(\d+))?([sdifeEgGxXob%r])/g, (_m, key, flags, width, prec, conv) => {
    if (conv === '%') return '%';
    const value = key ? ((arg as PyDict).get(key) ?? null) : args[i++];
    let spec = '';
    if (flags.includes('-')) spec += '<';
    else if (flags.includes('0')) spec += '0';
    if (width) spec += width;
    if (prec !== undefined) spec += '.' + prec;
    if (conv === 'i') conv = 'd';
    if (conv === 'r' || conv === 's') return conv === 'r' ? reprSimple(value) : typeof value === 'string' ? value : reprSimple(value);
    const out = formatValue(value, spec + conv);
    return out ?? reprSimple(value);
  });
}

// indices
export function normIndex(i: PyVal, len: number, what: string): number {
  if (!isNum(i) || typeof i === 'number') {
    if (typeof i === 'number' && Number.isInteger(i)) i = BigInt(i);
    else typeError(`${what} indices must be integers, not ${typeName(i)}`);
  }
  let n = Number(toBig(i));
  if (n < 0) n += len;
  if (n < 0 || n >= len) raisePy('IndexError', `${what} index out of range`);
  return n;
}

export function sliceIndices(s: PySlice, len: number): { start: number; stop: number; step: number } {
  const step = s.step === null ? 1 : Number(toBig(s.step));
  if (step === 0) valueError('slice step cannot be zero');
  const def = (v: PyVal, whenNeg: number, whenPos: number) => {
    if (v === null) return step > 0 ? whenPos : whenNeg;
    let n = Number(toBig(v));
    if (n < 0) n += len;
    return Math.max(step > 0 ? 0 : -1, Math.min(n, step > 0 ? len : len - 1));
  };
  const start = def(s.lower, len - 1, 0);
  const stop = def(s.upper, -1, len);
  return { start, stop, step };
}

export function sliceSeq<T>(items: T[], s: PySlice): T[] {
  const { start, stop, step } = sliceIndices(s, items.length);
  const out: T[] = [];
  if (step > 0) for (let i = start; i < stop; i += step) out.push(items[i]);
  else for (let i = start; i > stop; i += step) out.push(items[i]);
  return out;
}
