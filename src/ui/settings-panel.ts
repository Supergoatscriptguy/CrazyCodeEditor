import type { Settings } from '../app/settings';
import { DEFAULT_SETTINGS } from '../app/settings';
import { TERMINAL_THEMES, UI_THEMES } from '../app/themes';
import type { Dialogs } from './dialogs';

export interface SettingsActions {
  change(s: Settings): void;
  exportWorkspace(): void;
  importWorkspace(): void;
  resetWorkspace(): void;
  forgetRuntime(): void;
}

export function openSettings(dialogs: Dialogs, current: Settings, actions: SettingsActions): void {
  const s: Settings = { ...current };
  dialogs.modal(
    'Settings',
    (body, foot, close) => {
      const field = (label: string, hint: string, control: HTMLElement) => {
        const f = document.createElement('div');
        f.className = 'field';
        const l = document.createElement('label');
        l.textContent = label;
        if (hint) {
          const sm = document.createElement('small');
          sm.textContent = hint;
          l.appendChild(sm);
        }
        f.append(l, control);
        body.appendChild(f);
      };
      const select = <K extends keyof Settings>(key: K, options: Array<[string, string]>) => {
        const sel = document.createElement('select');
        for (const [v, t] of options) {
          const o = document.createElement('option');
          o.value = v;
          o.textContent = t;
          sel.appendChild(o);
        }
        sel.value = String(s[key]);
        sel.onchange = () => {
          (s as any)[key] = sel.value;
          actions.change({ ...s });
        };
        return sel;
      };
      const number = <K extends keyof Settings>(key: K, min: number, max: number) => {
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.min = String(min);
        inp.max = String(max);
        inp.value = String(s[key]);
        inp.onchange = () => {
          const v = Math.max(min, Math.min(max, parseInt(inp.value, 10) || (DEFAULT_SETTINGS[key] as number)));
          inp.value = String(v);
          (s as any)[key] = v;
          actions.change({ ...s });
        };
        return inp;
      };
      const check = <K extends keyof Settings>(key: K) => {
        const inp = document.createElement('input');
        inp.type = 'checkbox';
        inp.checked = !!s[key];
        inp.onchange = () => {
          (s as any)[key] = inp.checked;
          actions.change({ ...s });
        };
        return inp;
      };

      field('Editor theme', 'Colors for the whole editor and interface', select('theme', UI_THEMES.map((t) => [t.name, t.name])));
      field('Terminal theme', 'Colors for the Output and REPL panels', select('terminalTheme', TERMINAL_THEMES.map((t) => [t.name, t.name])));
      field('Editor font size', '', number('fontSize', 9, 32));
      field('Terminal font size', '', number('terminalFontSize', 9, 32));
      field('Tab size', 'Spaces per indent level', number('tabSize', 2, 8));
      field('Autocomplete', 'Ctrl+Space always works', select('autocomplete', [['on', 'As you type'], ['dot', 'Only after a dot'], ['off', 'Manual only']]));
      field('Word wrap', '', check('wordWrap'));
      field('Error underlines', 'pyflakes checks while you type', check('lint'));
      field('Format on save', 'Run Black when you press Ctrl+S', check('formatOnSave'));
      field('Black line length', '', number('lineLength', 60, 200));
      field('Save all before run', '', check('saveBeforeRun'));
      field('Clear output on run', '', check('clearOnRun'));

      const mk = (label: string, cls: string, fn: () => void) => {
        const b = document.createElement('button');
        b.className = `btn ${cls}`;
        b.textContent = label;
        b.onclick = () => {
          close();
          fn();
        };
        return b;
      };
      foot.append(
        mk('Import zip…', '', actions.importWorkspace),
        mk('Export zip…', '', actions.exportWorkspace),
        mk('Forget runtime', '', actions.forgetRuntime),
        mk('Reset workspace', 'danger', actions.resetWorkspace),
        mk('Done', 'primary', () => {}),
      );
      foot.style.flexWrap = 'wrap';
    },
    { wide: true },
  );
}
