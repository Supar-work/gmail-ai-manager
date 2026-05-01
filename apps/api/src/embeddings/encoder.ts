import { logger } from '../logger.js';

/**
 * Lazy wrapper around `@xenova/transformers` so the app doesn't pay the
 * 80-MB model + native deps cost unless the user opts in by setting
 * `GAM_ENABLE_EMBEDDINGS=1` AND installing the package.
 *
 * Default model: `Xenova/all-MiniLM-L6-v2` — 384-dim, ~80 MB, runs
 * comfortably on CPU at ~50ms/message on Apple Silicon.
 *
 * The indexer + MCP tools call `encode(text)` and gracefully degrade
 * to a "feature_disabled" error if the package isn't installed.
 */

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
export const MODEL_VERSION = 'minilm-l6-v2-1.0';
export const EMBEDDING_DIM = 384;

type PipelineFn = (input: string, opts: { pooling: 'mean'; normalize: boolean }) => Promise<{
  data: Float32Array;
}>;

let pipelinePromise: Promise<PipelineFn | null> | null = null;
let isAvailable: boolean | null = null;

async function getPipeline(): Promise<PipelineFn | null> {
  if (pipelinePromise) return pipelinePromise;
  pipelinePromise = (async () => {
    try {
      // Computed specifier defeats TS2307 / bundler resolution when
      // the package isn't installed. The user opts in by adding
      // `@xenova/transformers` to apps/api/package.json.
      const specifier = '@xenova/transformers';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod: any = await import(/* @vite-ignore */ specifier);
      const fn = await mod.pipeline('feature-extraction', MODEL_ID, {
        quantized: true,
      });
      isAvailable = true;
      return fn as PipelineFn;
    } catch (err) {
      isAvailable = false;
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'embeddings disabled — @xenova/transformers not installed',
      );
      return null;
    }
  })();
  return pipelinePromise;
}

export async function isEncoderAvailable(): Promise<boolean> {
  if (isAvailable != null) return isAvailable;
  await getPipeline();
  return isAvailable ?? false;
}

/**
 * Embed `text` into a 384-d float32 vector. Returns `null` when the
 * encoder is unavailable; callers should degrade to keyword search.
 */
export async function encode(text: string): Promise<Float32Array | null> {
  const pipe = await getPipeline();
  if (!pipe) return null;
  const trimmed = text.trim().slice(0, 2000); // hard cap on input length
  if (!trimmed) return null;
  const out = await pipe(trimmed, { pooling: 'mean', normalize: true });
  return out.data;
}

// ── (de)serialisation helpers ──────────────────────────────────────────

/** Pack a Float32Array into a Buffer for SQLite BLOB storage. */
export function vectorToBuffer(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/** Reverse of vectorToBuffer; expects EMBEDDING_DIM floats. */
export function bufferToVector(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/** Cosine similarity for two unit-length vectors. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}
