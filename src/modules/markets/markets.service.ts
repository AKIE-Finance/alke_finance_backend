import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/services/audit.service';
import { UpdateMarketDto } from './dto/update-market.dto';
import { CreatePartnerDto } from './dto/create-partner.dto';
import { UpdatePartnerDto } from './dto/update-partner.dto';
import { CreateInstrumentDto } from './dto/create-instrument.dto';
import { UpdateInstrumentDto } from './dto/update-instrument.dto';
import { AddQuoteDto } from './dto/add-quote.dto';
import { BulkQuotesDto } from './dto/bulk-quotes.dto';
import { AssetClass, PartnerAgreementStatus } from '@prisma/client';

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
      actorUserId: adminId, actorRole: 'ADMIN', action: 'MARKET_UPDATED',
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

  createPartner(adminId: string, dto: CreatePartnerDto) {
    return this.prisma.marketPartner.create({ data: dto }).then(async (p) => {
      await this.audit.log({
        actorUserId: adminId, actorRole: 'ADMIN', action: 'PARTNER_CREATED',
        entityType: 'MarketPartner', entityId: p.id, after: p,
      });
      return p;
    });
  }

  async updatePartner(id: string, adminId: string, dto: UpdatePartnerDto) {
    const before = await this.prisma.marketPartner.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Partenaire introuvable.');
    const after = await this.prisma.marketPartner.update({
      where: { id },
      data: { ...dto, lastContactAt: new Date() },
    });

    // Si un partenaire devient ACTIVE, faire passer le marche en LIVE :
    // c'est le moment ou le repli "mode simule" peut etre leve pour ce
    // marche (cf. Guide ALKE-BOURSE section 8, principe de repli automatique).
    if (dto.agreementStatus === PartnerAgreementStatus.ACTIVE) {
      await this.prisma.market.update({ where: { id: after.marketId }, data: { status: 'LIVE' } });
    }

    await this.audit.log({
      actorUserId: adminId, actorRole: 'ADMIN', action: 'PARTNER_UPDATED',
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

  createInstrument(dto: CreateInstrumentDto) {
    return this.prisma.instrument.create({ data: dto as any });
  }

  async updateInstrument(id: string, dto: UpdateInstrumentDto) {
    const exists = await this.prisma.instrument.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Valeur introuvable.');
    return this.prisma.instrument.update({ where: { id }, data: dto as any });
  }

  // --------------------------------------------------- Cotations (BOC/manuel)
  async addQuote(instrumentId: string, adminId: string, dto: AddQuoteDto) {
    const instrument = await this.prisma.instrument.findUnique({ where: { id: instrumentId } });
    if (!instrument) throw new NotFoundException('Valeur introuvable.');

    await this.prisma.instrumentQuote.upsert({
      where: { instrumentId_tradeDate: { instrumentId, tradeDate: new Date(dto.tradeDate) } },
      create: { instrumentId, tradeDate: new Date(dto.tradeDate), open: dto.open, high: dto.high, low: dto.low, close: dto.close, volume: dto.volume, source: 'BOC_MANUAL_ENTRY' },
      update: { open: dto.open, high: dto.high, low: dto.low, close: dto.close, volume: dto.volume },
    });

    const updated = await this.prisma.instrument.update({
      where: { id: instrumentId },
      data: {
        previousClose: instrument.lastPrice ?? dto.open,
        lastPrice: dto.close,
        dayHigh: dto.high,
        dayLow: dto.low,
      },
    });

    await this.prisma.marketDataIngestionLog.create({
      data: { marketId: instrument.marketId, source: 'BOC_MANUAL_ENTRY', performedByAdminId: adminId, rowsProcessed: 1 },
    });

    return updated;
  }

  async bulkQuotes(marketId: string, adminId: string, dto: BulkQuotesDto) {
    let processed = 0;
    let failed = 0;
    for (const row of dto.rows) {
      const instrument = await this.prisma.instrument.findUnique({
        where: { marketId_symbol: { marketId, symbol: row.symbol } },
      });
      if (!instrument) { failed++; continue; }
      await this.addQuote(instrument.id, adminId, row);
      processed++;
    }
    await this.prisma.marketDataIngestionLog.create({
      data: { marketId, source: 'BOC_FILE_UPLOAD', performedByAdminId: adminId, rowsProcessed: processed, rowsFailed: failed },
    });
    return { processed, failed };
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
    await this.prisma.watchlistItem.create({ data: { userId, instrumentId } });
    return { watching: true };
  }
}
