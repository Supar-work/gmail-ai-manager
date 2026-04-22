export type RunEvent = {
  t: number;
  level: 'info' | 'warn' | 'error';
  msg: string;
};

export type RunAction = {
  kind: 'applied' | 'scheduled';
  t: number;
  ruleId: string;
  subject: string | null;
  gmailMessageId: string;
  action: unknown;
  runAt?: string;
};

type RunState = {
  id: string;
  userId: string;
  startedAt: number;
  finishedAt?: number;
  status: 'running' | 'done' | 'error' | 'stopped';
  /** Runtime control — workers check this between messages. */
  control: 'running' | 'paused' | 'stopping';
  events: RunEvent[];
  actions: RunAction[];
  scanned: number;
  matched: number;
  applied: number;
  scheduled: number;
  skipped: number;
  errorMsg?: string;
};

/**
 * In-memory registry of in-flight and recently-completed classification runs.
 * The frontend polls /api/runs/:id to tail events, see the running summary,
 * and flip control via POST /api/runs/:id/{pause,resume,stop}.
 */
const runs = new Map<string, RunState>();

export function createRun(id: string, userId: string): RunState {
  const state: RunState = {
    id,
    userId,
    startedAt: Date.now(),
    status: 'running',
    control: 'running',
    events: [],
    actions: [],
    scanned: 0,
    matched: 0,
    applied: 0,
    scheduled: 0,
    skipped: 0,
  };
  runs.set(id, state);
  return state;
}

export function getRun(id: string): RunState | undefined {
  return runs.get(id);
}

export function pushEvent(id: string, msg: string, level: RunEvent['level'] = 'info'): void {
  const s = runs.get(id);
  if (!s) return;
  s.events.push({ t: Date.now(), level, msg });
}

export function pushAction(id: string, action: Omit<RunAction, 't'>): void {
  const s = runs.get(id);
  if (!s) return;
  s.actions.push({ ...action, t: Date.now() });
}

export function updateCounts(
  id: string,
  counts: Partial<Pick<RunState, 'scanned' | 'matched' | 'applied' | 'scheduled' | 'skipped'>>,
): void {
  const s = runs.get(id);
  if (!s) return;
  if (counts.scanned != null) s.scanned = counts.scanned;
  if (counts.matched != null) s.matched = counts.matched;
  if (counts.applied != null) s.applied = counts.applied;
  if (counts.scheduled != null) s.scheduled = counts.scheduled;
  if (counts.skipped != null) s.skipped = counts.skipped;
}

export function finishRun(id: string, status: 'done' | 'error' | 'stopped', errorMsg?: string): void {
  const s = runs.get(id);
  if (!s) return;
  s.status = status;
  s.control = 'running'; // reset so any late readers don't see stale state
  s.finishedAt = Date.now();
  if (errorMsg) s.errorMsg = errorMsg;
}

export function setControl(id: string, control: RunState['control']): boolean {
  const s = runs.get(id);
  if (!s) return false;
  if (s.status !== 'running') return false; // already terminal
  s.control = control;
  return true;
}

/**
 * Await permission to process the next unit of work.
 *   - 'running'  → resolve true
 *   - 'paused'   → sleep and re-poll (doesn't resolve until resumed or stopped)
 *   - 'stopping' → resolve false; caller should exit its loop
 */
export async function shouldContinue(id: string): Promise<boolean> {
  while (true) {
    const s = runs.get(id);
    if (!s) return false;
    if (s.control === 'stopping') return false;
    if (s.control === 'running') return true;
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Drop runs older than TTL to keep the registry bounded. */
export function sweepOldRuns(maxAgeMs = 60 * 60 * 1000): void {
  const now = Date.now();
  for (const [id, s] of runs) {
    if (s.status !== 'running' && s.finishedAt && now - s.finishedAt > maxAgeMs) {
      runs.delete(id);
    }
  }
}
