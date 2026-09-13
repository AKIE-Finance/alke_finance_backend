import { Controller, ForbiddenException, Get, NotFoundException, Param, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { LocalDiskStorage } from './local-disk.storage';

/** Sert les pièces du stockage local via URL signée (aucune authentification JWT : la signature fait foi). */
@ApiTags('kyc')
@Controller('kyc/documents')
export class DocumentsController {
  constructor(private readonly disk: LocalDiskStorage) {}

  @Get(':key')
  async stream(@Param('key') key: string, @Query('exp') exp: string, @Query('sig') sig: string, @Res() res: Response) {
    const expiry = Number(exp);
    if (!this.disk.verify(key, expiry, String(sig ?? ''))) {
      throw new ForbiddenException('Lien expiré ou signature invalide.');
    }
    let file: Awaited<ReturnType<LocalDiskStorage['open']>>;
    try {
      file = await this.disk.open(key);
    } catch {
      throw new NotFoundException('Document introuvable.');
    }
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Length', String(file.size));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `inline; filename="${key}"`);
    file.stream.pipe(res);
  }
}
