-- CreateTable
CREATE TABLE "MessageEmbedding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "gmailMessageId" TEXT NOT NULL,
    "embedding" BLOB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MessageEmbedding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "MessageEmbedding_userId_modelVersion_idx" ON "MessageEmbedding"("userId", "modelVersion");

-- CreateIndex
CREATE UNIQUE INDEX "MessageEmbedding_userId_gmailMessageId_key" ON "MessageEmbedding"("userId", "gmailMessageId");
