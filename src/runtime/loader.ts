// Finds the runtime pack: cache, dev URL, then a file dialog.
import { parsePack, type Pack } from './pack';
import { kvGet, kvSet } from './store';

const CACHE_KEY = 'runtime-pack';

export interface CachedPack {
  version: string;
  raw: ArrayBuffer;
}

export type PackSource = 'cache' | 'dev-url' | 'node-fs' | 'file-dialog';

export async function loadCachedPack(): Promise<Pack | null> {
  try {
    const cached = await kvGet<CachedPack>(CACHE_KEY);
    if (!cached) return null;
    const pack = await parsePack(cached.raw);
    if (pack.index.version !== __VERSION__) return null;
    return pack;
  } catch (e) {
    console.warn('[crazy] cached pack unusable', e);
    return null;
  }
}

export async function loadDevPack(): Promise<Pack | null> {
  const url = (globalThis as any).__CRAZY_DEV_PACK_URL__ as string | undefined;
  if (!url) return null;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`dev pack fetch failed: ${res.status}`);
  return acceptRaw(await res.arrayBuffer());
}

export async function acceptRaw(raw: ArrayBuffer): Promise<Pack> {
  const pack = await parsePack(raw);
  if (pack.index.version !== __VERSION__) {
    throw new Error(`This runtime pack is for v${pack.index.version}, but the editor is v${__VERSION__}. Use the pack from the same download.`);
  }
  try {
    await kvSet(CACHE_KEY, { version: pack.index.version, raw } satisfies CachedPack);
  } catch (e) {
    console.warn('[crazy] could not cache pack', e);
  }
  return pack;
}

/** Must be called from a user gesture (click). */
export async function pickPackFile(): Promise<ArrayBuffer | null> {
  const g = globalThis as any;
  if (typeof g.showOpenFilePicker === 'function') {
    try {
      const [handle] = await g.showOpenFilePicker({
        multiple: false,
        types: [{ description: 'CrazyCodeEditor runtime pack', accept: { 'application/octet-stream': ['.pack'] } }],
      });
      const file: File = await handle.getFile();
      return await file.arrayBuffer();
    } catch (e: any) {
      if (e?.name === 'AbortError') return null;
      // Fall through to the classic input on any other failure.
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pack';
    input.style.display = 'none';
    input.onchange = async () => {
      const f = input.files?.[0];
      input.remove();
      resolve(f ? await f.arrayBuffer() : null);
    };
    // Some hosts never fire change on cancel; clean up on focus return.
    window.addEventListener('focus', () => setTimeout(() => input.remove(), 1000), { once: true });
    document.documentElement.appendChild(input);
    input.click();
  });
}
