# AlKÉ Finance — Backend

API backend (NestJS + Prisma + PostgreSQL) pour AlKÉ Finance. Couvre l'ensemble
des modules du CDC (ALKE-CDC-2026-001) qui ne nécessitent pas de compte
externe : authentification, KYC (workflow + validation manuelle), wallet
(dépôt/retrait simulés + conversion FX réelle), catalogue multi-marché
(BVMAC/BRVM/international), moteur d'ordres multi-marché avec résolution
automatique de partenaire (SDB/SGI), pipeline de démarchage des partenaires
boursiers, back-office complet (Module 9), support client, parrainage,
abonnement AlKÉ Pro, préférences de notification, journal d'audit.

## Démarrage rapide

```bash
docker compose up -d          # PostgreSQL (port 55432) + Redis (port 55380)
cp .env.example .env          # APP_ENV=local, OTP démo activé, paiements simulés
pnpm install                  # pnpm est le gestionnaire déclaré (package.json "packageManager")
pnpm prisma migrate dev       # crée le schéma
pnpm seed                     # marchés, partenaires, frais, admin (ADMIN_SEED_EMAIL / ADMIN_SEED_PASSWORD du .env)
pnpm start:dev                # http://localhost:3000  (docs Swagger : /docs, santé : /health, /health/ready)
```

Ou tout-en-un depuis l'image de production : `docker compose --profile api up --build`.

L'administrateur de démo est créé à partir de `ADMIN_SEED_EMAIL` /
`ADMIN_SEED_PASSWORD` (voir `.env.example`) ; le seed refuse de créer un admin
en production sans `SEED_ADMIN_IN_PROD=true`. Les variables d'environnement sont
validées au démarrage (`src/config/env.validation.ts`) : hors `APP_ENV=local`,
le mode OTP démo est refusé, `JWT_SECRET` doit faire au moins 32 caractères et
`CORS_ORIGINS` est obligatoire.

## Infrastructure

- `Dockerfile` : image de production (Node 24, pnpm, Prisma). La même image
  exécute les migrations avec `RUN_MIGRATIONS=true` (tâche ECS ponctuelle).
- `.github/workflows/ci.yml` : validation du schéma, compilation, application
  des migrations sur une base vierge, contrôle de dérive schéma/migrations,
  seed, tests, construction de l'image ; déploiement staging sur `main` si le
  rôle AWS OIDC est configuré.
- `infra/terraform` : VPC, RDS PostgreSQL 16, ElastiCache Redis, ECS Fargate +
  ALB, ECR, Secrets Manager, stockage privé des pièces d'identité, alarmes.
  Région et localisation des données personnelles selon le blueprint v3.2 (D16).
- `infra/README.md` : environnements, secrets, sauvegardes, procédure de
  restauration, runbook d'incident, observabilité.

## Pourquoi les ports 55432/55380 ?

Cette machine avait déjà des instances PostgreSQL natives occupant les ports
5432/5433 (pour d'autres projets). Le `docker-compose.yml` utilise donc des
ports distinctifs pour éviter tout conflit silencieux. Si vous déployez sur
un autre environnement, vous pouvez revenir à 5432/6379 sans problème.

## Principe de repli automatique

Comme dans l'application mobile, chaque intégration externe (paiement, KYC,
SMS/e-mail, données de marché BVMAC/BRVM, exécution d'ordres) fonctionne en
mode simulé tant qu'aucune clé/partenaire réel n'est configuré :

- **OTP** : code fixe `123456` en mode démo (`OTP_DEMO_MODE=true`), renvoyé
  dans la réponse API (`debugCode`).
- **Dépôts/retraits** : complétés instantanément en mode démo au lieu
  d'attendre un webhook réel de MTN MoMo/Orange Money/CinetPay.
- **Moteur d'ordres** : un ordre est exécuté immédiatement en simulation
  (Palier 0) tant qu'aucun `MarketPartner` du marché concerné n'est passé en
  statut `ACTIVE` côté back-office. Dès qu'un partenaire devient `ACTIVE`,
  le marché bascule en `LIVE` et les nouveaux ordres passent automatiquement
  en `TRANSMITTED`, en attente de rapprochement manuel (Module 9.3) — voir
  `orders.service.ts`.
- **Taux de change (FX)** : seule intégration déjà réellement branchée sans
  clé (open.er-api.com), comme côté application mobile.

## Structure

```
prisma/schema.prisma   # schéma complet (30+ modèles)
prisma/seed.ts         # marchés, short-list de partenaires (guides bourse), frais, admin
src/modules/
  auth/       # inscription, connexion, OTP, JWT
  kyc/        # soumission + validation manuelle
  markets/    # marchés, partenaires (pipeline SDB/SGI), catalogue, cotations
  wallet/     # comptes, dépôts/retraits, conversion FX
  orders/     # moteur d'ordres multi-marché, positions, versements programmés
  fees/       # grille tarifaire
  portfolio/  # tableau de bord consolidé
  users/      # gestion des utilisateurs (back-office)
  profile/    # portefeuille externe, parrainage, abonnement, notifications
  support/    # tickets
  admin/      # statistiques, journal d'audit
```

## Brancher un vrai fournisseur externe

Chaque intégration est isolée derrière un service dédié
(`OtpService`, `FxRateService`, etc.). Renseigner la clé correspondante dans
`.env` (voir le Guide Backend & Back-office, ALKE-BACKEND-2026-001, section 5)
suffit à activer le comportement réel sans modifier les contrôleurs.
