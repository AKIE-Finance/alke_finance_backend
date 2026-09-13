# AlKÉ Finance API — architecture (blueprint v3.2 §4.12)

NestJS modulith. Each module owns its tables and talks to others through
explicit service calls or the in-process `EventBus`; no module reads or writes
another module's tables directly.

## Module ownership

| Module (`src/modules/…`) | Owns (Prisma models) | Contract other modules use |
|---|---|---|
| `auth` | User (auth fields), Session, OtpCode, UserDevice | `JwtAuthGuard`, `@CurrentUser()`, `TokenVersion` check |
| `kyc` | KycSubmission, User.kycStatus/kycResubmissions | `KycService.isTradingAllowed(userId)` |
| `markets` | Market, MarketPartner, Instrument, InstrumentQuote, MarketDataIngestionLog, WatchlistItem, BrokerAccount | `MarketsService`, `BrokerAccountsService` |
| `ledger` | LedgerAccount, LedgerTxn, LedgerEntry | `LedgerPort` (`ledger.types.ts`) — the only way money moves |
| `payments` | PaymentIntent | `PaymentsService`, provider adapters (`PaymentProviderPort`) |
| `brokerage` | Order, OrderBatch, Execution, Position, RecurringPlan | `OrdersService`, `IOrderConnector` (simulated, file) |
| `reconciliation` | ReconciliationItem | daily job, exception queue |
| `fees` | FeeSchedule | `FeesService.compute(...)` returns ledger lines per fee code |
| `config` | ConfigValue | `ConfigValuesService.get<T>(key)` |
| `approvals` | PendingApproval | `ApprovalsPort` (`approvals.types.ts`) |
| `compliance` | ComplianceAlert/Case/Note/Decision | `ComplianceService.raiseAlert(...)` |
| `notifications` | Notification, NotificationLog, NotificationPreference | subscribes to events |
| `portfolio` | (reads ledger + positions) | — |
| `support`, `profile`, `users`, `admin` | as before | — |
| `common/audit` | AuditLog (hash-chained) | `AuditService.log(...)`, subscribes to `*` events |

## Rules

1. **Money**: `Prisma.Decimal` everywhere (`src/common/money.ts`). Balances are
   `SUM(LedgerEntry.amount)`; nothing else stores a balance.
2. **Ledger writes** go through `LedgerPort.post` with an idempotency key
   derived from the trigger (`deposit:<intentId>`, `reserve:<orderId>`,
   `fill:<executionId>`, `csh:<ref>`). Corrections are `reverse()`.
3. **Simulated vs real** is decided by `market.liveTrading && SDB_CONNECTOR !== simulated`.
   Simulated orders never touch the ledger (`Order.simulated = true`) and are
   refused unless the caller is flagged as a demo user (`DEMO_USERS` config) —
   pilot users cannot place simulated orders (blueprint D15).
4. **Sensitive admin actions** go through `ApprovalsPort.request`; the executor
   registered by the owning module performs the change after a second approver.
5. **Events**: emit after the transaction commits. Audit subscribes to every
   event; notifications subscribe to the user-facing subset.
6. **Guards**: `canTrade`, `canPlaceOrder`, `canWithdraw`, `canOpenBrokerAccount`
   live in `src/modules/policy/policy.service.ts` and are the single place a
   business eligibility rule changes (blueprint §4.13).
7. **Errors**: throw Nest HTTP exceptions with French user-facing messages, as
   the existing code does; never leak Prisma errors.
