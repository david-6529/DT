// Types shared between backend and web. Wire format uses strings for bigints.

/** Risk classification for an owned token. */
export type TokenRisk = "safe" | "delinquent" | "audited" | "at-risk" | "dead";

/** Status of a Citizen token the wallet owns. */
export interface OwnedTokenStatus {
  tokenId: string;
  lastEpochPaid: string;
  currentEpoch: string;
  /** 0 if not under audit; otherwise the unix timestamp after which it can be killed. */
  auditDueTimestamp: string;
  /** Seconds until the active audit expires (kill becomes possible). Null if not audited. */
  secondsUntilKillable: number | null;
  bribeBalance: string;
  hasLifeInsurance: boolean;
  risk: TokenRisk;
  /** Estimated wei to pay to become current / clear an audit (1 epoch). */
  estimatedPayWei: string;
}

/** A token owned by someone else that the bot could audit or kill. */
export interface TargetTokenStatus {
  tokenId: string;
  owner: string;
  lastEpochPaid: string;
  /** True if at least 1 epoch behind (includes auditable). */
  delinquent: boolean;
  /** How many epochs behind the current epoch. */
  epochsBehind: number;
  /** True if delinquent enough to be audited right now (2+ epochs behind). */
  auditable: boolean;
  /** 0 if not under audit; else unix ts after which kill() succeeds. */
  auditDueTimestamp: string;
  /** True if under audit and already expired -> kill() will succeed now. */
  killable: boolean;
}

export type ActivityKind =
  | "pay-taxes"
  | "use-bribe"
  | "audit"
  | "kill"
  | "info"
  | "error";

export type ActivityStatus =
  | "planned"
  | "simulated"
  | "submitted"
  | "included"
  | "reverted"
  | "skipped"
  | "dry-run"
  | "info";

export interface ActivityEntry {
  id: string;
  ts: number;
  kind: ActivityKind;
  status: ActivityStatus;
  tokenId?: string;
  targetTokenId?: string;
  txHash?: string;
  bundleHash?: string;
  targetBlock?: string;
  valueWei?: string;
  gasWei?: string;
  message: string;
}

export interface StrategyConfig {
  /** Master switch: when false, the engine observes but never submits. */
  enabled: boolean;
  /** Simulate/plan only; never actually send. Defaults true on first run. */
  dryRun: boolean;

  // --- Defense ---
  /** Clear an audit when it will expire within this many seconds. */
  auditSafetyBufferSeconds: number;
  /** Proactively pay before becoming delinquent (don't wait to be audited). */
  proactivePay: boolean;
  /** Epochs to prepay per payTaxes call (1-7) to lock the current rate. */
  prepayEpochs: number;
  /** Spend a held bribe to clear an audit (free, but consumes the bribe and leaves
   *  the token still delinquent). OFF by default — the bot pays taxes to clear
   *  instead, so bribes are never auto-consumed unless you opt in. */
  autoUseBribe: boolean;
  /** Global cap on how many epochs a single AUTOMATIC payment may cover. On-chain,
   *  payTaxes(tokenId, n) costs n * currentEpoch * base and advances the token n
   *  epochs — so this caps the ETH spent per auto payment. Applies to proactive-pay
   *  and defense (which would otherwise pay `prepayEpochs`); JIT and the pre-boundary
   *  race always pay exactly one epoch and are never blocked, so the single-epoch
   *  payment for the upcoming epoch still fires even when a citizen is momentarily
   *  2 behind. Default 1 = auto-payments never spend more than one day's taxes at
   *  once; a lost/failed payment never balloons into a multi-day charge. Raise it to
   *  let proactive-pay / defense auto-catch-up multiple epochs in one payment. */
  maxAutoPayEpochs: number;

  // --- Just-in-time single-epoch payment (one-shot) ---
  /** When armed, pay exactly one epoch for each selected token the moment the
   *  target epoch begins on-chain, then auto-disarm. */
  jitEnabled: boolean;
  /** The epoch to pay for. Set when arming (usually currentEpoch + 1). */
  jitTargetEpoch: number | null;
  /** Specific tokenIds to cover; empty = all owned citizens. */
  jitTokenIds: string[];
  /** ADVANCED: pre-submit needed proactive-defense payments, plus any armed JIT
   *  payment, ~preBoundaryLeadMs before the target epoch boundary. The value is
   *  computed off-chain for the upcoming epoch and validated by simulating at the
   *  boundary timestamp. A normal on-chain-estimate tick remains the fallback. */
  preBoundaryPay: boolean;
  /** How many ms before the target boundary to build and simulate the transaction
   *  in public/local mode (250–8000). Broadcast waits for the boundary timestamp. */
  preBoundaryLeadMs: number;
  /** Lead used in `mainnet` (bundle) mode (250–11000). The bundle carries a
   *  boundary minTimestamp and its public fallback waits for that timestamp.
   *  Keep the lead under one 12s slot. */
  preBoundaryLeadMainnetMs: number;

  // --- Offense (optional) ---
  offenseEnabled: boolean;
  /** Automatically audit delinquent rival tokens. */
  autoAudit: boolean;
  /** Automatically kill tokens whose audit has expired. */
  autoKill: boolean;
  /** Only run offense once citizen supply is within this many of WINNERS. */
  endgameOnlyWithin: number | null;
  /** Specific rival token IDs to target. Empty array = target any delinquent rival. */
  offenseTargetTokenIds: string[];
  /** ADVANCED: pre-submit audits ~preBoundaryLeadMs before the epoch boundary so
   *  they land in the FIRST block of the epoch (auditing rivals the instant they
   *  become delinquent, like a batch-auditor) instead of the block after.
   *  Unsimulated; a mis-timed audit reverts (gas only — the fee is refunded). */
  preBoundaryAudit: boolean;
  /** ADVANCED: pre-submit kills ~preBoundaryLeadMs before a target's audit-expiry
   *  so the kill lands in the first eligible block. Unsimulated; a too-early kill
   *  reverts (gas only). */
  preBoundaryKill: boolean;

  // --- Guardrails ---
  /** Max base fee (gwei) the bot will transact at. Applies to tax payments
   *  (defense) and, unless `separateOffenseGas` is on, to audit/kill too. */
  maxBaseFeeGwei: number;
  /** Priority fee (gwei) to include on bundles. Applies to tax payments
   *  (defense) and, unless `separateOffenseGas` is on, to audit/kill too. */
  priorityFeeGwei: number;
  /** Never spend below this wallet balance (ether). */
  minBalanceEth: number;

  // --- Offense gas override (audit / kill) ---
  /** When true, audit/kill use the `offense*` gas fields below instead of the
   *  shared `maxBaseFeeGwei`/`priorityFeeGwei`/`dynamicTip*` settings. Lets you
   *  bid more aggressively to win offense races without overpaying on the
   *  (non-competitive) tax payments. When false, audit/kill inherit the base
   *  settings — identical to the pre-split behavior. */
  separateOffenseGas: boolean;
  /** Max base fee (gwei) for audit/kill. Used only when separateOffenseGas. */
  offenseMaxBaseFeeGwei: number;
  /** Priority fee (gwei) for audit/kill. Used only when separateOffenseGas. */
  offensePriorityFeeGwei: number;
  /** Dynamic-tip toggle for audit/kill. Used only when separateOffenseGas. */
  offenseDynamicTipEnabled: boolean;
  /** Dynamic-tip ceiling (gwei) for audit/kill. Used only when separateOffenseGas. */
  offenseDynamicTipMaxGwei: number;

  // --- Latency (mainnet mode only) ---
  /** Fire an extra tick just before each offense deadline (nearest audit
   *  expiry / next epoch boundary) so kills/audits compete in the first
   *  eligible block instead of the block after. */
  offenseBoundaryScheduling: boolean;
  /** Also broadcast time-critical offense txs to the public mempool alongside
   *  the Flashbots bundle, so any builder can include them in the next block.
   *  Trades bundle privacy for lower inclusion latency. Defense/JIT overrides
   *  this to true so a private offense nonce cannot fence a survival payment. */
  racePublicMempool: boolean;
  /** Scale the priority-fee tip up as the latest block fills, so we stay
   *  competitive for inclusion in contested blocks. When off, the static
   *  priorityFeeGwei is always used. */
  dynamicTipEnabled: boolean;
  /** Upper bound (gwei) the dynamic tip may scale to at a 100%-full block.
   *  Ignored when dynamicTipEnabled is false. */
  dynamicTipMaxGwei: number;

  /** Hard cap (ETH) on the value of any single transaction (payments in
   *  particular). A tx whose value exceeds this is skipped, not sent — a
   *  backstop against a bad estimate or many-epoch debt draining the wallet.
   *  0 disables the cap. */
  maxPaymentEth: number;
}

/** One transaction resolved on-chain for a race post-mortem. */
export interface PostMortemTx {
  hash: string;
  role: "ours" | "rival";
  found: boolean;
  action: string;
  args: string;
  from: string;
  blockNumber: string | null;
  txIndex: number | null;
  blockTs: number | null;
  baseFeeGwei: number | null;
  /** Effective priority tip actually paid. */
  tipGwei: number | null;
  /** Total effective gas price paid. */
  effectiveGwei: number | null;
  /** True if the tx targeted the game contract. */
  toGame: boolean;
}

/** Win/loss verdict for one of our txs vs one rival tx. */
export interface PostMortemVerdict {
  ourHash: string;
  rivalHash: string;
  ourLabel: string;
  rivalLabel: string;
  sameAction: boolean;
  /** "won" | "lost-timing" | "lost-fee" | "unknown". */
  outcome: "won" | "lost-timing" | "lost-fee" | "unknown";
  detail: string;
}

export interface PostMortemResult {
  txs: PostMortemTx[];
  verdicts: PostMortemVerdict[];
  summary: string;
  gameAddress: string;
  mode: string;
}

export interface BotStatus {
  /** The bot's release version (see VERSION in constants). */
  version: string;
  running: boolean;
  unlocked: boolean;
  dryRun: boolean;
  address: string | null;
  balanceWei: string | null;
  chainId: number | null;
  currentEpoch: string | null;
  gameState: number | null;
  citizenSupply: string | null;
  citizensAddress: string | null;
  lastBlock: string | null;
  spentThisEpochWei: string;
  /** Game start time (unix seconds) — lets the UI compute epoch boundaries. */
  startTime: string | null;
  jitEnabled: boolean;
  jitTargetEpoch: number | null;
  /** True when the Alchemy NFT API (or token overrides) are configured. */
  nftConfigured: boolean;
}
