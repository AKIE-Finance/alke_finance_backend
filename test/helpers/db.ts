import { PrismaClient } from '@prisma/client';

/**
 * Integration-test helpers. Tests run against the local database named in
 * .env.test (alke_finance_test), which already has all migrations applied
 * (`DATABASE_URL=... npx prisma migrate deploy`). Each test file calls
 * `resetDatabase()` in `beforeEach`/`beforeAll` to start from empty tables.
 */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const names = rows.map((r) => `"${r.tablename}"`).join(', ');
  if (names.length) await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
}

export function testPrisma(): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
}
