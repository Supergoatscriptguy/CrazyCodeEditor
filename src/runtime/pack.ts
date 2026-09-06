// Parses crazy-runtime.pack (see tools/pack/build-pack.mjs for the format).

export interface PackIndex {
  format: number;
  version: string;
  pyodide: string;
  /** Pyodide-distribution packages bundled (with dependencies). */
  packages?: string[];
  /** The packages that were asked for, without their dependencies. */
  requested?: string[];
  files: Record<string, [number, number]>;
}

export interface Pack {
  index: PackIndex;
  /** Decompressed payload. File bytes are views into this buffer. */
  buffer: ArrayBuffer;
  /** Byte offset in `buffer` where file blobs begin. */
  base: number;
}

const MAGIC = 'CCEPACK1';

export async function parsePack(raw: ArrayBuffer): Promise<Pack> {
  const magic = new TextDecoder().decode(new Uint8Array(raw, 0, 8));
  if (magic !== MAGIC) throw new Error('Not a CrazyCodeEditor runtime pack (bad magic).');
  const gz = new Blob([new Uint8Array(raw, 8)]);
  const ds = new DecompressionStream('gzip');
  const buffer = await new Response(gz.stream().pipeThrough(ds)).arrayBuffer();
  const dv = new DataView(buffer);
  const idxLen = dv.getUint32(0, true);
  const index = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, idxLen))) as PackIndex;
  if (index.format !== 1) throw new Error(`Unsupported pack format ${index.format}.`);
  return { index, buffer, base: 4 + idxLen };
}

export function packFile(pack: Pack, name: string): Uint8Array {
  const entry = pack.index.files[name];
  if (!entry) throw new Error(`Pack is missing ${name}`);
  return new Uint8Array(pack.buffer, pack.base + entry[0], entry[1]);
}
