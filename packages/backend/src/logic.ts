import type { StrategyConfig, TokenRisk } from "@dat-bot/shared";

// Pure game/strategy logic — no I/O, so it can be unit-tested directly.

/** The gas knobs that apply to a single transaction. */
export interface GasSettings {
  maxBaseFeeGwei: number;
  priorityFeeGwei: number;
  dynamicTipEnabled: boolean;
  dynamicTipMaxGwei: number;
}

/**
 * Resolve the gas settings for a transaction. Audit/kill (`offense`) use the
 * dedicated `offense*` fields when `separateOffenseGas` is on; everything else —
 * and offense when the split is off — uses the shared base settings. Keeping
 * this in one pure function guarantees the guardrail check (`canSpend`) and the
 * fee builder (`computeFees`) always agree on which numbers apply.
 */
export function resolveGas(s: StrategyConfig, offense: boolean): GasSettings {
  if (offense && s.separateOffenseGas) {
    return {
      maxBaseFeeGwei: s.offenseMaxBaseFeeGwei,
      priorityFeeGwei: s.offensePriorityFeeGwei,
      dynamicTipEnabled: s.offenseDynamicTipEnabled,
      dynamicTipMaxGwei: s.offenseDynamicTipMaxGwei,
    };
  }
  return {
    maxBaseFeeGwei: s.maxBaseFeeGwei,
    priorityFeeGwei: s.priorityFeeGwei,
    dynamicTipEnabled: s.dynamicTipEnabled,
    dynamicTipMaxGwei: s.dynamicTipMaxGwei,
  };
}

/** Strictly exceed the common 12.5% txpool replacement threshold. The trailing
 * +1 matters when `previous` is exactly divisible by eight. */
export function nextReplacementFee(previous: bigint): bigint {
  return (previous * 9n) / 8n + 1n;
}

/** Resolve a same-nonce replacement while honoring the operator's existing gas
 * ceilings. Returns null once either EIP-1559 field would exceed those ceilings,
 * preventing an unmined transaction from compounding fees without bound. */
export function cappedReplacementFees(
  currentMaxFeePerGas: bigint,
  currentMaxPriorityFeePerGas: bigint,
  priorMaxFeePerGas: bigint,
  priorMaxPriorityFeePerGas: bigint,
  gas: GasSettings,
): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | null {
  const priorityCap = BigInt(Math.round(Math.max(
    gas.priorityFeeGwei,
    gas.dynamicTipMaxGwei,
  ) * 1e9));
  const maxFeeCap = BigInt(Math.round(2 * gas.maxBaseFeeGwei * 1e9)) + priorityCap;
  const bumpedMax = nextReplacementFee(priorMaxFeePerGas);
  const bumpedPriority = nextReplacementFee(priorMaxPriorityFeePerGas);
  const maxFeePerGas = currentMaxFeePerGas > bumpedMax ? currentMaxFeePerGas : bumpedMax;
  const maxPriorityFeePerGas = currentMaxPriorityFeePerGas > bumpedPriority
    ? currentMaxPriorityFeePerGas
    : bumpedPriority;
  if (maxFeePerGas > maxFeeCap || maxPriorityFeePerGas > priorityCap) return null;
  return { maxFeePerGas, maxPriorityFeePerGas };
}

/** A token is auditable once it is >= 2 epochs behind (matches contract `_audit`). */
export function isAuditable(lastEpochPaid: bigint, currentEpoch: bigint): boolean {
  return lastEpochPaid + 2n <= currentEpoch;
}

/** A token can be killed once it is under audit and the deadline has passed. */
export function isKillable(auditDueTimestamp: bigint, nowSec: bigint): boolean {
  return auditDueTimestamp !== 0n && nowSec > auditDueTimestamp;
}

/**
 * Whether an owned token can be used as an audit "from" token right now. The
 * contract requires the from-token to not itself be delinquent/auditable and to
 * still have audit capacity this epoch. On-chain evidence: a token one epoch
 * behind can still audit (so it need not be strictly current — up to 1 behind is
 * fine), and each token may audit `auditLimit` times per epoch (1 for a normal
 * token, higher for auditor-role tokens).
 */
export function isEligibleAuditor(
  lastEpochPaid: bigint,
  currentEpoch: bigint,
  auditsUsedThisEpoch: bigint,
  auditLimit: bigint,
): boolean {
  return !isAuditable(lastEpochPaid, currentEpoch) && auditsUsedThisEpoch < auditLimit;
}

export interface RiskResult {
  risk: TokenRisk;
  secondsUntilKillable: number | null;
}

/** Classify an owned token's risk from on-chain fields. */
export function classifyRisk(
  lastEpochPaid: bigint,
  currentEpoch: bigint,
  auditDueTimestamp: bigint,
  nowSec: bigint,
): RiskResult {
  if (auditDueTimestamp !== 0n) {
    const secs = Number(auditDueTimestamp - nowSec);
    if (nowSec > auditDueTimestamp) return { risk: "at-risk", secondsUntilKillable: secs };
    return { risk: "audited", secondsUntilKillable: secs };
  }
  if (isAuditable(lastEpochPaid, currentEpoch)) {
    return { risk: "delinquent", secondsUntilKillable: null };
  }
  return { risk: "safe", secondsUntilKillable: null };
}


/**
 * Wei to send for a **pre-boundary / just-in-time** payTaxes that will execute in
 * `targetEpoch` (the first block of the new epoch), computed off-chain because our
 * reads only see the current epoch.
 *
 * JIT pays exactly **one upcoming epoch's amount** — `numEpochs * targetEpoch *
 * baseTaxRateWei` — regardless of how many epochs the token is behind. This
 * matches the game's JIT semantics (arm for epoch N -> pay `N * 0.00069`) and the
 * observed boundary-block behaviour: every payTaxes that succeeded in the epoch-137
 * boundary block sent exactly `1 * 137 * base` (0.09453 ETH), while a catch-up
 * amount (`2 * 137`) was rejected with `IncorrectPayment`.
 *
 * Returns 0 if the token is already current for the target (nothing to pre-pay).
 * If the value is wrong when the tx lands, payTaxes reverts — wasted gas, no fund
 * loss (the contract refunds on revert).
 */
export function preBoundaryTaxWei(
  lastEpochPaid: bigint,
  targetEpoch: bigint,
  numEpochs: number,
  baseTaxRateWei: bigint,
): bigint {
  if (lastEpochPaid >= targetEpoch) return 0n; // already current for the target epoch
  return BigInt(numEpochs) * targetEpoch * baseTaxRateWei;
}

/**
 * How many epochs a single automatic payTaxes should actually cover: the
 * requested count, clamped to the global `maxAutoPayEpochs` cap and to at least 1.
 * On-chain, payTaxes(tokenId, n) costs n * currentEpoch * base regardless of how
 * far behind the token is, so clamping n caps the ETH spent per auto payment
 * without ever blocking the single-epoch payment JIT relies on. Used by
 * proactive-pay and defense (which request `prepayEpochs`); JIT paths always
 * request 1, so the cap never reduces them below a full single-epoch payment.
 */
export function cappedAutoPayEpochs(requestedEpochs: number, maxAutoPayEpochs: number): number {
  return Math.max(1, Math.min(requestedEpochs, maxAutoPayEpochs));
}

/**
 * Deterministically order items by a salted hash of their key.
 *
 * Every bot enumerates rival candidates in the same order (the NFT API returns a
 * stable list), so without this every user sweeps the same tokens first — piling
 * onto identical targets and colliding on the same races, while tokens late in the
 * list are never reached when the auditor pool runs out. Salting per engine start
 * gives each run a stable but distinct order, spreading coverage across users.
 *
 * Stable for a given salt (so a run doesn't reshuffle mid-flight) and a pure
 * permutation — same elements, just reordered.
 */
export function orderBySalt<T>(items: T[], keyOf: (item: T) => string, salt: number): T[] {
  const hash = (key: string): number => {
    let h = salt >>> 0;
    for (let i = 0; i < key.length; i++) {
      h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0; // FNV-1a style
    }
    return h >>> 0;
  };
  return [...items]
    .map((item) => ({ item, h: hash(keyOf(item)) }))
    // Tie-break on the key so equal hashes still order deterministically.
    .sort((a, b) => a.h - b.h || keyOf(a.item).localeCompare(keyOf(b.item)))
    .map((x) => x.item);
}

/** Would spending `total` drop the balance below the floor? */
export function wouldBreachFloor(
  balance: bigint,
  total: bigint,
  floorWei: bigint,
): boolean {
  return balance - total < floorWei;
}

/**
 * Whether a spend of `value` (plus `gasWei` gas) is affordable without dropping
 * the wallet below `floorWei`. `committedWei` is spend already decided but not
 * yet reflected in `balanceWei` — e.g. earlier payments made in the same engine
 * tick, which the on-chain balance (read once at tick start) doesn't show yet.
 * Subtracting it makes the floor guard hold across *all* spends in a tick, not
 * just each one in isolation.
 */
export function canAffordSpend(
  balanceWei: bigint,
  committedWei: bigint,
  value: bigint,
  gasWei: bigint,
  floorWei: bigint,
): boolean {
  return (balanceWei - committedWei) - (value + gasWei) >= floorWei;
}

/**
 * Scale the priority-fee tip by how full the latest block is. Blocks target 50%
 * fullness under EIP-1559; above that, inclusion is contested and a higher tip
 * helps. Returns `baseTipGwei` at/below 50% fill, ramping linearly to
 * `maxTipGwei` at 100% fill. Clamped so it never drops below the base or
 * exceeds the max. Degrades to `baseTipGwei` on missing/zero gas limit.
 */
export function dynamicTipGwei(
  baseTipGwei: number,
  maxTipGwei: number,
  gasUsed: bigint,
  gasLimit: bigint,
): number {
  if (gasLimit <= 0n) return baseTipGwei;
  const ceil = Math.max(baseTipGwei, maxTipGwei); // guard against maxGwei < base
  const fill = Number(gasUsed) / Number(gasLimit); // 0..1
  if (fill <= 0.5) return baseTipGwei;
  const t = (fill - 0.5) / 0.5; // 0 at half-full, 1 at full
  const scaled = baseTipGwei + (ceil - baseTipGwei) * Math.min(t, 1);
  return Math.min(scaled, ceil);
}

/**
 * The priority tip (gwei) to actually bid for a transaction given its resolved
 * gas profile and the latest block's fullness. Returns the static
 * `priorityFeeGwei` unless the profile's dynamic tip is enabled, in which case it
 * scales with block fullness up to the profile's ceiling. Applies to whichever
 * profile `resolveGas` selected — tax payments included — so it's the single
 * source of truth `computeFees` uses for every action.
 */
export function effectiveTipGwei(gas: GasSettings, gasUsed: bigint, gasLimit: bigint): number {
  if (!gas.dynamicTipEnabled) return gas.priorityFeeGwei;
  return dynamicTipGwei(gas.priorityFeeGwei, gas.dynamicTipMaxGwei, gasUsed, gasLimit);
}
