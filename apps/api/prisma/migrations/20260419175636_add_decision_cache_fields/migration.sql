/*
  Warnings:

  - Added the required column `updatedAt` to the `EmailDecision` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_EmailDecision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "gmailMessageId" TEXT NOT NULL,
    "matchedRuleIds" TEXT NOT NULL,
    "reasoning" TEXT NOT NULL,
    "actionsApplied" TEXT NOT NULL,
    "actionsScheduled" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "contentHistoryId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EmailDecision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- Backfill updatedAt for existing rows to the current createdAt so they are
-- considered "up to date" relative to current rules; a rule edit will bump
-- max(Rule.updatedAt) past this and invalidate them on the next run.
INSERT INTO "new_EmailDecision" ("actionsApplied", "actionsScheduled", "createdAt", "gmailMessageId", "id", "matchedRuleIds", "modelVersion", "reasoning", "userId", "updatedAt") SELECT "actionsApplied", "actionsScheduled", "createdAt", "gmailMessageId", "id", "matchedRuleIds", "modelVersion", "reasoning", "userId", "createdAt" FROM "EmailDecision";
DROP TABLE "EmailDecision";
ALTER TABLE "new_EmailDecision" RENAME TO "EmailDecision";
CREATE INDEX "EmailDecision_userId_createdAt_idx" ON "EmailDecision"("userId", "createdAt");
CREATE UNIQUE INDEX "EmailDecision_userId_gmailMessageId_key" ON "EmailDecision"("userId", "gmailMessageId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
