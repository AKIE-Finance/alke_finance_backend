import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/** Tableau de bord de portefeuille (Module 5 du CDC). */
@Injectable()
export class PortfolioService {
  constructor(private prisma: PrismaService) {}

  /**
   * `currency` filtre le total consolide sur une seule devise a la fois
   * (comme cote app mobile) - additionner des soldes en devises differentes
   * sans conversion prealable n'aurait pas de sens financier.
   */
  async dashboard(userId: string, currency?: string) {
    const [positions, accounts, externalHoldings] = await Promise.all([
      this.prisma.position.findMany({
        where: { userId, ...(currency && { currency }) },
        include: { instrument: { include: { market: true } } },
      }),
      this.prisma.account.findMany({ where: { userId, ...(currency && { currency }) } }),
      this.prisma.externalHolding.findMany({ where: { userId, ...(currency && { currency }) } }),
    ]);

    const positionsWithValue = positions.map((p) => {
      const currentPrice = Number(p.instrument.lastPrice ?? p.avgCost);
      const marketValue = Math.round(Number(p.quantity) * currentPrice * 100) / 100;
      const costBasis = Math.round(Number(p.quantity) * Number(p.avgCost) * 100) / 100;
      const gain = Math.round((marketValue - costBasis) * 100) / 100;
      const gainPct = costBasis === 0 ? 0 : Math.round((gain / costBasis) * 10000) / 100;
      return { ...p, currentPrice, marketValue, costBasis, gain, gainPct };
    });

    const totalInvestedValue = positionsWithValue.reduce((sum, p) => sum + p.marketValue, 0);
    const totalCostBasis = positionsWithValue.reduce((sum, p) => sum + p.costBasis, 0);
    const totalCash = accounts.reduce((sum, a) => sum + Number(a.balance), 0);

    return {
      accounts,
      positions: positionsWithValue,
      externalHoldings,
      totals: {
        totalCash,
        totalInvestedValue,
        totalCostBasis,
        totalGain: Math.round((totalInvestedValue - totalCostBasis) * 100) / 100,
        totalWealth: Math.round((totalCash + totalInvestedValue) * 100) / 100,
      },
    };
  }
}
