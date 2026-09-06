-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN "shippingCostPerOrder" REAL NOT NULL DEFAULT 5.0;
ALTER TABLE "ShopSettings" ADD COLUMN "targetMarginPercent" REAL NOT NULL DEFAULT 20;
ALTER TABLE "ShopSettings" ADD COLUMN "notificationEmail" TEXT;
