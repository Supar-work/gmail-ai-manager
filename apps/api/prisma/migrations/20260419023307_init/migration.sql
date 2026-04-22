-- CreateTable
CREATE TABLE "User" (
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Rule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "naturalLanguage" TEXT NOT NULL,
    "actionsJson" TEXT NOT NULL,
    "originalFilterJson" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Rule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FilterBackup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "snapshotJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FilterBackup_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EmailDecision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "gmailMessageId" TEXT NOT NULL,
    "matchedRuleIds" TEXT NOT NULL,
    "reasoning" TEXT NOT NULL,
    "actionsApplied" TEXT NOT NULL,
    "actionsScheduled" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmailDecision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ScheduledAction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "gmailMessageId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "runAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reasoning" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ScheduledAction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ScheduledAction_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "Rule" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ForwardingAddress" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ForwardingAddress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_googleSub_key" ON "User"("googleSub");

-- CreateIndex
CREATE INDEX "Rule_userId_position_idx" ON "Rule"("userId", "position");

-- CreateIndex
CREATE INDEX "FilterBackup_userId_createdAt_idx" ON "FilterBackup"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailDecision_userId_createdAt_idx" ON "EmailDecision"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailDecision_userId_gmailMessageId_key" ON "EmailDecision"("userId", "gmailMessageId");

-- CreateIndex
CREATE INDEX "ScheduledAction_status_runAt_idx" ON "ScheduledAction"("status", "runAt");

-- CreateIndex
CREATE INDEX "ScheduledAction_userId_status_idx" ON "ScheduledAction"("userId", "status");

-- CreateIndex
CREATE INDEX "ScheduledAction_ruleId_idx" ON "ScheduledAction"("ruleId");

-- CreateIndex
CREATE UNIQUE INDEX "ForwardingAddress_userId_address_key" ON "ForwardingAddress"("userId", "address");
