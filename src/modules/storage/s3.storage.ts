import { Injectable } from '@nestjs/common';
import { DocumentStoragePort, StoredDocument } from './storage.types';

/**
 * Espace réservé S3 (af-south-1, bucket DOCUMENTS_BUCKET). Sélectionné dès que
 * DOCUMENTS_BUCKET est défini ; l'implémentation (SDK AWS, URLs présignées)
 * arrive avec la dépendance @aws-sdk/client-s3 — hors périmètre de ce lot.
 */
@Injectable()
export class S3Storage implements DocumentStoragePort {
  private fail(): never {
    throw new Error('Stockage S3 non configuré');
  }

  async put(_key: string, _content: Buffer, _contentType: string): Promise<StoredDocument> {
    return this.fail();
  }

  async getSignedUrl(_key: string, _ttlSeconds?: number): Promise<string> {
    return this.fail();
  }

  async delete(_key: string): Promise<void> {
    return this.fail();
  }
}
