// Streaming ANSI parser: SGR, \r, \b, clears.

export interface Style {
  fg: string | null; // css color or 'a0'..'a15' palette index
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  strike: boolean;
}

export type AnsiEvent =
  | { type: 'text'; text: string; style: Style }
  | { type: 'newline' }
  | { type: 'cr' }
  | { type: 'backspace' }
  | { type: 'clearLine' }
  | { type: 'clearScreen' };

export const DEFAULT_STYLE: Style = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false, strike: false };

function color256(n: number): string {
  if (n < 16) return `a${n}`;
  if (n < 232) {
    const v = n - 16;
    const r = Math.floor(v / 36);
    const g = Math.floor((v % 36) / 6);
    const b = v % 6;
    const c = (x: number) => (x === 0 ? 0 : 55 + x * 40);
    return `rgb(${c(r)},${c(g)},${c(b)})`;
  }
  const gray = 8 + (n - 232) * 10;
  return `rgb(${gray},${gray},${gray})`;
}

export class AnsiParser {
  style: Style = { ...DEFAULT_STYLE };
  private pending = '';

  reset(): void {
    this.style = { ...DEFAULT_STYLE };
    this.pending = '';
  }

  parse(input: string, emit: (e: AnsiEvent) => void): void {
    let s = this.pending + input;
    this.pending = '';
    let i = 0;
    let textStart = 0;
    const flush = (end: number) => {
      if (end > textStart) emit({ type: 'text', text: s.slice(textStart, end), style: { ...this.style } });
    };
    while (i < s.length) {
      const ch = s[i];
      if (ch === '\x1b') {
        if (i + 1 >= s.length) {
          flush(i);
          this.pending = s.slice(i);
          return;
        }
        if (s[i + 1] === '[') {
          // CSI: ESC [ params final
          let j = i + 2;
          while (j < s.length && /[0-9;?]/.test(s[j])) j++;
          if (j >= s.length) {
            flush(i);
            this.pending = s.slice(i);
            return;
          }
          const params = s.slice(i + 2, j);
          const final = s[j];
          flush(i);
          this.csi(params, final, emit);
          i = j + 1;
          textStart = i;
          continue;
        }
        if (s[i + 1] === ']') {
          // OSC ... BEL or ESC \ : swallow
          let j = s.indexOf('\x07', i);
          const k = s.indexOf('\x1b\\', i);
          if (j === -1 || (k !== -1 && k < j)) j = k === -1 ? -1 : k + 1;
          if (j === -1) {
            flush(i);
            this.pending = s.slice(i);
            return;
          }
          flush(i);
          i = j + 1;
          textStart = i;
          continue;
        }
        // Other two-char escapes: skip.
        flush(i);
        i += 2;
        textStart = i;
        continue;
      }
      if (ch === '\n') {
        flush(i);
        emit({ type: 'newline' });
        i++;
        textStart = i;
        continue;
      }
      if (ch === '\r') {
        flush(i);
        if (s[i + 1] !== '\n') emit({ type: 'cr' });
        i++;
        textStart = i;
        continue;
      }
      if (ch === '\b') {
        flush(i);
        emit({ type: 'backspace' });
        i++;
        textStart = i;
        continue;
      }
      if (ch === '\x07') {
        flush(i);
        i++;
        textStart = i;
        continue;
      }
      i++;
    }
    flush(s.length);
  }

  private csi(params: string, final: string, emit: (e: AnsiEvent) => void): void {
    if (final === 'm') {
      this.sgr(params.split(';').map((p) => (p === '' ? 0 : parseInt(p, 10))));
    } else if (final === 'K') {
      emit({ type: 'clearLine' });
    } else if (final === 'J') {
      if (params === '2' || params === '3') emit({ type: 'clearScreen' });
    } else if (final === 'H' || final === 'f') {
      if (params === '' || params === '1;1') emit({ type: 'clearScreen' });
    }
    // Cursor movement and others are ignored in this line-oriented terminal.
  }

  private sgr(codes: number[]): void {
    const st = this.style;
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) Object.assign(st, DEFAULT_STYLE);
      else if (c === 1) st.bold = true;
      else if (c === 2) st.dim = true;
      else if (c === 3) st.italic = true;
      else if (c === 4) st.underline = true;
      else if (c === 7) st.inverse = true;
      else if (c === 9) st.strike = true;
      else if (c === 22) (st.bold = false), (st.dim = false);
      else if (c === 23) st.italic = false;
      else if (c === 24) st.underline = false;
      else if (c === 27) st.inverse = false;
      else if (c === 29) st.strike = false;
      else if (c >= 30 && c <= 37) st.fg = `a${c - 30}`;
      else if (c === 39) st.fg = null;
      else if (c >= 40 && c <= 47) st.bg = `a${c - 40}`;
      else if (c === 49) st.bg = null;
      else if (c >= 90 && c <= 97) st.fg = `a${c - 90 + 8}`;
      else if (c >= 100 && c <= 107) st.bg = `a${c - 100 + 8}`;
      else if (c === 38 || c === 48) {
        const target = c === 38 ? 'fg' : 'bg';
        if (codes[i + 1] === 5) {
          st[target] = color256(codes[i + 2] ?? 0);
          i += 2;
        } else if (codes[i + 1] === 2) {
          st[target] = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`;
          i += 4;
        }
      }
    }
  }
}
