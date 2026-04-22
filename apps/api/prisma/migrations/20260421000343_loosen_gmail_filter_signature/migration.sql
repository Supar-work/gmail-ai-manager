-- DropIndex
DROP INDEX "GmailFilter_userId_signature_key";

-- CreateIndex
CREATE INDEX "GmailFilter_userId_signature_idx" ON "GmailFilter"("userId", "signature");
