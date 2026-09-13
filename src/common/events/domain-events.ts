/**
 * Domain events (blueprint §4.14). Emitted in-process by the owning module,
 * consumed by audit (always), notifications, reconciliation and reporting.
 * Every event carries the entity id, the actor, a timestamp and a correlation id.
 */

export const DomainEventNames = [
  'UserRegistered',
  'UserLoggedIn',
  'PasswordReset',
  'KYCSubmitted',
  'KYCAutoApproved',
  'KYCManualReview',
  'KYCValidated',
  'KYCRejected',
  'BrokerAccountRequested',
  'BrokerAccountOpened',
  'DepositCreated',
  'DepositConfirmed',
  'DepositFailed',
  'DepositExpired',
  'WithdrawalRequested',
  'WithdrawalApproved',
  'WithdrawalPaid',
  'WithdrawalFailed',
  'OrderCreated',
  'OrderCancelled',
  'OrderTransmitted',
  'OrderAcknowledged',
  'OrderRejected',
  'OrderPartiallyExecuted',
  'OrderExecuted',
  'OrderExpired',
  'OrderAdjusted',
  'BatchBuilt',
  'BatchSent',
  'BatchAcknowledged',
  'BatchProcessed',
  'SettlementStarted',
  'SettlementConfirmed',
  'SettlementFailed',
  'LedgerTxnPosted',
  'LedgerReversalPosted',
  'FeeCharged',
  'ReconciliationMismatchDetected',
  'ReconciliationResolved',
  'ComplianceAlertRaised',
  'ComplianceCaseOpened',
  'ApprovalRequested',
  'ApprovalDecided',
  'ApprovalExecuted',
  'ConfigChanged',
  'MarketLiveTradingChanged',
  'StatementGenerated',
] as const;

export type DomainEventName = (typeof DomainEventNames)[number];

export interface DomainEvent<TPayload = Record<string, unknown>> {
  name: DomainEventName;
  /** Entity the event is about (order id, intent id, user id…). */
  entityType: string;
  entityId: string;
  /** User id of the actor, or a system actor such as "SYSTEM", "SDB_FILE", "PROVIDER:MTN_MOMO". */
  actor: string;
  /** Ties together everything caused by one request, webhook or job run. */
  correlationId: string;
  occurredAt: Date;
  payload: TPayload;
}

export type DomainEventHandler = (event: DomainEvent) => Promise<void> | void;
