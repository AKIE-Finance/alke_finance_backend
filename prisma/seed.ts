/**
 * Reference data for a fresh database (blueprint v3.2):
 *  - markets: BVMAC (v1.0), BRVM (v1.1, simulated only), INTL (watch-only, A5);
 *  - the seven BVMAC listed equities and the SDB outreach short-list (§7.1);
 *  - fee schedule v0 with ledger fee codes (§3.2);
 *  - day-one config_values thresholds (§4.18, §9);
 *  - an ADMIN and, optionally, a COMPLIANCE user (maker-checker needs two people).
 * Idempotent: safe to re-run.
 */
import { PrismaClient, MarketCode, PartnerType, AssetClass, UserRole, KycStatus, FeeType } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const adminEmail = process.env.ADMIN_SEED_EMAIL;
  const adminPassword = process.env.ADMIN_SEED_PASSWORD;
  const complianceEmail = process.env.COMPLIANCE_SEED_EMAIL;
  const compliancePassword = process.env.COMPLIANCE_SEED_PASSWORD;
  const isProd = process.env.APP_ENV === 'production' || process.env.NODE_ENV === 'production';
  const allowAdminSeed = !isProd || process.env.SEED_ADMIN_IN_PROD === 'true';

  if (!adminEmail || !adminPassword) {
    console.warn('ADMIN_SEED_EMAIL / ADMIN_SEED_PASSWORD not set: no admin user will be created.');
  } else if (!allowAdminSeed) {
    console.warn('Production environment: admin seeding skipped (set SEED_ADMIN_IN_PROD=true to override).');
  }

  await prisma.$transaction(
    async (tx) => {
      // ------------------------------------------------------------ Markets
      const bvmac = await tx.market.upsert({
        where: { code: MarketCode.BVMAC },
        create: {
          code: MarketCode.BVMAC,
          name: 'Bourse des Valeurs Mobilières de l’Afrique Centrale',
          zone: 'Zone CEMAC',
          currency: 'XAF',
          regulator: 'COSUMAF',
          status: 'SIMULATED_ONLY',
          liveTrading: false,
          timezone: 'Africa/Douala',
          cutoffTime: '09:30',
          settlementDays: 3,
          sessionsJson: {
            days: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
            phases: [
              { name: 'consultation', from: '08:00', to: '09:00' },
              { name: 'pre-opening', from: '09:00', to: '11:00' },
              { name: 'fixing', at: '11:00' },
              { name: 'surveillance', from: '11:00', to: '15:00' },
              { name: 'post-session', at: '15:30' },
            ],
          },
          openingHoursNote: 'Un fixing par jour à 11:00 (heure de Douala). Les ordres reçus avant 09:30 partent dans le lot du jour.',
        },
        update: { timezone: 'Africa/Douala', cutoffTime: '09:30', settlementDays: 3 },
      });

      const brvm = await tx.market.upsert({
        where: { code: MarketCode.BRVM },
        create: {
          code: MarketCode.BRVM,
          name: 'Bourse Régionale des Valeurs Mobilières',
          zone: 'Zone UEMOA',
          currency: 'XOF',
          regulator: 'CREPMF',
          status: 'SIMULATED_ONLY',
          liveTrading: false,
          timezone: 'Africa/Abidjan',
          openingHoursNote: 'v1.1 — hors périmètre du pilote (A1).',
        },
        update: {},
      });

      await tx.market.upsert({
        where: { code: MarketCode.INTL },
        create: {
          code: MarketCode.INTL,
          name: 'Marchés internationaux (consultation seule)',
          zone: 'International',
          currency: 'USD',
          regulator: 'N/A',
          status: 'SIMULATED_ONLY',
          liveTrading: false,
          openingHoursNote: 'Cours Twelve Data, consultation seule — aucun ordre (A5).',
        },
        update: {},
      });

      // ------------------------------------------ SDB outreach short-list (§7.1)
      const bvmacPartners: { code: string; name: string; contactName?: string; notes: string }[] = [
        { code: 'EDC', name: 'EDC Investment Corporation', contactName: 'Département Corporate / Institutionnels', notes: 'Filiale boursière du groupe Ecobank, Douala. Agréée COSUMAF. À contacter en priorité.' },
        { code: 'SGC', name: 'SG Capital Securities Central Africa', notes: 'Adossée à Société Générale Cameroun. Back-office moderne.' },
        { code: 'AFB', name: 'Afriland Bourse & Investissement', notes: 'Groupe Afriland First Bank. Forte activité actions.' },
        { code: 'ESS', name: 'ESS Bourse (Emerald Securities Services)', notes: 'Première part de marché de la zone.' },
        { code: 'BGB', name: 'BGFI Bourse', notes: 'Groupe BGFIBank.' },
        { code: 'ACCA', name: 'AFG Capital Central Africa', notes: 'Agréée 2020 (ex-Attijari Securities Central Africa).' },
        { code: 'CBC', name: 'CBC Bourse', notes: 'Adossée à Commercial Bank of Cameroon.' },
        { code: 'DGC', name: 'Digicapital Bourse', notes: 'Positionnement digitalisation des actifs.' },
        { code: 'FIN', name: 'Financia Capital', notes: 'Active sur le segment obligataire.' },
      ];
      for (const p of bvmacPartners) {
        const existing = await tx.marketPartner.findFirst({ where: { marketId: bvmac.id, name: p.name } });
        if (!existing) {
          await tx.marketPartner.create({
            data: { marketId: bvmac.id, type: PartnerType.SDB, code: p.code, name: p.name, contactName: p.contactName, notes: p.notes },
          });
        } else if (!existing.code) {
          await tx.marketPartner.update({ where: { id: existing.id }, data: { code: p.code } });
        }
      }

      const brvmPartners = [
        { code: 'BOAC', name: 'BOA Capital Securities', aelp: true, notes: 'Réseau Bank of Africa. Participe à l’AELP.' },
        { code: 'CORI', name: 'Coris Bourse', aelp: true, notes: 'Groupe Coris Bank International.' },
        { code: 'CGF', name: 'CGF Bourse', aelp: true, notes: 'Sénégal. Première SGI agréée CREPMF.' },
        { code: 'SGCS', name: 'Société Générale Capital Securities (SGCS) Bourse', aelp: true, notes: 'Réseau Société Générale.' },
      ];
      for (const p of brvmPartners) {
        const existing = await tx.marketPartner.findFirst({ where: { marketId: brvm.id, name: p.name } });
        if (!existing) {
          await tx.marketPartner.create({
            data: { marketId: brvm.id, type: PartnerType.SGI, code: p.code, name: p.name, aelpParticipant: p.aelp, notes: p.notes },
          });
        }
      }

      // ------------------------------------------------- Fee schedule v0 (§3.2)
      const fees: { feeType: FeeType; value: number; label: string; isPercentage?: boolean; min?: number }[] = [
        { feeType: FeeType.COURTAGE_SDB, value: 1.0, label: 'Courtage SDB (à confirmer dans la convention)' },
        { feeType: FeeType.COMMISSION_ALKE, value: 0.5, label: 'Commission ALKÉ (grille v1 à signer, B12)' },
        { feeType: FeeType.TAXE, value: 0.0, label: 'Taxes de bourse (à renseigner selon le barème BVMAC)' },
      ];
      for (const f of fees) {
        const existing = await tx.feeSchedule.findFirst({ where: { marketId: bvmac.id, feeType: f.feeType, isActive: true } });
        if (!existing) {
          await tx.feeSchedule.create({
            data: { marketId: bvmac.id, feeType: f.feeType, isPercentage: f.isPercentage ?? true, value: f.value, minAmount: f.min, label: f.label },
          });
        }
      }

      // ------------------------------------ v1.0 catalogue: BVMAC listed equities
      const bvmacEquities = [
        { symbol: 'SEMC', name: 'Société des Eaux Minérales du Cameroun', sector: 'Agroalimentaire', country: 'CM' },
        { symbol: 'SAFACAM', name: 'Société Africaine Forestière et Agricole du Cameroun', sector: 'Agro-industrie', country: 'CM' },
        { symbol: 'SOCAPALM', name: 'Société Camerounaise de Palmeraies', sector: 'Agro-industrie', country: 'CM' },
        { symbol: 'LAREGIONALE', name: 'La Régionale d’Épargne et de Crédit', sector: 'Finance', country: 'CM' },
        { symbol: 'BANGE', name: 'Banco Nacional de Guinea Ecuatorial', sector: 'Banque', country: 'GQ' },
        { symbol: 'SCGRE', name: 'Société Commerciale Gabonaise de Réassurance', sector: 'Assurance', country: 'GA' },
        { symbol: 'BGFIHC', name: 'BGFI Holding Corporation', sector: 'Banque', country: 'GA' },
      ];
      for (const s of bvmacEquities) {
        const existing = await tx.instrument.findUnique({ where: { marketId_symbol: { marketId: bvmac.id, symbol: s.symbol } } });
        if (!existing) {
          // Prices are intentionally absent: they arrive from the BOC ingestion
          // or a manual quote entry; an instrument without a price is not orderable.
          await tx.instrument.create({
            data: { marketId: bvmac.id, symbol: s.symbol, name: s.name, assetClass: AssetClass.STOCK, sector: s.sector, currency: 'XAF', lotSize: 1 },
          });
        }
      }

      // ------------------------------------------ Day-one thresholds (§4.18, §9)
      const configs: { key: string; value: unknown }[] = [
        { key: 'pilot.deposit_cap_xaf', value: 500000 },
        { key: 'pilot.order_cap_xaf', value: 250000 },
        { key: 'pilot.daily_batch_cap_xaf', value: 10000000 },
        { key: 'order.cutoff_time', value: '09:30' },
        { key: 'order.expiry_sessions', value: 1 },
        { key: 'reconciliation.materiality_xaf', value: 1000 },
        { key: 'withdrawal.sla_hours', value: 24 },
        { key: 'withdrawal.daily_cap_xaf', value: 500000 },
        { key: 'otp.max_requests_per_hour', value: 5 },
        { key: 'otp.max_attempts', value: 5 },
        { key: 'payment.intent_ttl_minutes', value: 15 },
        { key: 'kyc.max_resubmissions', value: 3 },
        { key: 'kyc.auto_approve_min_coverage', value: 0.6 },
        { key: 'demo.user_emails', value: [] },
      ];
      for (const c of configs) {
        const existing = await tx.configValue.findFirst({ where: { key: c.key, effectiveTo: null } });
        if (!existing) {
          await tx.configValue.create({ data: { key: c.key, value: c.value as object, createdById: null } });
        }
      }

      // ----------------------------------------------------------- Back-office
      if (adminEmail && adminPassword && allowAdminSeed) {
        const existingAdmin = await tx.user.findUnique({ where: { email: adminEmail } });
        if (!existingAdmin) {
          await tx.user.create({
            data: {
              fullName: 'Administrateur AlKÉ',
              email: adminEmail,
              phone: process.env.ADMIN_SEED_PHONE ?? '+237600000001',
              country: 'CMR',
              displayCurrency: 'XAF',
              role: UserRole.ADMIN,
              kycStatus: KycStatus.VALIDATED,
              passwordHash: await bcrypt.hash(adminPassword, 12),
              referralCode: 'ALKEADMIN',
              notificationPref: { create: {} },
            },
          });
          console.log('Admin user created from environment variables.');
        }
      }
      if (complianceEmail && compliancePassword && allowAdminSeed) {
        const existing = await tx.user.findUnique({ where: { email: complianceEmail } });
        if (!existing) {
          await tx.user.create({
            data: {
              fullName: 'Conformité AlKÉ',
              email: complianceEmail,
              phone: process.env.COMPLIANCE_SEED_PHONE ?? '+237600000002',
              country: 'CMR',
              displayCurrency: 'XAF',
              role: UserRole.COMPLIANCE,
              kycStatus: KycStatus.VALIDATED,
              passwordHash: await bcrypt.hash(compliancePassword, 12),
              referralCode: 'ALKECOMPL',
              notificationPref: { create: {} },
            },
          });
          console.log('Compliance user created (second approver for maker-checker).');
        }
      }

      console.log('Seed complete.');
    },
    { timeout: 60000 },
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
