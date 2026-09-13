-- Blueprint v3.2 core migration. The legacy mutable-balance wallet tables are dropped
-- first so that enum swaps below have no dependents (order fixed by hand after `prisma migrate diff`).
DROP TABLE IF EXISTS "WalletTransaction" CASCADE;
DROP TABLE IF EXISTS "FxConversion" CASCADE;
DROP TABLE IF EXISTS "Account" CASCADE;
DROP TYPE IF EXISTS "WalletTransactionType";
DROP TYPE IF EXISTS "WalletTransactionStatus";

-- CreateEnum
CREATE TYPE "BrokerAccountState" AS ENUM ('REQUESTED', 'OPEN', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "LedgerOwnerType" AS ENUM ('USER', 'SDB', 'ALKE', 'FEE', 'PROVIDER', 'TAX');

-- CreateEnum
CREATE TYPE "LedgerAccountKind" AS ENUM ('AVAILABLE', 'RESERVED', 'SETTLING', 'WITHDRAWABLE', 'CLEARING');

-- CreateEnum
CREATE TYPE "LedgerTxnType" AS ENUM ('DEPOSIT', 'RESERVE', 'RELEASE', 'FILL', 'FEE', 'TAX', 'SETTLEMENT', 'WITHDRAWAL', 'ADJUST', 'REVERSAL');

-- CreateEnum
CREATE TYPE "LedgerTxnStatus" AS ENUM ('POSTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "PaymentDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "PaymentIntentState" AS ENUM ('CREATED', 'PENDING', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReconciliationSource" AS ENUM ('SDB_STATEMENT', 'PROVIDER', 'EXE_FILE');

-- CreateEnum
CREATE TYPE "ReconciliationState" AS ENUM ('OPEN', 'INVESTIGATING', 'RESOLVED', 'WRITTEN_OFF');

-- CreateEnum
CREATE TYPE "BatchType" AS ENUM ('ORD', 'WDR');

-- CreateEnum
CREATE TYPE "BatchState" AS ENUM ('BUILT', 'SENT', 'ACKED', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "SettlementState" AS ENUM ('UNSETTLED', 'SETTLING', 'SETTLED', 'FAILED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('SMS', 'PUSH', 'EMAIL', 'IN_APP');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "ApprovalState" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXECUTED', 'FAILED');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AlertSource" AS ENUM ('KYC_SCREENING', 'RECONCILIATION', 'TRANSACTION_THRESHOLD', 'SETTLEMENT_FAILURE', 'WITHDRAWAL_VELOCITY', 'MANUAL');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('OPEN', 'ATTACHED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ComplianceCaseState" AS ENUM ('OPEN', 'UNDER_REVIEW', 'ESCALATED', 'CLEARED', 'REPORTED', 'CLOSED');

-- AlterEnum
BEGIN;
CREATE TYPE "FeeType_new" AS ENUM ('COURTAGE_SDB', 'COMMISSION_ALKE', 'FX_SPREAD', 'TAXE', 'WITHDRAWAL');
ALTER TABLE "FeeSchedule" ALTER COLUMN "feeType" TYPE "FeeType_new" USING ("feeType"::text::"FeeType_new");
ALTER TYPE "FeeType" RENAME TO "FeeType_old";
ALTER TYPE "FeeType_new" RENAME TO "FeeType";
DROP TYPE "FeeType_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "KycStatus_new" AS ENUM ('NOT_STARTED', 'DRAFT', 'SUBMITTED', 'AUTO_APPROVED', 'MANUAL_REVIEW', 'VALIDATED', 'REJECTED', 'RE_KYC');
ALTER TABLE "KycSubmission" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "User" ALTER COLUMN "kycStatus" DROP DEFAULT;
ALTER TABLE "User" ALTER COLUMN "kycStatus" TYPE "KycStatus_new" USING ("kycStatus"::text::"KycStatus_new");
ALTER TABLE "KycSubmission" ALTER COLUMN "status" TYPE "KycStatus_new" USING ("status"::text::"KycStatus_new");
ALTER TYPE "KycStatus" RENAME TO "KycStatus_old";
ALTER TYPE "KycStatus_new" RENAME TO "KycStatus";
DROP TYPE "KycStatus_old";
ALTER TABLE "KycSubmission" ALTER COLUMN "status" SET DEFAULT 'DRAFT';
ALTER TABLE "User" ALTER COLUMN "kycStatus" SET DEFAULT 'NOT_STARTED';
COMMIT;

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OrderStatus" ADD VALUE 'ACKNOWLEDGED';
ALTER TYPE "OrderStatus" ADD VALUE 'EXPIRED';
ALTER TYPE "OrderStatus" ADD VALUE 'ADJUSTED';

-- AlterEnum
BEGIN;
CREATE TYPE "PaymentProvider_new" AS ENUM ('MTN_MOMO', 'ORANGE_MONEY', 'CINETPAY', 'PAYDUNYA', 'BANK_TRANSFER', 'SIMULATED');
ALTER TYPE "PaymentProvider" RENAME TO "PaymentProvider_old";
ALTER TYPE "PaymentProvider_new" RENAME TO "PaymentProvider";
DROP TYPE "PaymentProvider_old";
COMMIT;

-- AlterEnum
ALTER TYPE "SupportedCountry" ADD VALUE 'GNQ';

-- DropForeignKey

-- DropForeignKey

-- DropIndex
DROP INDEX "InstrumentQuote_instrumentId_tradeDate_idx";

-- DropIndex
DROP INDEX "Order_marketId_idx";

-- DropIndex
DROP INDEX "Order_status_idx";

-- DropIndex
DROP INDEX "Order_userId_idx";

-- DropIndex
DROP INDEX "OtpCode_destination_purpose_idx";

-- DropIndex
DROP INDEX "User_email_idx";

-- DropIndex
DROP INDEX "User_phone_idx";

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "actorType" TEXT NOT NULL DEFAULT 'USER',
ADD COLUMN     "correlationId" TEXT,
ADD COLUMN     "hash" TEXT NOT NULL,
ADD COLUMN     "prevHash" TEXT,
ADD COLUMN     "seq" BIGSERIAL NOT NULL;

-- AlterTable
ALTER TABLE "FeeSchedule" ADD COLUMN     "effectiveTo" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Instrument" ADD COLUMN     "isin" TEXT,
ADD COLUMN     "lotSize" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "tickSize" DECIMAL(18,4);

-- AlterTable
ALTER TABLE "InstrumentQuote" ALTER COLUMN "tradeDate" SET DATA TYPE DATE;

-- AlterTable
ALTER TABLE "KycSubmission" DROP COLUMN "documentBackUrl",
DROP COLUMN "documentFrontUrl",
DROP COLUMN "reviewedAt",
DROP COLUMN "selfieUrl",
ADD COLUMN     "autoDecision" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "decidedAt" TIMESTAMP(3),
ADD COLUMN     "documentBackKey" TEXT,
ADD COLUMN     "documentCountry" TEXT,
ADD COLUMN     "documentFrontKey" TEXT,
ADD COLUMN     "livenessScore" DECIMAL(5,2),
ADD COLUMN     "providerRef" TEXT,
ADD COLUMN     "screeningResult" JSONB,
ADD COLUMN     "selfieKey" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "status" SET DEFAULT 'DRAFT',
ALTER COLUMN "submittedAt" DROP NOT NULL,
ALTER COLUMN "submittedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Market" ADD COLUMN     "cutoffTime" TEXT NOT NULL DEFAULT '09:30',
ADD COLUMN     "liveTrading" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sessionsJson" JSONB,
ADD COLUMN     "settlementDays" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'Africa/Douala';

-- AlterTable
ALTER TABLE "MarketDataIngestionLog" ADD COLUMN     "layoutFingerprint" TEXT;

-- AlterTable
ALTER TABLE "MarketPartner" ADD COLUMN     "code" TEXT;

-- AlterTable
ALTER TABLE "Order" DROP COLUMN "executedPrice",
DROP COLUMN "partnerReference",
ADD COLUMN     "acknowledgedAt" TIMESTAMP(3),
ADD COLUMN     "avgExecutedPrice" DECIMAL(18,4),
ADD COLUMN     "batchId" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "expiredAt" TIMESTAMP(3),
ADD COLUMN     "expiresAfterSessions" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "feesJson" JSONB,
ADD COLUMN     "filledQuantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN     "maxAmount" DECIMAL(18,2) NOT NULL,
ADD COLUMN     "reserveTxnId" TEXT,
ADD COLUMN     "sdbRef" TEXT,
ADD COLUMN     "simulated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "validity" TEXT NOT NULL DEFAULT 'DAY';

-- AlterTable
ALTER TABLE "OtpCode" DROP COLUMN "code",
ADD COLUMN     "codeHash" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Position" ADD COLUMN     "pendingQuantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN     "reservedQuantity" DECIMAL(18,4) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "kycResubmissions" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "kycValidatedAt" TIMESTAMP(3),
ADD COLUMN     "passwordChangedAt" TIMESTAMP(3),
ADD COLUMN     "tokenVersion" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "displayCurrency" SET DEFAULT 'XAF';

-- AlterTable
ALTER TABLE "UserDevice" ADD COLUMN     "pushToken" TEXT;

-- DropTable

-- DropTable

-- DropTable

-- DropEnum

-- DropEnum

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "deviceId" TEXT,
    "deviceLabel" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrokerAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "externalAccountNo" TEXT,
    "state" "BrokerAccountState" NOT NULL DEFAULT 'REQUESTED',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openedAt" TIMESTAMP(3),
    "suspendedAt" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "BrokerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerAccount" (
    "id" TEXT NOT NULL,
    "ownerType" "LedgerOwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "kind" "LedgerAccountKind" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerTxn" (
    "id" TEXT NOT NULL,
    "type" "LedgerTxnType" NOT NULL,
    "status" "LedgerTxnStatus" NOT NULL DEFAULT 'POSTED',
    "idempotencyKey" TEXT NOT NULL,
    "externalReference" TEXT,
    "source" TEXT NOT NULL,
    "actorId" TEXT,
    "refType" TEXT,
    "refId" TEXT,
    "currency" TEXT NOT NULL,
    "description" TEXT,
    "metadata" JSONB,
    "reversalOfId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerTxn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "txnId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentIntent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "direction" "PaymentDirection" NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "state" "PaymentIntentState" NOT NULL DEFAULT 'CREATED',
    "msisdn" TEXT,
    "providerRef" TEXT,
    "providerStatus" TEXT,
    "webhookPayload" JSONB,
    "failureReason" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "ledgerTxnId" TEXT,
    "batchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationItem" (
    "id" TEXT NOT NULL,
    "source" "ReconciliationSource" NOT NULL,
    "externalRef" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3),
    "rawLine" TEXT,
    "matchedTxnId" TEXT,
    "state" "ReconciliationState" NOT NULL DEFAULT 'OPEN',
    "reason" TEXT,
    "ownerId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconciliationItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderBatch" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "type" "BatchType" NOT NULL DEFAULT 'ORD',
    "sequence" INTEGER NOT NULL,
    "cutoffAt" TIMESTAMP(3) NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileHash" TEXT,
    "manifestSig" TEXT,
    "state" "BatchState" NOT NULL DEFAULT 'BUILT',
    "lineCount" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "ackAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Execution" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "batchId" TEXT,
    "quantity" DECIMAL(18,4) NOT NULL,
    "price" DECIMAL(18,4) NOT NULL,
    "grossAmount" DECIMAL(18,2) NOT NULL,
    "courtage" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxes" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(18,2) NOT NULL,
    "sdbExecRef" TEXT,
    "executedAt" TIMESTAMP(3) NOT NULL,
    "settlementDate" DATE,
    "settlementState" "SettlementState" NOT NULL DEFAULT 'UNSETTLED',
    "settledAt" TIMESTAMP(3),
    "fillTxnId" TEXT,
    "settlementTxnId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Execution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConfigValue" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "createdById" TEXT,
    "approvedById" TEXT,
    "auditLogId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConfigValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "channel" "NotificationChannel" NOT NULL,
    "recipient" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "payload" JSONB,
    "status" "NotificationStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "providerRef" TEXT,
    "error" TEXT,
    "eventName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingApproval" (
    "id" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "payload" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "makerId" TEXT NOT NULL,
    "checkerId" TEXT,
    "state" "ApprovalState" NOT NULL DEFAULT 'PENDING',
    "decisionNote" TEXT,
    "decidedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "error" TEXT,
    "auditLogId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceAlert" (
    "id" TEXT NOT NULL,
    "source" "AlertSource" NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'OPEN',
    "userId" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "summary" TEXT NOT NULL,
    "details" JSONB,
    "caseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComplianceAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceCase" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "subjectUserId" TEXT,
    "state" "ComplianceCaseState" NOT NULL DEFAULT 'OPEN',
    "ownerId" TEXT,
    "title" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "ComplianceCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceNote" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComplianceNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceDecision" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "decidedById" TEXT NOT NULL,
    "approvalId" TEXT,
    "regulatoryReportRef" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComplianceDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Session_refreshTokenHash_key" ON "Session"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_revokedAt_idx" ON "Session"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "BrokerAccount_state_idx" ON "BrokerAccount"("state");

-- CreateIndex
CREATE UNIQUE INDEX "BrokerAccount_userId_partnerId_key" ON "BrokerAccount"("userId", "partnerId");

-- CreateIndex
CREATE INDEX "LedgerAccount_ownerType_ownerId_idx" ON "LedgerAccount"("ownerType", "ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAccount_ownerType_ownerId_currency_kind_key" ON "LedgerAccount"("ownerType", "ownerId", "currency", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerTxn_idempotencyKey_key" ON "LedgerTxn"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerTxn_reversalOfId_key" ON "LedgerTxn"("reversalOfId");

-- CreateIndex
CREATE INDEX "LedgerTxn_refType_refId_idx" ON "LedgerTxn"("refType", "refId");

-- CreateIndex
CREATE INDEX "LedgerTxn_type_postedAt_idx" ON "LedgerTxn"("type", "postedAt");

-- CreateIndex
CREATE INDEX "LedgerEntry_accountId_createdAt_idx" ON "LedgerEntry"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "LedgerEntry_txnId_idx" ON "LedgerEntry"("txnId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentIntent_reference_key" ON "PaymentIntent"("reference");

-- CreateIndex
CREATE INDEX "PaymentIntent_userId_createdAt_idx" ON "PaymentIntent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentIntent_state_expiresAt_idx" ON "PaymentIntent"("state", "expiresAt");

-- CreateIndex
CREATE INDEX "PaymentIntent_provider_providerRef_idx" ON "PaymentIntent"("provider", "providerRef");

-- CreateIndex
CREATE INDEX "ReconciliationItem_state_idx" ON "ReconciliationItem"("state");

-- CreateIndex
CREATE UNIQUE INDEX "ReconciliationItem_source_externalRef_key" ON "ReconciliationItem"("source", "externalRef");

-- CreateIndex
CREATE UNIQUE INDEX "OrderBatch_fileName_key" ON "OrderBatch"("fileName");

-- CreateIndex
CREATE INDEX "OrderBatch_partnerId_cutoffAt_idx" ON "OrderBatch"("partnerId", "cutoffAt");

-- CreateIndex
CREATE INDEX "OrderBatch_state_idx" ON "OrderBatch"("state");

-- CreateIndex
CREATE UNIQUE INDEX "Execution_sdbExecRef_key" ON "Execution"("sdbExecRef");

-- CreateIndex
CREATE INDEX "Execution_orderId_idx" ON "Execution"("orderId");

-- CreateIndex
CREATE INDEX "Execution_settlementState_settlementDate_idx" ON "Execution"("settlementState", "settlementDate");

-- CreateIndex
CREATE INDEX "ConfigValue_key_effectiveFrom_idx" ON "ConfigValue"("key", "effectiveFrom");

-- CreateIndex
CREATE INDEX "NotificationLog_status_createdAt_idx" ON "NotificationLog"("status", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationLog_userId_idx" ON "NotificationLog"("userId");

-- CreateIndex
CREATE INDEX "PendingApproval_state_createdAt_idx" ON "PendingApproval"("state", "createdAt");

-- CreateIndex
CREATE INDEX "PendingApproval_entityType_entityId_idx" ON "PendingApproval"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "ComplianceAlert_status_severity_idx" ON "ComplianceAlert"("status", "severity");

-- CreateIndex
CREATE INDEX "ComplianceAlert_userId_idx" ON "ComplianceAlert"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceCase_reference_key" ON "ComplianceCase"("reference");

-- CreateIndex
CREATE INDEX "ComplianceCase_state_idx" ON "ComplianceCase"("state");

-- CreateIndex
CREATE INDEX "ComplianceNote_caseId_idx" ON "ComplianceNote"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "AuditLog_seq_key" ON "AuditLog"("seq");

-- CreateIndex
CREATE INDEX "FeeSchedule_feeType_effectiveFrom_idx" ON "FeeSchedule"("feeType", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "Instrument_isin_key" ON "Instrument"("isin");

-- CreateIndex
CREATE INDEX "Order_userId_submittedAt_idx" ON "Order"("userId", "submittedAt");

-- CreateIndex
CREATE INDEX "Order_marketId_status_idx" ON "Order"("marketId", "status");

-- CreateIndex
CREATE INDEX "Order_batchId_idx" ON "Order"("batchId");

-- CreateIndex
CREATE INDEX "OtpCode_destination_purpose_createdAt_idx" ON "OtpCode"("destination", "purpose", "createdAt");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrokerAccount" ADD CONSTRAINT "BrokerAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrokerAccount" ADD CONSTRAINT "BrokerAccount_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "MarketPartner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerTxn" ADD CONSTRAINT "LedgerTxn_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "LedgerTxn"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_txnId_fkey" FOREIGN KEY ("txnId") REFERENCES "LedgerTxn"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "OrderBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "OrderBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderBatch" ADD CONSTRAINT "OrderBatch_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderBatch" ADD CONSTRAINT "OrderBatch_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "MarketPartner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Execution" ADD CONSTRAINT "Execution_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Execution" ADD CONSTRAINT "Execution_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "OrderBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingApproval" ADD CONSTRAINT "PendingApproval_makerId_fkey" FOREIGN KEY ("makerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingApproval" ADD CONSTRAINT "PendingApproval_checkerId_fkey" FOREIGN KEY ("checkerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceAlert" ADD CONSTRAINT "ComplianceAlert_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ComplianceCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceCase" ADD CONSTRAINT "ComplianceCase_subjectUserId_fkey" FOREIGN KEY ("subjectUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceNote" ADD CONSTRAINT "ComplianceNote_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ComplianceCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceDecision" ADD CONSTRAINT "ComplianceDecision_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ComplianceCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

