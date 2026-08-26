/**
 * Amorce la base avec les donnees de reference issues des documents CDC :
 * les 2 marches v1.0 (BVMAC, BRVM) + INTL, la short-list de partenaires
 * boursiers deja identifies dans les guides ALKE-BOURSE-2026-001/002
 * (statut PROSPECT - a mettre a jour au fur et a mesure du demarchage
 * reel), une grille de frais de depart, et un compte administrateur.
 */
import { PrismaClient, MarketCode, PartnerType, AssetClass, UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  // ------------------------------------------------------------- Marches
  const bvmac = await prisma.market.upsert({
    where: { code: MarketCode.BVMAC },
    create: {
      code: MarketCode.BVMAC,
      name: 'Bourse des Valeurs Mobilieres de l’Afrique Centrale',
      zone: 'Zone CEMAC',
      currency: 'XAF',
      regulator: 'COSUMAF',
      status: 'SIMULATED_ONLY',
    },
    update: {},
  });

  const brvm = await prisma.market.upsert({
    where: { code: MarketCode.BRVM },
    create: {
      code: MarketCode.BRVM,
      name: 'Bourse Regionale des Valeurs Mobilieres',
      zone: 'Zone UEMOA',
      currency: 'XOF',
      regulator: 'CREPMF',
      status: 'SIMULATED_ONLY',
    },
    update: {},
  });

  const intl = await prisma.market.upsert({
    where: { code: MarketCode.INTL },
    create: {
      code: MarketCode.INTL,
      name: 'Marches internationaux (selection)',
      zone: 'International',
      currency: 'USD',
      regulator: 'N/A pour la v1.0',
      status: 'SIMULATED_ONLY',
      openingHoursNote: 'Cours fournis par Twelve Data - hors execution d’ordres reels.',
    },
    update: {},
  });

  // ------------------------ Partenaires boursiers (pipeline de demarchage)
  // Reference : Guide ALKE-BOURSE-2026-001 section 6 (BVMAC) et
  // ALKE-BOURSE-2026-002 section 7.2 (BRVM, participants AELP).
  const bvmacPartners = [
    { name: 'EDC Investment Corporation', contactName: 'Departement Corporate / Institutionnels', notes: 'Filiale boursiere du groupe Ecobank, Douala. Agreee COSUMAF (n° MFAC-SB-003/2007). Deja familiere de l’ecosysteme fintech (Ecobank Fintech Challenge). A contacter en priorite.' },
    { name: 'SG Capital Securities Central Africa', notes: 'Adossee a Societe Generale Cameroun. Back-office reputé moderne, ouvert aux partenariats institutionnels.' },
    { name: 'Afriland Bourse & Investissement', notes: 'Acteur local, groupe Afriland First Bank. Forte activite sur les actions, agilite commerciale.' },
    { name: 'CBC Bourse', notes: 'Adossee a Commercial Bank of Cameroon. Acteur local bien implante.' },
    { name: 'ESS Bourse (Emrald Securities Services)', notes: 'Un des plus gros portefeuilles geres sur la zone.' },
    { name: 'Digicapital Bourse', notes: 'Acteur plus recent, positionnement oriente digitalisation des actifs.' },
    { name: 'Attijari Securities Central Africa (ASCA)', notes: 'Adossee au groupe Attijariwafa Bank.' },
    { name: 'Financia Capital', notes: 'Particulierement active sur le segment obligataire.' },
  ];
  for (const p of bvmacPartners) {
    const existing = await prisma.marketPartner.findFirst({ where: { marketId: bvmac.id, name: p.name } });
    if (!existing) {
      await prisma.marketPartner.create({
        data: { marketId: bvmac.id, type: PartnerType.SDB, name: p.name, contactName: p.contactName, notes: p.notes },
      });
    }
  }

  const brvmPartners = [
    { name: 'BOA Capital Securities', aelp: true, notes: 'Reseau regional Bank of Africa. Participe a l’AELP.' },
    { name: 'Coris Bourse', aelp: true, notes: 'Groupe Coris Bank International. Participe a l’AELP.' },
    { name: 'CGF Bourse', aelp: true, notes: 'Senegal. Premier SGI agree CREPMF historiquement. Participe a l’AELP.' },
    { name: 'FGI Bourse', aelp: true, notes: 'Senegal. A realise une operation de trading en direct avec la Bourse de Nairobi lors du lancement de l’AELP.' },
    { name: 'Societe Generale Capital Securities (SGCS) Bourse', aelp: true, notes: 'Reseau Societe Generale. Coherence possible avec le partenariat SG cote CEMAC.' },
  ];
  for (const p of brvmPartners) {
    const existing = await prisma.marketPartner.findFirst({ where: { marketId: brvm.id, name: p.name } });
    if (!existing) {
      await prisma.marketPartner.create({
        data: { marketId: brvm.id, type: PartnerType.SGI, name: p.name, aelpParticipant: p.aelp, notes: p.notes },
      });
    }
  }

  // ---------------------------------------------------------- Grille de frais
  const existingFee = await prisma.feeSchedule.findFirst({ where: { marketId: null, feeType: 'BROKERAGE' } });
  if (!existingFee) {
    await prisma.feeSchedule.create({
      data: { feeType: 'BROKERAGE', isPercentage: true, value: 1.5, label: 'Frais de courtage par defaut (a confirmer par marche)' },
    });
  }
  const existingFx = await prisma.feeSchedule.findFirst({ where: { marketId: null, feeType: 'FX_SPREAD' } });
  if (!existingFx) {
    await prisma.feeSchedule.create({
      data: { feeType: 'FX_SPREAD', isPercentage: true, value: 0.5, label: 'Spread de change par defaut' },
    });
  }

  // ----------------------------------------------------- Catalogue (demo)
  const seedInstruments = [
    { market: bvmac, symbol: 'SAFACAM', name: 'Societe Africaine Forestiere et Agricole du Cameroun', sector: 'Agro-industrie', price: 24500 },
    { market: bvmac, symbol: 'SOCAPALM', name: 'Societe Camerounaise de Palmeraies', sector: 'Agro-industrie', price: 4100 },
    { market: brvm, symbol: 'SNTS', name: 'Sonatel Senegal', sector: 'Telecommunications', price: 15200 },
    { market: brvm, symbol: 'ETIT', name: 'Ecobank Transnational Incorporated', sector: 'Banque', price: 22 },
    { market: brvm, symbol: 'ORAC', name: 'Orange Cote d’Ivoire', sector: 'Telecommunications', price: 8400 },
  ];
  for (const s of seedInstruments) {
    const existing = await prisma.instrument.findUnique({ where: { marketId_symbol: { marketId: s.market.id, symbol: s.symbol } } });
    if (!existing) {
      await prisma.instrument.create({
        data: {
          marketId: s.market.id,
          symbol: s.symbol,
          name: s.name,
          assetClass: AssetClass.STOCK,
          sector: s.sector,
          currency: s.market.currency,
          lastPrice: s.price,
          previousClose: s.price,
        },
      });
    }
  }

  // -------------------------------------------------------------- Admin
  const adminEmail = 'admin@alke.finance';
  const existingAdmin = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (!existingAdmin) {
    await prisma.user.create({
      data: {
        fullName: 'Administrateur AlKÉ',
        email: adminEmail,
        phone: '+225000000000',
        country: 'CIV',
        displayCurrency: 'XOF',
        role: UserRole.ADMIN,
        kycStatus: 'VERIFIED',
        passwordHash: await bcrypt.hash('ChangeMe!2026', 10),
        referralCode: 'ALKEADMIN',
        accounts: { create: { currency: 'XOF' } },
        notificationPref: { create: {} },
      },
    });
    console.log('Compte admin cree : admin@alke.finance / ChangeMe!2026 (a changer immediatement)');
  }

  console.log('Seed termine.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
