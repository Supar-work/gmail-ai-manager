-- CreateTable
CREATE TABLE "InboxMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "gmailMessageId" TEXT NOT NULL,
    "threadId" TEXT,
    "historyId" TEXT,
    "fromHeader" TEXT,
    "toHeader" TEXT,
    "subject" TEXT,
    "snippet" TEXT,
    "bodyText" TEXT,
    "labelIds" TEXT NOT NULL DEFAULT '[]',
    "dateHeader" TEXT,
    "internalDate" DATETIME,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "InboxMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "InboxMessage_userId_internalDate_idx" ON "InboxMessage"("userId", "internalDate");

-- CreateIndex
CREATE UNIQUE INDEX "InboxMessage_userId_gmailMessageId_key" ON "InboxMessage"("userId", "gmailMessageId");
