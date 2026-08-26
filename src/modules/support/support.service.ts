import { Injectable, NotFoundException } from '@nestjs/common';
import { TicketStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { AddMessageDto } from './dto/add-message.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';

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
        messages: { create: { authorType: 'USER', authorId: userId, body: dto.message } },
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

  async addMessage(userId: string, ticketId: string, authorType: 'USER' | 'AGENT', dto: AddMessageDto) {
    const ticket = await this.prisma.supportTicket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundException('Ticket introuvable.');
    return this.prisma.supportTicketMessage.create({
      data: { ticketId, authorType, authorId: userId, body: dto.body },
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
    return this.prisma.supportTicket.update({
      where: { id },
      data: { ...dto, closedAt: dto.status === 'CLOSED' || dto.status === 'RESOLVED' ? new Date() : ticket.closedAt },
    });
  }
}
