import { PendingApproval, Prisma } from '@prisma/client';

/**
 * Maker-checker contract (blueprint §4.17). Implemented by ApprovalsService;
 * any module that owns a sensitive action registers an executor for its
 * action type and calls `request` instead of performing the action directly.
 *
 * Rules the implementation enforces:
 *  - the checker must be a different user from the maker;
 *  - the checker must hold ADMIN or COMPLIANCE role;
 *  - on approval the registered executor runs; success → EXECUTED, failure → FAILED with the error;
 *  - every transition writes an audit entry.
 */

export const APPROVAL_ACTIONS = [
  'LIVE_TRADING_TOGGLE',
  'LEDGER_ADJUST',
  'LEDGER_REVERSAL',
  'WITHDRAWAL_OVERRIDE',
  'FEE_CHANGE',
  'INSTRUMENT_ACTIVATION',
  'USER_UNBLOCK',
  'COMPLIANCE_DECISION',
  'RECON_WRITE_OFF',
  'ORDER_REVIEW',
  'CONFIG_CHANGE',
  'PAYMENT_FORCE_COMPLETE',
] as const;
export type ApprovalActionType = (typeof APPROVAL_ACTIONS)[number];

export interface ApprovalRequestInput {
  actionType: ApprovalActionType;
  entityType?: string;
  entityId?: string;
  payload: Prisma.InputJsonValue;
  reason: string;
  makerId: string;
}

export type ApprovalExecutor = (approval: PendingApproval) => Promise<unknown>;

export interface ApprovalsPort {
  /** Registers the function that performs the action once a checker approves. One executor per action type. */
  registerExecutor(actionType: ApprovalActionType, executor: ApprovalExecutor): void;
  request(input: ApprovalRequestInput): Promise<PendingApproval>;
  approve(approvalId: string, checkerId: string, note?: string): Promise<PendingApproval>;
  reject(approvalId: string, checkerId: string, note: string): Promise<PendingApproval>;
  listPending(actionType?: ApprovalActionType): Promise<PendingApproval[]>;
}

export const APPROVALS_PORT = Symbol('APPROVALS_PORT');
