-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'SUPPORT', 'COMPLIANCE', 'ADMIN');

-- CreateEnum
CREATE TYPE "SupportedCountry" AS ENUM ('CIV', 'SEN', 'TGO', 'BEN', 'BFA', 'MLI', 'CMR', 'GAB', 'COG', 'INTL');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('NOT_STARTED', 'PENDING', 'IN_REVIEW', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "RiskProfile" AS ENUM ('PRUDENT', 'EQUILIBRE', 'DYNAMIQUE');

-- CreateEnum
CREATE TYPE "OtpPurpose" AS ENUM ('REGISTER', 'LOGIN', 'RESET_PASSWORD', 'WITHDRAWAL', 'CHANGE_PHONE');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('NATIONAL_ID', 'PASSPORT', 'DRIVER_LICENSE');

-- CreateEnum
CREATE TYPE "MarketCode" AS ENUM ('BVMAC', 'BRVM', 'INTL', 'NGX', 'NSE', 'EGX', 'JSE', 'CASABLANCA', 'SEM');

-- CreateEnum
CREATE TYPE "MarketStatus" AS ENUM ('SIMULATED_ONLY', 'PARTNER_IN_PROGRESS', 'LIVE');

-- CreateEnum
CREATE TYPE "PartnerType" AS ENUM ('SDB', 'SGI', 'BROKER');

-- CreateEnum
CREATE TYPE "PartnerAgreementStatus" AS ENUM ('PROSPECT', 'CONTACTED', 'MEETING_SCHEDULED', 'IN_DISCUSSION', 'TERM_SHEET', 'SIGNED', 'ACTIVE', 'DECLINED');

-- CreateEnum
CREATE TYPE "IntegrationTier" AS ENUM ('TIER0_SIMULATED', 'TIER1_FILE', 'TIER2_BACKOFFICE_LINK', 'TIER3_API');

-- CreateEnum
CREATE TYPE "AssetClass" AS ENUM ('STOCK', 'BOND');

-- CreateEnum
CREATE TYPE "WalletTransactionType" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'FX_CONVERT_IN', 'FX_CONVERT_OUT', 'ORDER_DEBIT', 'ORDER_CREDIT', 'FEE', 'DIVIDEND', 'COUPON', 'REFERRAL_REWARD');

-- CreateEnum
CREATE TYPE "WalletTransactionStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('MTN_MOMO', 'ORANGE_MONEY', 'CINETPAY', 'PAYDUNYA', 'BANK_TRANSFER', 'INTERNAL');

-- CreateEnum
CREATE TYPE "OrderSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('MARKET', 'LIMIT');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'TRANSMITTED', 'PARTIALLY_EXECUTED', 'EXECUTED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RecurringFrequency" AS ENUM ('WEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "FeeType" AS ENUM ('BROKERAGE', 'FX_SPREAD', 'MANAGEMENT', 'WITHDRAWAL');

-- CreateEnum
CREATE TYPE "ReferralStatus" AS ENUM ('INVITED', 'SIGNED_UP', 'FIRST_DEPOSIT_DONE', 'REWARDED');

-- CreateEnum
CREATE TYPE "ProPlan" AS ENUM ('MONTHLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "TicketAuthorType" AS ENUM ('USER', 'AGENT');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "country" "SupportedCountry" NOT NULL,
    "displayCurrency" TEXT NOT NULL DEFAULT 'XOF',
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "kycStatus" "KycStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "kycRejectionReason" TEXT,
    "riskProfile" "RiskProfile",
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "biometricEnabled" BOOLEAN NOT NULL DEFAULT false,
    "avatarSeed" TEXT,
    "referralCode" TEXT NOT NULL,
    "referredById" TEXT,
    "isBlocked" BOOLEAN NOT NULL DEFAULT false,
    "blockedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtpCode" (
    "id" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "purpose" "OtpPurpose" NOT NULL,
    "code" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OtpCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserDevice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KycSubmission" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "KycStatus" NOT NULL DEFAULT 'PENDING',
    "documentType" "DocumentType",
    "documentFrontUrl" TEXT,
    "documentBackUrl" TEXT,
    "selfieUrl" TEXT,
    "questionnaire" JSONB,
    "rejectionReason" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedByAdminId" TEXT,

    CONSTRAINT "KycSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Market" (
    "id" TEXT NOT NULL,
    "code" "MarketCode" NOT NULL,
    "name" TEXT NOT NULL,
    "zone" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "regulator" TEXT NOT NULL,
    "status" "MarketStatus" NOT NULL DEFAULT 'SIMULATED_ONLY',
    "openingHoursNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Market_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketPartner" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PartnerType" NOT NULL,
    "agreementStatus" "PartnerAgreementStatus" NOT NULL DEFAULT 'PROSPECT',
    "integrationTier" "IntegrationTier" NOT NULL DEFAULT 'TIER0_SIMULATED',
    "aelpParticipant" BOOLEAN NOT NULL DEFAULT false,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "notes" TEXT,
    "agreementNumber" TEXT,
    "lastContactAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketPartner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Instrument" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "assetClass" "AssetClass" NOT NULL,
    "sector" TEXT,
    "currency" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastPrice" DECIMAL(18,4),
    "previousClose" DECIMAL(18,4),
    "dayHigh" DECIMAL(18,4),
    "dayLow" DECIMAL(18,4),
    "week52High" DECIMAL(18,4),
    "week52Low" DECIMAL(18,4),
    "marketCap" DECIMAL(20,2),
    "per" DECIMAL(10,2),
    "dividendYield" DECIMAL(6,3),
    "couponRate" DECIMAL(6,3),
    "maturityDate" TIMESTAMP(3),
    "nominalPrice" DECIMAL(18,4),
    "minSubscription" DECIMAL(18,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Instrument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstrumentQuote" (
    "id" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "tradeDate" TIMESTAMP(3) NOT NULL,
    "open" DECIMAL(18,4) NOT NULL,
    "high" DECIMAL(18,4) NOT NULL,
    "low" DECIMAL(18,4) NOT NULL,
    "close" DECIMAL(18,4) NOT NULL,
    "volume" BIGINT,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InstrumentQuote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketDataIngestionLog" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "performedByAdminId" TEXT,
    "rowsProcessed" INTEGER NOT NULL DEFAULT 0,
    "rowsFailed" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketDataIngestionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WatchlistItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WatchlistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "balance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletTransaction" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "type" "WalletTransactionType" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "status" "WalletTransactionStatus" NOT NULL DEFAULT 'PENDING',
    "provider" "PaymentProvider" NOT NULL DEFAULT 'INTERNAL',
    "providerReference" TEXT,
    "feeAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "WalletTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FxConversion" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fromCurrency" TEXT NOT NULL,
    "toCurrency" TEXT NOT NULL,
    "fromAmount" DECIMAL(18,2) NOT NULL,
    "toAmount" DECIMAL(18,2) NOT NULL,
    "rateApplied" DECIMAL(18,8) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FxConversion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "partnerId" TEXT,
    "side" "OrderSide" NOT NULL,
    "orderType" "OrderType" NOT NULL DEFAULT 'MARKET',
    "quantity" DECIMAL(18,4) NOT NULL,
    "limitPrice" DECIMAL(18,4),
    "estimatedPrice" DECIMAL(18,4) NOT NULL,
    "estimatedTotal" DECIMAL(18,2) NOT NULL,
    "brokerageFee" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "executionTier" "IntegrationTier" NOT NULL DEFAULT 'TIER0_SIMULATED',
    "partnerReference" TEXT,
    "rejectionReason" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "transmittedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "executedPrice" DECIMAL(18,4),

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "avgCost" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecurringPlan" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "frequency" "RecurringFrequency" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecurringPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeeSchedule" (
    "id" TEXT NOT NULL,
    "marketId" TEXT,
    "feeType" "FeeType" NOT NULL,
    "isPercentage" BOOLEAN NOT NULL DEFAULT true,
    "value" DECIMAL(10,4) NOT NULL,
    "minAmount" DECIMAL(18,2),
    "maxAmount" DECIMAL(18,2),
    "label" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeeSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalHolding" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "assetType" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "avgCost" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalHolding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Referral" (
    "id" TEXT NOT NULL,
    "referrerUserId" TEXT NOT NULL,
    "refereeUserId" TEXT,
    "code" TEXT NOT NULL,
    "status" "ReferralStatus" NOT NULL DEFAULT 'INVITED',
    "rewardAmount" DECIMAL(18,2),
    "rewardCurrency" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rewardedAt" TIMESTAMP(3),

    CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "plan" "ProPlan" NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "renewsAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "push" BOOLEAN NOT NULL DEFAULT true,
    "priceAlerts" BOOLEAN NOT NULL DEFAULT true,
    "news" BOOLEAN NOT NULL DEFAULT true,
    "orders" BOOLEAN NOT NULL DEFAULT true,
    "promo" BOOLEAN NOT NULL DEFAULT false,
    "community" BOOLEAN NOT NULL DEFAULT true,
    "email" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NpsResponse" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NpsResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportTicket" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "TicketPriority" NOT NULL DEFAULT 'NORMAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportTicketMessage" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "authorType" "TicketAuthorType" NOT NULL,
    "authorId" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportTicketMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorRole" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "beforeJson" JSONB,
    "afterJson" JSONB,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "User_referralCode_key" ON "User"("referralCode");

-- CreateIndex
CREATE INDEX "User_email_idx" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_phone_idx" ON "User"("phone");

-- CreateIndex
CREATE INDEX "User_kycStatus_idx" ON "User"("kycStatus");

-- CreateIndex
CREATE INDEX "OtpCode_destination_purpose_idx" ON "OtpCode"("destination", "purpose");

-- CreateIndex
CREATE INDEX "UserDevice_userId_idx" ON "UserDevice"("userId");

-- CreateIndex
CREATE INDEX "KycSubmission_userId_idx" ON "KycSubmission"("userId");

-- CreateIndex
CREATE INDEX "KycSubmission_status_idx" ON "KycSubmission"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Market_code_key" ON "Market"("code");

-- CreateIndex
CREATE INDEX "MarketPartner_marketId_idx" ON "MarketPartner"("marketId");

-- CreateIndex
CREATE INDEX "MarketPartner_agreementStatus_idx" ON "MarketPartner"("agreementStatus");

-- CreateIndex
CREATE INDEX "Instrument_assetClass_idx" ON "Instrument"("assetClass");

-- CreateIndex
CREATE UNIQUE INDEX "Instrument_marketId_symbol_key" ON "Instrument"("marketId", "symbol");

-- CreateIndex
CREATE INDEX "InstrumentQuote_instrumentId_tradeDate_idx" ON "InstrumentQuote"("instrumentId", "tradeDate");

-- CreateIndex
CREATE UNIQUE INDEX "InstrumentQuote_instrumentId_tradeDate_key" ON "InstrumentQuote"("instrumentId", "tradeDate");

-- CreateIndex
CREATE INDEX "MarketDataIngestionLog_marketId_idx" ON "MarketDataIngestionLog"("marketId");

-- CreateIndex
CREATE UNIQUE INDEX "WatchlistItem_userId_instrumentId_key" ON "WatchlistItem"("userId", "instrumentId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_userId_currency_key" ON "Account"("userId", "currency");

-- CreateIndex
CREATE INDEX "WalletTransaction_accountId_idx" ON "WalletTransaction"("accountId");

-- CreateIndex
CREATE INDEX "WalletTransaction_status_idx" ON "WalletTransaction"("status");

-- CreateIndex
CREATE INDEX "FxConversion_userId_idx" ON "FxConversion"("userId");

-- CreateIndex
CREATE INDEX "Order_userId_idx" ON "Order"("userId");

-- CreateIndex
CREATE INDEX "Order_marketId_idx" ON "Order"("marketId");

-- CreateIndex
CREATE INDEX "Order_status_idx" ON "Order"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Position_userId_instrumentId_key" ON "Position"("userId", "instrumentId");

-- CreateIndex
CREATE INDEX "RecurringPlan_userId_idx" ON "RecurringPlan"("userId");

-- CreateIndex
CREATE INDEX "RecurringPlan_active_nextRunAt_idx" ON "RecurringPlan"("active", "nextRunAt");

-- CreateIndex
CREATE INDEX "ExternalHolding_userId_idx" ON "ExternalHolding"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Referral_refereeUserId_key" ON "Referral"("refereeUserId");

-- CreateIndex
CREATE INDEX "Referral_referrerUserId_idx" ON "Referral"("referrerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_userId_key" ON "Subscription"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_userId_key" ON "NotificationPreference"("userId");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE INDEX "SupportTicket_userId_idx" ON "SupportTicket"("userId");

-- CreateIndex
CREATE INDEX "SupportTicket_status_idx" ON "SupportTicket"("status");

-- CreateIndex
CREATE INDEX "SupportTicketMessage_ticketId_idx" ON "SupportTicketMessage"("ticketId");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserDevice" ADD CONSTRAINT "UserDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KycSubmission" ADD CONSTRAINT "KycSubmission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KycSubmission" ADD CONSTRAINT "KycSubmission_reviewedByAdminId_fkey" FOREIGN KEY ("reviewedByAdminId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketPartner" ADD CONSTRAINT "MarketPartner_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Instrument" ADD CONSTRAINT "Instrument_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstrumentQuote" ADD CONSTRAINT "InstrumentQuote_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketDataIngestionLog" ADD CONSTRAINT "MarketDataIngestionLog_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchlistItem" ADD CONSTRAINT "WatchlistItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchlistItem" ADD CONSTRAINT "WatchlistItem_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "MarketPartner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringPlan" ADD CONSTRAINT "RecurringPlan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringPlan" ADD CONSTRAINT "RecurringPlan_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeSchedule" ADD CONSTRAINT "FeeSchedule_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalHolding" ADD CONSTRAINT "ExternalHolding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referrerUserId_fkey" FOREIGN KEY ("referrerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_refereeUserId_fkey" FOREIGN KEY ("refereeUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NpsResponse" ADD CONSTRAINT "NpsResponse_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicketMessage" ADD CONSTRAINT "SupportTicketMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
