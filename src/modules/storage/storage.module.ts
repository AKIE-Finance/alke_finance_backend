import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DOCUMENT_STORAGE } from './storage.types';
import { LocalDiskStorage } from './local-disk.storage';
import { S3Storage } from './s3.storage';
import { DocumentsController } from './documents.controller';

/**
 * Global : KYC et le back-office injectent `DOCUMENT_STORAGE`. Le disque local
 * est utilisé sauf si DOCUMENTS_BUCKET est défini (S3, à implémenter).
 */
@Global()
@Module({
  providers: [
    LocalDiskStorage,
    S3Storage,
    {
      provide: DOCUMENT_STORAGE,
      inject: [ConfigService, LocalDiskStorage, S3Storage],
      useFactory: (config: ConfigService, disk: LocalDiskStorage, s3: S3Storage) =>
        config.get<string>('DOCUMENTS_BUCKET') ? s3 : disk,
    },
  ],
  controllers: [DocumentsController],
  exports: [DOCUMENT_STORAGE, LocalDiskStorage],
})
export class StorageModule {}
