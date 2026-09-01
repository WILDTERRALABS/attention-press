export { AttentionMeter } from "./AttentionMeter.js";
export type { AttentionMeterDeps } from "./AttentionMeter.js";

export { SessionKey } from "./session/SessionKey.js";
export {
  buildDomain,
  buildTypedData,
  VOUCHER_TYPES,
  VOUCHER_PRIMARY_TYPE,
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  type VoucherMessage,
} from "./session/voucher.js";
export { computeCumulative, isBudgetExhausted } from "./session/accrual.js";

export { EngagementTracker } from "./engagement/EngagementTracker.js";
export type { EngagementChange, EngagementTrackerOptions } from "./engagement/EngagementTracker.js";
export { IdleDetector } from "./engagement/idle.js";

export { attentionStreamAbi, erc20Abi } from "./chain/abi.js";
export { openSession, type OpenSessionParams, type OpenSessionResult, type OpenSessionFn } from "./chain/openSession.js";
export { closeSession, type CloseSessionParams, type CloseSessionFn } from "./chain/closeSession.js";

export type {
  AttentionMeterConfig,
  Eip1193Provider,
  VoucherRecord,
  MeterEventMap,
  MeterEventName,
  MeterState,
  PauseReason,
  EndReason,
  SessionKeyStorage,
} from "./types.js";
