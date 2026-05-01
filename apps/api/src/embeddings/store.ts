import { createHash } from 'node:crypto';
import { prisma } from '../db/client.js';
import {
  bufferToVector,
  cosine,
  encode,
  EMBEDDING_DIM,
  MODEL_VERSION,
  vectorToBuffer,
} from './encoder.js';

/**
 * Embedding storage layer. Powers the indexer + the
 * `inbox.semanticSearch` / `inbox.similar` MCP tools.
 *
 * Vector index: brute-force JS cosine over the user's `MessageEmbedding`
 * rows. Sufficient for the typical 5-50k inbox; future large-inbox
 * users can swap in `sqlite-vec` without changing this surface.
 */

export type EmbedInput = {
  userId: string;
  gmailMessageId: string;
  /** Material to embed: subject + snippet + body excerpt joined. */
  text: string;
};

export function contentHashFor(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

/**
 * Embed and persist a single message. Idempotent: skips when the row
 * already exists with a matching contentHash + modelVersion.
 *
 * Returns `'skipped' | 'inserted' | 'updated' | 'unavailable'`.
 */
export async function indexOne(
  input: EmbedInput,
): Promise<'skipped' | 'inserted' | 'updated' | 'unavailable'> {
  const hash = contentHashFor(input.text);
  const existing = await prisma.messageEmbedding.findUnique({
    where: {
      userId_gmailMessageId: {
        userId: input.userId,
        gmailMessageId: input.gmailMessageId,
      },
    },
    select: { id: true, contentHash: true, modelVersion: true },
  });
  if (
    existing &&
    existing.contentHash === hash &&
    existing.modelVersion === MODEL_VERSION
  ) {
    return 'skipped';
  }

  const vec = await encode(input.text);
  if (!vec) return 'unavailable';
  if (vec.length !== EMBEDDING_DIM) {
    throw new Error(`unexpected_dim: ${vec.length}, expected ${EMBEDDING_DIM}`);
  }

  if (existing) {
    await prisma.messageEmbedding.update({
      where: { id: existing.id },
      data: {
        embedding: vectorToBuffer(vec),
        contentHash: hash,
        modelVersion: MODEL_VERSION,
      },
    });
    return 'updated';
  }
  await prisma.messageEmbedding.create({
    data: {
      userId: input.userId,
      gmailMessageId: input.gmailMessageId,
      embedding: vectorToBuffer(vec),
      contentHash: hash,
      modelVersion: MODEL_VERSION,
    },
  });
  return 'inserted';
}

export type SemanticSearchHit = {
  gmailMessageId: string;
  score: number;
  subject: string | null;
  from: string | null;
  snippet: string | null;
};

/** Cosine search over the user's embeddings. */
export async function semanticSearch(
  userId: string,
  query: string,
  limit: number,
): Promise<SemanticSearchHit[]> {
  const qvec = await encode(query);
  if (!qvec) return [];

  const rows = await prisma.messageEmbedding.findMany({
    where: { userId, modelVersion: MODEL_VERSION },
    select: { gmailMessageId: true, embedding: true },
  });
  if (rows.length === 0) return [];

  const scored = rows
    .map((r) => ({
      gmailMessageId: r.gmailMessageId,
      score: cosine(qvec, bufferToVector(r.embedding)),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // Hydrate with subject / from / snippet from InboxMessage.
  const messages = await prisma.inboxMessage.findMany({
    where: {
      userId,
      gmailMessageId: { in: scored.map((s) => s.gmailMessageId) },
    },
    select: {
      gmailMessageId: true,
      subject: true,
      fromHeader: true,
      snippet: true,
    },
  });
  const byId = new Map(messages.map((m) => [m.gmailMessageId, m]));
  return scored.map((s) => {
    const m = byId.get(s.gmailMessageId);
    return {
      gmailMessageId: s.gmailMessageId,
      score: s.score,
      subject: m?.subject ?? null,
      from: m?.fromHeader ?? null,
      snippet: m?.snippet ?? null,
    };
  });
}

/** Find messages whose embeddings are nearest the given source. */
export async function similar(
  userId: string,
  gmailMessageId: string,
  limit: number,
): Promise<SemanticSearchHit[]> {
  const source = await prisma.messageEmbedding.findUnique({
    where: {
      userId_gmailMessageId: { userId, gmailMessageId },
    },
    select: { embedding: true },
  });
  if (!source) return [];
  const sv = bufferToVector(source.embedding);

  const rows = await prisma.messageEmbedding.findMany({
    where: {
      userId,
      modelVersion: MODEL_VERSION,
      NOT: { gmailMessageId },
    },
    select: { gmailMessageId: true, embedding: true },
  });

  const scored = rows
    .map((r) => ({
      gmailMessageId: r.gmailMessageId,
      score: cosine(sv, bufferToVector(r.embedding)),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const messages = await prisma.inboxMessage.findMany({
    where: {
      userId,
      gmailMessageId: { in: scored.map((s) => s.gmailMessageId) },
    },
    select: {
      gmailMessageId: true,
      subject: true,
      fromHeader: true,
      snippet: true,
    },
  });
  const byId = new Map(messages.map((m) => [m.gmailMessageId, m]));
  return scored.map((s) => {
    const m = byId.get(s.gmailMessageId);
    return {
      gmailMessageId: s.gmailMessageId,
      score: s.score,
      subject: m?.subject ?? null,
      from: m?.fromHeader ?? null,
      snippet: m?.snippet ?? null,
    };
  });
}

/** Pull text we want to embed for a message — subject + snippet + body excerpt. */
export function buildTextFor(m: {
  subject: string | null;
  snippet: string | null;
  bodyText: string | null;
  fromHeader: string | null;
}): string {
  const parts: string[] = [];
  if (m.fromHeader) parts.push(`From: ${m.fromHeader}`);
  if (m.subject) parts.push(`Subject: ${m.subject}`);
  if (m.snippet) parts.push(m.snippet);
  if (m.bodyText) parts.push(m.bodyText.slice(0, 1500));
  return parts.join('\n');
}
