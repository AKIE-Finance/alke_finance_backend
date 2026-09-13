# AlKÉ Finance — Infrastructure

Implements blueprint v3.2 §4.1 (environments, secrets, flags), §4.10 (controls),
§4.20 (DR runbook), §4.21 (observability) and decision D16 (data location).
Status on 2026-09-04: authored and reviewed, **not yet applied**. Neither
`terraform` nor the AWS CLI was available on the authoring machine, so run
`terraform init && terraform validate` first and expect to pin module versions.

## Layout

| Path | What |
|---|---|
| `../Dockerfile`, `../docker-entrypoint.sh` | Production API image. `RUN_MIGRATIONS=true` runs `prisma migrate deploy`; `MIGRATE_ONLY=true` exits afterwards (one-off ECS task). |
| `../docker-compose.yml` | Local Postgres 16 + Redis 7 on ports 55432 / 55380. `--profile api` adds the API from the production image. |
| `../.github/workflows/ci.yml` | Schema validation, type-check, migrations on a clean DB, schema/migration drift check, seed, tests, image build. Deploys staging from `main` when `AWS_DEPLOY_ROLE_ARN` is set. |
| `terraform/` | One stack per environment: VPC, RDS PostgreSQL 16, ElastiCache Redis 7, ECS Fargate + ALB, ECR, Secrets Manager, documents storage, alarms, GitHub OIDC role. |
| `../src/config/env.validation.ts` | Boot-time guard: no demo OTP outside local, no simulated payments or KYC on pilot/production, real JWT secret, explicit CORS. |
| `../src/health/` | `GET /health` (liveness) and `GET /health/ready` (database) for ALB, container and uptime checks. |

## Environments

| Env | Purpose | Money | Flags enforced by the API | Data |
|---|---|---|---|---|
| local | developer machine, docker-compose | none | `OTP_DEMO_MODE` allowed; `PAYMENTS_MODE=simulated` | seed fixtures |
| staging | QA, SDB file-exchange tests, store-review builds | sandbox keys | demo OTP refused; payments `sandbox` | synthetic users; documents may stay in `af-south-1` |
| pilot | 50–200 invited users, caps from `config_values` | real | `PAYMENTS_MODE=live`, `KYC_MODE=smileid` required; `simulated` refused | real; documents per D16 |
| production | public | real | as pilot | real; documents per D16 |

Region: `af-south-1` (Cape Town) for compute, RDS and Redis. Latency from Douala
is acceptable; Render was dropped because it has no African region.

### Personal data location (D16, counsel question Q4)

Law No. 2024/017 (Cameroon, 23 Dec 2024) art. 19 requires prior authorisation of
the Data Protection Authority for any transfer of personal data abroad, and South
Africa is abroad. The stack therefore treats identity documents as a pluggable
store:

- `documents_backend = "s3"`: KMS-encrypted, versioned, private bucket in
  `aws_region`. Fine for staging (synthetic data). For pilot/production only with
  a written authorisation on file.
- `documents_backend = "external"`: S3-compatible endpoint hosted in Cameroon
  (Uptime-certified Tier III facilities exist in Douala and Yaoundé). The API
  reads `DOCUMENTS_ENDPOINT` / `DOCUMENTS_BUCKET` / `DOCUMENTS_REGION`; access
  keys go into Secrets Manager as `<env>/DOCUMENTS_ACCESS_KEY` and
  `<env>/DOCUMENTS_SECRET_KEY` and are wired into the task definition when the
  storage module lands in the API (blueprint S4).

The operational database also holds personal data (names, phones, e-mails, KYC
status). If counsel concludes that the whole database must be in-country, the
answer is a Cameroon-hosted PostgreSQL with the same schema and a VPN/peering to
the ECS tasks; that variant is deliberately not modelled here until Q4 is answered.

## Secrets

- Never in git, `.env` files on servers, chat, tickets or the mobile binary.
- Terraform creates `alke-<env>/DATABASE_URL` and `alke-<env>/JWT_SECRET` with
  generated values, plus empty entries for every provider key. The sponsor fills
  provider entries from the provider portals:
  `aws secretsmanager put-secret-value --secret-id alke-pilot/CINETPAY_API_KEY --secret-string '...'`.
- Rotation: `JWT_SECRET` rotation logs every user out; do it in a maintenance
  window, then `aws ecs update-service --force-new-deployment`. Database
  password rotation: change `random_password.db` keepers, apply, roll the service.
- GitHub deploys assume an OIDC role scoped to `refs/heads/main` of the backend
  repo. No long-lived AWS keys exist anywhere.

## Deploy flow

1. Merge to `main` → CI checks → image built → pushed to ECR as `<sha>` and `staging`.
2. CI runs a one-off ECS task from the current task definition with
   `RUN_MIGRATIONS=true MIGRATE_ONLY=true`, waits for exit code 0.
3. CI forces a new deployment of the staging service and waits until stable.
4. Pilot and production are promoted by hand: retag the tested SHA
   (`pilot` / `production`), set `api_image_tag`, `terraform apply`, then repeat
   steps 2–3 manually. Two people approve (maker-checker, blueprint §4.17).

Rollback: set `api_image_tag` to the previous SHA and apply, or
`aws ecs update-service --task-definition <previous revision>`. Migrations are
forward-only; a rollback that needs a schema change is a new migration.

## Backups and restore drill (blueprint §4.20, S3 and S9)

- RDS automated snapshots daily at 02:00 Douala with point-in-time recovery;
  retention 7 days (staging) / 35 days (pilot, production). Deletion protection
  on real-money environments.
- Redis holds no balances (blueprint §4.4), so its loss costs rate-limit state
  and OTP counters only.
- Documents bucket: versioned, non-current versions kept 90 days.
- **Restore drill** (first in S3, then quarterly, target < 1 h):
  1. `aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier alke-staging --target-db-instance-identifier alke-staging-drill --restore-time <ISO>`.
  2. Point a throwaway task at the restored endpoint (`DATABASE_URL` override), run `prisma migrate status`, `SELECT count(*) FROM "User"`, and the ledger balance check once the ledger module exists.
  3. Record start/end time and any gap in `docs/runbooks/restore-drill-<date>.md`; delete the drill instance.

## Incident runbook (one page)

| Symptom | First check | Action |
|---|---|---|
| ALB 5xx alarm | `/health/ready` on a task; CloudWatch logs for the service | If DB down: RDS events; if bad deploy: rollback (above) |
| Unhealthy targets | Task stopped reason in ECS console | OOM → raise `api_memory`; crash loop → logs, rollback |
| RDS free storage | `max_allocated_storage` autoscaling headroom | Raise the ceiling; check for runaway audit/log tables |
| Order batch stuck (no ACK by cut-off + 1h) | Batch state in back-office; SFTP receipt | Phone the SDB desk; mark batch per §4.5 reconciliation rules |
| Payment provider outage | Provider status page; `payment_intents` stuck PENDING | Intents expire at 15 min; late confirmations are matched by reference |
| Suspected secret leak | Secrets Manager access logs (CloudTrail) | Rotate the secret, force new deployment, open a compliance case |

Escalation: developer on call → sponsor → SDB operations contact (convention annex).

## Observability (blueprint §4.21)

- Technical: CloudWatch Container Insights, ALB and RDS alarms → SNS e-mail
  (`alert_emails`). Sentry for application errors (`SENTRY_DSN` secret).
- Business/financial: the API emits `MirrorMismatchXAF`, `AckLatencyMinutes`,
  `OldestPendingPayoutHours` and `ReconciliationExceptions` as CloudWatch custom
  metrics from the scheduled reconciliation job; alarms on them reuse the same
  topic. Thresholds live in `config_values`, not here.
- Logs: 30 days on staging, 365 days on real-money environments. VPC flow logs
  and ALB access logs are kept as audit evidence for the CIF dossier.

## Cost (indicative, af-south-1, per month)

| Env | Main lines | Estimate |
|---|---|---|
| staging | t4g.small RDS, t4g.micro Redis, 1 Fargate task, 1 NAT, ALB | ~USD 150–220 |
| pilot | t4g.medium RDS multi-AZ off, 2 Fargate tasks, 2 NAT, ALB, Redis ×1 | ~USD 350–500 |
| production | m6g.large RDS multi-AZ, 2+ tasks, Redis ×2 | ~USD 700–1,100 |

Cameroon-resident document storage is priced separately by the provider.
