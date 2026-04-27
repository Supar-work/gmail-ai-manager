-- CreateTable
CREATE TABLE "AgentAction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceId" TEXT,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "toolInputJson" TEXT NOT NULL,
    "toolResultJson" TEXT,
    "reasoning" TEXT,
    "reversibleAs" TEXT,
    "reversedAt" DATETIME,
    "reversedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentAction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "AgentAction_userId_createdAt_idx" ON "AgentAction"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentAction_userId_source_createdAt_idx" ON "AgentAction"("userId", "source", "createdAt");

-- CreateIndex
CREATE INDEX "AgentAction_userId_targetType_targetId_idx" ON "AgentAction"("userId", "targetType", "targetId");
