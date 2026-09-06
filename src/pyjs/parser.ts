// Tokenizer and parser. No eval anywhere: this runs where CSP forbids it.

export interface Tok {
  type: 'NAME' | 'KEYWORD' | 'NUMBER' | 'STRING' | 'FSTRING' | 'OP' | 'NEWLINE' | 'INDENT' | 'DEDENT' | 'EOF';
  value: string;
  line: number;
  col: number;
  /** STRING/FSTRING: prefix letters (r, b, f, u) lowercased. */
  prefix?: string;
  /** NUMBER: true when the literal is an int. */
  isInt?: boolean;
}

export class PySyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly col: number,
  ) {
    super(message);
  }
}

const KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
  'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
  'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
]);

// Longest first so maximal munch works with a simple scan.
const OPERATORS = [
  '**=', '//=', '>>=', '<<=', '...', '!=', '>=', '<=', '==', '->', ':=', '+=', '-=', '*=', '/=', '%=', '&=', '|=',
  '^=', '@=', '**', '//', '<<', '>>', '+', '-', '*', '/', '%', '@', '&', '|', '^', '~', '<', '>', '(', ')', '[',
  ']', '{', '}', ',', ':', '.', ';', '=',
];

// \u escapes on purpose: a raw U+FFFF didn't survive a clipboard once
const IDENT_START = /[A-Za-z_\u00aa-\uffff]/;
const IDENT_PART = /[A-Za-z0-9_\u00aa-\uffff]/;

export function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  const indents = [0];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  let depth = 0; // bracket nesting: newlines inside brackets are not significant
  let atLineStart = true;
  const col = () => i - lineStart + 1;
  const push = (type: Tok['type'], value: string, extra: Partial<Tok> = {}) => toks.push({ type, value, line, col: col(), ...extra });
  const err = (m: string) => {
    throw new PySyntaxError(m, line, col());
  };

  while (i < src.length) {
    if (atLineStart && depth === 0) {
      // Measure indentation; skip blank and comment-only lines entirely.
      let width = 0;
      const start = i;
      for (; i < src.length; i++) {
        if (src[i] === ' ') width++;
        else if (src[i] === '\t') width += 8 - (width % 8);
        else break;
      }
      if (i >= src.length) break;
      if (src[i] === '\n' || src[i] === '\r' || src[i] === '#') {
        while (i < src.length && src[i] !== '\n') i++;
        if (i < src.length) {
          i++;
          line++;
          lineStart = i;
        }
        continue;
      }
      const top = indents[indents.length - 1];
      if (width > top) {
        indents.push(width);
        toks.push({ type: 'INDENT', value: '', line, col: 1 });
      } else if (width < top) {
        while (indents.length && indents[indents.length - 1] > width) {
          indents.pop();
          toks.push({ type: 'DEDENT', value: '', line, col: 1 });
        }
        if (indents[indents.length - 1] !== width) throw new PySyntaxError('unindent does not match any outer indentation level', line, i - start + 1);
      }
      atLineStart = false;
      continue;
    }

    const c = src[i];
    if (c === '\r') {
      i++;
      continue;
    }
    if (c === '\n') {
      i++;
      if (depth === 0) {
        push('NEWLINE', '\n');
        atLineStart = true;
      }
      line++;
      lineStart = i;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\f') {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '\\' && (src[i + 1] === '\n' || (src[i + 1] === '\r' && src[i + 2] === '\n'))) {
      i += src[i + 1] === '\r' ? 3 : 2;
      line++;
      lineStart = i;
      continue;
    }

    // Strings, possibly with a prefix.
    const prefixMatch = /^([rRbBuUfF]{0,3})(['"])/.exec(src.slice(i, i + 5));
    if (prefixMatch && (prefixMatch[1].length === 0 ? /['"]/.test(c) : IDENT_START.test(c))) {
      const prefix = prefixMatch[1].toLowerCase();
      const startLine = line;
      const startCol = col();
      i += prefix.length;
      const quote = src[i];
      const triple = src[i + 1] === quote && src[i + 2] === quote;
      const term = triple ? quote.repeat(3) : quote;
      i += term.length;
      const raw = prefix.includes('r');
      let out = '';
      for (;;) {
        if (i >= src.length) throw new PySyntaxError(triple ? 'unterminated triple-quoted string literal' : 'unterminated string literal', startLine, startCol);
        if (src.startsWith(term, i)) {
          i += term.length;
          break;
        }
        if (src[i] === '\n') {
          if (!triple) throw new PySyntaxError('unterminated string literal', startLine, startCol);
          out += '\n';
          i++;
          line++;
          lineStart = i;
          continue;
        }
        if (src[i] === '\\') {
          if (raw) {
            // Raw strings keep the backslash but a quote can still be escaped.
            out += src[i];
            i++;
            if (i < src.length) {
              out += src[i];
              i++;
            }
            continue;
          }
          i++;
          const e = src[i++];
          const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', '0': '\0', a: '\x07', b: '\b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"' };
          if (e === '\n') {
            line++;
            lineStart = i;
          } else if (e === 'x' || e === 'u' || e === 'U') {
            const len = e === 'x' ? 2 : e === 'u' ? 4 : 8;
            const hex = src.slice(i, i + len);
            i += len;
            out += String.fromCodePoint(parseInt(hex, 16) || 0);
          } else if (e in simple) out += simple[e];
          else out += '\\' + e;
          continue;
        }
        out += src[i++];
      }
      toks.push({ type: prefix.includes('f') ? 'FSTRING' : 'STRING', value: out, line: startLine, col: startCol, prefix });
      continue;
    }

    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const start = i;
      let isInt = true;
      if (c === '0' && /[xXoObB]/.test(src[i + 1] ?? '')) {
        i += 2;
        while (i < src.length && /[0-9a-fA-F_]/.test(src[i])) i++;
      } else {
        while (i < src.length && /[0-9_]/.test(src[i])) i++;
        if (src[i] === '.' && /[0-9]/.test(src[i + 1] ?? '')) {
          isInt = false;
          i++;
          while (i < src.length && /[0-9_]/.test(src[i])) i++;
        } else if (src[i] === '.' && !IDENT_START.test(src[i + 1] ?? '')) {
          isInt = false;
          i++;
        }
        if (/[eE]/.test(src[i] ?? '') && /[0-9+-]/.test(src[i + 1] ?? '')) {
          isInt = false;
          i += 2;
          while (i < src.length && /[0-9_]/.test(src[i])) i++;
        }
      }
      if (/[jJ]/.test(src[i] ?? '')) err('complex numbers are not supported');
      push('NUMBER', src.slice(start, i).replace(/_/g, ''), { isInt });
      continue;
    }

    if (IDENT_START.test(c)) {
      const start = i;
      while (i < src.length && IDENT_PART.test(src[i])) i++;
      const word = src.slice(start, i);
      push(KEYWORDS.has(word) ? 'KEYWORD' : 'NAME', word);
      continue;
    }

    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op) {
      if ('([{'.includes(op)) depth++;
      else if (')]}'.includes(op)) depth = Math.max(0, depth - 1);
      push('OP', op);
      i += op.length;
      continue;
    }
    err(`invalid character ${JSON.stringify(c)}`);
  }

  if (toks.length && toks[toks.length - 1].type !== 'NEWLINE') toks.push({ type: 'NEWLINE', value: '\n', line, col: col() });
  while (indents.length > 1) {
    indents.pop();
    toks.push({ type: 'DEDENT', value: '', line, col: 1 });
  }
  toks.push({ type: 'EOF', value: '', line, col: 1 });
  return toks;
}

// AST
export interface Node {
  type: string;
  line: number;
  col: number;
  [k: string]: any;
}

export interface Params {
  args: Array<{ name: string; default: Node | null }>;
  vararg: string | null;
  kwonly: Array<{ name: string; default: Node | null }>;
  kwarg: string | null;
}

const AUG_OPS: Record<string, string> = {
  '+=': '+', '-=': '-', '*=': '*', '/=': '/', '//=': '//', '%=': '%', '**=': '**',
  '&=': '&', '|=': '|', '^=': '^', '<<=': '<<', '>>=': '>>', '@=': '@',
};

class Parser {
  private p = 0;

  constructor(private toks: Tok[]) {}

  private peek(n = 0): Tok {
    return this.toks[Math.min(this.p + n, this.toks.length - 1)];
  }

  private next(): Tok {
    return this.toks[this.p++];
  }

  private at(type: Tok['type'], value?: string): boolean {
    const t = this.peek();
    return t.type === type && (value === undefined || t.value === value);
  }

  private atOp(...values: string[]): boolean {
    const t = this.peek();
    return t.type === 'OP' && values.includes(t.value);
  }

  private atKw(...values: string[]): boolean {
    const t = this.peek();
    return t.type === 'KEYWORD' && values.includes(t.value);
  }

  private eat(type: Tok['type'], value?: string): boolean {
    if (this.at(type, value)) {
      this.p++;
      return true;
    }
    return false;
  }

  private expect(type: Tok['type'], value?: string): Tok {
    if (!this.at(type, value)) {
      const t = this.peek();
      const got = t.type === 'NEWLINE' ? 'end of line' : t.type === 'EOF' ? 'end of file' : t.type === 'INDENT' ? 'an indented block' : t.type === 'DEDENT' ? 'a dedent' : `'${t.value}'`;
      this.fail(`expected ${value ? `'${value}'` : type.toLowerCase()}, found ${got}`);
    }
    return this.next();
  }

  private fail(msg: string): never {
    const t = this.peek();
    throw new PySyntaxError(msg, t.line, t.col);
  }

  private node(type: string, tok: Tok, fields: Record<string, any>): Node {
    return { type, line: tok.line, col: tok.col, ...fields };
  }

  // statements
  parseModule(): Node {
    const body: Node[] = [];
    while (!this.at('EOF')) {
      if (this.eat('NEWLINE')) continue;
      body.push(...this.statement());
    }
    return { type: 'Module', line: 1, col: 1, body };
  }

  private block(): Node[] {
    // Either a suite on the same line, or an indented block.
    if (this.eat('NEWLINE')) {
      this.expect('INDENT');
      const body: Node[] = [];
      while (!this.at('DEDENT') && !this.at('EOF')) {
        if (this.eat('NEWLINE')) continue;
        body.push(...this.statement());
      }
      this.eat('DEDENT');
      return body;
    }
    return this.simpleLine();
  }

  private simpleLine(): Node[] {
    const out: Node[] = [this.simpleStatement()];
    while (this.eat('OP', ';')) {
      if (this.at('NEWLINE') || this.at('EOF')) break;
      out.push(this.simpleStatement());
    }
    if (!this.at('EOF')) this.expect('NEWLINE');
    return out;
  }

  private statement(): Node[] {
    const t = this.peek();
    if (t.type === 'KEYWORD') {
      switch (t.value) {
        case 'if':
          return [this.ifStatement()];
        case 'while':
          return [this.whileStatement()];
        case 'for':
          return [this.forStatement()];
        case 'def':
          return [this.funcDef([])];
        case 'class':
          return [this.classDef([])];
        case 'try':
          return [this.tryStatement()];
        case 'with':
          return [this.withStatement()];
        case 'async':
          this.fail('async / await are not supported by the built-in interpreter');
      }
    }
    if (this.atOp('@')) return [this.decorated()];
    return this.simpleLine();
  }

  private decorated(): Node {
    const decorators: Node[] = [];
    while (this.atOp('@')) {
      this.next();
      decorators.push(this.expression());
      this.expect('NEWLINE');
    }
    if (this.atKw('def')) return this.funcDef(decorators);
    if (this.atKw('class')) return this.classDef(decorators);
    return this.fail('expected a function or class after a decorator');
  }

  private ifStatement(): Node {
    const tok = this.next(); // if / elif
    const test = this.namedExpr();
    this.expect('OP', ':');
    const body = this.block();
    let orelse: Node[] = [];
    if (this.atKw('elif')) orelse = [this.ifStatement()];
    else if (this.atKw('else')) {
      this.next();
      this.expect('OP', ':');
      orelse = this.block();
    }
    return this.node('If', tok, { test, body, orelse });
  }

  private whileStatement(): Node {
    const tok = this.next();
    const test = this.namedExpr();
    this.expect('OP', ':');
    const body = this.block();
    let orelse: Node[] = [];
    if (this.atKw('else')) {
      this.next();
      this.expect('OP', ':');
      orelse = this.block();
    }
    return this.node('While', tok, { test, body, orelse });
  }

  private forStatement(): Node {
    const tok = this.next();
    const target = this.targetList();
    this.expect('KEYWORD', 'in');
    const iter = this.exprList();
    this.expect('OP', ':');
    const body = this.block();
    let orelse: Node[] = [];
    if (this.atKw('else')) {
      this.next();
      this.expect('OP', ':');
      orelse = this.block();
    }
    return this.node('For', tok, { target, iter, body, orelse });
  }

  private tryStatement(): Node {
    const tok = this.next();
    this.expect('OP', ':');
    const body = this.block();
    const handlers: Node[] = [];
    let orelse: Node[] = [];
    let finalbody: Node[] = [];
    while (this.atKw('except')) {
      const et = this.next();
      let etype: Node | null = null;
      let name: string | null = null;
      if (!this.atOp(':')) {
        etype = this.expression();
        if (this.eat('KEYWORD', 'as')) name = this.expect('NAME').value;
      }
      this.expect('OP', ':');
      handlers.push(this.node('ExceptHandler', et, { etype, name, body: this.block() }));
    }
    if (this.atKw('else')) {
      this.next();
      this.expect('OP', ':');
      orelse = this.block();
    }
    if (this.atKw('finally')) {
      this.next();
      this.expect('OP', ':');
      finalbody = this.block();
    }
    if (!handlers.length && !finalbody.length) this.fail("expected 'except' or 'finally' block");
    return this.node('Try', tok, { body, handlers, orelse, finalbody });
  }

  private withStatement(): Node {
    const tok = this.next();
    const items: Array<{ ctx: Node; target: Node | null }> = [];
    const parenthesised = this.atOp('(') && this.looksLikeWithParens();
    if (parenthesised) this.next();
    do {
      const ctx = this.expression();
      let target: Node | null = null;
      if (this.eat('KEYWORD', 'as')) target = this.target();
      items.push({ ctx, target });
    } while (this.eat('OP', ','));
    if (parenthesised) this.expect('OP', ')');
    this.expect('OP', ':');
    return this.node('With', tok, { items, body: this.block() });
  }

  /** `with (a as b, c as d):` needs a peek to tell it from `with (expr):`. */
  private looksLikeWithParens(): boolean {
    let depth = 0;
    for (let k = this.p; k < this.toks.length; k++) {
      const t = this.toks[k];
      if (t.type === 'OP' && '([{'.includes(t.value)) depth++;
      else if (t.type === 'OP' && ')]}'.includes(t.value)) {
        depth--;
        if (depth === 0) return false;
      } else if (depth === 1 && t.type === 'KEYWORD' && t.value === 'as') return true;
      else if (t.type === 'NEWLINE' || t.type === 'EOF') return false;
    }
    return false;
  }

  private funcDef(decorators: Node[]): Node {
    const tok = this.expect('KEYWORD', 'def');
    const name = this.expect('NAME').value;
    this.expect('OP', '(');
    const params = this.paramList(')');
    this.expect('OP', ')');
    if (this.eat('OP', '->')) this.expression(); // annotation, ignored
    this.expect('OP', ':');
    return this.node('FunctionDef', tok, { name, params, body: this.block(), decorators });
  }

  private classDef(decorators: Node[]): Node {
    const tok = this.expect('KEYWORD', 'class');
    const name = this.expect('NAME').value;
    const bases: Node[] = [];
    if (this.eat('OP', '(')) {
      while (!this.atOp(')')) {
        if (this.at('NAME') && this.peek(1).type === 'OP' && this.peek(1).value === '=') {
          this.next();
          this.next();
          this.expression(); // class keywords (metaclass=...) are ignored
        } else bases.push(this.expression());
        if (!this.eat('OP', ',')) break;
      }
      this.expect('OP', ')');
    }
    this.expect('OP', ':');
    return this.node('ClassDef', tok, { name, bases, body: this.block(), decorators });
  }

  /** `annotations` is false for lambdas, where ':' ends the parameter list. */
  private paramList(closer: string, annotations = true): Params {
    const params: Params = { args: [], vararg: null, kwonly: [], kwarg: null };
    let seenStar = false;
    while (!this.atOp(closer)) {
      if (this.eat('OP', '*')) {
        if (this.at('NAME')) params.vararg = this.next().value;
        seenStar = true;
      } else if (this.eat('OP', '**')) {
        params.kwarg = this.expect('NAME').value;
      } else if (this.eat('OP', '/')) {
        // positional-only marker: accepted and ignored
      } else {
        const name = this.expect('NAME').value;
        if (annotations && this.eat('OP', ':')) this.expression(); // annotation, ignored
        const def = this.eat('OP', '=') ? this.expression() : null;
        (seenStar ? params.kwonly : params.args).push({ name, default: def });
      }
      if (!this.eat('OP', ',')) break;
    }
    return params;
  }

  private simpleStatement(): Node {
    const t = this.peek();
    if (t.type === 'KEYWORD') {
      switch (t.value) {
        case 'pass':
          this.next();
          return this.node('Pass', t, {});
        case 'break':
          this.next();
          return this.node('Break', t, {});
        case 'continue':
          this.next();
          return this.node('Continue', t, {});
        case 'return': {
          this.next();
          const value = this.at('NEWLINE') || this.at('EOF') || this.atOp(';') ? null : this.exprList();
          return this.node('Return', t, { value });
        }
        case 'raise': {
          this.next();
          if (this.at('NEWLINE') || this.at('EOF') || this.atOp(';')) return this.node('Raise', t, { exc: null, cause: null });
          const exc = this.expression();
          const cause = this.eat('KEYWORD', 'from') ? this.expression() : null;
          return this.node('Raise', t, { exc, cause });
        }
        case 'global':
        case 'nonlocal': {
          this.next();
          const names = [this.expect('NAME').value];
          while (this.eat('OP', ',')) names.push(this.expect('NAME').value);
          return this.node(t.value === 'global' ? 'Global' : 'Nonlocal', t, { names });
        }
        case 'del': {
          this.next();
          const targets = [this.target()];
          while (this.eat('OP', ',')) targets.push(this.target());
          return this.node('Delete', t, { targets });
        }
        case 'assert': {
          this.next();
          const test = this.expression();
          const msg = this.eat('OP', ',') ? this.expression() : null;
          return this.node('Assert', t, { test, msg });
        }
        case 'import':
          return this.importStatement();
        case 'from':
          return this.fromImport();
        case 'yield': {
          const value = this.expression();
          return this.node('Expr', t, { value });
        }
      }
    }
    return this.exprStatement();
  }

  private dottedName(): string {
    let name = this.expect('NAME').value;
    while (this.atOp('.') && this.peek(1).type === 'NAME') {
      this.next();
      name += '.' + this.next().value;
    }
    return name;
  }

  private importStatement(): Node {
    const t = this.next();
    const names: Array<{ name: string; asname: string | null }> = [];
    do {
      const name = this.dottedName();
      const asname = this.eat('KEYWORD', 'as') ? this.expect('NAME').value : null;
      names.push({ name, asname });
    } while (this.eat('OP', ','));
    return this.node('Import', t, { names });
  }

  private fromImport(): Node {
    const t = this.next();
    let level = 0;
    while (this.atOp('.') || this.atOp('...')) level += this.next().value.length;
    const module = this.at('NAME') ? this.dottedName() : '';
    this.expect('KEYWORD', 'import');
    const names: Array<{ name: string; asname: string | null }> = [];
    if (this.eat('OP', '*')) names.push({ name: '*', asname: null });
    else {
      const paren = this.eat('OP', '(');
      do {
        if (paren && this.atOp(')')) break;
        const name = this.expect('NAME').value;
        const asname = this.eat('KEYWORD', 'as') ? this.expect('NAME').value : null;
        names.push({ name, asname });
      } while (this.eat('OP', ','));
      if (paren) this.expect('OP', ')');
    }
    return this.node('ImportFrom', t, { module, names, level });
  }

  private exprStatement(): Node {
    const t = this.peek();
    const first = this.exprList();
    if (this.at('OP') && AUG_OPS[this.peek().value]) {
      const op = AUG_OPS[this.next().value];
      const value = this.exprList();
      return this.node('AugAssign', t, { target: first, op, value });
    }
    if (this.atOp(':')) {
      // Annotated assignment: the annotation is parsed and discarded.
      this.next();
      this.expression();
      const value = this.eat('OP', '=') ? this.exprList() : null;
      return this.node('AnnAssign', t, { target: first, value });
    }
    if (this.atOp('=')) {
      const targets: Node[] = [first];
      let value: Node = first;
      while (this.eat('OP', '=')) {
        value = this.exprList();
        targets.push(value);
      }
      targets.pop();
      return this.node('Assign', t, { targets, value });
    }
    return this.node('Expr', t, { value: first });
  }

  // expressions
  private target(): Node {
    return this.unary();
  }

  private targetList(): Node {
    const t = this.peek();
    const first = this.target();
    if (!this.atOp(',')) return first;
    const elts = [first];
    while (this.eat('OP', ',')) {
      if (this.atKw('in') || this.atOp('=') || this.at('NEWLINE')) break;
      elts.push(this.target());
    }
    return this.node('Tuple', t, { elts });
  }

  /** Comma-separated expressions become a tuple (right side of `=`, `return`, ...). */
  private exprList(): Node {
    const t = this.peek();
    const first = this.starOrExpr();
    if (!this.atOp(',')) return first;
    const elts = [first];
    while (this.eat('OP', ',')) {
      if (this.at('NEWLINE') || this.at('EOF') || this.atOp('=', ')', ']', '}', ':', ';')) break;
      elts.push(this.starOrExpr());
    }
    return this.node('Tuple', t, { elts });
  }

  private starOrExpr(): Node {
    if (this.atOp('*')) {
      const t = this.next();
      return this.node('Starred', t, { value: this.expression() });
    }
    return this.namedExpr();
  }

  private namedExpr(): Node {
    const t = this.peek();
    const value = this.expression();
    if (this.atOp(':=')) {
      this.next();
      if (value.type !== 'Name') this.fail('cannot use := with this target');
      return this.node('NamedExpr', t, { name: value.id, value: this.expression() });
    }
    return value;
  }

  expression(): Node {
    if (this.atKw('lambda')) {
      const t = this.next();
      const params = this.paramList(':', false);
      this.expect('OP', ':');
      return this.node('Lambda', t, { params, body: this.expression() });
    }
    if (this.atKw('yield')) {
      const t = this.next();
      if (this.eat('KEYWORD', 'from')) return this.node('YieldFrom', t, { value: this.expression() });
      const value = this.at('NEWLINE') || this.at('EOF') || this.atOp(')', ']', '}', ',', ';') ? null : this.exprList();
      return this.node('Yield', t, { value });
    }
    const t = this.peek();
    const body = this.orExpr();
    if (this.atKw('if')) {
      this.next();
      const test = this.orExpr();
      this.expect('KEYWORD', 'else');
      const orelse = this.expression();
      return this.node('IfExp', t, { test, body, orelse });
    }
    return body;
  }

  private orExpr(): Node {
    const t = this.peek();
    let left = this.andExpr();
    if (!this.atKw('or')) return left;
    const values = [left];
    while (this.eat('KEYWORD', 'or')) values.push(this.andExpr());
    return this.node('BoolOp', t, { op: 'or', values });
  }

  private andExpr(): Node {
    const t = this.peek();
    let left = this.notExpr();
    if (!this.atKw('and')) return left;
    const values = [left];
    while (this.eat('KEYWORD', 'and')) values.push(this.notExpr());
    return this.node('BoolOp', t, { op: 'and', values });
  }

  private notExpr(): Node {
    if (this.atKw('not')) {
      const t = this.next();
      return this.node('UnaryOp', t, { op: 'not', operand: this.notExpr() });
    }
    return this.comparison();
  }

  private comparison(): Node {
    const t = this.peek();
    const left = this.bitOr();
    const ops: string[] = [];
    const comparators: Node[] = [];
    for (;;) {
      let op: string | null = null;
      if (this.atOp('<', '>', '==', '!=', '<=', '>=')) op = this.next().value;
      else if (this.atKw('in')) {
        this.next();
        op = 'in';
      } else if (this.atKw('not') && this.peek(1).type === 'KEYWORD' && this.peek(1).value === 'in') {
        this.next();
        this.next();
        op = 'not in';
      } else if (this.atKw('is')) {
        this.next();
        if (this.atKw('not')) {
          this.next();
          op = 'is not';
        } else op = 'is';
      }
      if (!op) break;
      ops.push(op);
      comparators.push(this.bitOr());
    }
    if (!ops.length) return left;
    return this.node('Compare', t, { left, ops, comparators });
  }

  private binaryLevel(ops: string[], nextLevel: () => Node): Node {
    const t = this.peek();
    let left = nextLevel.call(this);
    while (this.at('OP') && ops.includes(this.peek().value)) {
      const op = this.next().value;
      left = this.node('BinOp', t, { left, op, right: nextLevel.call(this) });
    }
    return left;
  }

  private bitOr(): Node {
    return this.binaryLevel(['|'], this.bitXor);
  }
  private bitXor(): Node {
    return this.binaryLevel(['^'], this.bitAnd);
  }
  private bitAnd(): Node {
    return this.binaryLevel(['&'], this.shift);
  }
  private shift(): Node {
    return this.binaryLevel(['<<', '>>'], this.arith);
  }
  private arith(): Node {
    return this.binaryLevel(['+', '-'], this.term);
  }
  private term(): Node {
    return this.binaryLevel(['*', '/', '//', '%', '@'], this.unary);
  }

  private unary(): Node {
    if (this.atOp('-', '+', '~')) {
      const t = this.next();
      return this.node('UnaryOp', t, { op: t.value, operand: this.unary() });
    }
    return this.power();
  }

  private power(): Node {
    const t = this.peek();
    const base = this.postfix();
    if (this.atOp('**')) {
      this.next();
      return this.node('BinOp', t, { left: base, op: '**', right: this.unary() });
    }
    return base;
  }

  private postfix(): Node {
    let node = this.atom();
    for (;;) {
      const t = this.peek();
      if (this.atOp('.')) {
        this.next();
        node = this.node('Attribute', t, { value: node, attr: this.expect('NAME').value });
      } else if (this.atOp('(')) {
        this.next();
        const { args, keywords } = this.callArgs();
        this.expect('OP', ')');
        node = this.node('Call', t, { func: node, args, keywords });
      } else if (this.atOp('[')) {
        this.next();
        const index = this.subscript();
        this.expect('OP', ']');
        node = this.node('Subscript', t, { value: node, slice: index });
      } else break;
    }
    return node;
  }

  private subscript(): Node {
    const t = this.peek();
    const parts: Node[] = [];
    let isSlice = false;
    let current: Node | null = null;
    const slice: Array<Node | null> = [];
    const readItem = (): Node => {
      const item = this.starOrExpr();
      return item;
    };
    if (!this.atOp(':')) current = readItem();
    if (this.atOp(':')) {
      isSlice = true;
      slice.push(current);
      while (this.eat('OP', ':')) {
        if (this.atOp(']') || this.atOp(':') || this.atOp(',')) slice.push(null);
        else slice.push(this.expression());
      }
      while (slice.length < 3) slice.push(null);
      current = this.node('Slice', t, { lower: slice[0], upper: slice[1], step: slice[2] });
    }
    parts.push(current!);
    while (this.eat('OP', ',')) {
      if (this.atOp(']')) break;
      parts.push(this.expression());
    }
    if (parts.length > 1) return this.node('Tuple', t, { elts: parts });
    return parts[0];
  }

  private callArgs(): { args: Node[]; keywords: Array<{ name: string | null; value: Node }> } {
    const args: Node[] = [];
    const keywords: Array<{ name: string | null; value: Node }> = [];
    while (!this.atOp(')')) {
      if (this.atOp('*')) {
        const t = this.next();
        args.push(this.node('Starred', t, { value: this.expression() }));
      } else if (this.atOp('**')) {
        this.next();
        keywords.push({ name: null, value: this.expression() });
      } else if (this.at('NAME') && this.peek(1).type === 'OP' && this.peek(1).value === '=') {
        const name = this.next().value;
        this.next();
        keywords.push({ name, value: this.expression() });
      } else {
        const t = this.peek();
        const value = this.namedExpr();
        // A bare generator argument: f(x for x in y)
        if (this.atKw('for')) args.push(this.node('GenExp', t, { elt: value, generators: this.comprehensionClauses() }));
        else args.push(value);
      }
      if (!this.eat('OP', ',')) break;
    }
    return { args, keywords };
  }

  private comprehensionClauses(): Node[] {
    const gens: Node[] = [];
    while (this.atKw('for')) {
      const t = this.next();
      const target = this.targetList();
      this.expect('KEYWORD', 'in');
      const iter = this.orExpr();
      const ifs: Node[] = [];
      while (this.atKw('if')) {
        this.next();
        ifs.push(this.orExpr());
      }
      gens.push(this.node('comprehension', t, { target, iter, ifs }));
    }
    return gens;
  }

  private atom(): Node {
    const t = this.peek();
    if (t.type === 'NUMBER') {
      this.next();
      return this.node('Num', t, { value: t.isInt ? parseIntLiteral(t.value) : parseFloat(t.value), isInt: t.isInt });
    }
    if (t.type === 'STRING' || t.type === 'FSTRING') {
      // Adjacent literals concatenate; if any is an f-string the result is one.
      const pieces: Array<{ tok: Tok }> = [];
      while (this.at('STRING') || this.at('FSTRING')) pieces.push({ tok: this.next() });
      const anyF = pieces.some((p) => p.tok.type === 'FSTRING');
      if (!anyF) return this.node('Str', t, { value: pieces.map((p) => p.tok.value).join('') });
      const parts: Node[] = [];
      for (const p of pieces) {
        if (p.tok.type === 'STRING') parts.push(this.node('Str', p.tok, { value: p.tok.value }));
        else parts.push(...parseFStringParts(p.tok, (src, line, col) => parseExpressionSource(src, line, col)));
      }
      return this.node('JoinedStr', t, { parts });
    }
    if (t.type === 'NAME') {
      this.next();
      return this.node('Name', t, { id: t.value });
    }
    if (t.type === 'KEYWORD') {
      if (t.value === 'True' || t.value === 'False') {
        this.next();
        return this.node('Const', t, { value: t.value === 'True' });
      }
      if (t.value === 'None') {
        this.next();
        return this.node('Const', t, { value: null });
      }
      if (t.value === 'not' || t.value === 'lambda' || t.value === 'yield') return this.expression();
    }
    if (this.atOp('(')) {
      this.next();
      if (this.atOp(')')) {
        this.next();
        return this.node('Tuple', t, { elts: [] });
      }
      const first = this.starOrExpr();
      if (this.atKw('for')) {
        const gens = this.comprehensionClauses();
        this.expect('OP', ')');
        return this.node('GenExp', t, { elt: first, generators: gens });
      }
      if (this.atOp(',')) {
        const elts = [first];
        while (this.eat('OP', ',')) {
          if (this.atOp(')')) break;
          elts.push(this.starOrExpr());
        }
        this.expect('OP', ')');
        return this.node('Tuple', t, { elts });
      }
      this.expect('OP', ')');
      return first;
    }
    if (this.atOp('[')) {
      this.next();
      if (this.atOp(']')) {
        this.next();
        return this.node('List', t, { elts: [] });
      }
      const first = this.starOrExpr();
      if (this.atKw('for')) {
        const gens = this.comprehensionClauses();
        this.expect('OP', ']');
        return this.node('ListComp', t, { elt: first, generators: gens });
      }
      const elts = [first];
      while (this.eat('OP', ',')) {
        if (this.atOp(']')) break;
        elts.push(this.starOrExpr());
      }
      this.expect('OP', ']');
      return this.node('List', t, { elts });
    }
    if (this.atOp('{')) {
      this.next();
      if (this.atOp('}')) {
        this.next();
        return this.node('Dict', t, { keys: [], values: [] });
      }
      if (this.atOp('**')) {
        // {**a, 'b': 1}
        const keys: Array<Node | null> = [];
        const values: Node[] = [];
        do {
          if (this.atOp('}')) break;
          if (this.eat('OP', '**')) {
            keys.push(null);
            values.push(this.orExpr());
          } else {
            keys.push(this.expression());
            this.expect('OP', ':');
            values.push(this.expression());
          }
        } while (this.eat('OP', ','));
        this.expect('OP', '}');
        return this.node('Dict', t, { keys, values });
      }
      const first = this.starOrExpr();
      if (this.atOp(':')) {
        this.next();
        const firstValue = this.expression();
        if (this.atKw('for')) {
          const gens = this.comprehensionClauses();
          this.expect('OP', '}');
          return this.node('DictComp', t, { key: first, value: firstValue, generators: gens });
        }
        const keys: Array<Node | null> = [first];
        const values: Node[] = [firstValue];
        while (this.eat('OP', ',')) {
          if (this.atOp('}')) break;
          if (this.eat('OP', '**')) {
            keys.push(null);
            values.push(this.orExpr());
            continue;
          }
          keys.push(this.expression());
          this.expect('OP', ':');
          values.push(this.expression());
        }
        this.expect('OP', '}');
        return this.node('Dict', t, { keys, values });
      }
      if (this.atKw('for')) {
        const gens = this.comprehensionClauses();
        this.expect('OP', '}');
        return this.node('SetComp', t, { elt: first, generators: gens });
      }
      const elts = [first];
      while (this.eat('OP', ',')) {
        if (this.atOp('}')) break;
        elts.push(this.starOrExpr());
      }
      this.expect('OP', '}');
      return this.node('Set', t, { elts });
    }
    if (this.atOp('...')) {
      this.next();
      return this.node('Const', t, { value: null });
    }
    return this.fail(`unexpected ${t.type === 'NEWLINE' ? 'end of line' : t.type === 'EOF' ? 'end of file' : `'${t.value}'`}`);
  }
}

function parseIntLiteral(text: string): bigint {
  if (/^0[xX]/.test(text)) return BigInt(text);
  if (/^0[oO]/.test(text)) return BigInt('0o' + text.slice(2));
  if (/^0[bB]/.test(text)) return BigInt('0b' + text.slice(2));
  return BigInt(text.replace(/^0+(?=\d)/, ''));
}

/** Splits an f-string body into literal and expression parts. */
function parseFStringParts(tok: Tok, parseExpr: (src: string, line: number, col: number) => Node): Node[] {
  const src = tok.value;
  const parts: Node[] = [];
  let literal = '';
  let i = 0;
  const flushLiteral = () => {
    if (literal) {
      parts.push({ type: 'Str', line: tok.line, col: tok.col, value: literal });
      literal = '';
    }
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '{' && src[i + 1] === '{') {
      literal += '{';
      i += 2;
      continue;
    }
    if (c === '}' && src[i + 1] === '}') {
      literal += '}';
      i += 2;
      continue;
    }
    if (c === '{') {
      flushLiteral();
      i++;
      let depth = 1;
      let expr = '';
      let quote: string | null = null;
      let conversion: string | null = null;
      let spec = '';
      let inSpec = false;
      while (i < src.length) {
        const ch = src[i];
        if (quote) {
          expr += ch;
          if (ch === quote) quote = null;
          i++;
          continue;
        }
        if (ch === '"' || ch === "'") {
          quote = ch;
          (inSpec ? (spec += ch) : (expr += ch));
          i++;
          continue;
        }
        if ('([{'.includes(ch)) depth++;
        if (')]}'.includes(ch)) {
          depth--;
          if (depth === 0 && ch === '}') {
            i++;
            break;
          }
        }
        if (depth === 1 && !inSpec && ch === '!' && src[i + 1] !== '=' && /[sra]/.test(src[i + 1] ?? '')) {
          conversion = src[i + 1];
          i += 2;
          continue;
        }
        if (depth === 1 && !inSpec && ch === ':') {
          inSpec = true;
          i++;
          continue;
        }
        if (depth === 1 && !inSpec && ch === '=' && src[i + 1] === '}') {
          // f"{x=}" debug form
          conversion = conversion ?? 'r';
          parts.push({ type: 'Str', line: tok.line, col: tok.col, value: expr + '=' });
          i++;
          continue;
        }
        (inSpec ? (spec += ch) : (expr += ch));
        i++;
      }
      if (!expr.trim()) throw new PySyntaxError('f-string: empty expression not allowed', tok.line, tok.col);
      parts.push({
        type: 'FormattedValue',
        line: tok.line,
        col: tok.col,
        value: parseExpr(expr, tok.line, tok.col),
        conversion,
        spec: spec || null,
      });
      continue;
    }
    literal += c;
    i++;
  }
  flushLiteral();
  return parts;
}

function parseExpressionSource(src: string, line: number, col: number): Node {
  try {
    const toks = tokenize(src);
    const p = new Parser(toks);
    return p.expression();
  } catch (e) {
    if (e instanceof PySyntaxError) throw new PySyntaxError(`f-string: ${e.message}`, line, col);
    throw e;
  }
}

export function parse(src: string): Node {
  return new Parser(tokenize(src)).parseModule();
}

/** Used by the REPL to tell "incomplete block" from a real syntax error. */
export function isIncomplete(src: string): boolean {
  try {
    parse(src);
    return false;
  } catch (e) {
    if (!(e instanceof PySyntaxError)) return false;
    const m = e.message;
    return /end of file|an indented block|unterminated triple-quoted/.test(m);
  }
}
