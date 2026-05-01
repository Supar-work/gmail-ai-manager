-- AlterTable
ALTER TABLE "InboxMessage" ADD COLUMN "listId" TEXT;
ALTER TABLE "InboxMessage" ADD COLUMN "listPost" TEXT;
ALTER TABLE "InboxMessage" ADD COLUMN "listUnsubscribe" TEXT;
ALTER TABLE "InboxMessage" ADD COLUMN "originalFromHeader" TEXT;
ALTER TABLE "InboxMessage" ADD COLUMN "precedence" TEXT;

-- CreateIndex
CREATE INDEX "InboxMessage_userId_listId_idx" ON "InboxMessage"("userId", "listId");
