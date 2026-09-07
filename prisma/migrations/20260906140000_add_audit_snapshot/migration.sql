-- CreateTable
CREATE TABLE "AuditSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "scannedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "healthScore" INTEGER NOT NULL,
    "totalMonthlyLeak" REAL NOT NULL,
    "currencyCode" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "AuditSnapshot_shop_scannedAt_idx" ON "AuditSnapshot"("shop", "scannedAt");
