import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { createReadStream, promises as fs } from 'fs';
import { Readable } from 'stream';
import { join, resolve } from 'path';
import { DOCUMENT_KEY_RE, DocumentStoragePort, StoredDocument, contentTypeForKey } from './storage.types';

/**
 * Stockage local (développement / pilote mono-serveur). Répertoire
 * DOCUMENTS_DIR (défaut ./var/documents). URL signée :
 * /kyc/documents/<key>?exp=<epoch s>&sig=hmac-sha256(key|exp, JWT_SECRET).
 */
@Injectable()
export class LocalDiskStorage implements DocumentStoragePort {
  static readonly DEFAULT_TTL_SECONDS = 15 * 60;
  private readonly logger = new Logger(LocalDiskStorage.name);
  readonly rootDir: string;
  private readonly secret: string;
  private readonly baseUrl: string;

  constructor(config: ConfigService) {
    this.rootDir = resolve(config.get<string>('DOCUMENTS_DIR') ?? './var/documents');
    this.secret = config.get<string>('JWT_SECRET') ?? '';
    this.baseUrl = (config.get<string>('API_BASE_URL') ?? '').replace(/\/+$/, '');
  }

  private pathFor(key: string): string {
    if (!DOCUMENT_KEY_RE.test(key)) throw new Error('Clé de document invalide.');
    return join(this.rootDir, key);
  }

  async put(key: string, content: Buffer, contentType: string): Promise<StoredDocument> {
    const path = this.pathFor(key);
    await fs.mkdir(this.rootDir, { recursive: true });
    await fs.writeFile(path, content, { mode: 0o600 });
    return { key, contentType, size: content.length };
  }

  async getSignedUrl(key: string, ttlSeconds = LocalDiskStorage.DEFAULT_TTL_SECONDS): Promise<string> {
    if (!DOCUMENT_KEY_RE.test(key)) throw new Error('Clé de document invalide.');
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sig = this.sign(key, exp);
    return `${this.baseUrl}/kyc/documents/${encodeURIComponent(key)}?exp=${exp}&sig=${sig}`;
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(this.pathFor(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`Suppression de ${key} impossible : ${(err as Error).message}`);
      }
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  /** Opens the file for streaming; throws when absent. */
  async open(key: string): Promise<{ stream: Readable; contentType: string; size: number }> {
    const path = this.pathFor(key);
    const stat = await fs.stat(path);
    return { stream: createReadStream(path), contentType: contentTypeForKey(key), size: stat.size };
  }

  sign(key: string, exp: number): string {
    return createHmac('sha256', this.secret).update(`${key}|${exp}`).digest('hex');
  }

  /** Constant-time signature check plus expiry. */
  verify(key: string, exp: number, sig: string): boolean {
    if (!DOCUMENT_KEY_RE.test(key)) return false;
    if (!Number.isInteger(exp) || exp < Math.floor(Date.now() / 1000)) return false;
    if (!/^[0-9a-f]{64}$/.test(sig)) return false;
    const expected = Buffer.from(this.sign(key, exp), 'hex');
    const given = Buffer.from(sig, 'hex');
    return expected.length === given.length && timingSafeEqual(expected, given);
  }
}
