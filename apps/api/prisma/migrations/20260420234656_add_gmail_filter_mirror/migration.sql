-- CreateTable
CREATE TABLE "GmailFilter" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "currentGmailId" TEXT,
    "criteriaJson" TEXT NOT NULL,
    "actionJson" TEXT NOT NULL,
    "labelMap" TEXT NOT NULL DEFAULT '{}',
    "naturalLanguage" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "signature" TEXT NOT NULL,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GmailFilter_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "GmailFilter_userId_enabled_idx" ON "GmailFilter"("userId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "GmailFilter_userId_signature_key" ON "GmailFilter"("userId", "signature");
