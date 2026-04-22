-- CreateTable
CREATE TABLE "ClassifyRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "ruleIds" TEXT,
    "scanned" INTEGER NOT NULL DEFAULT 0,
    "matched" INTEGER NOT NULL DEFAULT 0,
    "applied" INTEGER NOT NULL DEFAULT 0,
    "scheduled" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "logJson" TEXT NOT NULL DEFAULT '[]',
    "errorMsg" TEXT,
    CONSTRAINT "ClassifyRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "googleSub" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "encAccessToken" BLOB,
    "encRefreshToken" BLOB,
    "tokenScope" TEXT,
    "tokenExpiresAt" DATETIME,
    "watchExpiresAt" DATETIME,
    "lastHistoryId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "migratedAt" DATETIME,
    "pollIntervalSec" INTEGER NOT NULL DEFAULT 120,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_User" ("createdAt", "email", "encAccessToken", "encRefreshToken", "googleSub", "id", "lastHistoryId", "migratedAt", "status", "timezone", "tokenExpiresAt", "tokenScope", "updatedAt", "watchExpiresAt") SELECT "createdAt", "email", "encAccessToken", "encRefreshToken", "googleSub", "id", "lastHistoryId", "migratedAt", "status", "timezone", "tokenExpiresAt", "tokenScope", "updatedAt", "watchExpiresAt" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_googleSub_key" ON "User"("googleSub");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ClassifyRun_userId_startedAt_idx" ON "ClassifyRun"("userId", "startedAt");
