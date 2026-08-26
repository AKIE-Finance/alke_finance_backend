import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { KycStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/services/audit.service';
import { SubmitKycDto } from './dto/submit-kyc.dto';
import { ReviewKycDto } from './dto/review-kyc.dto';

@Injectable()
export class KycService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  async submit(userId: string, dto: SubmitKycDto) {
    const submission = await this.prisma.kycSubmission.create({
      data: {
        userId,
        documentType: dto.documentType,
        documentFrontUrl: dto.documentFrontUrl,
        documentBackUrl: dto.documentBackUrl,
        selfieUrl: dto.selfieUrl,
        questionnaire: dto.questionnaire as any,
        status: KycStatus.PENDING,
      },
    });
    await this.prisma.user.update({ where: { id: userId }, data: { kycStatus: KycStatus.PENDING } });
    return submission;
  }

  listMine(userId: string) {
    return this.prisma.kycSubmission.findMany({ where: { userId }, orderBy: { submittedAt: 'desc' } });
  }

  listForReview(status?: KycStatus) {
    return this.prisma.kycSubmission.findMany({
      where: status ? { status } : { status: { in: [KycStatus.PENDING, KycStatus.IN_REVIEW] } },
      include: { user: { select: { id: true, fullName: true, email: true, phone: true, country: true } } },
      orderBy: { submittedAt: 'asc' },
    });
  }

  async review(adminId: string, submissionId: string, dto: ReviewKycDto) {
    if (dto.status !== KycStatus.VERIFIED && dto.status !== KycStatus.REJECTED) {
      throw new BadRequestException('Le statut de revue doit être VERIFIED ou REJECTED.');
    }
    const submission = await this.prisma.kycSubmission.findUnique({ where: { id: submissionId } });
    if (!submission) throw new NotFoundException('Dossier KYC introuvable.');

    const updated = await this.prisma.kycSubmission.update({
      where: { id: submissionId },
      data: {
        status: dto.status,
        rejectionReason: dto.status === KycStatus.REJECTED ? dto.rejectionReason : null,
        reviewedAt: new Date(),
        reviewedByAdminId: adminId,
      },
    });

    await this.prisma.user.update({
      where: { id: submission.userId },
      data: {
        kycStatus: dto.status,
        kycRejectionReason: dto.status === KycStatus.REJECTED ? dto.rejectionReason : null,
      },
    });

    await this.audit.log({
      actorUserId: adminId,
      actorRole: 'ADMIN',
      action: dto.status === KycStatus.VERIFIED ? 'KYC_APPROVED' : 'KYC_REJECTED',
      entityType: 'KycSubmission',
      entityId: submissionId,
      before: { status: submission.status },
      after: { status: dto.status, rejectionReason: dto.rejectionReason },
    });

    return updated;
  }
}
