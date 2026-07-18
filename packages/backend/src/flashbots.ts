import fs from "node:fs";
import path from "node:path";
import { keccak256, toHex, type Address, type Block, type Hex } from "viem";
import {
  privateKeyToAccount,
  generatePrivateKey,
  type PrivateKeyAccount,
} from "viem/accounts";
import { mainnet } from "viem/chains";
import { publicClient, getLatestBlockCached } from "./chain.js";
import { appConfig } from "./config.js";
import { runtime } from "./runtime.js";
import { nonceManager } from "./nonce.js";
import { cappedReplacementFees, effectiveTipGwei, resolveGas } from "./logic.js";
import { logger } from "./logger.js";

export interface TxIntent {
  to: Address;
  data: Hex;
  value: bigint;
  /** Optional gas override; estimated if omitted. */
  gas?: bigint;
}

export interface SubmitResult {
  ok: boolean;
  /** A signed transaction was handed to at least one delivery path, but no path
   * acknowledged it. The nonce/hash must be retained because transport failure
   * is ambiguous: the remote endpoint may have accepted the request. */
  uncertain?: boolean;
  simulated: boolean;
  txHash?: Hex;
  bundleHash?: string;
  targetBlock?: bigint;
  nonce: number;
  valueWei: bigint;
  gasWei: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  error?: string;
  /** mainnet only: the tx was prepared + queued into an open bundle batch rather
   *  than sent immediately. Its deterministic txHash is already known; delivery
   *  success and bundleHash are reconciled later by flushBundle. */
  queued?: boolean;
}

export interface ReplacementOptions {
  nonce: number;
  priorMaxFeePerGas: bigint;
  priorMaxPriorityFeePerGas: bigint;
}

// --- Flashbots reputation signer (identity only; holds no funds) ---

function reputationSigner(): PrivateKeyAccount {
  const p = path.join(appConfig.dataDir, "flashbots-signer.key");
  let pk: Hex;
  if (fs.existsSync(p)) {
    pk = fs.readFileSync(p, "utf8").trim() as Hex;
  } else {
    pk = generatePrivateKey();
    fs.mkdirSync(appConfig.dataDir, { recursive: true });
    fs.writeFileSync(p, pk, { mode: 0o600 });
    logger.info("Generated a new Flashbots reputation key.");
  }
  return privateKeyToAccount(pk);
}
// Lazily initialized so switching mode from public→mainnet at runtime works.
let _signer: PrivateKeyAccount | null = null;
function getSigner(): PrivateKeyAccount {
  if (!_signer) _signer = reputationSigner();
  return _signer;
}

/** POST a bundle RPC to one builder/relay. `url` defaults to the Flashbots relay
 *  (the only endpoint that implements eth_callBundle for simulation). */
async function flashbotsRpc(
  method: string,
  params: unknown[],
  signal?: AbortSignal,
  url: string = appConfig.flashbotsRelayUrl,
): Promise<any> {
  const signer = getSigner();
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  // Flashbots requires this reputation signature; other builders accept or ignore it.
  const signature = `${signer.address}:${await signer.signMessage({
    message: keccak256(toHex(body)),
  })}`;
  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "X-Flashbots-Signature": signature,
    },
    body,
  });
  const json = (await res.json()) as { error?: { message: string }; result?: any };
  if (json.error) throw new Error(`${method} @${hostOf(url)}: ${json.error.message}`);
  return json.result;
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

// --- fee + gas ---

// Pure — takes an already-fetched block so the caller can share one read across
// the fee calc, the gas estimate, and the target-block derivation.
function computeFees(offense: boolean, block: Block): {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  baseFee: bigint;
} {
  const gas = resolveGas(runtime.strategy, offense);
  const baseFee = block.baseFeePerGas ?? 0n;

  // Priority tip: static by default, or scaled up by block fullness when the
  // dynamic-tip edge is enabled (helps win inclusion in contested blocks).
  const tipGwei = effectiveTipGwei(gas, block.gasUsed, block.gasLimit);
  const priority = BigInt(Math.round(tipGwei * 1e9));
  const maxFeePerGas = baseFee * 2n + priority;
  return { maxFeePerGas, maxPriorityFeePerGas: priority, baseFee };
}

async function estimateGas(account: Address, intent: TxIntent): Promise<bigint> {
  if (intent.gas) return intent.gas;
  const est = await publicClient.estimateGas({
    account,
    to: intent.to,
    data: intent.data,
    value: intent.value,
  });
  return (est * 12n) / 10n; // +20% buffer
}

async function signTx(
  account: PrivateKeyAccount,
  intent: TxIntent,
  nonce: number,
  gas: bigint,
  maxFeePerGas: bigint,
  maxPriorityFeePerGas: bigint,
): Promise<Hex> {
  return account.signTransaction({
    to: intent.to,
    data: intent.data,
    value: intent.value,
    gas,
    nonce,
    maxFeePerGas,
    maxPriorityFeePerGas,
    chainId: mainnet.id,
    type: "eip1559",
  });
}

/**
 * Build, (optionally simulate), and submit a single tx.
 * - dryRun: builds + simulates, never sends.
 * - mainnet: submits as a Flashbots bundle (block+1, block+2) after eth_callBundle sim.
 * - local: broadcasts the raw tx to the node (anvil).
 */
const RELAY_TIMEOUT_MS = 10_000;
// Bundle submission is time-critical and fans out to several builders: a slow or
// dead endpoint must not hold up the caller (submitTx awaits all attempts, so a
// 10s hang would stall every later token in a boundary race). Healthy builders
// ack in <1s, and one that can't answer before the block is built is useless to us.
const SEND_BUNDLE_TIMEOUT_MS = 3_000;
// Whole-bundle validation is valuable, but it sits directly in front of both
// private fanout and the public safety mirror. Give the relay a sub-slot budget,
// then fail open to the per-transaction checks if it is unavailable.
const BUNDLE_SIM_TIMEOUT_MS = 500;

class SubmissionDeadlineError extends Error {}

async function beforeSubmissionDeadline<T>(
  promise: Promise<T>,
  deadlineMs: number | undefined,
  label: string,
): Promise<T> {
  if (deadlineMs === undefined) return promise;
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) throw new SubmissionDeadlineError(`${label} missed its submission deadline`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new SubmissionDeadlineError(`${label} missed its submission deadline`)),
          remainingMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function flashbotsRpcWithTimeout(
  method: string,
  params: unknown[],
  url?: string,
  timeoutMs: number = RELAY_TIMEOUT_MS,
): Promise<any> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    return await flashbotsRpc(method, params, abort.signal, url);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Simulate an intent whose validity depends on a FUTURE block timestamp (the
 * pre-boundary races: the epoch hasn't rolled / the audit hasn't expired yet, so a
 * normal sim against "now" would wrongly revert). We re-run the call at `atTime`
 * via eth_call block overrides, which reproduces the exact context the tx will
 * execute in. Returns null when the sim passed, a revert message when the contract
 * rejected it, or throws if the RPC can't do block overrides (caller decides).
 */
async function simulateAtTimestamp(
  from: Address,
  intent: TxIntent,
  gas: bigint,
  atTime: bigint,
): Promise<string | null> {
  try {
    await (publicClient as unknown as {
      request: (a: { method: string; params: unknown[] }) => Promise<unknown>;
    }).request({
      method: "eth_call",
      params: [
        { from, to: intent.to, data: intent.data, value: toHex(intent.value), gas: toHex(gas) },
        "latest",
        {}, // no state overrides — the wallet's real balance applies
        { time: toHex(atTime) }, // block overrides: run at the boundary/expiry instant
      ],
    });
    return null; // simulated clean
  } catch (err) {
    const e = err as { message?: string; data?: unknown; code?: number };
    const msg = e.message ?? String(err);
    // A contract revert => the action is genuinely invalid: report it.
    if (e.data !== undefined || /revert|execution reverted/i.test(msg)) return msg;
    // Anything else (RPC lacks block-override support, transport error) => rethrow
    // so the caller can decide whether to proceed unsimulated.
    throw err;
  }
}

// --- Bundle batching (mainnet only) ---
// Every Citizen you hold is owned by the same wallet, so multiple payments/audits
// in one tick share a single nonce sequence. Sent as independent single-tx
// bundles, only the first (nonce == chain nonce) is a self-valid bundle; the rest
// carry a nonce gap and won't be placed top-of-block by builders (bundle merging
// across independent bundles is best-effort). Collecting a tick's txs into ONE
// atomic multi-tx bundle keeps the nonces valid in order and gives builders one
// coherent sequence to consider. Only meaningful in mainnet mode;
// public/local submit directly (future-valid races wait for simTimestamp).
interface QueuedTx {
  signed: Hex;
  txHash: Hex;
  nonce: number;
  race: boolean;
  /** Allowed to revert without invalidating the bundle (eth_sendBundle
   *  revertingTxHashes). Used for the optional audit riding behind a mandatory
   *  payment, so a reverting audit can never drop the payment from the bundle. */
  revertible: boolean;
  reserved: boolean;
  /** Future timestamp used by pre-boundary transactions. A flushed bundle must
   *  be simulated at the same timestamp as its constituent transactions. */
  simTimestamp?: bigint;
  /** Cancels a delayed public mirror when its engine generation is stopped. */
  signal?: AbortSignal;
}
let bundleQueue: QueuedTx[] | null = null;

/** Open a batching window: subsequent mainnet submitTx calls queue their signed
 *  tx instead of sending, until flushBundle() emits them as one bundle. */
export function beginBundle(): void {
  bundleQueue = [];
}

export interface BundleTxResult {
  ok: boolean;
  /** Delivery was attempted but not acknowledged; retain and reconcile this
   * deterministic hash rather than recycling its nonce. */
  uncertain?: boolean;
  txHash?: Hex;
  bundleHash?: string;
  error?: string;
}

/** Close an open batch that is known not to have left this process. Unlike an
 * attempted flush, discarding is a definite pre-send failure, so fresh contiguous
 * reservations can be released safely and callers can reconcile every entry. */
export function discardBundle(error = "bundle discarded before submission"): Map<number, BundleTxResult> {
  const queue = bundleQueue;
  bundleQueue = null;
  const out = new Map<number, BundleTxResult>();
  if (!queue || queue.length === 0) return out;
  queue.sort((a, b) => a.nonce - b.nonce);
  releaseQueuedReservations(queue);
  for (const q of queue) out.set(q.nonce, { ok: false, error });
  return out;
}

interface BundleSimulationIssue {
  failure: string;
  /** Null means the relay reported a bundle-wide error rather than a tx result. */
  index: number | null;
}

/** Extract the first non-permitted failure from an eth_callBundle response.
 * Transport/relay failures are thrown by flashbotsRpc and handled separately so
 * a relay outage cannot suppress the public-mempool safety path. */
function bundleSimulationIssue(sim: any, queue?: readonly QueuedTx[]): BundleSimulationIssue | null {
  if (sim?.error) return { failure: String(sim.error), index: null };
  const results = sim?.results ?? [];
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    if (!result?.error && !result?.revert) continue;
    const failure = String(result.error ?? result.revert);
    const explicitlyRevertible = queue?.[index]?.revertible === true;
    const contractRevert = result.revert !== undefined || /revert|execution reverted/i.test(failure);
    // eth_sendBundle's revertingTxHashes permits only the explicitly marked
    // transaction to revert. Never forgive a mandatory payment failure, a global
    // simulation error, or structural failures such as an invalid nonce.
    if (explicitlyRevertible && contractRevert) continue;
    return { failure, index };
  }
  return null;
}

function bundleSimulationFailure(sim: any, queue?: readonly QueuedTx[]): string | null {
  return bundleSimulationIssue(sim, queue)?.failure ?? null;
}

function bundleHashFromResult(result: any): string | undefined {
  if (typeof result === "string") return result;
  return typeof result?.bundleHash === "string" ? result.bundleHash : undefined;
}

function isNonceGapSimulationFailure(error: string): boolean {
  return /nonce\s+(?:too\s+(?:high|low)|gap|mismatch)|invalid\s+nonce|account\s+nonce|expected\s+nonce/i.test(error);
}

function releaseQueuedReservations(queue: readonly QueuedTx[]): void {
  const reservedNonces = queue.filter((q) => q.reserved).map((q) => q.nonce);
  if (reservedNonces.length > 0) nonceManager.releaseContiguous(reservedNonces);
}

function abortQueuedBeforeDelivery(
  queue: readonly QueuedTx[],
  out: Map<number, BundleTxResult>,
): boolean {
  if (!queue.some((q) => q.signal?.aborted)) return false;
  const error = "bundle submission aborted before delivery";
  for (const q of queue) out.set(q.nonce, { ok: false, error });
  releaseQueuedReservations(queue);
  return true;
}

type PublicMirrorState = "accepted" | "uncertain" | "untouched";

interface PublicMirrorTx {
  signed: Hex;
  txHash: Hex;
  nonce: number;
  race: boolean;
  simTimestamp?: bigint;
  signal?: AbortSignal;
}

interface PublicMirrorResult {
  state: PublicMirrorState;
  error?: string;
}

function isAlreadyKnownError(err: unknown): boolean {
  const message = (err as { message?: string })?.message ?? String(err);
  return /already known|known transaction|already imported/i.test(message);
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("delay aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("delay aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Wait until a future-valid transaction can safely enter the public mempool.
 * Chunking keeps very distant timestamps within Node's timer range; AbortSignal
 * makes outstanding waits cancellable and deterministic under fake timers. */
async function waitUntilTimestamp(atTime: bigint | undefined, signal?: AbortSignal): Promise<void> {
  if (atTime === undefined) return;
  const targetMs = atTime * 1_000n;
  while (targetMs > BigInt(Date.now())) {
    const remaining = targetMs - BigInt(Date.now());
    const chunk = Number(remaining > 2_000_000_000n ? 2_000_000_000n : remaining);
    await abortableDelay(chunk, signal);
  }
}

async function sendPublicMirror(tx: PublicMirrorTx, signal: AbortSignal): Promise<PublicMirrorResult> {
  try {
    await waitUntilTimestamp(tx.simTimestamp, signal);
  } catch (err) {
    if (signal.aborted) return { state: "uncertain", error: "public broadcast aborted" };
    throw err;
  }
  if (signal.aborted) return { state: "uncertain", error: "public broadcast aborted" };
  try {
    await publicClient.sendRawTransaction({ serializedTransaction: tx.signed });
    return { state: "accepted" };
  } catch (err) {
    if (isAlreadyKnownError(err)) return { state: "accepted" };
    const error = (err as Error).message;
    logger.warn(`public broadcast (nonce ${tx.nonce}) uncertain:`, error);
    return { state: "uncertain", error };
  }
}

/** Public fallback is deliberately a nonce-ordered prefix. Once one transaction
 * is private-only or ambiguous, sending later nonces would create a queued tx
 * above a gap if no builder accepts the atomic bundle. */
async function mirrorPublicSequentially(
  queue: readonly PublicMirrorTx[],
): Promise<Map<number, PublicMirrorResult>> {
  const out = new Map<number, PublicMirrorResult>();
  for (const q of queue) out.set(q.nonce, { state: "untouched" });
  for (const q of queue) {
    if (!q.race) break;
    const signal = q.signal ?? new AbortController().signal;
    const result = await sendPublicMirror(q, signal);
    out.set(q.nonce, result);
    if (result.state !== "accepted") break;
  }
  return out;
}

// Give the intended private boundary bundles one full slot before publishing an
// optional revertible suffix. If only the payment prefix lands publicly, this
// fallback eventually consumes the reserved audit nonce instead of fencing later
// survival transactions behind an invisible private nonce for the full stale
// reservation window.
const REVERTIBLE_SUFFIX_FALLBACK_DELAY_SECONDS = 12n;
const suffixFallbackJobs = new Set<Promise<void>>();

/** Lifecycle callers use this after aborting the engine. A scheduled timer exits
 * immediately on abort; a raw send that already started is allowed to settle so
 * an old wallet cannot still be broadcasting after an identity/config change. */
export async function waitForBundleFallbacks(): Promise<void> {
  while (suffixFallbackJobs.size > 0) {
    await Promise.allSettled([...suffixFallbackJobs]);
  }
}

function scheduleRevertibleSuffixFallback(
  queue: readonly QueuedTx[],
  mirrors: ReadonlyMap<number, PublicMirrorResult>,
): void {
  const firstRevertible = queue.findIndex((q) => q.revertible);
  if (firstRevertible < 0) return;
  const prefix = queue.slice(0, firstRevertible);
  if (prefix.length === 0 || !prefix.every((q) => mirrors.get(q.nonce)?.state === "accepted")) return;

  const suffix = queue.slice(firstRevertible);
  const latestBoundary = suffix.reduce(
    (latest, q) => q.simTimestamp !== undefined && q.simTimestamp > latest ? q.simTimestamp : latest,
    BigInt(Math.floor(Date.now() / 1000)),
  );
  const fallbackTimestamp = latestBoundary + REVERTIBLE_SUFFIX_FALLBACK_DELAY_SECONDS;

  const job = (async () => {
    for (const q of suffix) {
      const signal = q.signal ?? new AbortController().signal;
      if (signal.aborted) return;
      try {
        await waitUntilTimestamp(fallbackTimestamp, signal);
        if (signal.aborted) return;
        await publicClient.sendRawTransaction({ serializedTransaction: q.signed });
        logger.info(`published delayed audit fallback for nonce ${q.nonce}`);
      } catch (err) {
        if (signal.aborted) return;
        const message = (err as Error).message;
        // These responses mean the identical nonce is already pending, mined, or
        // superseded. In each case there is no useful retry for this signed tx.
        if (isAlreadyKnownError(err) || /nonce too low|replacement transaction underpriced/i.test(message)) return;
        logger.warn(`delayed audit fallback (nonce ${q.nonce}) failed:`, message);
        return;
      }
    }
  })();
  suffixFallbackJobs.add(job);
  void job.then(
    () => suffixFallbackJobs.delete(job),
    () => suffixFallbackJobs.delete(job),
  );
}

function sendBundleParams(
  txs: readonly Hex[],
  blockNumber: bigint,
  minTimestamp?: bigint,
  revertingTxHashes: readonly Hex[] = [],
): Record<string, unknown> {
  const params: Record<string, unknown> = { txs, blockNumber: toHex(blockNumber) };
  if (minTimestamp !== undefined) params.minTimestamp = Number(minTimestamp);
  if (revertingTxHashes.length > 0) params.revertingTxHashes = revertingTxHashes;
  return params;
}

/**
 * Send everything queued since beginBundle() as a single atomic multi-tx bundle
 * (txs in ascending-nonce order) per target block, mirroring each race-flagged tx
 * to the public mempool as a fallback. Returns a per-nonce result map so the
 * caller can fill in each activity entry's hashes and start receipt tracking.
 * Always closes the batching window, even on error.
 */
export async function flushBundle(): Promise<Map<number, BundleTxResult>> {
  const queue = bundleQueue;
  bundleQueue = null;
  const out = new Map<number, BundleTxResult>();
  if (!queue || queue.length === 0) return out;
  if (abortQueuedBeforeDelivery(queue, out)) return out;

  // A bundle executes its txs in the given order, so nonces must ascend. Mandatory
  // txs (payments) come first at lower nonces; revertible txs (audits) follow.
  queue.sort((a, b) => a.nonce - b.nonce);
  const firstRevertible = queue.findIndex((q) => q.revertible);
  if (firstRevertible >= 0 && queue.slice(firstRevertible).some((q) => !q.revertible)) {
    const error = "bundle contains a mandatory transaction after a revertible suffix";
    for (const q of queue) out.set(q.nonce, { ok: false, error });
    releaseQueuedReservations(queue);
    return out;
  }
  let signedList = queue.map((q) => q.signed);
  // Txs explicitly allowed to revert without invalidating an otherwise valid
  // bundle. A tx's hash is the keccak of its signed serialization.
  let revertingTxHashes = queue.filter((q) => q.revertible).map((q) => q.txHash);
  let targetBlock: bigint;
  try {
    targetBlock = (await publicClient.getBlockNumber()) + 1n;
  } catch (err) {
    releaseQueuedReservations(queue); // no delivery attempt has started
    throw err;
  }
  if (abortQueuedBeforeDelivery(queue, out)) return out;

  // Individual eth_callBundle simulations cannot validate the second and later
  // transactions in a nonce sequence: on their own they have a nonce gap. The
  // final, ordered bundle is the unit builders execute, so validate that exact
  // list before sending it anywhere. Pre-boundary batches share one future block
  // timestamp; reject a malformed batch that somehow mixes different ones.
  const simulationTimestamps = [
    ...new Set(queue.flatMap((q) => q.simTimestamp === undefined ? [] : [q.simTimestamp.toString()])),
  ];
  if (simulationTimestamps.length > 1) {
    const error = "bundle contains conflicting simulation timestamps";
    for (const q of queue) out.set(q.nonce, { ok: false, error });
    releaseQueuedReservations(queue);
    return out;
  }
  const simTimestamp = simulationTimestamps[0] === undefined
    ? undefined
    : BigInt(simulationTimestamps[0]);
  const simParams: Record<string, unknown> = {
    txs: signedList,
    blockNumber: toHex(targetBlock),
    stateBlockNumber: "latest",
  };
  if (simTimestamp !== undefined) simParams.timestamp = Number(simTimestamp);

  try {
    const sim = await flashbotsRpcWithTimeout(
      "eth_callBundle",
      [simParams],
      undefined,
      BUNDLE_SIM_TIMEOUT_MS,
    );
    const issue = bundleSimulationIssue(sim, queue);
    if (issue) {
      // Optional suffix work must never suppress a clean mandatory prefix. A
      // permitted execution revert stays in the bundle, but any structural
      // suffix failure is removed before delivery and its fresh reservations are
      // rolled back. The mandatory results before this index already simulated
      // successfully in the same ordered call.
      if (
        issue.index !== null
        && firstRevertible >= 0
        && issue.index >= firstRevertible
      ) {
        const dropped = queue.splice(firstRevertible);
        releaseQueuedReservations(dropped);
        const error = `optional revertible suffix removed after simulation: ${issue.failure}`;
        for (const q of dropped) out.set(q.nonce, { ok: false, error });
        signedList = queue.map((q) => q.signed);
        revertingTxHashes = [];
        logger.warn(error);
        if (queue.length === 0) return out;
      } else if (isNonceGapSimulationFailure(issue.failure)) {
        // A replacement can legitimately be below the nonce manager's private
        // ceiling, while omitted private transactions fill the apparent gap.
        // Individual semantic calls already passed; let the public txpool decide
        // the same-nonce replacement instead of suppressing every delivery path.
        logger.warn(`whole-bundle nonce simulation mismatch (${issue.failure}); submitting individual fallbacks`);
      } else {
        const error = `bundle simulation reverted: ${issue.failure}`;
        for (const q of queue) out.set(q.nonce, { ok: false, error });
        releaseQueuedReservations(queue);
        return out;
      }
    }
  } catch (err) {
    // Preserve the availability-first safety policy used by single payments. A
    // slow/down simulation relay must not prevent the already individually
    // checked transactions from reaching builders and the public mempool.
    logger.warn(`whole-bundle simulation unavailable (${(err as Error).message}); submitting with individual checks`);
  }
  // stopEngine may have invalidated this generation while getBlockNumber or the
  // whole-bundle simulation was in flight. No delivery request has started yet,
  // so cancellation remains definite and fresh reservations can be released.
  if (abortQueuedBeforeDelivery(queue, out)) return out;

  // One multi-tx bundle, fanned out to every builder for the next two blocks.
  const acceptedBy = new Set<string>();
  const bundleHashes: string[] = [];
  const attempts = appConfig.builderUrls.flatMap((url) =>
    [targetBlock, targetBlock + 1n].map(async (blk) => {
      const r = await flashbotsRpcWithTimeout(
        "eth_sendBundle",
        [sendBundleParams(signedList, blk, simTimestamp, revertingTxHashes)],
        url,
        SEND_BUNDLE_TIMEOUT_MS,
      );
      return { url, bundleHash: bundleHashFromResult(r) };
    }),
  );

  // The ordered public-prefix fallback starts concurrently with builder fanout.
  // Future-valid transactions wait until their simulation timestamp before the
  // first send, so they cannot be mined/reverted in a pre-boundary block.
  const [settled, mirrors] = await Promise.all([
    Promise.allSettled(attempts),
    mirrorPublicSequentially(queue),
  ]);
  scheduleRevertibleSuffixFallback(queue, mirrors);
  for (const s of settled) {
    if (s.status === "fulfilled") {
      if (s.value.bundleHash) {
        acceptedBy.add(hostOf(s.value.url));
        bundleHashes.push(s.value.bundleHash);
      }
    } else {
      logger.warn("sendBundle failed:", (s.reason as Error).message);
    }
  }
  const bundleHash = bundleHashes[0];
  const bundleOk = bundleHashes.length > 0;
  if (acceptedBy.size > 0) {
    logger.info(
      `batched bundle (${queue.length} tx) accepted by ${acceptedBy.size}/${appConfig.builderUrls.length} builders: ${[...acceptedBy].join(", ")}`,
    );
  }

  for (const q of queue) {
    const publicResult = mirrors.get(q.nonce) ?? { state: "untouched" as const };
    const acknowledged = bundleOk || publicResult.state === "accepted";
    out.set(q.nonce, {
      // Once delivery starts, lack of an acknowledgement is ambiguous. Keep the
      // flight/hash alive so strategy retries this exact nonce rather than opening
      // a gap or colliding with a request that may have reached a remote endpoint.
      ok: true,
      uncertain: acknowledged ? undefined : true,
      txHash: q.txHash,
      bundleHash,
      error: acknowledged ? undefined : publicResult.error ?? "delivery unacknowledged",
    });
  }
  return out;
}

export async function submitTx(
  intent: TxIntent,
  opts: {
    dryRun: boolean;
    race?: boolean;
    offense?: boolean;
    /** Simulate at this future unix-second timestamp (pre-boundary races). */
    simTimestamp?: bigint;
    /** Queue this tx as allowed-to-revert in the bundle (never mirrored to the
     *  mempool). Used for an audit riding behind a mandatory payment. */
    revertible?: boolean;
    /** Absolute wall-clock cutoff for optional work riding a mandatory bundle. */
    deadlineMs?: number;
    /** Replace a previously signed transaction without consuming a new nonce. */
    replacement?: ReplacementOptions;
    /** Cancel a delayed public broadcast when this engine generation stops. */
    signal?: AbortSignal;
  },
): Promise<SubmitResult> {
  const account = runtime.account;
  if (!account) throw new Error("Wallet locked");
  const batchingMainnet = appConfig.mode === "mainnet" && bundleQueue !== null;

  // Independent pre-submission reads — run together (viem batches them, and the
  // block is usually already cached from the pass's canSpend), instead of three
  // serial round-trips per tx. Pre-boundary races pass explicit gas, so estimateGas
  // is instant there and this whole block costs zero extra round-trips.
  const [gas, latest] = await beforeSubmissionDeadline(
    Promise.all([
      estimateGas(account.address, intent),
      getLatestBlockCached(),
    ]),
    opts.deadlineMs,
    "transaction preparation",
  );
  const offense = opts.offense ?? false;
  let { maxFeePerGas, maxPriorityFeePerGas } = computeFees(offense, latest);
  let replacementFeeError: string | undefined;
  if (opts.replacement) {
    const replacement = cappedReplacementFees(
      maxFeePerGas,
      maxPriorityFeePerGas,
      opts.replacement.priorMaxFeePerGas,
      opts.replacement.priorMaxPriorityFeePerGas,
      resolveGas(runtime.strategy, offense),
    );
    if (replacement) {
      ({ maxFeePerGas, maxPriorityFeePerGas } = replacement);
    } else {
      replacementFeeError = "replacement fee ceiling reached";
    }
  }
  const gasWei = gas * maxFeePerGas;
  // Reuse the block's own number instead of a separate getBlockNumber round-trip.
  // Only used for sim context + reporting here; the actual bundle target block is
  // re-derived fresh at flush time (see flushBundle).
  const latestNumber = latest.number ?? await beforeSubmissionDeadline(
    publicClient.getBlockNumber(),
    opts.deadlineMs,
    "target block lookup",
  );
  const targetBlock = latestNumber + 1n;

  // Nonce is only reserved after simulation passes to avoid burning nonces on reverts.
  const candidateNonce = opts.replacement?.nonce ?? nonceManager.peek();
  const base: SubmitResult = {
    ok: false,
    simulated: false,
    nonce: candidateNonce,
    valueWei: intent.value,
    gasWei,
    maxFeePerGas,
    maxPriorityFeePerGas,
  };
  if (replacementFeeError) {
    return { ...base, error: replacementFeeError, targetBlock };
  }

  // --- Simulation ---
  if (opts.simTimestamp !== undefined) {
    // Future-timestamp race (pre-boundary pay/audit/kill): validate at the instant
    // the tx will actually execute. Always uses eth_call block overrides against
    // OUR OWN RPC — verified working, and deliberately not the relay's
    // eth_callBundle `timestamp`, so the race doesn't depend on relay behaviour we
    // can't test. Works identically in public and mainnet mode.
    try {
      const revert = await beforeSubmissionDeadline(
        simulateAtTimestamp(account.address, intent, gas, opts.simTimestamp),
        opts.deadlineMs,
        "future transaction simulation",
      );
      if (revert) return { ...base, simulated: true, error: `sim revert @${opts.simTimestamp}: ${revert}`, targetBlock };
      base.simulated = true;
    } catch (err) {
      if (err instanceof SubmissionDeadlineError) {
        return { ...base, error: err.message, targetBlock };
      }
      logger.warn(`timestamp-override sim unavailable (${(err as Error).message}); sending unsimulated`);
    }
  } else if (appConfig.mode === "mainnet" && !batchingMainnet) {
    // Flashbots bundle simulation needs a signed tx — use peeked nonce (not consumed yet).
    const simSigned = await signTx(account, intent, candidateNonce, gas, maxFeePerGas, maxPriorityFeePerGas);
    try {
      const sim = await flashbotsRpcWithTimeout("eth_callBundle", [
        { txs: [simSigned], blockNumber: toHex(targetBlock), stateBlockNumber: "latest" },
      ]);
      const failure = bundleSimulationFailure(sim);
      if (failure) {
        return { ...base, simulated: true, error: `sim revert: ${failure}`, targetBlock };
      }
      base.simulated = true;
    } catch (err) {
      // The relay being slow/down must NOT block a payment — that can cost a
      // citizen, and mainnet is the default mode. Fall back to a plain eth_call
      // against our own RPC instead of skipping the tx entirely.
      logger.warn(`relay sim unavailable (${(err as Error).message}); falling back to eth_call`);
      try {
        await publicClient.call({
          account: account.address,
          to: intent.to,
          data: intent.data,
          value: intent.value,
          gas,
          maxFeePerGas,
          maxPriorityFeePerGas,
        });
        base.simulated = true;
      } catch (e2) {
        return { ...base, simulated: true, error: `sim revert: ${(e2 as Error).message}`, targetBlock };
      }
    }
  } else if (appConfig.mode === "public" || batchingMainnet) {
    // Plain eth_call — no nonce needed, no relay round-trip.
    // Batched mainnet transactions use this individual semantic check while they
    // are being assembled; flushBundle later simulates their signed nonce sequence
    // as one ordered eth_callBundle before private/public submission.
    try {
      await beforeSubmissionDeadline(
        publicClient.call({
          account: account.address,
          to: intent.to,
          data: intent.data,
          value: intent.value,
          gas,
          maxFeePerGas,
          maxPriorityFeePerGas,
        }),
        opts.deadlineMs,
        "transaction simulation",
      );
      base.simulated = true;
    } catch (err) {
      if (err instanceof SubmissionDeadlineError) {
        return { ...base, error: err.message, targetBlock };
      }
      return { ...base, simulated: true, error: `sim revert: ${(err as Error).message}`, targetBlock };
    }
  }

  if (opts.dryRun) {
    return { ...base, ok: true, targetBlock };
  }

  if (opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs) {
    return { ...base, error: "transaction preparation missed its submission deadline", targetBlock };
  }

  // Simulation passed — now officially consume the nonce and sign for real.
  const reserved = opts.replacement === undefined;
  let nonce: number;
  if (opts.replacement) {
    nonce = opts.replacement.nonce;
    // Reuse the old nonce, but fence it from a later ordinary reserve() in this
    // same tick in case its former private reservation already went stale.
    nonceManager.ensureNextAbove(nonce);
  } else {
    nonce = nonceManager.reserve();
  }
  base.nonce = nonce;
  const signed = await signTx(account, intent, nonce, gas, maxFeePerGas, maxPriorityFeePerGas);
  const signedTxHash = keccak256(signed);

  // --- Submission ---
  if (appConfig.mode === "local" || appConfig.mode === "public") {
    const mirrors = await mirrorPublicSequentially([{
      signed,
      txHash: signedTxHash,
      nonce,
      race: true,
      simTimestamp: opts.simTimestamp,
      signal: opts.signal,
    }]);
    const delivery = mirrors.get(nonce)!;
    if (delivery.error === "public broadcast aborted") {
      // In direct public/local mode there is no private delivery path. Aborting
      // before send is therefore a definite non-delivery, so a fresh reservation
      // may be released safely (a replacement keeps its prior flight instead).
      if (reserved) nonceManager.releaseContiguous([nonce]);
      return { ...base, ok: false, error: delivery.error, targetBlock };
    }
    const acknowledged = delivery.state === "accepted";
    return {
      ...base,
      ok: true,
      uncertain: acknowledged ? undefined : true,
      txHash: signedTxHash,
      targetBlock,
      error: acknowledged ? undefined : delivery.error ?? "delivery unacknowledged",
    };
  }

  // mainnet: if a batching window is open (beginBundle), queue this tx so the
  // whole tick's txs go out as ONE atomic multi-tx bundle with valid sequential
  // nonces (see flushBundle). Hashes are filled in by the caller after flush.
  if (bundleQueue !== null) {
    bundleQueue.push({
      signed,
      txHash: signedTxHash,
      nonce,
      race: opts.revertible ? false : opts.race ?? false,
      revertible: opts.revertible ?? false,
      reserved,
      simTimestamp: opts.simTimestamp,
      signal: opts.signal,
    });
    return { ...base, ok: true, queued: true, txHash: signedTxHash, targetBlock };
  }

  // No batch open: fan this single-tx bundle out to EVERY configured builder for
  // the next two blocks. Only the builder that wins a slot can include us, so
  // submitting to one relay means only winning when that relay's builder wins. All
  // attempts run in parallel; unreachable builders are tolerated — succeed if ANY
  // accepts.
  const bundleHashes: string[] = [];
  const acceptedBy = new Set<string>();
  const attempts = appConfig.builderUrls.flatMap((url) =>
    [targetBlock, targetBlock + 1n].map(async (blk) => {
      const r = await flashbotsRpcWithTimeout(
        "eth_sendBundle",
        [sendBundleParams([signed], blk, opts.simTimestamp)],
        url,
        SEND_BUNDLE_TIMEOUT_MS,
      );
      return { url, bundleHash: bundleHashFromResult(r) };
    }),
  );

  // Public-mempool copy (identical tx: same nonce/sig, so only one can ever land
  // and the loser is dropped as a duplicate). Fire it CONCURRENTLY with the
  // bundles — awaiting relay round-trips first would delay the broadcast by
  // 100-200ms+ per builder, which is exactly the margin a boundary race runs on.
  const mirrorTx: PublicMirrorTx = {
    signed,
    txHash: signedTxHash,
    nonce,
    race: opts.revertible ? false : opts.race ?? false,
    simTimestamp: opts.simTimestamp,
    signal: opts.signal,
  };
  const [mirrors, settled] = await Promise.all([
    mirrorPublicSequentially([mirrorTx]),
    Promise.allSettled(attempts),
  ]);
  for (const s of settled) {
    if (s.status === "fulfilled") {
      if (s.value.bundleHash) {
        acceptedBy.add(hostOf(s.value.url));
        bundleHashes.push(s.value.bundleHash);
      }
    } else {
      logger.warn("sendBundle failed:", (s.reason as Error).message);
    }
  }
  if (acceptedBy.size > 0) {
    logger.info(`bundle accepted by ${acceptedBy.size}/${appConfig.builderUrls.length} builders: ${[...acceptedBy].join(", ")}`);
  }

  const publicResult = mirrors.get(nonce) ?? { state: "untouched" as const };
  const acknowledged = bundleHashes.length > 0 || publicResult.state === "accepted";
  return {
    ...base,
    ok: true,
    uncertain: acknowledged ? undefined : true,
    bundleHash: bundleHashes[0],
    txHash: signedTxHash,
    targetBlock,
    error: acknowledged ? undefined : publicResult.error ?? "delivery unacknowledged",
  };
}
