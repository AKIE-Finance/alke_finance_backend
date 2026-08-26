import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentProvider, WalletTransactionStatus, WalletTransactionType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/services/audit.service';
import { FxRateService } from './fx-rate.service';
import { DepositDto } from './dto/deposit.dto';
import { WithdrawDto } from './dto/withdraw.dto';
import { ConvertFxDto } from './dto/convert-fx.dto';

/**
 * Wallet & paiement (Module 2 du CDC).
 *
 * Tant que MTN MoMo / Orange Money / CinetPay ne sont pas branches avec de
 * vraies cles de production (voir Guide Backend, section 5.2), le backend
 * fonctionne en "PAYMENT_DEMO_MODE" : chaque depot/retrait est cree en
 * statut PENDING puis bascule immediatement en COMPLETED, exactement comme
 * le mock deja en place cote application mobile. Le jour ou une cle reelle
 * est configuree, il suffira de remplacer cette completion immediate par
 * l'appel au webhook du fournisseur, sans toucher au reste du flux.
 */
@Injectable()
export class WalletService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private audit: AuditService,
    private fx: FxRateService,
  ) {}

  private get demoMode(): boolean {
    return this.config.get<string>('OTP_DEMO_MODE') === 'true';
  }

  async getOrCreateAccount(userId: string, currency: string) {
    const existing = await this.prisma.account.findUnique({ where: { userId_currency: { userId, currency } } });
    if (existing) return existing;
    return this.prisma.account.create({ data: { userId, currency } });
  }

  accounts(userId: string) {
    return this.prisma.account.findMany({ where: { userId } });
  }

  async deposit(userId: string, dto: DepositDto) {
    const account = await this.getOrCreateAccount(userId, dto.currency);
    const tx = await this.prisma.walletTransaction.create({
      data: {
        accountId: account.id,
        type: WalletTransactionType.DEPOSIT,
        amount: dto.amount,
        provider: dto.provider ?? PaymentProvider.INTERNAL,
        status: WalletTransactionStatus.PENDING,
      },
    });

    if (this.demoMode) {
      return this.completeTransaction(tx.id);
    }
    return tx;
  }

  async withdraw(userId: string, dto: WithdrawDto) {
    const account = await this.getOrCreateAccount(userId, dto.currency);
    if (Number(account.balance) < dto.amount) {
      throw new BadRequestException('Solde disponible insuffisant pour ce retrait.');
    }

    const tx = await this.prisma.$transaction(async (db) => {
      await db.account.update({ where: { id: account.id }, data: { balance: { decrement: dto.amount } } });
      return db.walletTransaction.create({
        data: {
          accountId: account.id,
          type: WalletTransactionType.WITHDRAWAL,
          amount: dto.amount,
          provider: dto.provider ?? PaymentProvider.INTERNAL,
          status: WalletTransactionStatus.PENDING,
        },
      });
    });

    if (this.demoMode) {
      return this.completeTransaction(tx.id, false);
    }
    return tx;
  }

  /**
   * Marque une transaction comme terminee. `creditBalance=true` pour un
   * depot (le solde est cree au moment de la completion, pas avant, pour
   * ne jamais afficher un solde qui n'a pas ete recu) ; `false` pour un
   * retrait (le solde a deja ete debite a la demande).
   */
  async completeTransaction(transactionId: string, creditBalance = true) {
    const tx = await this.prisma.walletTransaction.findUnique({ where: { id: transactionId } });
    if (!tx) throw new NotFoundException('Transaction introuvable.');
    if (tx.status !== WalletTransactionStatus.PENDING) return tx;

    return this.prisma.$transaction(async (db) => {
      if (creditBalance) {
        await db.account.update({ where: { id: tx.accountId }, data: { balance: { increment: tx.amount } } });
      }
      return db.walletTransaction.update({
        where: { id: transactionId },
        data: { status: WalletTransactionStatus.COMPLETED, completedAt: new Date() },
      });
    });
  }

  async convertFx(userId: string, dto: ConvertFxDto) {
    const fromAccount = await this.getOrCreateAccount(userId, dto.fromCurrency);
    if (Number(fromAccount.balance) < dto.amount) {
      throw new BadRequestException('Solde disponible insuffisant pour cette conversion.');
    }
    const rate = await this.fx.getRate(dto.fromCurrency, dto.toCurrency);
    const toAmount = Math.round(dto.amount * rate * 100) / 100;
    const toAccount = await this.getOrCreateAccount(userId, dto.toCurrency);

    const [conversion] = await this.prisma.$transaction([
      this.prisma.fxConversion.create({
        data: {
          userId,
          fromCurrency: dto.fromCurrency,
          toCurrency: dto.toCurrency,
          fromAmount: dto.amount,
          toAmount,
          rateApplied: rate,
        },
      }),
      this.prisma.account.update({ where: { id: fromAccount.id }, data: { balance: { decrement: dto.amount } } }),
      this.prisma.account.update({ where: { id: toAccount.id }, data: { balance: { increment: toAmount } } }),
      this.prisma.walletTransaction.create({
        data: { accountId: fromAccount.id, type: WalletTransactionType.FX_CONVERT_OUT, amount: dto.amount, status: WalletTransactionStatus.COMPLETED, completedAt: new Date() },
      }),
      this.prisma.walletTransaction.create({
        data: { accountId: toAccount.id, type: WalletTransactionType.FX_CONVERT_IN, amount: toAmount, status: WalletTransactionStatus.COMPLETED, completedAt: new Date() },
      }),
    ]);

    return conversion;
  }

  async transactions(userId: string, currency?: string) {
    const accounts = await this.prisma.account.findMany({
      where: { userId, ...(currency && { currency }) },
      select: { id: true },
    });
    return this.prisma.walletTransaction.findMany({
      where: { accountId: { in: accounts.map((a) => a.id) } },
      include: { account: { select: { currency: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ------------------------------------------------------------- Back-office
  async adminListPending() {
    return this.prisma.walletTransaction.findMany({
      where: { status: WalletTransactionStatus.PENDING },
      include: { account: { include: { user: { select: { id: true, fullName: true, email: true } } } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async adminForceComplete(adminId: string, transactionId: string) {
    const tx = await this.prisma.walletTransaction.findUnique({ where: { id: transactionId } });
    if (!tx) throw new NotFoundException('Transaction introuvable.');
    const result = await this.completeTransaction(transactionId, tx.type === WalletTransactionType.DEPOSIT);
    await this.audit.log({
      actorUserId: adminId, actorRole: 'ADMIN', action: 'WALLET_TX_FORCE_COMPLETED',
      entityType: 'WalletTransaction', entityId: transactionId, before: tx, after: result,
    });
    return result;
  }
}
