import { kvGet, kvSet } from '../runtime/store';

export interface Settings {
  theme: string;
  terminalTheme: string;
  fontSize: number;
  terminalFontSize: number;
  tabSize: number;
  autocomplete: 'on' | 'dot' | 'off';
  formatOnSave: boolean;
  lint: boolean;
  wordWrap: boolean;
  lineLength: number;
  saveBeforeRun: boolean;
  clearOnRun: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'Dark+',
  terminalTheme: 'Dark+',
  fontSize: 14,
  terminalFontSize: 13,
  tabSize: 4,
  autocomplete: 'on',
  formatOnSave: false,
  lint: true,
  wordWrap: false,
  lineLength: 88,
  saveBeforeRun: true,
  clearOnRun: false,
};

const KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  try {
    const stored = await kvGet<Partial<Settings>>(KEY);
    return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  try {
    await kvSet(KEY, s);
  } catch (e) {
    console.warn('[crazy] settings not saved', e);
  }
}
