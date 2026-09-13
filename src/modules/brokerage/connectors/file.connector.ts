import { Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import { join, resolve } from 'path';
import { BatchContext, CshLine, ExeLine, AckLine, IOrderConnector, PollContext, SubmitBatchInput, SubmitResult, WdrLine } from './connector.types';
import { batchFileName, buildOrdCsv, buildWdrCsv, parseAck, parseCsh, parseExe, sha256, MARKET_TZ } from './csv';
import { yyyymmdd } from '../trading-days';

/**
 * Tier-1 file connector (blueprint §4.5). Writes ORD/WDR files to
 *   <SDB_FILE_DIR>/<partnerCode>/outbox
 * and reads ACK/EXE/CSH files from
 *   <SDB_FILE_DIR>/<partnerCode>/inbox
 * moving each processed file to inbox/processed. The transport itself
 * (SFTP drop, secure e-mail) is operated outside the API in v1.0; the same
 * parsers back the HTTP upload endpoints.
 *
 * Expected inbox names mirror the outbound file with the type swapped:
 *   ALKE_<CODE>_ACK_<YYYYMMDD>_<SEQ>.csv, ALKE_<CODE>_EXE_<YYYYMMDD>_<SEQ>.csv,
 *   ALKE_<CODE>_CSH_<YYYYMMDD>_<SEQ>.csv (SEQ ignored for statements).
 */
export class FileConnector implements IOrderConnector {
  readonly kind = 'file' as const;
  private readonly logger = new Logger(FileConnector.name);

  constructor(private readonly baseDir: string = process.env.SDB_FILE_DIR ?? resolve('./var/sdb')) {}

  static partnerCode(partner: { code: string | null; id: string }): string {
    return (partner.code ?? partner.id.slice(0, 8)).toUpperCase();
  }

  private partnerDir(partner: { code: string | null; id: string }, sub: 'outbox' | 'inbox' | 'inbox/processed'): string {
    return join(this.baseDir, FileConnector.partnerCode(partner), sub);
  }

  async submit(input: SubmitBatchInput): Promise<SubmitResult> {
    const content = buildOrdCsv(input.lines);
    return this.write(input, input.batch.fileName, content);
  }

  async submitWithdrawals(input: BatchContext & { lines: WdrLine[] }): Promise<SubmitResult> {
    const content = buildWdrCsv(input.lines);
    return this.write(input, input.batch.fileName, content);
  }

  protected async write(ctx: BatchContext, fileName: string, content: string): Promise<SubmitResult> {
    const dir = this.partnerDir(ctx.partner, 'outbox');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, fileName), content, 'utf8');
    return { fileName, fileHash: sha256(content), content };
  }

  async pollAck(ctx: PollContext): Promise<AckLine[]> {
    const text = await this.consume(ctx.partner, ctx.batch.fileName.replace('_ORD_', '_ACK_'));
    return text === null ? [] : parseAck(text);
  }

  async pollExecutions(ctx: PollContext): Promise<ExeLine[]> {
    const text = await this.consume(ctx.partner, ctx.batch.fileName.replace('_ORD_', '_EXE_'));
    return text === null ? [] : parseExe(text);
  }

  async fetchStatement(partnerId: string, date: Date): Promise<CshLine[]> {
    // The statement inbox is keyed by partner code; callers pass the partner id
    // when the code is unknown — both directory layouts are looked up.
    const partner = { code: null, id: partnerId };
    const prefix = `ALKE_${FileConnector.partnerCode(partner)}_CSH_${yyyymmdd(date, MARKET_TZ)}_`;
    const dir = this.partnerDir(partner, 'inbox');
    let names: string[];
    try {
      names = (await fs.readdir(dir)).filter((n) => n.startsWith(prefix) && n.endsWith('.csv')).sort();
    } catch {
      return [];
    }
    const lines: CshLine[] = [];
    for (const name of names) {
      const text = await this.consume(partner, name);
      if (text !== null) lines.push(...parseCsh(text));
    }
    return lines;
  }

  /** Reads an inbox file and moves it to inbox/processed; null when absent. */
  private async consume(partner: { code: string | null; id: string }, fileName: string): Promise<string | null> {
    const inbox = this.partnerDir(partner, 'inbox');
    const path = join(inbox, fileName);
    let text: string;
    try {
      text = await fs.readFile(path, 'utf8');
    } catch {
      return null;
    }
    const processed = this.partnerDir(partner, 'inbox/processed');
    await fs.mkdir(processed, { recursive: true });
    await fs.rename(path, join(processed, fileName));
    this.logger.log(`Consumed ${fileName}`);
    return text;
  }

  static ordFileName(partner: { code: string | null; id: string }, date: Date, sequence: number): string {
    return batchFileName(FileConnector.partnerCode(partner), 'ORD', date, sequence);
  }

  static wdrFileName(partner: { code: string | null; id: string }, date: Date, sequence: number): string {
    return batchFileName(FileConnector.partnerCode(partner), 'WDR', date, sequence);
  }
}
