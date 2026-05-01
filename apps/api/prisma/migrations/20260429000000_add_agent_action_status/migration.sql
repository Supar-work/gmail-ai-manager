-- Add audit lifecycle columns so a row can be pre-written as `pending`,
-- the Gmail/DB mutation runs, and the row is then flipped to `applied`
-- or `failed`. Closes the gap where a SIGKILL between mutation and
-- audit-write left Gmail mutated with no trail.
--
-- Existing rows pre-date this change; assume `applied` since we only
-- wrote on success before today.
ALTER TABLE "AgentAction" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'applied';
ALTER TABLE "AgentAction" ADD COLUMN "appliedAt" DATETIME;
ALTER TABLE "AgentAction" ADD COLUMN "errorMessage" TEXT;

-- Reverse-lookup: find an existing audit row for a given source action so
-- we can dedupe a re-fired forward / labeled retry. Used by the
-- agent-actions reversal endpoint and by scheduler dedup.
CREATE INDEX "AgentAction_userId_sourceId_idx" ON "AgentAction"("userId", "sourceId");
