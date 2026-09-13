import { Injectable, NotFoundException } from '@nestjs/common';
import { AssetClass, Instrument, PartnerAgreementStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/services/audit.service';
import { UpdateMarketDto } from './dto/update-market.dto';
import { CreatePartnerDto } from './dto/create-partner.dto';
import { UpdatePartnerDto } from './dto/update-partner.dto';
import { CreateInstrumentDto } from './dto/create-instrument.dto';
import { UpdateInstrumentDto } from './dto/update-instrument.dto';
import { AddQuoteDto } from './dto/add-quote.dto';
import { BulkQuotesDto } from './dto/bulk-quotes.dto';

const SOURCE_MANUAL = 'BOC_MANUAL_ENTRY';
const SOURCE_FILE = 'BOC_FILE_UPLOAD';

/** Colonne `@db.Date` : on ne garde que le jour, en UTC, pour que l'unicité (instrument, jour) tienne. */
export function toTradeDate(input: string | Date): Date {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) throw new NotFoundException('Date de cotation invalide.');
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

@Injectable()
export class MarketsService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  // ---------------------------------------------------------------- Markets
  listMarkets() {
    return this.prisma.market.findMany({
      include: { _count: { select: { instruments: true, partners: true } } },
      orderBy: { code: 'asc' },
    });
  }

  async updateMarket(id: string, adminId: string, dto: UpdateMarketDto) {
    const before = await this.prisma.market.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Marché introuvable.');
    const after = await this.prisma.market.update({ where: { id }, data: dto });
    await this.audit.log({
      actorUserId: adminId, action: 'MARKET_UPDATED',
      entityType: 'Market', entityId: id, before, after,
    });
    return after;
  }

  // --------------------------------------------------------------- Partners
  listPartners(marketId?: string, agreementStatus?: PartnerAgreementStatus) {
    return this.prisma.marketPartner.findMany({
      where: { ...(marketId && { marketId }), ...(agreementStatus && { agreementStatus }) },
      include: { market: true },
      orderBy: [{ marketId: 'asc' }, { agreementStatus: 'desc' }],
    });
  }

  async createPartner(adminId: string, dto: CreatePartnerDto) {
    const partner = await this.prisma.marketPartner.create({ data: dto });
    await this.audit.log({
      actorUserId: adminId, action: 'PARTNER_CREATED',
      entityType: 'MarketPartner', entityId: partner.id, after: partner,
    });
    return partner;
  }

  /**
   * Le passage d'un partenaire à ACTIVE ne change plus l'état du marché :
   * `Market.status` / `liveTrading` sont l'interrupteur légal (blueprint §4.1)
   * et ne bougent que par maker-checker (module approvals).
   */
  async updatePartner(id: string, adminId: string, dto: UpdatePartnerDto) {
    const before = await this.prisma.marketPartner.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Partenaire introuvable.');
    const after = await this.prisma.marketPartner.update({
      where: { id },
      data: { ...dto, lastContactAt: new Date() },
    });
    await this.audit.log({
      actorUserId: adminId, action: 'PARTNER_UPDATED',
      entityType: 'MarketPartner', entityId: id, before, after,
    });
    return after;
  }

  // ------------------------------------------------------------ Instruments
  listInstruments(params: { marketId?: string; assetClass?: AssetClass; search?: string }) {
    return this.prisma.instrument.findMany({
      where: {
        isActive: true,
        ...(params.marketId && { marketId: params.marketId }),
        ...(params.assetClass && { assetClass: params.assetClass }),
        ...(params.search && {
          OR: [
            { name: { contains: params.search, mode: 'insensitive' } },
            { symbol: { contains: params.search, mode: 'insensitive' } },
            { isin: { equals: params.search.toUpperCase() } },
          ],
        }),
      },
      include: { market: true },
      orderBy: { symbol: 'asc' },
    });
  }

  async getInstrument(id: string) {
    const instrument = await this.prisma.instrument.findUnique({
      where: { id },
      include: { market: true, quoteHistory: { orderBy: { tradeDate: 'desc' }, take: 60 } },
    });
    if (!instrument) throw new NotFoundException('Valeur introuvable.');
    return instrument;
  }

  async createInstrument(dto: CreateInstrumentDto) {
    const market = await this.prisma.market.findUnique({ where: { id: dto.marketId }, select: { id: true } });
    if (!market) throw new NotFoundException('Marché introuvable.');
    return this.prisma.instrument.create({ data: { ...dto, isin: dto.isin?.toUpperCase() } });
  }

  async updateInstrument(id: string, dto: UpdateInstrumentDto) {
    const exists = await this.prisma.instrument.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException('Valeur introuvable.');
    return this.prisma.instrument.update({ where: { id }, data: { ...dto, isin: dto.isin?.toUpperCase() } });
  }

  // --------------------------------------------------- Cotations (BOC/manuel)
  /**
   * Insère/écrase la cotation du jour. Les champs de prix courant de l'instrument
   * (lastPrice, previousClose, dayHigh, dayLow) ne sont rafraîchis que si ce jour
   * est le plus récent connu : un rattrapage d'historique ne réécrit pas le dernier cours.
   */
  private async upsertQuote(instrument: Pick<Instrument, 'id'>, dto: AddQuoteDto, source: string): Promise<Instrument> {
    const tradeDate = toTradeDate(dto.tradeDate);
    await this.prisma.instrumentQuote.upsert({
      where: { instrumentId_tradeDate: { instrumentId: instrument.id, tradeDate } },
      create: { instrumentId: instrument.id, tradeDate, open: dto.open, high: dto.high, low: dto.low, close: dto.close, volume: dto.volume, source },
      update: { open: dto.open, high: dto.high, low: dto.low, close: dto.close, volume: dto.volume, source },
    });

    const [latest, previous] = await this.prisma.instrumentQuote.findMany({
      where: { instrumentId: instrument.id },
      orderBy: { tradeDate: 'desc' },
      take: 2,
    });
    if (!latest || latest.tradeDate.getTime() !== tradeDate.getTime()) {
      return this.prisma.instrument.findUniqueOrThrow({ where: { id: instrument.id } });
    }
    return this.prisma.instrument.update({
      where: { id: instrument.id },
      data: {
        lastPrice: latest.close,
        previousClose: previous?.close ?? latest.open,
        dayHigh: latest.high,
        dayLow: latest.low,
      },
    });
  }

  async addQuote(instrumentId: string, adminId: string, dto: AddQuoteDto) {
    const instrument = await this.prisma.instrument.findUnique({ where: { id: instrumentId } });
    if (!instrument) throw new NotFoundException('Valeur introuvable.');

    const updated = await this.upsertQuote(instrument, dto, SOURCE_MANUAL);
    await this.prisma.marketDataIngestionLog.create({
      data: { marketId: instrument.marketId, source: SOURCE_MANUAL, performedByAdminId: adminId, rowsProcessed: 1 },
    });
    return updated;
  }

  /** Un import = une ligne de journal, quel que soit le nombre de lignes traitées. */
  async bulkQuotes(marketId: string, adminId: string, dto: BulkQuotesDto) {
    const market = await this.prisma.market.findUnique({ where: { id: marketId }, select: { id: true } });
    if (!market) throw new NotFoundException('Marché introuvable.');

    let processed = 0;
    const failures: string[] = [];
    for (const row of dto.rows) {
      const instrument = await this.prisma.instrument.findUnique({
        where: { marketId_symbol: { marketId, symbol: row.symbol } },
        select: { id: true },
      });
      if (!instrument) {
        failures.push(`${row.symbol}: valeur inconnue`);
        continue;
      }
      try {
        await this.upsertQuote(instrument, row, SOURCE_FILE);
        processed++;
      } catch (err) {
        failures.push(`${row.symbol}@${row.tradeDate}: ${(err as Error).message}`);
      }
    }

    const notes = [dto.notes, failures.length ? failures.slice(0, 50).join('; ') : undefined].filter(Boolean).join(' | ') || undefined;
    const log = await this.prisma.marketDataIngestionLog.create({
      data: {
        marketId,
        source: SOURCE_FILE,
        performedByAdminId: adminId,
        rowsProcessed: processed,
        rowsFailed: failures.length,
        layoutFingerprint: Object.keys(dto.rows[0] ?? {}).sort().join(','),
        notes,
      },
    });
    return { ingestionLogId: log.id, processed, failed: failures.length, failures };
  }

  ingestionHistory(marketId?: string) {
    return this.prisma.marketDataIngestionLog.findMany({
      where: marketId ? { marketId } : undefined,
      include: { market: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  // --------------------------------------------------------------- Watchlist
  watchlist(userId: string) {
    return this.prisma.watchlistItem.findMany({
      where: { userId },
      include: { instrument: { include: { market: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async toggleWatch(userId: string, instrumentId: string) {
    const existing = await this.prisma.watchlistItem.findUnique({
      where: { userId_instrumentId: { userId, instrumentId } },
    });
    if (existing) {
      await this.prisma.watchlistItem.delete({ where: { id: existing.id } });
      return { watching: false };
    }
    const instrument = await this.prisma.instrument.findUnique({ where: { id: instrumentId }, select: { id: true } });
    if (!instrument) throw new NotFoundException('Valeur introuvable.');
    await this.prisma.watchlistItem.create({ data: { userId, instrumentId } });
    return { watching: true };
  }
}
