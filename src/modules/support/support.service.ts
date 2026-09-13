import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { TicketAuthorType, TicketStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { AddMessageDto } from './dto/add-message.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';

const CLOSING_STATUSES: ReadonlySet<TicketStatus> = new Set<TicketStatus>([TicketStatus.RESOLVED, TicketStatus.CLOSED]);

/** Support client (Module 8 du CDC). */
@Injectable()
export class SupportService {
  constructor(private prisma: PrismaService) {}

  async createTicket(userId: string, dto: CreateTicketDto) {
    return this.prisma.supportTicket.create({
      data: {
        userId,
        subject: dto.subject,
        category: dto.category,
        messages: { create: { authorType: TicketAuthorType.USER, authorId: userId, body: dto.message } },
      },
      include: { messages: true },
    });
  }

  listMine(userId: string) {
    return this.prisma.supportTicket.findMany({
      where: { userId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Un utilisateur ne peut écrire que sur ses propres tickets ; les agents sur tous. */
  async addMessage(authorId: string, ticketId: string, authorType: TicketAuthorType, dto: AddMessageDto) {
    const ticket = await this.prisma.supportTicket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundException('Ticket introuvable.');
    if (authorType === TicketAuthorType.USER && ticket.userId !== authorId) {
      throw new ForbiddenException("Ce ticket ne vous appartient pas.");
    }
    return this.prisma.supportTicketMessage.create({
      data: { ticketId, authorType, authorId, body: dto.body },
    });
  }

  // --------------------------------------------------------------- Back-office
  listAll(status?: TicketStatus) {
    return this.prisma.supportTicket.findMany({
      where: status ? { status } : undefined,
      include: { user: { select: { fullName: true, email: true } }, messages: { orderBy: { createdAt: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateTicket(id: string, dto: UpdateTicketDto) {
    const ticket = await this.prisma.supportTicket.findUnique({ where: { id } });
    if (!ticket) throw new NotFoundException('Ticket introuvable.');

    // Fermeture : horodatée une seule fois. Réouverture (OPEN / IN_PROGRESS) : closedAt effacé.
    let closedAt: Date | null = ticket.closedAt;
    if (dto.status) closedAt = CLOSING_STATUSES.has(dto.status) ? ticket.closedAt ?? new Date() : null;

    return this.prisma.supportTicket.update({
      where: { id },
      data: { status: dto.status, priority: dto.priority, closedAt },
    });
  }
}
