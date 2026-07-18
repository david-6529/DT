import { parseEther, formatEther, type Address, type Hex } from "viem";
import { AUDIT_COST_WEI, WINNERS, EPOCH_DURATION_SECONDS, BASE_TAX_RATE_WEI } from "@dat-bot/shared";
import { publicClient, wsClient, getLatestBlockCached } from "./chain.js";
import { appConfig } from "./config.js";
import { runtime } from "./runtime.js";
import { activity } from "./activity.js";
import { nonceManager } from "./nonce.js";
import {
  getGameSnapshot,
  batchGetOwnedStatuses,
  batchGetTargetStatuses,
  filterLiveTokenIds,
  encodePayTaxes,
  encodeAudit,
  encodeKill,
  encodeUseBribe,
  gameContract,
} from "./contract.js";
import {
  fetchOwnedTokenIds,
  fetchCandidateTokenIds,
  ownershipIndexingAvailable,
} from "./index-tokens.js";
import {
  submitTx,
  beginBundle,
  flushBundle,
  discardBundle,
  waitForBundleFallbacks,
  type TxIntent,
  type SubmitResult,
} from "./flashbots.js";
import { resolveGas, effectiveTipGwei, cappedReplacementFees, canAffordSpend, isEligibleAuditor, isAuditable, preBoundaryTaxWei, cappedAutoPayEpochs, orderBySalt } from "./logic.js";
import { logger } from "./logger.js";

const TICK_MS = 12_000; // fallback poll interval when WebSocket unavailable
const GAS_GUESS = 200_000n; // for pre-flight spend-cap checks only

let timer: NodeJS.Timeout | null = null;
let boundaryTimer: NodeJS.Timeout | null = null;
let offenseBoundaryTimer: NodeJS.Timeout | null = null;
let preBoundaryTimer: NodeJS.Timeout | null = null;
let preBoundaryAuditTimer: NodeJS.Timeout | null = null;
let preBoundaryKillTimer: NodeJS.Timeout | null = null;
let unwatchBlocks: (() => void) | null = null;
let ticking = false;
let engineGeneration = 0;
let executingGeneration: number | null = null;
let engineAbortController: AbortController | null = null;
let idleWaiters: Array<() => void> = [];

function executionIsCurrent(generation: number): boolean {
  return runtime.running && generation === engineGeneration;
}

function finishExclusive(generation: number): void {
  if (executingGeneration === generation) executingGeneration = null;
  ticking = false;
  const waiters = idleWaiters;
  idleWaiters = [];
  for (const resolve of waiters) resolve();
  // If a new run started while the old run was winding down, its immediate tick
  // was intentionally blocked by `ticking`; start it now under the new generation.
  if (runtime.running && generation !== engineGeneration) void tick(engineGeneration);
}

export async function waitForEngineIdle(): Promise<void> {
  if (ticking) {
    await new Promise<void>((resolve) => idleWaiters.push(resolve));
  }
  await waitForBundleFallbacks();
}
// Randomized once per engine start (see startEngine) and used to reorder the
// rival sweep (offensePass, firePreBoundaryAudit, firePreBoundaryKill) so every
// bot instance doesn't audit/kill candidates in the same identical order — the
// candidate list order itself is identical for everyone (same indexer, same
// on-chain order), so without this every user piles onto the same first few
// targets and starves the ones later in the list.
let engineSalt = 0;
// Total wei committed to spend so far in the current tick (value + gas of each
// submitted tx). Reset at the top of every tick; consulted by canSpend so the
// min-balance floor holds across all spends in a tick, not just each in isolation.
let committedThisTickWei = 0n;

type PaymentSource = "pre-boundary" | "defense" | "proactive" | "jit";

interface PaymentFlight {
  attemptId: number;
  account: Address;
  tokenId: string;
  expectedLastEpochPaid: bigint;
  nonce: number;
  valueWei: bigint;
  gasWei: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  txHash?: Hex;
  source: PaymentSource;
  /** Target-scoped obligations carried across same-nonce replacements. */
  jitTargetEpoch: number | null;
  proactiveEpoch: bigint | null;
  proactiveMarkerReserved: boolean;
  submittedAtMs: number;
  delivery: "queued" | "submitted" | "included";
}

interface BatchEntry {
  entryId: string;
  nonce: number;
  message: string;
  paymentAttemptId?: number;
  paymentTokenId?: string;
  previousPaymentFlight?: PaymentFlight;
}

// One shared guard covers every tax-payment path. The on-chain lastEpochPaid
// value remains authoritative; this map only prevents a still-pending tx from
// being duplicated by another pass while that value is necessarily stale.
const paymentFlights = new Map<string, PaymentFlight>();
let nextPaymentAttemptId = 0;
let paymentFlightAccount: Address | null = null;

// Activity entries whose tx was queued into the current bundle batch (mainnet).
// flushBatch fills in each one's txHash/bundleHash and reconciles provisional
// payment-flight state once the whole batch has actually been delivered.
let batchEntries: BatchEntry[] = [];
let batchOpenedForMainnet = false;

/** Open a bundle batch for a tick so all its txs go out as one atomic multi-tx
 *  bundle (mainnet only; public/local submit directly, with future-valid races
 *  held until their simulated timestamp). */
function beginBatch(): void {
  batchEntries = [];
  batchOpenedForMainnet = appConfig.mode === "mainnet";
  if (batchOpenedForMainnet) beginBundle();
}

/** Send the tick's queued txs as one bundle and reconcile each activity entry
 *  with its resulting hashes / status. No-op in public/local mode. */
async function flushBatch(): Promise<void> {
  const entries = batchEntries;
  batchEntries = [];
  const wasMainnet = batchOpenedForMainnet;
  batchOpenedForMainnet = false;
  if (!wasMainnet) return;
  if (entries.length === 0) {
    discardBundle("empty batch");
    return;
  }
  let results: Awaited<ReturnType<typeof flushBundle>>;
  try {
    results = await flushBundle();
  } catch (err) {
    logger.error("bundle flush error:", (err as Error).message);
    for (const entry of entries) reconcileFailedBatchEntry(entry, "bundle flush error");
    return;
  }
  for (const entry of entries) {
    const { entryId, nonce } = entry;
    const r = results.get(nonce);
    if (!r || (!r.ok && !r.uncertain)) {
      reconcileFailedBatchEntry(entry, r?.error ?? "bundle was not delivered");
      continue;
    }
    activity.update(entryId, {
      status: "submitted",
      txHash: r.txHash,
      bundleHash: r.bundleHash,
      message: r.uncertain
        ? `${entry.message} — delivery was not acknowledged; retaining the nonce and retrying safely`
        : entry.message,
    });
    const flight = currentBatchPaymentFlight(entry);
    if (flight) {
      flight.delivery = "submitted";
      flight.txHash = r.txHash ?? flight.txHash;
    }
    if (r.txHash) void trackReceipt(entryId, r.txHash, flight);
  }
}

function discardBatch(reason = "engine stopped before bundle submission"): void {
  const entries = batchEntries;
  batchEntries = [];
  const wasMainnet = batchOpenedForMainnet;
  batchOpenedForMainnet = false;
  const results = wasMainnet ? discardBundle(reason) : new Map();
  for (const entry of entries) {
    const error = results.get(entry.nonce)?.error ?? reason;
    reconcileFailedBatchEntry(entry, error);
  }
}

async function flushOrDiscardBatch(generation: number): Promise<void> {
  if (executionIsCurrent(generation)) await flushBatch();
  else discardBatch();
}

function currentBatchPaymentFlight(entry: BatchEntry): PaymentFlight | undefined {
  if (entry.paymentTokenId === undefined || entry.paymentAttemptId === undefined) return undefined;
  const current = paymentFlights.get(entry.paymentTokenId);
  return current?.attemptId === entry.paymentAttemptId ? current : undefined;
}

function clearSourceMarker(flight: PaymentFlight): void {
  if (flight.proactiveMarkerReserved && proactivePaySubmittedEpoch === flight.proactiveEpoch) {
    proactivePaySubmitted.delete(flight.tokenId);
  }
}

function restoreSourceMarker(flight: PaymentFlight): void {
  if (flight.proactiveMarkerReserved && proactivePaySubmittedEpoch === flight.proactiveEpoch) {
    proactivePaySubmitted.add(flight.tokenId);
  }
}

function reconcileFailedBatchEntry(entry: BatchEntry, error: string): void {
  activity.update(entry.entryId, { status: "skipped", message: error });
  const flight = currentBatchPaymentFlight(entry);
  if (!flight) return;
  clearSourceMarker(flight);
  if (entry.previousPaymentFlight) {
    paymentFlights.set(flight.tokenId, entry.previousPaymentFlight);
    restoreSourceMarker(entry.previousPaymentFlight);
  } else {
    paymentFlights.delete(flight.tokenId);
  }
}

// NOTE: the pre-boundary races now simulate at the future boundary/expiry
// timestamp (see submitTx's simTimestamp), so they validate correctly in BOTH
// public mode (eth_call block overrides) and mainnet mode (eth_callBundle's
// timestamp field) — no mode gating needed.

/**
 * How early to pre-submit a boundary race, by submission path.
 *
 * public/local: build and simulate shortly before the boundary, but do not
 *   broadcast until the simulated timestamp so a prior block cannot consume the
 *   nonce with an overpayment revert.
 * mainnet: give builders a little more lead and set minTimestamp on the bundle;
 *   its public mirror is held to the same boundary timestamp. Keep the lead under
 *   a 12s slot so the intended target remains the next block in normal timing.
 */
function effectiveLeadMs(): number {
  const s = runtime.strategy;
  return appConfig.mode === "mainnet" ? s.preBoundaryLeadMainnetMs : s.preBoundaryLeadMs;
}

// A precisely-timed boundary tick (JIT / defense / offense) must not be silently
// dropped just because a routine block/poll tick happens to be running when its
// timer fires — that would push the payment/kill to the next ordinary tick and
// lose the boundary race. If a tick is in flight, retry shortly until it clears.
// Used ONLY for the setTimeout-driven boundary firings; the synchronous
// immediate-fire branches inside the schedulers keep dropping when nested in a
// tick, which is what avoids a re-entrant rerun loop.
const BOUNDARY_RETRY_MS = 250;
function fireBoundaryTick(generation = engineGeneration): void {
  if (!executionIsCurrent(generation)) return;
  if (ticking) {
    setTimeout(() => fireBoundaryTick(generation), BOUNDARY_RETRY_MS);
    return;
  }
  void tick(generation);
}

// Soonest future audit-expiry (kill deadline) seen in the last offense sweep, in
// unix seconds. Null when no rival token is currently under a pending audit.
let nextKillDeadlineSec: bigint | null = null;

// JIT one-shot bookkeeping: tokenIds already submitted for the active target epoch.
let jitSubmitted = new Set<string>();
let jitSubmittedTarget: number | null = null;

export function resetJitState(): void {
  jitSubmitted = new Set();
  jitSubmittedTarget = null;
}

function prepareJitBookkeeping(): void {
  const target = runtime.strategy.jitEnabled ? runtime.strategy.jitTargetEpoch : null;
  if (target !== null && jitSubmittedTarget !== target) {
    jitSubmitted = new Set();
    jitSubmittedTarget = target;
  }
}

// Proactive-pay bookkeeping: at most one successfully delivered automatic
// catch-up payment per token per epoch. The shared flight map handles pending
// deduplication; this cap prevents a deeply-behind Citizen from being drained by
// a new one-epoch payment on every 12-second tick.
let proactivePaySubmittedEpoch: bigint | null = null;
let proactivePaySubmitted = new Set<string>();

/** Clear run-scoped payment state when the wallet identity changes. Exported so
 *  the API/tests can make an explicit identity reset; pausing the engine must not
 *  erase it while transactions may still be pending. */
export function resetPaymentTracking(): void {
  paymentFlights.clear();
  nextPaymentAttemptId = 0;
  proactivePaySubmittedEpoch = null;
  proactivePaySubmitted = new Set();
  paymentFlightAccount = runtime.account?.address ?? null;
}

export function startEngine(): void {
  if (timer || unwatchBlocks) return;
  engineGeneration += 1;
  engineAbortController?.abort();
  engineAbortController = new AbortController();
  const accountAddress = runtime.account?.address ?? null;
  if (paymentFlightAccount !== null && accountAddress !== paymentFlightAccount) {
    resetPaymentTracking();
    resetJitState();
  }
  paymentFlightAccount = accountAddress;
  engineSalt = Math.floor(Math.random() * 0xffffffff);
  runtime.running = true;
  runtime.emitStatus();
  activity.add({ kind: "info", status: "info", message: "Engine started" });
  if (!ownershipIndexingAvailable()) {
    activity.add({
      kind: "info",
      status: "info",
      message:
        "Ownership indexing unavailable — set ALCHEMY_API_KEY (or OWNED_TOKENS/TARGET_TOKENS) so the bot can find your tokens.",
    });
  }

  // Always keep a polling watchdog. WebSocket subscriptions can go quiet after
  // a provider disconnect without delivering another block or error; `ticking`
  // safely coalesces watchdog and block-triggered ticks.
  timer = setInterval(() => void tick(), TICK_MS);
  if (wsClient) {
    // React on every new block (~100-500ms latency vs up to 12s with polling).
    unwatchBlocks = wsClient.watchBlocks({
      onBlock: () => void tick(),
      onError: (err) => logger.warn("Block subscription error:", (err as Error).message),
    });
    activity.add({ kind: "info", status: "info", message: "Block subscription active (WebSocket + 12s polling watchdog)" });
  } else {
    activity.add({ kind: "info", status: "info", message: "Polling every 12s (no WebSocket configured)" });
  }
  void tick();
}

export function stopEngine(): void {
  // Invalidate every in-progress action before clearing timers. HTTP callers
  // await waitForEngineIdle(), so "stopped" is not reported while an old batch
  // can still be flushed afterward.
  engineGeneration += 1;
  engineAbortController?.abort();
  runtime.running = false;
  if (timer) clearInterval(timer);
  if (boundaryTimer) clearTimeout(boundaryTimer);
  if (offenseBoundaryTimer) clearTimeout(offenseBoundaryTimer);
  if (preBoundaryTimer) clearTimeout(preBoundaryTimer);
  if (preBoundaryAuditTimer) clearTimeout(preBoundaryAuditTimer);
  if (preBoundaryKillTimer) clearTimeout(preBoundaryKillTimer);
  if (unwatchBlocks) unwatchBlocks();
  timer = null;
  boundaryTimer = null;
  offenseBoundaryTimer = null;
  preBoundaryTimer = null;
  preBoundaryAuditTimer = null;
  preBoundaryKillTimer = null;
  unwatchBlocks = null;
  runtime.emitStatus();
  activity.add({ kind: "info", status: "info", message: "Engine paused" });
}

/** Fire an extra tick precisely at the armed epoch's boundary (near-instant JIT pay). */
export function scheduleJitBoundary(): void {
  if (boundaryTimer) {
    clearTimeout(boundaryTimer);
    boundaryTimer = null;
  }
  const s = runtime.strategy;
  if (!runtime.running || !s.jitEnabled || s.jitTargetEpoch === null || runtime.startTime === null) {
    return;
  }
  // Epoch N begins at startTime + (N-1)*EPOCH_DURATION.
  const boundary = runtime.startTime + BigInt(s.jitTargetEpoch - 1) * EPOCH_DURATION_SECONDS;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const deltaSec = Number(boundary - nowSec);
  if (deltaSec <= 0) {
    void tick();
    return;
  }
  const delayMs = Math.min(deltaSec * 1000 + 500, 2_000_000_000);
  const generation = engineGeneration;
  boundaryTimer = setTimeout(() => fireBoundaryTick(generation), delayMs);
}

interface PreBoundaryPayPlan {
  targetEpoch: bigint;
  boundaryTs: bigint;
  includeJit: boolean;
  includeProactive: boolean;
}

function selectedOwnedJitTokenIds(ownedIds: bigint[]): bigint[] {
  const configured = runtime.strategy.jitTokenIds;
  if (configured.length === 0) return ownedIds;
  const ownedById = new Map(ownedIds.map((id) => [id.toString(), id]));
  return [...new Set(configured)].flatMap((id) => {
    if (!/^\d+$/.test(id)) return [];
    const owned = ownedById.get(BigInt(id).toString());
    return owned === undefined ? [] : [owned];
  });
}

/** Pick the next future epoch that needs a pre-boundary payment. In addition to
 * one-shot JIT, proactive defense recurs every epoch and only pays citizens that
 * will cross from the one-epoch grace period into auditable delinquency. */
function preBoundaryPayPlan(): PreBoundaryPayPlan | null {
  const s = runtime.strategy;
  const currentEpoch = runtime.currentEpoch;
  const startTime = runtime.startTime;
  if (currentEpoch === null || startTime === null) return null;

  const proactiveTarget = s.enabled && s.proactivePay ? currentEpoch + 1n : null;
  const configuredJitTarget = s.jitEnabled && s.jitTargetEpoch !== null
    ? BigInt(s.jitTargetEpoch)
    : null;
  const jitTarget = configuredJitTarget !== null && configuredJitTarget > currentEpoch
    ? configuredJitTarget
    : null;
  if (proactiveTarget === null && jitTarget === null) return null;

  const targetEpoch = proactiveTarget === null
    ? jitTarget!
    : jitTarget === null || proactiveTarget <= jitTarget
      ? proactiveTarget
      : jitTarget;
  return {
    targetEpoch,
    boundaryTs: startTime + (targetEpoch - 1n) * EPOCH_DURATION_SECONDS,
    includeJit: jitTarget === targetEpoch,
    includeProactive: proactiveTarget === targetEpoch,
  };
}

/**
 * Arm a pre-submit ~preBoundaryLeadMs before the next defensive payment epoch.
 * This covers both one-shot JIT and recurring tax-skip defense, and validates the
 * upcoming-epoch value by simulating at the boundary timestamp before send.
 */
export function schedulePreBoundaryPay(): void {
  if (preBoundaryTimer) {
    clearTimeout(preBoundaryTimer);
    preBoundaryTimer = null;
  }
  const s = runtime.strategy;
  const plan = preBoundaryPayPlan();
  if (!runtime.running || !s.preBoundaryPay || plan === null) return;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const deltaMs = Number(plan.boundaryTs - nowSec) * 1000 - effectiveLeadMs();
  if (deltaMs <= 0) {
    // Starting or waking inside the configured lead is still useful. Fire now
    // while the boundary is in the future; public delivery remains held until
    // the future-valid timestamp. Post-boundary ticks are the fallback.
    if (nowSec < plan.boundaryTs) {
      const generation = engineGeneration;
      preBoundaryTimer = setTimeout(() => void firePreBoundaryPay(plan, generation), 0);
    }
    return;
  }
  const maxTimerDelayMs = 2_000_000_000;
  if (deltaMs > maxTimerDelayMs) {
    // Node timers cannot safely represent arbitrarily distant dates. Wake only
    // to recompute from fresh state; never mistake the clamp for the fire time.
    preBoundaryTimer = setTimeout(schedulePreBoundaryPay, maxTimerDelayMs);
    return;
  }
  // Capture the exact epoch this timer was armed for. Recomputing at callback
  // time can turn a delayed epoch-N timer into an early epoch-(N+1) payment.
  const generation = engineGeneration;
  preBoundaryTimer = setTimeout(() => void firePreBoundaryPay(plan, generation), deltaMs);
}

// Fixed gas for a pre-boundary payTaxes — we can't eth_estimateGas it (the value
// is invalid against current state), so pass a generous fixed limit.
const PRE_BOUNDARY_GAS = 120_000n;
// Optional offense may ride only while there is still comfortable time to hand
// the mandatory payment bundle to builders. One audit is enough to preserve the
// placement optimization without letting a large offense sweep delay survival.
const PRE_BOUNDARY_DELIVERY_MARGIN_MS = 1_500;
const MAX_RIDE_AUDITS = 1;

type DeadlineOutcome<T> = { timedOut: false; value: T } | { timedOut: true };

/** Bound read-only optional work by an absolute wall-clock cutoff. The abandoned
 * promise may finish later, but it cannot reserve a nonce or mutate the batch. */
async function settleBeforeDeadline<T>(
  promise: Promise<T>,
  deadlineMs: number,
): Promise<DeadlineOutcome<T>> {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) return { timedOut: true };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ timedOut: false as const, value })),
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), remainingMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Fire a pre-boundary payment for one-shot JIT tokens and/or owned citizens that
 * will become auditable in the upcoming epoch. A shared per-token flight prevents
 * duplicate sends while the normal on-chain-status pass remains authoritative.
 */
async function firePreBoundaryPay(plan: PreBoundaryPayPlan, generation = engineGeneration): Promise<void> {
  const s = runtime.strategy;
  if (!executionIsCurrent(generation)) return;
  if (!s.preBoundaryPay) return;
  if (!runtime.running || !runtime.unlocked || !runtime.account) return;

  const includeJit = plan.includeJit
    && s.jitEnabled
    && s.jitTargetEpoch !== null
    && BigInt(s.jitTargetEpoch) === plan.targetEpoch;
  const includeProactive = plan.includeProactive && s.enabled && s.proactivePay;
  if (!includeJit && !includeProactive) return;
  if (includeJit) prepareJitBookkeeping();

  const nowMs = Date.now();
  const boundaryMs = Number(plan.boundaryTs) * 1000;
  if (nowMs < boundaryMs - effectiveLeadMs() - 1_000) {
    schedulePreBoundaryPay();
    return;
  }
  if (nowMs >= boundaryMs) {
    // The epoch already rolled while this timer was delayed. Let the normal
    // on-chain estimate path recover; never send a stale or N+1 price here.
    if (!ticking) void tick();
    return;
  }
  if (ticking) { setTimeout(() => void firePreBoundaryPay(plan, generation), 150); return; } // don't overlap nonce use
  ticking = true;
  executingGeneration = generation;
  committedThisTickWei = 0n;
  beginBatch();
  const address = runtime.account.address;
  const { targetEpoch, boundaryTs } = plan;
  try {
    // Optional offense must never sit on the survival path. In mainnet mode,
    // start read-only audit discovery alongside the mandatory payment reads, then
    // attach it only if it has already finished by the time payments are ready.
    // Public/local mode keeps the standalone audit scheduler instead.
    let auditPrefetch: { settled: boolean; plan: PreBoundaryAuditPlan | null } | null = null;
    if (appConfig.mode === "mainnet") {
      auditPrefetch = { settled: false, plan: null };
      const state = auditPrefetch;
      void prefetchPreBoundaryAuditTargets(
        address,
        targetEpoch,
        BigInt(Math.floor(Date.now() / 1000)),
      ).then((auditPlan) => {
        state.plan = auditPlan;
        state.settled = true;
      });
    }

    // These reads are independent. The fresh snapshot prevents a delayed timer
    // from signing for the wrong epoch before any nonce is reserved.
    const [fresh, , ownedIds] = await Promise.all([
      getGameSnapshot(),
      nonceManager.sync(address, appConfig.mode),
      fetchOwnedTokenIds(runtime.citizensAddress as Address, address),
    ]);
    if (fresh.state !== 1 || fresh.currentEpoch + 1n !== targetEpoch) {
      logger.warn(`skip stale pre-boundary payment timer for epoch ${targetEpoch}; chain is at epoch ${fresh.currentEpoch}`);
      return;
    }
    const jitIds = includeJit ? selectedOwnedJitTokenIds(ownedIds) : [];
    const byId = new Map<string, bigint>();
    if (includeProactive) for (const id of ownedIds) byId.set(id.toString(), id);
    for (const id of jitIds) byId.set(id.toString(), id);
    const selected = [...byId.values()];

    const owned = new Set(ownedIds.map((id) => id.toString()));
    const jit = new Set(jitIds.map((id) => id.toString()));

    // One multicall for lastEpochPaid across the selected tokens.
    const results = selected.length === 0
      ? []
      : await publicClient.multicall({
          allowFailure: true,
          contracts: selected.map((id) => ({ ...gameContract, functionName: "lastEpochPaid" as const, args: [id] as const })),
        });
    let queuedPayment = false;
    for (let i = 0; i < selected.length; i++) {
      const r = results[i];
      if (r?.status !== "success") continue;
      const lastEpochPaid = r.result as bigint;
      const key = selected[i]!.toString();
      const jitDue = includeJit && jit.has(key) && lastEpochPaid < targetEpoch;
      const proactiveDue = includeProactive && owned.has(key) && lastEpochPaid + 2n <= targetEpoch;
      if (!jitDue && !proactiveDue) continue;
      if (pendingPaymentFor(key, lastEpochPaid)) continue;
      // JIT always pays exactly one epoch — one day (targetEpoch * base) — which
      // advances the citizen a single epoch regardless of how far behind it is. So
      // it fires even when the citizen is momentarily 2 behind at the boundary (the
      // tax-skip case); the auto-pay cap governs multi-epoch paths, not this one.
      const value = preBoundaryTaxWei(lastEpochPaid, targetEpoch, 1, BASE_TAX_RATE_WEI);
      if (value === 0n) continue;
      const guard = await canSpend(value, false); // enforces max-base-fee, floor, max-payment caps
      if (!guard.ok) {
        activity.add({ kind: "pay-taxes", status: "skipped", tokenId: key, message: `Defer pre-boundary pay #${key}: ${guard.reason}` });
        continue;
      }
      const res = await act(
        { to: appConfig.gameAddress, data: encodePayTaxes(selected[i]!, 1), value, gas: PRE_BOUNDARY_GAS },
        "pay-taxes",
        {
          tokenId: key,
          message: `Pre-boundary ${jitDue ? "JIT" : "tax-skip"} pay #${key} for epoch ${targetEpoch} = ${formatEther(value)} ETH (boundary race)`,
          race: true,
          simTimestamp: boundaryTs,
          payment: {
            expectedLastEpochPaid: lastEpochPaid + 1n,
            source: jitDue ? "jit" : "pre-boundary",
            jitTargetEpoch: jitDue ? Number(targetEpoch) : undefined,
            proactiveEpoch: proactiveDue ? targetEpoch : undefined,
          },
        },
      );
      if (res?.ok && res.queued) queuedPayment = true;
    }

    // If read-only discovery already finished with time to spare, ride one audit
    // behind the payments in the same mainnet bundle. The audit is explicitly
    // allowed to revert and stays out of the immediate public payment prefix. If
    // discovery is slow, flush the survival payment without waiting for offense.
    if (auditPrefetch?.settled && auditPrefetch.plan) {
      await queueAuditPlan(auditPrefetch.plan, targetEpoch, boundaryTs, {
        revertible: queuedPayment,
        deadlineMs: boundaryMs - PRE_BOUNDARY_DELIVERY_MARGIN_MS,
      });
    } else if (auditPrefetch && !auditPrefetch.settled) {
      logger.warn("pre-boundary audit discovery was not ready; submitting payments without optional audits");
    }
  } catch (err) {
    logger.error("pre-boundary pay error:", (err as Error).message);
    activity.add({ kind: "error", status: "skipped", message: `Pre-boundary pay error: ${(err as Error).message}` });
  } finally {
    await flushOrDiscardBatch(generation);
    nonceManager.reset();
    finishExclusive(generation);
  }
}

// Generous fixed gas for an unsimulated offense pre-submit (real audits used
// ~113–130k on-chain; we can't eth_estimateGas an action that isn't valid yet).
const PRE_BOUNDARY_OFFENSE_GAS = 250_000n;

/** Owned tokens usable as audit "from" tokens AT the upcoming epoch: not
 *  auditable at `targetEpoch` (so still current now) and with full capacity
 *  (the new epoch has 0 audits used). One audit per token. */
async function findPreBoundaryAuditors(ownedIds: bigint[], targetEpoch: bigint): Promise<bigint[]> {
  if (ownedIds.length === 0) return [];
  const results = await publicClient.multicall({
    allowFailure: true,
    contracts: ownedIds.flatMap((id) => [
      { ...gameContract, functionName: "lastEpochPaid" as const, args: [id] as const },
      { ...gameContract, functionName: "auditLimit" as const, args: [id] as const },
    ]),
  });
  const eligible: bigint[] = [];
  for (let i = 0; i < ownedIds.length; i++) {
    const lep = results[i * 2];
    const limit = results[i * 2 + 1];
    if (lep?.status !== "success" || limit?.status !== "success") continue;
    const limitV = limit.result as bigint;
    // 0n audits used because targetEpoch is a fresh epoch we haven't acted in yet,
    // so remaining capacity == auditLimit. Add one pool entry per available audit
    // so auditor-role tokens (limit > 1) can hit multiple rivals at the boundary.
    if (!isEligibleAuditor(lep.result as bigint, targetEpoch, 0n, limitV)) continue;
    for (let k = 0n; k < limitV; k++) eligible.push(ownedIds[i]!);
  }
  return eligible;
}

/** Arm a pre-submit of audits ~preBoundaryLeadMs before the next epoch boundary. */
export function schedulePreBoundaryAudit(): void {
  if (preBoundaryAuditTimer) {
    clearTimeout(preBoundaryAuditTimer);
    preBoundaryAuditTimer = null;
  }
  const s = runtime.strategy;
  if (!runtime.running || !s.preBoundaryAudit || !s.offenseEnabled || !s.autoAudit) return;
  if (runtime.startTime === null || runtime.currentEpoch === null) return;
  // If a pre-boundary PAYMENT is armed for this same upcoming boundary, it carries
  // the audits inside its atomic bundle (behind the payment, revertible). Don't
  // also fire a standalone audit — that would double-submit and reintroduce the
  // two-bundle nonce contention that demotes the payment.
  const paymentPlan = preBoundaryPayPlan();
  if (
    appConfig.mode === "mainnet"
    && s.preBoundaryPay
    && paymentPlan?.targetEpoch === runtime.currentEpoch + 1n
  ) {
    return;
  }
  const boundary = runtime.startTime + runtime.currentEpoch * EPOCH_DURATION_SECONDS; // starts current+1
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const deltaMs = Number(boundary - nowSec) * 1000 - effectiveLeadMs();
  if (deltaMs <= 0) return; // too late; normal offense picks it up after the roll
  const generation = engineGeneration;
  const maxTimerDelayMs = 2_000_000_000;
  preBoundaryAuditTimer = deltaMs > maxTimerDelayMs
    ? setTimeout(schedulePreBoundaryAudit, maxTimerDelayMs)
    : setTimeout(() => void firePreBoundaryAudit(generation), deltaMs);
}

interface PreBoundaryAuditPlan {
  auditors: bigint[];
  statuses: Awaited<ReturnType<typeof batchGetTargetStatuses>>;
  owned: Set<string>;
  pinned: Set<string> | null;
}

/**
 * Read-only discovery of pre-boundary audit targets (auditor pool + rival statuses
 * that will be auditable in the first block of `targetEpoch`). Does NOT touch the
 * nonce or the batch, so it can run CONCURRENTLY with payment processing and keep
 * the audit's read latency off the payment's critical path before the bundle
 * flushes. Returns null when there's nothing to audit. Never throws — an audit
 * read failure must never break a payment, so errors resolve to null.
 */
async function prefetchPreBoundaryAuditTargets(
  address: Address,
  targetEpoch: bigint,
  nowSec: bigint,
): Promise<PreBoundaryAuditPlan | null> {
  const s = runtime.strategy;
  if (!s.preBoundaryAudit || !s.offenseEnabled || !s.autoAudit) return null;
  if (s.endgameOnlyWithin !== null && (runtime.citizenSupply ?? 0n) - WINNERS > BigInt(s.endgameOnlyWithin)) return null;
  try {
    const ownedIds = await fetchOwnedTokenIds(runtime.citizensAddress as Address, address);
    const auditors = await findPreBoundaryAuditors(ownedIds, targetEpoch);
    if (auditors.length === 0) return null;

    const candidateIds = await fetchCandidateTokenIds(runtime.citizensAddress as Address);
    const liveRaw = await filterLiveTokenIds(runtime.citizensAddress as Address, candidateIds);
    const live = orderBySalt(liveRaw, (t) => t.id.toString(), engineSalt);
    const owned = new Set(ownedIds.map((x) => x.toString()));
    const pinned = s.offenseTargetTokenIds.length > 0 ? new Set(s.offenseTargetTokenIds) : null;
    // Auditable AT the target epoch, not already under audit.
    const statuses = await batchGetTargetStatuses(live, targetEpoch, nowSec);
    return { auditors, statuses, owned, pinned };
  } catch (err) {
    logger.warn(`pre-boundary audit prefetch failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Queue the audits from a prefetched plan into the CURRENTLY OPEN batch (caller has
 * opened beginBatch and synced the nonce). When `revertible`, each audit is marked
 * allowed-to-revert and is not part of the immediate public prefix. This lets an
 * execution revert be tolerated by builders without making optional offense a
 * prerequisite for submitting the payment.
 */
async function queueAuditPlan(
  plan: PreBoundaryAuditPlan,
  targetEpoch: bigint,
  boundaryTs: bigint,
  opts: { revertible: boolean; deadlineMs?: number },
): Promise<void> {
  const { auditors, statuses, owned, pinned } = plan;
  let idx = 0;
  for (const t of statuses) {
    if (idx >= auditors.length) break;
    if (opts.revertible && idx >= MAX_RIDE_AUDITS) break;
    if (opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs) {
      logger.warn("pre-boundary audit attach window closed; submitting the payment bundle now");
      break;
    }
    if (owned.has(t.tokenId)) continue;
    if (pinned && !pinned.has(t.tokenId)) continue;
    if (t.auditDueTimestamp !== "0") continue; // already under audit
    if (!isAuditable(BigInt(t.lastEpochPaid), targetEpoch)) continue; // won't be auditable at the boundary
    const guardOutcome = opts.deadlineMs === undefined
      ? { timedOut: false as const, value: await canSpend(AUDIT_COST_WEI, true) }
      : await settleBeforeDeadline(canSpend(AUDIT_COST_WEI, true), opts.deadlineMs);
    if (guardOutcome.timedOut) {
      logger.warn("pre-boundary audit spend check missed its attach deadline; submitting the payment bundle now");
      break;
    }
    const guard = guardOutcome.value;
    if (!guard.ok) continue;
    if (opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs) {
      logger.warn("pre-boundary audit attach window closed after spend checks; submitting the payment bundle now");
      break;
    }
    const from = auditors[idx]!;
    const res = await act(
      { to: appConfig.gameAddress, data: encodeAudit(from, BigInt(t.tokenId)), value: AUDIT_COST_WEI, gas: PRE_BOUNDARY_OFFENSE_GAS },
      "audit",
      {
        tokenId: from.toString(),
        targetTokenId: t.tokenId,
        message: `Pre-boundary audit #${t.tokenId} from #${from} for epoch ${targetEpoch}${opts.revertible ? " (rides payment bundle)" : " (boundary race)"}`,
        race: true,
        simTimestamp: boundaryTs,
        revertible: opts.revertible,
        deadlineMs: opts.deadlineMs,
      },
    );
    if (res?.ok) idx++;
  }
}

/** Standalone pre-boundary audit sweep (no payment this boundary): discover then
 *  queue, sequentially. Used by firePreBoundaryAudit. */
async function queuePreBoundaryAudits(
  address: Address,
  targetEpoch: bigint,
  nowSec: bigint,
  boundaryTs: bigint,
  opts: { revertible: boolean; deadlineMs?: number },
): Promise<void> {
  const plan = await prefetchPreBoundaryAuditTargets(address, targetEpoch, nowSec);
  if (plan) await queueAuditPlan(plan, targetEpoch, boundaryTs, opts);
}

/** Pre-submit audits for rivals that will be auditable in the FIRST block of the
 *  upcoming epoch, so we compete with a batch-auditor rather than landing a block
 *  later. Standalone (no payment this boundary): its own bundle, mirrored per
 *  racePublicMempool. When a payment IS armed for this boundary, firePreBoundaryPay
 *  carries the audits instead (see schedulePreBoundaryAudit). */
async function firePreBoundaryAudit(generation = engineGeneration): Promise<void> {
  const s = runtime.strategy;
  if (!executionIsCurrent(generation)) return;
  if (!s.preBoundaryAudit || !s.offenseEnabled || !s.autoAudit) return;
  if (!runtime.running || !runtime.unlocked || !runtime.account) return;
  if (runtime.gameState !== 1) return; // only act while the game is LIVE
  if (ticking) { setTimeout(() => void firePreBoundaryAudit(generation), 150); return; }
  if (s.endgameOnlyWithin !== null && (runtime.citizenSupply ?? 0n) - WINNERS > BigInt(s.endgameOnlyWithin)) return;
  ticking = true;
  executingGeneration = generation;
  committedThisTickWei = 0n;
  beginBatch();
  const address = runtime.account.address;
  const targetEpoch = (runtime.currentEpoch ?? 0n) + 1n;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  // Simulate at the boundary instant, where the target actually becomes auditable.
  const boundaryTs = (runtime.startTime ?? 0n) + (runtime.currentEpoch ?? 0n) * EPOCH_DURATION_SECONDS;
  try {
    await nonceManager.sync(address, appConfig.mode);
    await queuePreBoundaryAudits(address, targetEpoch, nowSec, boundaryTs, { revertible: false });
  } catch (err) {
    logger.error("pre-boundary audit error:", (err as Error).message);
    activity.add({ kind: "error", status: "skipped", message: `Pre-boundary audit error: ${(err as Error).message}` });
  } finally {
    await flushOrDiscardBatch(generation);
    nonceManager.reset();
    finishExclusive(generation);
  }
}

/** Arm a pre-submit of kills ~preBoundaryLeadMs before the soonest audit-expiry. */
export function schedulePreBoundaryKill(): void {
  if (preBoundaryKillTimer) {
    clearTimeout(preBoundaryKillTimer);
    preBoundaryKillTimer = null;
  }
  const s = runtime.strategy;
  if (!runtime.running || !s.preBoundaryKill || !s.offenseEnabled || !s.autoKill) return;
  if (nextKillDeadlineSec === null) return;
  const targetDeadline = nextKillDeadlineSec;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const deltaMs = Number(targetDeadline - nowSec) * 1000 - effectiveLeadMs();
  const generation = engineGeneration;
  if (deltaMs <= 0) {
    if (targetDeadline > nowSec) {
      preBoundaryKillTimer = setTimeout(
        () => void firePreBoundaryKill(generation, targetDeadline),
        0,
      );
    }
    return; // already expired => normal offense handles it
  }
  const maxTimerDelayMs = 2_000_000_000;
  preBoundaryKillTimer = deltaMs > maxTimerDelayMs
    ? setTimeout(schedulePreBoundaryKill, maxTimerDelayMs)
    : setTimeout(() => void firePreBoundaryKill(generation, targetDeadline), deltaMs);
}

/** Pre-submit kills (skip-sim) for targets whose audit is about to expire, so the
 *  kill lands in the first eligible block instead of the one after. */
async function firePreBoundaryKill(
  generation = engineGeneration,
  targetDeadline: bigint | null = nextKillDeadlineSec,
): Promise<void> {
  const s = runtime.strategy;
  if (!executionIsCurrent(generation)) return;
  if (!s.preBoundaryKill || !s.offenseEnabled || !s.autoKill) return;
  if (!runtime.running || !runtime.unlocked || !runtime.account) return;
  if (runtime.gameState !== 1) return; // only act while the game is LIVE
  if (ticking) { setTimeout(() => void firePreBoundaryKill(generation, targetDeadline), 150); return; }
  if (s.endgameOnlyWithin !== null && (runtime.citizenSupply ?? 0n) - WINNERS > BigInt(s.endgameOnlyWithin)) return;
  ticking = true;
  executingGeneration = generation;
  committedThisTickWei = 0n;
  beginBatch();
  const address = runtime.account.address;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  let followingDeadline: bigint | null = null;
  // Pre-submit kills for audits expiring within our lead + one slot of headroom.
  const windowSec = BigInt(Math.ceil(effectiveLeadMs() / 1000) + 12);
  try {
    await nonceManager.sync(address, appConfig.mode);
    const ownedIds = await fetchOwnedTokenIds(runtime.citizensAddress as Address, address);
    const candidateIds = await fetchCandidateTokenIds(runtime.citizensAddress as Address);
    const liveRaw = await filterLiveTokenIds(runtime.citizensAddress as Address, candidateIds);
    const live = orderBySalt(liveRaw, (t) => t.id.toString(), engineSalt);
    const owned = new Set(ownedIds.map((x) => x.toString()));
    const pinned = s.offenseTargetTokenIds.length > 0 ? new Set(s.offenseTargetTokenIds) : null;
    const statuses = await batchGetTargetStatuses(live, runtime.currentEpoch ?? 0n, nowSec);
    const imminent = statuses.flatMap((t) => {
      if (owned.has(t.tokenId)) return [];
      if (pinned && !pinned.has(t.tokenId)) return [];
      const due = BigInt(t.auditDueTimestamp);
      if (due === 0n || t.killable || due <= nowSec || due - nowSec > windowSec) return [];
      if (targetDeadline !== null && due < targetDeadline) return [];
      return [{ target: t, due }];
    });
    const earliestDue = imminent.reduce<bigint | null>(
      (earliest, item) => earliest === null || item.due < earliest ? item.due : earliest,
      null,
    );
    followingDeadline = imminent.reduce<bigint | null>((next, item) => {
      if (earliestDue === null || item.due <= earliestDue) return next;
      return next === null || item.due < next ? item.due : next;
    }, null);
    // A bundle has one execution timestamp. Batch only the earliest-deadline
    // cohort; mixing due+1 timestamps would invalidate and discard every kill.
    for (const { target: t, due } of imminent) {
      if (due !== earliestDue) continue;
      const guard = await canSpend(0n, true);
      if (!guard.ok) continue;
      await act(
        { to: appConfig.gameAddress, data: encodeKill(BigInt(t.tokenId)), value: 0n, gas: PRE_BOUNDARY_OFFENSE_GAS },
        "kill",
        // Simulate one second past the audit-expiry, where kill() first becomes valid.
        { targetTokenId: t.tokenId, message: `Pre-boundary kill #${t.tokenId} (audit expiring, deadline race)`, race: true, simTimestamp: due + 1n },
      );
    }
  } catch (err) {
    logger.error("pre-boundary kill error:", (err as Error).message);
    activity.add({ kind: "error", status: "skipped", message: `Pre-boundary kill error: ${(err as Error).message}` });
  } finally {
    await flushOrDiscardBatch(generation);
    nonceManager.reset();
    finishExclusive(generation);
    if (executionIsCurrent(generation) && followingDeadline !== null) {
      nextKillDeadlineSec = followingDeadline;
      schedulePreBoundaryKill();
    }
  }
}

// Lead time before an offense deadline at which we fire the pre-emptive tick, so
// the tx is built and submitted in time to compete in the first eligible block.
const OFFENSE_LEAD_MS = 1_500;

/**
 * Fire an extra tick just before the soonest offense deadline so kills/audits
 * land in the FIRST eligible block instead of the block after (the ~12s latency
 * gap seen in race post-mortems). Two kinds of deadline:
 *   - kill: the nearest pending audit's expiry (`nextKillDeadlineSec`) — after
 *     this instant, kill() succeeds.
 *   - audit: the next epoch boundary — a token 1 epoch behind becomes auditable
 *     (2+ behind) when the epoch rolls, and fresh delinquencies appear then too.
 * Picks whichever is sooner and schedules a tick ~OFFENSE_LEAD_MS before it.
 */
export function scheduleOffenseBoundary(): void {
  if (offenseBoundaryTimer) {
    clearTimeout(offenseBoundaryTimer);
    offenseBoundaryTimer = null;
  }
  const s = runtime.strategy;
  if (!runtime.running || !s.offenseEnabled || !s.offenseBoundaryScheduling) return;
  if (runtime.startTime === null || runtime.currentEpoch === null) return;

  const nowSec = BigInt(Math.floor(Date.now() / 1000));

  // Candidate 1: next epoch boundary. Epoch N begins at startTime + (N-1)*DUR,
  // so the boundary that starts epoch (current+1) is startTime + current*DUR.
  const nextEpochBoundary = runtime.startTime + runtime.currentEpoch * EPOCH_DURATION_SECONDS;

  // Candidate 2: soonest pending audit expiry that is still in the future.
  const candidates = [nextEpochBoundary];
  if (nextKillDeadlineSec !== null && nextKillDeadlineSec > nowSec) {
    candidates.push(nextKillDeadlineSec);
  }
  const soonest = candidates.filter((c) => c > nowSec).sort((a, b) => (a < b ? -1 : 1))[0];
  if (soonest === undefined) return;

  const deltaMs = Number(soonest - nowSec) * 1000 - OFFENSE_LEAD_MS;
  if (deltaMs <= 0) {
    void tick();
    return;
  }
  const delayMs = Math.min(deltaMs, 2_000_000_000);
  const generation = engineGeneration;
  offenseBoundaryTimer = setTimeout(() => fireBoundaryTick(generation), delayMs);
}

async function refreshSnapshot(address: Address): Promise<void> {
  // Fetch the full latest block (not just its number) so it warms the shared
  // block cache: every canSpend/computeFees later in this tick then reuses it
  // instead of each re-reading the block for the base fee.
  const [snap, balance, latest] = await Promise.all([
    getGameSnapshot(),
    publicClient.getBalance({ address }),
    getLatestBlockCached(),
  ]);
  runtime.gameState = snap.state;
  runtime.currentEpoch = snap.currentEpoch;
  runtime.citizenSupply = snap.citizenSupply;
  runtime.citizensAddress = snap.citizensAddress;
  runtime.startTime = snap.startTime;
  runtime.balanceWei = balance;
  runtime.lastBlock = latest.number;
  runtime.emitStatus();
  scheduleJitBoundary();
  schedulePreBoundaryPay();
  schedulePreBoundaryAudit();
}

/** Pre-flight guardrail: can we afford this spend without breaching caps/floors?
 *  `offense` selects the audit/kill gas profile so the base-fee cap and gas
 *  estimate match what `submitTx` will actually bid. */
async function canSpend(
  valueWei: bigint,
  offense: boolean,
  replacement?: PaymentFlight,
): Promise<{ ok: boolean; reason?: string }> {
  const s = runtime.strategy;
  const gas = resolveGas(s, offense);
  const block = await getLatestBlockCached();
  const baseFee = block.baseFeePerGas ?? 0n;
  const maxBase = BigInt(Math.round(gas.maxBaseFeeGwei * 1e9));
  if (baseFee > maxBase) {
    return { ok: false, reason: `base fee ${formatEther(baseFee * 1_000_000_000n)} gwei over cap` };
  }
  // Runaway-payment backstop: never send a single tx whose value exceeds the
  // cap. Guards against a bad tax estimate or a token being many epochs behind
  // draining the wallet in one shot. 0 disables the cap.
  if (s.maxPaymentEth > 0) {
    const cap = parseEther(String(s.maxPaymentEth));
    if (valueWei > cap) {
      return {
        ok: false,
        reason: `payment ${formatEther(valueWei)} ETH exceeds max-payment cap ${s.maxPaymentEth} ETH`,
      };
    }
  }

  let priorityFee = BigInt(Math.round(effectiveTipGwei(gas, block.gasUsed, block.gasLimit) * 1e9));
  let maxFeePerGas = baseFee * 2n + priorityFee;
  if (replacement) {
    const fees = cappedReplacementFees(
      maxFeePerGas,
      priorityFee,
      replacement.maxFeePerGas,
      replacement.maxPriorityFeePerGas,
      gas,
    );
    if (!fees) return { ok: false, reason: "replacement fee ceiling reached" };
    priorityFee = fees.maxPriorityFeePerGas;
    maxFeePerGas = fees.maxFeePerGas;
  }
  const gasWei = GAS_GUESS * maxFeePerGas;

  const bal = runtime.balanceWei ?? 0n;
  const floor = parseEther(String(s.minBalanceEth));
  // Account for spend already committed earlier in this tick — the on-chain
  // balance is read once per tick and doesn't yet reflect those payments, so
  // without this several payments in one tick could cumulatively breach the floor.
  if (!canAffordSpend(bal, committedThisTickWei, valueWei, gasWei, floor)) {
    return { ok: false, reason: "would breach min-balance floor" };
  }

  return { ok: true };
}

// How long to wait for a submitted tx's receipt before giving up. A tx that
// never lands (dropped, replaced, or a bundle that lost) times out and is left
// as "submitted" rather than being force-marked one way or the other.
const RECEIPT_TIMEOUT_MS = 3 * 60_000;

/**
 * Poll for a submitted tx's receipt and flip its activity entry from "submitted"
 * to "included" (mined OK) or "reverted" (mined but failed). Fire-and-forget:
 * never awaited by the tick loop, and swallows errors/timeouts so a stuck poll
 * can't wedge the engine.
 */
async function trackReceipt(
  entryId: string,
  txHash: `0x${string}`,
  receiptFlight?: PaymentFlight,
): Promise<void> {
  try {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: RECEIPT_TIMEOUT_MS,
    });
    const block = receipt.blockNumber?.toString();
    activity.update(entryId, {
      status: receipt.status === "success" ? "included" : "reverted",
      targetBlock: block,
    });
    if (receiptFlight) {
      const current = paymentFlights.get(receiptFlight.tokenId);
      // Every alternative signed with this nonce is terminal once any one of
      // them mines. Never resurrect a flight cleared by an account switch, and
      // preserve the current replacement's obligations if an older hash wins.
      if (
        current
        && current.account === receiptFlight.account
        && current.nonce === receiptFlight.nonce
      ) {
        if (receipt.status === "success") {
          current.delivery = "included";
        } else {
          clearSourceMarker(current);
          paymentFlights.delete(receiptFlight.tokenId);
        }
      }
    }
  } catch (err) {
    // Timed out or RPC error — leave the entry as "submitted".
    logger.warn(`receipt tracking for ${txHash.slice(0, 10)}… failed: ${(err as Error).message}`);
  }
}

interface PaymentActContext {
  expectedLastEpochPaid: bigint;
  source: PaymentSource;
  replace?: PaymentFlight;
  jitTargetEpoch?: number;
  proactiveEpoch?: bigint;
  reserveProactiveMarker?: boolean;
}

function pendingPaymentFor(tokenId: string, observedLastEpochPaid: bigint): PaymentFlight | undefined {
  const flight = paymentFlights.get(tokenId);
  if (!flight) return undefined;
  if (observedLastEpochPaid >= flight.expectedLastEpochPaid) {
    if (
      flight.jitTargetEpoch !== null
      && runtime.strategy.jitEnabled
      && runtime.strategy.jitTargetEpoch === flight.jitTargetEpoch
    ) {
      prepareJitBookkeeping();
      if (jitSubmittedTarget === flight.jitTargetEpoch) jitSubmitted.add(tokenId);
    }
    if (flight.proactiveEpoch !== null && runtime.currentEpoch === flight.proactiveEpoch) {
      if (proactivePaySubmittedEpoch !== flight.proactiveEpoch) {
        proactivePaySubmittedEpoch = flight.proactiveEpoch;
        proactivePaySubmitted = new Set();
      }
      proactivePaySubmitted.add(tokenId);
    }
    paymentFlights.delete(tokenId);
    return undefined;
  }
  return flight;
}

/** Reconcile payment flights at one explicit block. A receipt watcher can time
 * out, and another wallet transaction (or a reverted payment) can consume the
 * nonce without advancing lastEpochPaid. Once the confirmed nonce is beyond a
 * flight, stale tax state proves the flight is terminal and the next pass must
 * use a fresh nonce instead of replacing an impossible one forever. */
async function reconcilePaymentFlights(address: Address): Promise<void> {
  const flights = [...paymentFlights.values()].filter((flight) => flight.account === address);
  if (flights.length === 0) return;
  const blockNumber = runtime.lastBlock;
  try {
    const [confirmedNonce, results] = await Promise.all([
      blockNumber === null
        ? publicClient.getTransactionCount({ address, blockTag: "latest" })
        : publicClient.getTransactionCount({ address, blockNumber }),
      publicClient.multicall({
        allowFailure: true,
        contracts: flights.map((flight) => ({
          ...gameContract,
          functionName: "lastEpochPaid" as const,
          args: [BigInt(flight.tokenId)] as const,
        })),
        ...(blockNumber === null ? {} : { blockNumber }),
      }),
    ]);
    for (let i = 0; i < flights.length; i++) {
      const snapshot = flights[i]!;
      const current = paymentFlights.get(snapshot.tokenId);
      if (!current || current.attemptId !== snapshot.attemptId) continue;
      const result = results[i];
      if (result?.status !== "success") continue;
      const observed = result.result as bigint;
      if (observed >= current.expectedLastEpochPaid) {
        pendingPaymentFor(current.tokenId, observed);
      } else if (confirmedNonce > current.nonce) {
        clearSourceMarker(current);
        paymentFlights.delete(current.tokenId);
        activity.add({
          kind: "info",
          status: "info",
          tokenId: current.tokenId,
          message: `Payment nonce ${current.nonce} was consumed without advancing #${current.tokenId}; retrying with fresh chain state`,
        });
      } else if (
        Date.now() - current.submittedAtMs >= 90_000
        && !nonceManager.hasInvisibleReservation()
        && nonceManager.pendingNonce() <= current.nonce
      ) {
        // The latest replacement has aged past the nonce manager's reservation
        // window, is neither confirmed nor visible in this node's pending state,
        // and any private bundle targeted only the next two blocks. Clear the
        // flight so the next safety pass reuses this same on-chain nonce from
        // fresh state—even after fee bumps reached their configured ceiling.
        clearSourceMarker(current);
        paymentFlights.delete(current.tokenId);
        activity.add({
          kind: "info",
          status: "info",
          tokenId: current.tokenId,
          message: `Payment nonce ${current.nonce} is no longer pending; retrying #${current.tokenId} without exceeding the fee ceiling`,
        });
      }
    }
  } catch (err) {
    // Retain the existing flight and let the ordinary safety passes continue;
    // this check is retried on the next tick.
    logger.warn("payment-flight reconciliation failed:", (err as Error).message);
  }
}

const PAYMENT_REPLACEMENT_AFTER_MS = 30_000;

function replacementDue(flight: PaymentFlight, requiredValueWei: bigint, urgent: boolean): boolean {
  if (flight.delivery === "queued") return false;
  if (urgent && (requiredValueWei !== flight.valueWei || flight.source !== "defense")) return true;
  return Date.now() - flight.submittedAtMs >= PAYMENT_REPLACEMENT_AFTER_MS;
}

async function act(
  intent: TxIntent,
  kind: "pay-taxes" | "use-bribe" | "audit" | "kill",
  ctx: {
    tokenId?: string;
    targetTokenId?: string;
    message: string;
    race?: boolean;
    simTimestamp?: bigint;
    revertible?: boolean;
    /** Optional absolute cutoff for best-effort work riding a survival bundle. */
    deadlineMs?: number;
    payment?: PaymentActContext;
  },
): Promise<SubmitResult | null> {
  const dryRun = runtime.strategy.dryRun;
  const offense = kind === "audit" || kind === "kill";
  if (
    executingGeneration === null
    || !executionIsCurrent(executingGeneration)
  ) {
    activity.add({
      kind: "info",
      status: "skipped",
      tokenId: ctx.tokenId,
      targetTokenId: ctx.targetTokenId,
      message: `${ctx.message} — cancelled because the engine stopped`,
    });
    return null;
  }
  if (
    nonceManager.hasInvisibleReservation()
    && !ctx.payment?.replace
  ) {
    activity.add({
      kind: "info",
      status: "skipped",
      tokenId: ctx.tokenId,
      targetTokenId: ctx.targetTokenId,
      message: `${ctx.message} — waiting for a prior unacknowledged nonce to land or expire`,
    });
    return null;
  }
  try {
    const result = await submitTx(intent, {
      dryRun,
      // In mainnet mode a bundle only lands if a builder we sent it to wins the
      // slot — so PAYMENTS always mirror to the public mempool as a fallback: one
      // that never lands can cost a citizen, and a tax payment isn't meaningfully
      // front-runnable (rivals already see the delinquency on-chain).
      // A `revertible` tx (an audit riding behind a payment in one bundle) never
      // mirrors — the whole point is to keep the shared-nonce mempool sequence
      // clean so the payment still wins top-of-block.
      // OFFENSE stays opt-in (racePublicMempool) when offense runs alone. While
      // survival automation is active it also gets a public fallback: otherwise
      // a private-only offense nonce can invisibly fence an emergency payment.
      race: ctx.revertible
        ? false
        : offense
          ? Boolean(ctx.race && (
              runtime.strategy.racePublicMempool
              || runtime.strategy.enabled
              || runtime.strategy.jitEnabled
            ))
          : true,
      offense,
      simTimestamp: ctx.simTimestamp,
      revertible: ctx.revertible,
      deadlineMs: ctx.deadlineMs,
      signal: engineAbortController?.signal,
      replacement: ctx.payment?.replace
        ? {
            nonce: ctx.payment.replace.nonce,
            priorMaxFeePerGas: ctx.payment.replace.maxFeePerGas,
            priorMaxPriorityFeePerGas: ctx.payment.replace.maxPriorityFeePerGas,
          }
        : undefined,
    });
    if (!result.ok && !result.uncertain) {
      activity.add({
        kind,
        status: result.simulated ? "reverted" : "skipped",
        tokenId: ctx.tokenId,
        targetTokenId: ctx.targetTokenId,
        targetBlock: result.targetBlock?.toString(),
        message: `${ctx.message} — ${result.error ?? "failed"}`,
      });
      return result;
    }
    if (!dryRun) {
      const total = result.valueWei + result.gasWei;
      const prior = ctx.payment?.replace;
      const priorTotal = prior ? prior.valueWei + prior.gasWei : 0n;
      // Same-nonce alternatives are mutually exclusive. Count only the extra
      // worst-case liability instead of presenting every replacement as a second
      // full payment in spend telemetry.
      runtime.recordSpend(total > priorTotal ? total - priorTotal : 0n);
    }
    // Count it against this tick's budget so later canSpend checks in the same
    // tick see the reduced headroom (applies in dry-run too, to simulate faithfully).
    committedThisTickWei += result.valueWei + result.gasWei;
    let paymentFlight: PaymentFlight | undefined;
    let previousPaymentFlight: PaymentFlight | undefined;
    if (!dryRun && kind === "pay-taxes" && ctx.tokenId !== undefined && ctx.payment) {
      previousPaymentFlight = paymentFlights.get(ctx.tokenId);
      paymentFlight = {
        attemptId: ++nextPaymentAttemptId,
        account: runtime.account!.address,
        tokenId: ctx.tokenId,
        expectedLastEpochPaid: ctx.payment.expectedLastEpochPaid,
        nonce: result.nonce,
        valueWei: result.valueWei,
        gasWei: result.gasWei,
        maxFeePerGas: result.maxFeePerGas ?? 0n,
        maxPriorityFeePerGas: result.maxPriorityFeePerGas ?? 0n,
        txHash: result.txHash,
        source: ctx.payment.source,
        jitTargetEpoch: ctx.payment.jitTargetEpoch ?? previousPaymentFlight?.jitTargetEpoch ?? null,
        proactiveEpoch: ctx.payment.proactiveEpoch ?? previousPaymentFlight?.proactiveEpoch ?? null,
        proactiveMarkerReserved:
          Boolean(ctx.payment.reserveProactiveMarker)
          || Boolean(previousPaymentFlight?.proactiveMarkerReserved),
        submittedAtMs: Date.now(),
        delivery: result.queued ? "queued" : "submitted",
      };
      paymentFlights.set(ctx.tokenId, paymentFlight);
    }
    const entry = activity.add({
      kind,
      status: dryRun ? "dry-run" : "submitted",
      tokenId: ctx.tokenId,
      targetTokenId: ctx.targetTokenId,
      txHash: result.txHash,
      bundleHash: result.bundleHash,
      targetBlock: result.targetBlock?.toString(),
      valueWei: result.valueWei.toString(),
      gasWei: result.gasWei.toString(),
      message: dryRun ? `[dry-run] ${ctx.message}` : ctx.message,
    });
    runtime.emitStatus();
    // Queued into a bundle batch (mainnet): the tx isn't sent yet, so its hashes
    // and receipt tracking are reconciled by flushBatch at end of tick.
    if (result.queued) {
      batchEntries.push({
        entryId: entry.id,
        nonce: result.nonce,
        message: ctx.message,
        paymentAttemptId: paymentFlight?.attemptId,
        paymentTokenId: paymentFlight?.tokenId,
        previousPaymentFlight,
      });
      return result;
    }
    // Watch for the receipt so the entry flips submitted -> included/reverted.
    // Only public-mempool submissions expose a tx hash; pure Flashbots bundles
    // (bundleHash only) stay "submitted" since there's nothing to poll.
    if (!dryRun && result.txHash) {
      void trackReceipt(entry.id, result.txHash, paymentFlight);
    }
    return result;
  } catch (err) {
    activity.add({
      kind: "error",
      status: "skipped",
      tokenId: ctx.tokenId,
      targetTokenId: ctx.targetTokenId,
      message: `${ctx.message} — error: ${(err as Error).message}`,
    });
    return null;
  }
}

async function defensePass(
  ownedIds: bigint[],
  currentEpoch: bigint,
  nowSec: bigint,
): Promise<void> {
  const s = runtime.strategy;
  // Cap how many epochs a single auto payment covers (the on-chain estimate is
  // read for this many). Default cap 1 = pay one day to clear, as before.
  const epochs = cappedAutoPayEpochs(s.prepayEpochs, s.maxAutoPayEpochs);
  const statuses = await batchGetOwnedStatuses(ownedIds, currentEpoch, nowSec, epochs);
  for (const st of statuses) {
    const tokenId = BigInt(st.tokenId);
    const lastEpochPaid = BigInt(st.lastEpochPaid);
    const pending = pendingPaymentFor(st.tokenId, lastEpochPaid);
    const underAudit = st.auditDueTimestamp !== "0";
    const bribes = BigInt(st.bribeBalance);

    // 1) Under audit and within safety buffer -> clear it.
    if (underAudit && (st.secondsUntilKillable ?? 0) <= s.auditSafetyBufferSeconds) {
      // Only spend a bribe if the user opted in — a bribe clears the audit for free
      // but is consumed and leaves the token delinquent (re-auditable), so by
      // default we pay taxes to clear instead and never auto-consume bribes.
      if (!pending && s.autoUseBribe && bribes > 0n) {
        // Bribe is free (value 0) but still costs gas — apply the same guardrail
        // as the pay-to-clear path below so the base-fee cap holds consistently.
        const guard = await canSpend(0n, false);
        if (!guard.ok) {
          activity.add({ kind: "use-bribe", status: "skipped", tokenId: st.tokenId, message: `Defer bribe clear #${st.tokenId}: ${guard.reason}` });
          continue;
        }
        await act(
          { to: appConfig.gameAddress, data: encodeUseBribe(tokenId), value: 0n },
          "use-bribe",
          { tokenId: st.tokenId, message: `Clear audit on #${st.tokenId} with bribe` },
        );
        continue;
      }
      const value = BigInt(st.estimatedPayWei); // estimate for `epochs` (capped)
      if (pending && !replacementDue(pending, value, true)) continue;
      const guard = await canSpend(value, false, pending);
      if (!guard.ok) {
        activity.add({ kind: "pay-taxes", status: "skipped", tokenId: st.tokenId, message: `Defer pay #${st.tokenId}: ${guard.reason}` });
        continue;
      }
      await act(
        { to: appConfig.gameAddress, data: encodePayTaxes(tokenId, epochs), value },
        "pay-taxes",
        {
          tokenId: st.tokenId,
          message: `${pending ? "Replace pending payment and clear" : "Pay taxes on"} audited #${st.tokenId} (${epochs} epoch) = ${formatEther(value)} ETH`,
          payment: {
            expectedLastEpochPaid: lastEpochPaid + BigInt(epochs),
            source: "defense",
            replace: pending,
          },
        },
      );
      continue;
    }
  }
}

/**
 * Pay delinquent-but-not-yet-audited citizens. This runs on every tick as the
 * reliable fallback when a pre-boundary tax-skip payment was missed or lost.
 */
async function proactivePayPass(
  ownedIds: bigint[],
  currentEpoch: bigint,
  nowSec: bigint,
): Promise<void> {
  const s = runtime.strategy;
  if (proactivePaySubmittedEpoch !== currentEpoch) {
    proactivePaySubmittedEpoch = currentEpoch;
    proactivePaySubmitted = new Set();
  }
  // Cap how many epochs a single auto payment covers (so it can't spend a large
  // multi-day catch-up in one shot); the on-chain estimate is read for that many.
  const epochs = cappedAutoPayEpochs(s.prepayEpochs, s.maxAutoPayEpochs);
  const statuses = await batchGetOwnedStatuses(ownedIds, currentEpoch, nowSec, epochs);
  for (const st of statuses) {
    const tokenId = BigInt(st.tokenId);
    const key = st.tokenId;
    const lastEpochPaid = BigInt(st.lastEpochPaid);
    const pending = pendingPaymentFor(key, lastEpochPaid);

    const underAudit = st.auditDueTimestamp !== "0";
    if (underAudit || st.risk !== "delinquent") continue;

    const value = BigInt(st.estimatedPayWei); // estimate for `epochs` (capped)
    if (value === 0n) continue;
    if (pending && !replacementDue(pending, value, false)) continue;
    if (!pending && proactivePaySubmitted.has(key)) continue;
    const guard = await canSpend(value, false, pending);
    if (!guard.ok) {
      activity.add({ kind: "pay-taxes", status: "skipped", tokenId: st.tokenId, message: `Defer proactive pay #${st.tokenId}: ${guard.reason}` });
      continue;
    }
    proactivePaySubmitted.add(key); // reserve locally while the async submission is in flight
    const res = await act(
      { to: appConfig.gameAddress, data: encodePayTaxes(tokenId, epochs), value },
      "pay-taxes",
      {
        tokenId: st.tokenId,
        message: `${pending ? "Replace pending" : "Proactive"} pay #${st.tokenId} (${epochs} epoch) = ${formatEther(value)} ETH`,
        payment: {
          expectedLastEpochPaid: lastEpochPaid + BigInt(epochs),
          source: "proactive",
          replace: pending,
          proactiveEpoch: currentEpoch,
          reserveProactiveMarker: true,
        },
      },
    );
    if ((!res || (!res.ok && !res.uncertain)) && !pending) {
      proactivePaySubmitted.delete(key); // a definite failed first send must be retryable next tick
    }
  }
}

/**
 * Just-in-time single-epoch payment. When armed for a target epoch, pays exactly
 * one epoch for each selected token the moment the chain reaches that epoch, then
 * auto-disarms. Reads the exact owed amount on-chain so the value is always correct.
 */
async function jitPass(
  ownedIds: bigint[],
  currentEpoch: bigint,
  nowSec: bigint,
): Promise<void> {
  const s = runtime.strategy;
  if (!s.jitEnabled || s.jitTargetEpoch === null) return;
  const target = s.jitTargetEpoch;
  if (Number(currentEpoch) < target) return; // target epoch hasn't begun yet

  prepareJitBookkeeping();

  const selected = selectedOwnedJitTokenIds(ownedIds);
  if (selected.length === 0) return; // nothing owned yet — stay armed

  const statuses = await batchGetOwnedStatuses(selected, currentEpoch, nowSec, 1);
  for (const st of statuses) {
    const tokenId = BigInt(st.tokenId);
    const key = st.tokenId;
    const lastEpochPaid = BigInt(st.lastEpochPaid);
    const pending = pendingPaymentFor(key, lastEpochPaid);
    if (jitSubmitted.has(key)) continue;

    if (lastEpochPaid >= currentEpoch) {
      jitSubmitted.add(key); // confirmed current for this epoch
      continue;
    }
    // JIT pays exactly one epoch — one day — which advances the citizen a single
    // epoch no matter how far behind, so it always fires (even when momentarily 2
    // behind at the boundary). It never pays a multi-day catch-up; if one 1-day
    // payment isn't enough to make a deeply-behind citizen safe, the rest is left
    // for the user (this pays once and marks the token handled below).
    const value = BigInt(st.estimatedPayWei); // estimateTaxesToPay(tokenId, 1) = one day
    if (value === 0n) {
      jitSubmitted.add(key);
      continue;
    }
    if (pending && !replacementDue(pending, value, false)) continue;
    const guard = await canSpend(value, false, pending);
    if (!guard.ok) {
      activity.add({ kind: "pay-taxes", status: "skipped", tokenId: key, message: `Defer JIT pay #${key}: ${guard.reason}` });
      continue; // retry next tick — do not mark submitted
    }
    const res = await act(
      { to: appConfig.gameAddress, data: encodePayTaxes(tokenId, 1), value },
      "pay-taxes",
      {
        tokenId: key,
        message: `${pending ? "Replace pending JIT" : "JIT"} pay #${key} for epoch ${currentEpoch} = ${formatEther(value)} ETH`,
        payment: {
          expectedLastEpochPaid: lastEpochPaid + 1n,
          source: "jit",
          replace: pending,
          jitTargetEpoch: target,
        },
      },
    );
    // Stay armed until a fresh on-chain read confirms lastEpochPaid advanced.
    // A relay/bundle acknowledgement is delivery, not inclusion.
    if (!res || (!res.ok && !res.uncertain)) continue;
  }

  // One-shot: disarm once every selected token has been submitted/covered.
  if (selected.every((t) => jitSubmitted.has(t.toString()))) {
    runtime.saveStrategy({ jitEnabled: false, jitTargetEpoch: null });
    activity.add({ kind: "info", status: "info", message: `JIT payment complete for epoch ${target}; disarmed.` });
  }
}

/**
 * Build the pool of owned tokens usable as audit "from" tokens this tick — each
 * not itself auditable and still under its per-epoch audit limit. Reading
 * auditsUsedInEpoch on-chain means audits already spent earlier this epoch (even
 * in a prior tick) are excluded, so we never exceed a token's limit and hit
 * AuditLimitReached. A token may audit up to `auditLimit` DISTINCT targets per
 * epoch (auditor-role citizens have limit > 1), so it is added to the pool once
 * per *remaining* audit — `auditLimit - auditsUsedInEpoch` times — and each entry
 * backs one audit of a different rival.
 */
async function findEligibleAuditors(ownedIds: bigint[], currentEpoch: bigint): Promise<bigint[]> {
  if (ownedIds.length === 0) return [];
  const results = await publicClient.multicall({
    allowFailure: true,
    contracts: ownedIds.flatMap((id) => [
      { ...gameContract, functionName: "lastEpochPaid" as const, args: [id] as const },
      { ...gameContract, functionName: "auditsUsedInEpoch" as const, args: [id, currentEpoch] as const },
      { ...gameContract, functionName: "auditLimit" as const, args: [id] as const },
    ]),
  });
  const eligible: bigint[] = [];
  for (let i = 0; i < ownedIds.length; i++) {
    const lep = results[i * 3];
    const used = results[i * 3 + 1];
    const limit = results[i * 3 + 2];
    if (lep?.status !== "success" || used?.status !== "success" || limit?.status !== "success") continue;
    const lepV = lep.result as bigint;
    const usedV = used.result as bigint;
    const limitV = limit.result as bigint;
    if (!isEligibleAuditor(lepV, currentEpoch, usedV, limitV)) continue;
    // Remaining capacity this epoch (>= 1 given isEligibleAuditor); one pool entry each.
    for (let k = usedV; k < limitV; k++) eligible.push(ownedIds[i]!);
  }
  return eligible;
}

async function offensePass(
  ownedIds: bigint[],
  currentEpoch: bigint,
  nowSec: bigint,
): Promise<void> {
  const s = runtime.strategy;
  if (!s.offenseEnabled) return;

  // Endgame gate.
  if (s.endgameOnlyWithin !== null) {
    const supply = runtime.citizenSupply ?? 0n;
    if (supply - WINNERS > BigInt(s.endgameOnlyWithin)) return;
  }

  const candidateIds = await fetchCandidateTokenIds(runtime.citizensAddress as Address);
  const liveRaw = await filterLiveTokenIds(runtime.citizensAddress as Address, candidateIds);
  const live = orderBySalt(liveRaw, (t) => t.id.toString(), engineSalt);
  const owned = new Set(ownedIds.map((x) => x.toString()));
  const pinned = s.offenseTargetTokenIds.length > 0 ? new Set(s.offenseTargetTokenIds) : null;

  // Narrow to tokens we could actually act on BEFORE reading their status, then
  // fetch all their statuses in ONE multicall — a serial getTargetStatus per
  // token was hundreds/thousands of sequential RPC round-trips when offense
  // targets the whole field (viem's http batching can't coalesce awaited calls).
  const candidates = live.filter(({ id }) => {
    const key = id.toString();
    if (owned.has(key)) return false; // never audit our own
    if (pinned && !pinned.has(key)) return false; // not on the target list
    return true;
  });

  // The auditor pool (owned tokens usable as an audit "from" this tick — each
  // backs one audit, since a token audits at most `auditLimit` times/epoch) and
  // the target statuses are independent reads, so fetch them concurrently. We hand
  // auditors out one per target so multiple rivals can be audited in a single
  // epoch instead of reusing one token and reverting with AuditLimitReached.
  const [auditors, statuses] = await Promise.all([
    findEligibleAuditors(ownedIds, currentEpoch),
    batchGetTargetStatuses(candidates, currentEpoch, nowSec),
  ]);
  let auditorIdx = 0;
  let noAuditorSkips = 0;

  // Track the soonest not-yet-expired audit deadline so the boundary scheduler
  // can pre-empt the exact moment a kill becomes valid. Reset each sweep.
  let soonestKillDeadline: bigint | null = null;

  for (const t of statuses) {
    const tokenId = BigInt(t.tokenId);

    // Note the nearest future kill deadline (token under audit, not yet expired).
    const due = BigInt(t.auditDueTimestamp);
    if (due > nowSec && (soonestKillDeadline === null || due < soonestKillDeadline)) {
      soonestKillDeadline = due;
    }

    if (s.autoKill && t.killable) {
      const guard = await canSpend(0n, true);
      if (!guard.ok) continue;
      await act(
        { to: appConfig.gameAddress, data: encodeKill(tokenId), value: 0n },
        "kill",
        { targetTokenId: t.tokenId, message: `Kill expired-audit #${t.tokenId}`, race: true },
      );
      continue;
    }

    if (s.autoAudit && t.auditable) {
      if (auditorIdx >= auditors.length) { noAuditorSkips++; continue; } // out of usable auditor tokens
      const guard = await canSpend(AUDIT_COST_WEI, true);
      if (!guard.ok) continue;
      const auditFrom = auditors[auditorIdx]!;
      const res = await act(
        { to: appConfig.gameAddress, data: encodeAudit(auditFrom, tokenId), value: AUDIT_COST_WEI },
        "audit",
        { tokenId: auditFrom.toString(), targetTokenId: t.tokenId, message: `Audit delinquent #${t.tokenId} from #${auditFrom}`, race: true },
      );
      if (res?.ok) auditorIdx++; // consume this auditor only if the audit actually went out
    }
  }

  if (noAuditorSkips > 0) {
    activity.add({
      kind: "info",
      status: "info",
      message: `Audited ${auditorIdx} rival(s) this sweep; ${noAuditorSkips} more auditable but no eligible auditor token left (each audits up to its per-epoch limit).`,
    });
  }

  // Publish the nearest kill deadline and (re)arm the pre-emptive boundary tick.
  nextKillDeadlineSec = soonestKillDeadline;
  scheduleOffenseBoundary();
  schedulePreBoundaryKill();
}

async function tick(generation = engineGeneration): Promise<void> {
  if (ticking) return;
  if (!executionIsCurrent(generation) || !runtime.unlocked || !runtime.account) return;
  ticking = true;
  executingGeneration = generation;
  committedThisTickWei = 0n; // fresh spend budget for this tick
  beginBatch();
  const address = runtime.account.address;
  try {
    // Snapshot + nonce sync are independent RPC reads — run them together so the
    // boundary tick shaves a round-trip before it can submit anything.
    await Promise.all([
      refreshSnapshot(address),
      nonceManager.sync(address, appConfig.mode),
    ]);

    if (runtime.gameState !== 1) {
      // Not LIVE — nothing to do.
      return;
    }
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const currentEpoch = runtime.currentEpoch ?? 0n;

    const ownedIds = await fetchOwnedTokenIds(runtime.citizensAddress as Address, address);
    await reconcilePaymentFlights(address);

    if (runtime.strategy.enabled) {
      prepareJitBookkeeping();
      await defensePass(ownedIds, currentEpoch, nowSec);
      if (runtime.strategy.proactivePay) {
        await proactivePayPass(ownedIds, currentEpoch, nowSec);
      }
    }
    // JIT is independently armable through the config API and must continue even
    // when continuous defense is disabled.
    await jitPass(ownedIds, currentEpoch, nowSec);

    // Survival payments and best-effort offense must never share one atomic
    // bundle: a raced/stale audit or kill can legitimately revert and must not
    // suppress otherwise-valid defensive payments.
    if (!executionIsCurrent(generation)) return;
    await flushBatch();
    if (!executionIsCurrent(generation)) return;
    // A payment nonce that has not yet advanced on-chain is a hard fence for
    // best-effort offense. Deferring offense avoids constructing a second private
    // bundle above that nonce (which cannot execute independently).
    if (appConfig.mode === "mainnet" && paymentFlights.size > 0) return;
    beginBatch();
    await offensePass(ownedIds, currentEpoch, nowSec);
  } catch (err) {
    logger.error("tick error:", (err as Error).message);
    activity.add({ kind: "error", status: "skipped", message: `Tick error: ${(err as Error).message}` });
  } finally {
    await flushOrDiscardBatch(generation);
    nonceManager.reset();
    finishExclusive(generation);
  }
}
