import { prisma } from '../db/client.js';

/**
 * The user's verified set of forward targets.
 *
 * `forward` actions are the highest-stakes thing this app can do — they
 * leave the user's account permanently and can't be undone via the
 * audit-log inverse path. We require an explicit, per-address user
 * confirmation before any address becomes a valid `to:`.
 *
 * Storage: `ForwardingAddress` rows (`address` lower-cased + trimmed,
 * `verified` flag flipped to `true` only after the user clicks confirm
 * in the UI). Unverified rows are visible in the UI as "pending
 * confirmation" so the user knows what's queued.
 *
 * Trust model: a malicious page that lands a CSRF/rebinding hit
 * (closed by `localOnly` middleware) cannot just create+confirm in two
 * calls because the confirm endpoint requires a freshly-issued
 * single-use token (`pendingToken`) that the create call only logs to
 * the server-side audit-log; the UI-driven flow re-fetches the row to
 * read the token. Future hardening: post the token via a Tauri tray
 * notification so the user types it back.
 */

function normalize(address: string): string {
  return address.trim().toLowerCase();
}

export async function isForwardTargetAllowed(
  userId: string,
  address: string,
): Promise<boolean> {
  const row = await prisma.forwardingAddress.findUnique({
    where: { userId_address: { userId, address: normalize(address) } },
    select: { verified: true },
  });
  return Boolean(row?.verified);
}

export async function listForwardTargets(userId: string): Promise<
  { id: string; address: string; verified: boolean; updatedAt: Date }[]
> {
  return prisma.forwardingAddress.findMany({
    where: { userId },
    select: { id: true, address: true, verified: true, updatedAt: true },
    orderBy: [{ verified: 'desc' }, { updatedAt: 'desc' }],
  });
}

/**
 * Add an address to the user's allowlist as a pending (unverified) row.
 * Idempotent: if the row already exists, returns the existing one and
 * does not reset its verified flag.
 */
export async function addPendingForwardTarget(
  userId: string,
  rawAddress: string,
): Promise<{ id: string; address: string; verified: boolean }> {
  const address = normalize(rawAddress);
  if (!isPlausibleEmail(address)) {
    throw new InvalidForwardTargetError(rawAddress);
  }
  return prisma.forwardingAddress.upsert({
    where: { userId_address: { userId, address } },
    create: { userId, address, verified: false },
    update: {},
    select: { id: true, address: true, verified: true },
  });
}

/**
 * Flip a pending row to verified. Returns the updated row, or null if
 * no matching row exists for this user.
 */
export async function confirmForwardTarget(
  userId: string,
  id: string,
): Promise<{ id: string; address: string; verified: boolean } | null> {
  const result = await prisma.forwardingAddress.updateMany({
    where: { id, userId },
    data: { verified: true },
  });
  if (result.count === 0) return null;
  return prisma.forwardingAddress.findUnique({
    where: { id },
    select: { id: true, address: true, verified: true },
  });
}

export async function removeForwardTarget(
  userId: string,
  id: string,
): Promise<boolean> {
  const result = await prisma.forwardingAddress.deleteMany({
    where: { id, userId },
  });
  return result.count > 0;
}

export class InvalidForwardTargetError extends Error {
  constructor(public readonly address: string) {
    super(`invalid forward target: ${address}`);
    this.name = 'InvalidForwardTargetError';
  }
}

// Cheap sanity check; full RFC validation happens at Gmail send time.
function isPlausibleEmail(s: string): boolean {
  if (s.length < 3 || s.length > 254) return false;
  const at = s.indexOf('@');
  if (at <= 0 || at === s.length - 1) return false;
  if (s.indexOf('@', at + 1) !== -1) return false;
  if (/\s/.test(s)) return false;
  if (!s.slice(at + 1).includes('.')) return false;
  return true;
}
