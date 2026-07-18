import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";

const EPOCH_SECONDS = 86_400n;
const BASE_TAX_RATE_WEI = 690_000_000_000_000n;
const START_TIME = 0n;

const testState = vi.hoisted(() => ({
  lastEpochPaid: 0n,
  auditDueTimestamp: 0n,
  estimatedPayWei: 1_000_000_000_000_000n,
  submitOutcomes: [] as boolean[],
  submitTxHashes: [] as Hex[],
  submitGate: null as Promise<void> | null,
  blockGate: null as Promise<void> | null,
  candidateGate: null as Promise<bigint[]> | null,
  submitQueued: false,
  nextNonce: 0,
  confirmedNonce: 0,
  pendingNonce: 0,
  submittedMaxFeePerGas: 20n,
  submittedMaxPriorityFeePerGas: 2n,
  ownedIds: [1n] as bigint[],
  lastEpochPaidByToken: new Map<string, bigint>(),
  auditLimitByToken: new Map<string, bigint>(),
  receipts: new Map<Hex, Promise<{ status: "success" | "reverted"; blockNumber: bigint }>>(),
  flushResults: new Map<number, { ok: boolean; error?: string }>(),
  candidateIds: [] as bigint[],
  liveTargets: [] as { id: bigint; owner: `0x${string}` }[],
  targetStatuses: [] as Array<{
    tokenId: string;
    owner: `0x${string}`;
    lastEpochPaid: string;
    delinquent: boolean;
    epochsBehind: number;
    auditable: boolean;
    auditDueTimestamp: string;
    killable: boolean;
  }>,
  nextActivityId: 0,
}));

function epochStart(epoch: number): bigint {
  return BigInt(epoch - 1) * EPOCH_SECONDS;
}

function currentEpochAt(nowSec: bigint): bigint {
  return 1n + (nowSec - START_TIME) / EPOCH_SECONDS;
}

vi.mock("./chain.js", () => ({
  publicClient: {
    getBlock: vi.fn(async () => ({
      baseFeePerGas: 10_000_000_000n,
      gasUsed: 15_000_000n,
      gasLimit: 30_000_000n,
    })),
    getBalance: vi.fn(async () => 10_000_000_000_000_000_000n),
    getBlockNumber: vi.fn(async () => 100n),
    getTransactionCount: vi.fn(async () => testState.confirmedNonce),
    multicall: vi.fn(async ({ contracts }: { contracts: Array<{
      functionName?: string;
      args?: readonly unknown[];
    }> }) => contracts.map((contract) => {
      const tokenId = contract.args?.[0]?.toString();
      if (contract.functionName === "lastEpochPaid" && tokenId !== undefined) {
        return {
          status: "success",
          result: testState.lastEpochPaidByToken.get(tokenId) ?? testState.lastEpochPaid,
        };
      }
      if (contract.functionName === "auditLimit" && tokenId !== undefined) {
        return {
          status: "success",
          result: testState.auditLimitByToken.get(tokenId) ?? testState.lastEpochPaid,
        };
      }
      return { status: "success", result: testState.lastEpochPaid };
    })),
    waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => {
      const receipt = testState.receipts.get(hash);
      if (!receipt) throw new Error(`no mocked receipt for ${hash}`);
      return receipt;
    }),
  },
  getLatestBlockCached: vi.fn(async () => {
    if (testState.blockGate) await testState.blockGate;
    return {
      baseFeePerGas: 10_000_000_000n,
      gasUsed: 15_000_000n,
      gasLimit: 30_000_000n,
      number: 100n,
    };
  }),
  wsClient: {
    watchBlocks: vi.fn(() => vi.fn()),
  },
}));

vi.mock("./config.js", () => ({
  appConfig: {
    mode: "public",
    gameAddress: "0x00000000000000000000000000000000000000aa",
    dataDir: "C:/dat-bot-test-scratch-nonexistent",
    httpUrl: "http://localhost",
    port: 8787,
    host: "127.0.0.1",
  },
  loadSettings: vi.fn(() => ({})),
  saveSettings: vi.fn(),
  deriveUrlsFromKey: vi.fn(),
}));

vi.mock("./activity.js", () => ({
  activity: {
    add: vi.fn(() => ({ id: `test-${++testState.nextActivityId}` })),
    update: vi.fn(),
  },
}));

vi.mock("./nonce.js", () => ({
  nonceManager: {
    sync: vi.fn(async () => {}),
    reset: vi.fn(),
    hasInvisibleReservation: vi.fn(() => false),
    pendingNonce: vi.fn(() => testState.pendingNonce),
  },
}));

vi.mock("./index-tokens.js", () => ({
  fetchOwnedTokenIds: vi.fn(async () => testState.ownedIds),
  fetchCandidateTokenIds: vi.fn(async () => testState.candidateGate ?? testState.candidateIds),
  ownershipIndexingAvailable: vi.fn(() => true),
}));

vi.mock("./flashbots.js", () => ({
  submitTx: vi.fn(async (
    intent: { value: bigint },
    opts: { replacement?: { nonce: number } },
  ) => {
    if (testState.submitGate) await testState.submitGate;
    const ok = testState.submitOutcomes.shift() ?? true;
    return {
      ok,
      simulated: true,
      nonce: opts.replacement?.nonce ?? testState.nextNonce++,
      valueWei: intent.value,
      gasWei: 0n,
      maxFeePerGas: testState.submittedMaxFeePerGas,
      maxPriorityFeePerGas: testState.submittedMaxPriorityFeePerGas,
      txHash: ok ? testState.submitTxHashes.shift() : undefined,
      queued: testState.submitQueued || undefined,
    };
  }),
  beginBundle: vi.fn(),
  flushBundle: vi.fn(async () => new Map(testState.flushResults)),
  discardBundle: vi.fn(() => new Map()),
  waitForBundleFallbacks: vi.fn(async () => {}),
}));

vi.mock("./contract.js", () => ({
  getGameSnapshot: vi.fn(async () => ({
    state: 1,
    currentEpoch: currentEpochAt(BigInt(Math.floor(Date.now() / 1000))),
    startTime: START_TIME,
    citizensAddress: "0x00000000000000000000000000000000000000cc",
    citizenSupply: 100n,
  })),
  batchGetOwnedStatuses: vi.fn(
    async (tokenIds: bigint[], currentEpoch: bigint, nowSec: bigint) =>
      tokenIds.map((tokenId) => {
        const underAudit = testState.auditDueTimestamp !== 0n;
        const secondsUntilKillable = underAudit
          ? Number(testState.auditDueTimestamp - nowSec)
          : null;
        const delinquent = testState.lastEpochPaid + 2n <= currentEpoch;
        return {
          tokenId: tokenId.toString(),
          lastEpochPaid: testState.lastEpochPaid.toString(),
          currentEpoch: currentEpoch.toString(),
          auditDueTimestamp: testState.auditDueTimestamp.toString(),
          secondsUntilKillable,
          bribeBalance: "0",
          hasLifeInsurance: false,
          risk: underAudit ? "audited" : delinquent ? "delinquent" : "safe",
          estimatedPayWei: testState.estimatedPayWei.toString(),
        };
      }),
  ),
  batchGetTargetStatuses: vi.fn(async () => testState.targetStatuses),
  filterLiveTokenIds: vi.fn(async () => testState.liveTargets),
  estimateTaxes: vi.fn(async () => 1_000_000_000_000_000n),
  encodePayTaxes: vi.fn(() => "0xPAYTAXES"),
  encodeAudit: vi.fn(() => "0xAUDIT"),
  encodeKill: vi.fn(() => "0xKILL"),
  encodeUseBribe: vi.fn(() => "0xBRIBE"),
  gameContract: {
    address: "0x00000000000000000000000000000000000000aa",
    abi: [],
  },
}));

const { submitTx } = await import("./flashbots.js");
const { beginBundle, flushBundle, discardBundle } = await import("./flashbots.js");
const { nonceManager } = await import("./nonce.js");
const { getLatestBlockCached, wsClient } = await import("./chain.js");
const { appConfig } = await import("./config.js");
const { encodePayTaxes } = await import("./contract.js");
const { runtime, DEFAULT_STRATEGY } = await import("./runtime.js");
const {
  startEngine,
  stopEngine,
  waitForEngineIdle,
  resetJitState,
  resetPaymentTracking,
  schedulePreBoundaryPay,
} = await import("./strategy.js");

const saveStrategy = vi.spyOn(runtime, "saveStrategy").mockImplementation((next) => {
  runtime.strategy = { ...runtime.strategy, ...next };
  return runtime.strategy;
});

const FAKE_ACCOUNT = {
  address: "0x1111111111111111111111111111111111111111",
} as unknown as PrivateKeyAccount;

const TX_HASH_0 = `0x${"01".repeat(32)}` as Hex;
const TX_HASH_1 = `0x${"02".repeat(32)}` as Hex;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function configure(overrides: Partial<typeof DEFAULT_STRATEGY> = {}): void {
  runtime.strategy = {
    ...DEFAULT_STRATEGY,
    enabled: true,
    proactivePay: true,
    dryRun: false,
    offenseEnabled: false,
    jitEnabled: false,
    minBalanceEth: 0,
    maxPaymentEth: 0,
    maxBaseFeeGwei: 100,
    priorityFeeGwei: 2,
    ...overrides,
  };
}

async function startAt(nowSec: bigint): Promise<void> {
  vi.setSystemTime(new Date(Number(nowSec) * 1000));
  startEngine();
  await vi.advanceTimersByTimeAsync(0);
}

function configurePreBoundaryAuditRide(kind: "proactive" | "jit", queued = true): void {
  appConfig.mode = "mainnet";
  testState.submitQueued = queued;
  testState.flushResults = new Map([
    [0, { ok: true }],
    [1, { ok: true }],
  ]);
  testState.candidateIds = [99n];
  testState.liveTargets = [{
    id: 99n,
    owner: "0x9999999999999999999999999999999999999999",
  }];
  testState.targetStatuses = [{
    tokenId: "99",
    owner: "0x9999999999999999999999999999999999999999",
    lastEpochPaid: "4",
    delinquent: false,
    epochsBehind: 1,
    auditable: false,
    auditDueTimestamp: "0",
    killable: false,
  }];

  if (kind === "proactive") {
    testState.lastEpochPaid = 4n;
    testState.ownedIds = [1n, 2n];
    testState.lastEpochPaidByToken = new Map([["1", 4n], ["2", 5n]]);
    testState.auditLimitByToken = new Map([["2", 1n]]);
  } else {
    testState.lastEpochPaid = 5n;
    testState.ownedIds = [1n];
    testState.lastEpochPaidByToken = new Map([["1", 5n]]);
    testState.auditLimitByToken = new Map([["1", 1n]]);
  }

  configure({
    proactivePay: kind === "proactive",
    jitEnabled: kind === "jit",
    jitTargetEpoch: kind === "jit" ? 6 : null,
    offenseEnabled: true,
    autoAudit: true,
    autoKill: false,
    preBoundaryPay: true,
    preBoundaryAudit: true,
    racePublicMempool: true,
  });
}

describe("defensive payment scheduling and retries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    resetJitState();
    resetPaymentTracking();
    testState.lastEpochPaid = 0n;
    testState.auditDueTimestamp = 0n;
    testState.estimatedPayWei = 1_000_000_000_000_000n;
    testState.submitOutcomes = [];
    testState.submitTxHashes = [];
    testState.submitGate = null;
    testState.blockGate = null;
    testState.candidateGate = null;
    testState.submitQueued = false;
    testState.nextNonce = 0;
    testState.confirmedNonce = 0;
    testState.pendingNonce = 0;
    testState.submittedMaxFeePerGas = 20n;
    testState.submittedMaxPriorityFeePerGas = 2n;
    testState.ownedIds = [1n];
    testState.lastEpochPaidByToken = new Map();
    testState.auditLimitByToken = new Map();
    testState.receipts = new Map();
    testState.flushResults = new Map();
    testState.candidateIds = [];
    testState.liveTargets = [];
    testState.targetStatuses = [];
    testState.nextActivityId = 0;
    appConfig.mode = "public";
    vi.mocked(nonceManager.hasInvisibleReservation).mockReturnValue(false);

    runtime.account = FAKE_ACCOUNT;
    runtime.running = false;
    runtime.balanceWei = null;
    runtime.currentEpoch = null;
    runtime.gameState = null;
    runtime.citizensAddress = null;
    runtime.startTime = null;
    configure();
  });

  afterEach(() => {
    stopEngine();
    vi.useRealTimers();
  });

  it("pre-submits the recurring tax-skip payment when a one-behind citizen will become auditable next epoch", async () => {
    // Epoch 5, ten seconds before epoch 6. Paid through epoch 4 means the citizen
    // is safe now, but will be two behind at the epoch-6 boundary.
    testState.lastEpochPaid = 4n;
    await startAt(epochStart(6) - 10n);

    expect(submitTx).not.toHaveBeenCalled();

    // Public-mode pre-boundary lead is 3s, so the recurring payment fires 7s later.
    await vi.advanceTimersByTimeAsync(7_000);

    expect(submitTx).toHaveBeenCalledTimes(1);
    expect(encodePayTaxes).toHaveBeenCalledWith(1n, 1);
    const [intent, opts] = vi.mocked(submitTx).mock.calls[0]!;
    expect(intent.value).toBe(6n * BASE_TAX_RATE_WEI);
    expect(opts.simTimestamp).toBe(epochStart(6));
  });

  it.each(["proactive", "jit"] as const)(
    "suppresses standalone mainnet audits and rides one revertible audit behind a %s payment",
    async (kind) => {
      const paymentGate = deferred<void>();
      configurePreBoundaryAuditRide(kind);
      testState.submitGate = paymentGate.promise;

      await startAt(epochStart(6) - 10n);
      vi.clearAllMocks();
      await vi.advanceTimersByTimeAsync(5_000);

      // Payment submission is deliberately paused so the concurrent, read-only
      // audit prefetch deterministically settles before the batch is assembled.
      expect(submitTx).toHaveBeenCalledTimes(1);
      paymentGate.resolve(undefined);
      await waitForEngineIdle();

      expect(submitTx).toHaveBeenCalledTimes(2);
      expect(vi.mocked(submitTx).mock.calls.map(([intent]) => intent.data)).toEqual([
        "0xPAYTAXES",
        "0xAUDIT",
      ]);
      const auditOpts = vi.mocked(submitTx).mock.calls[1]![1];
      expect(auditOpts.revertible).toBe(true);
      expect(auditOpts.race).toBe(false);
      expect(beginBundle).toHaveBeenCalledTimes(1);
      expect(flushBundle).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps a riding audit mandatory when the preceding payment was not actually queued", async () => {
    const paymentGate = deferred<void>();
    configurePreBoundaryAuditRide("jit", false);
    testState.submitGate = paymentGate.promise;

    await startAt(epochStart(6) - 10n);
    vi.clearAllMocks();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(submitTx).toHaveBeenCalledTimes(1);

    paymentGate.resolve(undefined);
    await waitForEngineIdle();

    expect(submitTx).toHaveBeenCalledTimes(2);
    const auditOpts = vi.mocked(submitTx).mock.calls[1]![1];
    expect(auditOpts.revertible).toBe(false);
    expect(auditOpts.race).toBe(true);
  });

  it("flushes a mandatory pre-boundary payment without waiting for unresolved audit prefetch", async () => {
    const candidates = deferred<bigint[]>();
    configurePreBoundaryAuditRide("jit");

    await startAt(epochStart(6) - 10n);
    vi.clearAllMocks();
    // Let the initial ordinary tick complete before stalling only the optional
    // pre-boundary discovery launched alongside the payment path.
    testState.candidateGate = candidates.promise;
    await vi.advanceTimersByTimeAsync(5_000);
    await waitForEngineIdle();

    expect(submitTx).toHaveBeenCalledTimes(1);
    expect(vi.mocked(submitTx).mock.calls[0]![0].data).toBe("0xPAYTAXES");
    expect(flushBundle).toHaveBeenCalledTimes(1);

    // Settle the intentionally late read after the survival batch is already out.
    candidates.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
  });

  it("cuts off a hanging optional audit spend read and flushes the mandatory payment", async () => {
    const paymentGate = deferred<void>();
    const blockGate = deferred<void>();
    configurePreBoundaryAuditRide("jit");
    testState.submitGate = paymentGate.promise;

    await startAt(epochStart(6) - 10n);
    vi.clearAllMocks();
    await vi.advanceTimersByTimeAsync(5_000);

    // The payment's spend check already completed. Stall only the audit's next
    // block read after its read-only target prefetch has had time to settle.
    expect(submitTx).toHaveBeenCalledTimes(1);
    testState.blockGate = blockGate.promise;
    paymentGate.resolve(undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(getLatestBlockCached).toHaveBeenCalledTimes(2);

    // Mainnet fires five seconds before the boundary and preserves the final
    // 1.5 seconds for delivery, leaving this optional read a 3.5-second budget.
    await vi.advanceTimersByTimeAsync(3_499);
    expect(flushBundle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await waitForEngineIdle();

    expect(submitTx).toHaveBeenCalledTimes(1);
    expect(vi.mocked(submitTx).mock.calls[0]![0].data).toBe("0xPAYTAXES");
    expect(flushBundle).toHaveBeenCalledTimes(1);

    // Let the abandoned read settle; it must not attach an audit afterward.
    blockGate.resolve(undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(submitTx).toHaveBeenCalledTimes(1);
  });

  it("immediately pays a delinquent unaudited citizen on a regular tick after a missed boundary", async () => {
    // Start after the epoch-7 boundary with payment only through epoch 5.
    testState.lastEpochPaid = 5n;
    testState.estimatedPayWei = 7n * BASE_TAX_RATE_WEI;
    await startAt(epochStart(7) + 60n);

    expect(submitTx).toHaveBeenCalledTimes(1);
    const [intent] = vi.mocked(submitTx).mock.calls[0]!;
    expect(intent.value).toBe(testState.estimatedPayWei);
  });

  it("keeps polling when the WebSocket subscription is silent", async () => {
    testState.lastEpochPaid = 5n;
    configure({ enabled: false, proactivePay: false });
    await startAt(epochStart(5) + 100n);

    expect(wsClient?.watchBlocks).toHaveBeenCalledTimes(1);
    expect(nonceManager.sync).toHaveBeenCalledTimes(1);
    // No mocked onBlock callback fires. The watchdog alone must trigger a tick.
    await vi.advanceTimersByTimeAsync(12_000);
    expect(nonceManager.sync).toHaveBeenCalledTimes(2);
  });

  it("clears a fresh audit immediately using the full audit-first on-chain estimate", async () => {
    const now = epochStart(8) + 100n;
    testState.lastEpochPaid = 6n;
    testState.auditDueTimestamp = now + EPOCH_SECONDS;
    testState.estimatedPayWei = 2n * 8n * BASE_TAX_RATE_WEI;

    await startAt(now);

    expect(DEFAULT_STRATEGY.auditSafetyBufferSeconds).toBe(Number(EPOCH_SECONDS));
    expect(submitTx).toHaveBeenCalledTimes(1);
    const [intent] = vi.mocked(submitTx).mock.calls[0]!;
    expect(intent.value).toBe(testState.estimatedPayWei);
    expect(encodePayTaxes).toHaveBeenCalledWith(1n, 1);
  });

  it("keeps JIT armed and retries when submitTx returns ok:false", async () => {
    testState.lastEpochPaid = 8n;
    testState.estimatedPayWei = 9n * BASE_TAX_RATE_WEI;
    testState.submitOutcomes = [false, true];
    configure({ proactivePay: false, jitEnabled: true, jitTargetEpoch: 9 });

    await startAt(epochStart(9) + 100n);

    expect(submitTx).toHaveBeenCalledTimes(1);
    expect(runtime.strategy.jitEnabled).toBe(true);
    expect(saveStrategy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(12_000);

    expect(submitTx).toHaveBeenCalledTimes(2);
    expect(runtime.strategy.jitEnabled).toBe(true);
    expect(saveStrategy).not.toHaveBeenCalled();

    // Relay/broadcast acceptance is not inclusion. JIT disarms only after the
    // next on-chain read confirms lastEpochPaid actually advanced.
    testState.lastEpochPaid = 9n;
    await vi.advanceTimersByTimeAsync(12_000);

    expect(submitTx).toHaveBeenCalledTimes(2);
    expect(saveStrategy).toHaveBeenCalledWith({ jitEnabled: false, jitTargetEpoch: null });
    expect(runtime.strategy.jitEnabled).toBe(false);
  });

  it("runs an armed JIT payment even when continuous defense is disabled", async () => {
    testState.lastEpochPaid = 8n;
    testState.estimatedPayWei = 9n * BASE_TAX_RATE_WEI;
    configure({
      enabled: false,
      proactivePay: false,
      preBoundaryPay: false,
      jitEnabled: true,
      jitTargetEpoch: 9,
    });

    await startAt(epochStart(9) + 100n);

    expect(submitTx).toHaveBeenCalledTimes(1);
    expect(encodePayTaxes).toHaveBeenCalledWith(1n, 1);
  });

  it("counts one confirmed deep-behind pre-boundary JIT payment and disarms without paying again", async () => {
    // The citizen is four epochs behind the target. JIT still promises exactly
    // one epoch, so confirmation means lastEpochPaid advances 5 -> 6, not -> 10.
    testState.lastEpochPaid = 5n;
    configure({ proactivePay: false, jitEnabled: true, jitTargetEpoch: 10 });

    await startAt(epochStart(10) - 10n);
    await vi.advanceTimersByTimeAsync(7_000);
    expect(submitTx).toHaveBeenCalledTimes(1);

    testState.lastEpochPaid = 6n;
    await vi.advanceTimersByTimeAsync(3_500);

    expect(submitTx).toHaveBeenCalledTimes(1);
    expect(saveStrategy).toHaveBeenCalledWith({ jitEnabled: false, jitTargetEpoch: null });
    expect(runtime.strategy.jitEnabled).toBe(false);

    await vi.advanceTimersByTimeAsync(12_000);
    expect(submitTx).toHaveBeenCalledTimes(1);
  });

  it("preserves the JIT target when audit defense replaces its pending payment", async () => {
    testState.lastEpochPaid = 5n;
    configure({ proactivePay: false, jitEnabled: true, jitTargetEpoch: 10 });

    await startAt(epochStart(10) - 10n);
    await vi.advanceTimersByTimeAsync(7_000);
    expect(submitTx).toHaveBeenCalledTimes(1);

    // At the boundary an audit forces an urgent same-nonce replacement. That
    // replacement still fulfills the one-epoch JIT obligation it superseded.
    testState.auditDueTimestamp = epochStart(10) + EPOCH_SECONDS;
    testState.estimatedPayWei = 2n * 10n * BASE_TAX_RATE_WEI;
    await vi.advanceTimersByTimeAsync(3_500);

    expect(submitTx).toHaveBeenCalledTimes(2);
    expect(vi.mocked(submitTx).mock.calls[1]![1].replacement?.nonce).toBe(0);

    testState.lastEpochPaid = 6n;
    testState.auditDueTimestamp = 0n;
    await vi.advanceTimersByTimeAsync(1_500);

    expect(submitTx).toHaveBeenCalledTimes(2);
    expect(saveStrategy).toHaveBeenCalledWith({ jitEnabled: false, jitTargetEpoch: null });
  });

  it("preserves the JIT target when proactive recovery replaces its pending payment", async () => {
    testState.lastEpochPaid = 5n;
    configure({
      proactivePay: false,
      preBoundaryPay: false,
      jitEnabled: true,
      jitTargetEpoch: 10,
    });

    await startAt(epochStart(10) + 100n);
    expect(submitTx).toHaveBeenCalledTimes(1);

    runtime.strategy = { ...runtime.strategy, proactivePay: true };
    await vi.advanceTimersByTimeAsync(36_000);

    expect(submitTx).toHaveBeenCalledTimes(2);
    expect(vi.mocked(submitTx).mock.calls[1]![1].replacement?.nonce).toBe(0);

    testState.lastEpochPaid = 6n;
    await vi.advanceTimersByTimeAsync(12_000);

    expect(submitTx).toHaveBeenCalledTimes(2);
    expect(saveStrategy).toHaveBeenCalledWith({ jitEnabled: false, jitTargetEpoch: null });
  });

  it("does not let confirmation for an old JIT target satisfy a newly re-armed target", async () => {
    testState.lastEpochPaid = 9n;
    configure({
      proactivePay: false,
      preBoundaryPay: false,
      jitEnabled: true,
      jitTargetEpoch: 10,
    });

    // Target 10 is late but still outstanding when the chain is already in 11.
    await startAt(epochStart(11) + 100n);
    expect(submitTx).toHaveBeenCalledTimes(1);

    // Re-arm for 11 before the target-10 transaction is observed on-chain.
    runtime.strategy = { ...runtime.strategy, jitEnabled: true, jitTargetEpoch: 11 };
    testState.lastEpochPaid = 10n;
    await vi.advanceTimersByTimeAsync(12_000);

    expect(submitTx).toHaveBeenCalledTimes(2);
    expect(runtime.strategy.jitEnabled).toBe(true);

    testState.lastEpochPaid = 11n;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(submitTx).toHaveBeenCalledTimes(2);
    expect(saveStrategy).toHaveBeenCalledWith({ jitEnabled: false, jitTargetEpoch: null });
  });

  it("retains pending-payment dedupe across an engine stop and restart", async () => {
    testState.lastEpochPaid = 12n;
    await startAt(epochStart(14) + 100n);
    expect(submitTx).toHaveBeenCalledTimes(1);

    stopEngine();
    startEngine();
    await vi.advanceTimersByTimeAsync(0);

    expect(submitTx).toHaveBeenCalledTimes(1);

    // Confirm before leaving the test so retained run-scoped state cannot leak.
    testState.lastEpochPaid = 13n;
    await vi.advanceTimersByTimeAsync(12_000);
  });

  it("discards a queued batch when stop is requested during submission", async () => {
    const gate = deferred<void>();
    appConfig.mode = "mainnet";
    testState.submitQueued = true;
    testState.submitGate = gate.promise;
    testState.lastEpochPaid = 12n;

    vi.setSystemTime(new Date(Number(epochStart(14) + 100n) * 1000));
    startEngine();
    await vi.waitFor(() => expect(submitTx).toHaveBeenCalledTimes(1));

    stopEngine();
    gate.resolve(undefined);
    await waitForEngineIdle();

    expect(discardBundle).toHaveBeenCalledTimes(1);
    expect(flushBundle).not.toHaveBeenCalled();
    expect(runtime.running).toBe(false);
  });

  it("flushes a queued mainnet payment using the mode captured when its batch opened", async () => {
    const gate = deferred<void>();
    appConfig.mode = "mainnet";
    testState.submitQueued = true;
    testState.submitGate = gate.promise;
    testState.flushResults = new Map([[0, { ok: true }]]);
    testState.lastEpochPaid = 12n;

    vi.setSystemTime(new Date(Number(epochStart(14) + 100n) * 1000));
    startEngine();
    await vi.waitFor(() => expect(submitTx).toHaveBeenCalledTimes(1));

    // Model a hostile live settings mutation. The API now stops/awaits first,
    // but the batch itself must also be immune to a changing global mode.
    appConfig.mode = "public";
    gate.resolve(undefined);
    await waitForEngineIdle();

    expect(flushBundle).toHaveBeenCalledTimes(1);
  });

  it("never pays a configured JIT token that the active wallet does not own", async () => {
    testState.ownedIds = [1n];
    testState.lastEpochPaid = 15n;
    configure({
      proactivePay: false,
      preBoundaryPay: false,
      jitEnabled: true,
      jitTargetEpoch: 16,
      jitTokenIds: ["2"],
    });

    await startAt(epochStart(16) + 100n);

    expect(submitTx).not.toHaveBeenCalled();
    expect(encodePayTaxes).not.toHaveBeenCalledWith(2n, expect.any(Number));
    expect(runtime.strategy.jitEnabled).toBe(true);
  });

  it("does not allocate a fresh payment above an unresolved private nonce", async () => {
    appConfig.mode = "mainnet";
    vi.mocked(nonceManager.hasInvisibleReservation).mockReturnValue(true);
    testState.lastEpochPaid = 15n;

    await startAt(epochStart(17) + 100n);
    expect(submitTx).not.toHaveBeenCalled();

    vi.mocked(nonceManager.hasInvisibleReservation).mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(submitTx).toHaveBeenCalledTimes(1);
  });

  it("removes a failed proactive marker so the next regular tick retries", async () => {
    testState.lastEpochPaid = 8n;
    testState.estimatedPayWei = 10n * BASE_TAX_RATE_WEI;
    testState.submitOutcomes = [false, true];

    await startAt(epochStart(10) + 100n);
    expect(submitTx).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(12_000);
    expect(submitTx).toHaveBeenCalledTimes(2);

    // A successful submission remains marked for the epoch, preventing duplicates.
    await vi.advanceTimersByTimeAsync(12_000);
    expect(submitTx).toHaveBeenCalledTimes(2);
  });

  it("waits for the replacement threshold before replacing an accepted but unmined payment at the same nonce", async () => {
    testState.lastEpochPaid = 18n;
    await startAt(epochStart(20) + 100n);

    expect(submitTx).toHaveBeenCalledTimes(1);
    expect(vi.mocked(submitTx).mock.calls[0]![1].replacement).toBeUndefined();

    // Polls at 12s and 24s must keep deduping the accepted transaction.
    await vi.advanceTimersByTimeAsync(24_000);
    expect(submitTx).toHaveBeenCalledTimes(1);

    // The first poll after the 30s threshold is at 36s. It must replace the
    // original transaction, not allocate a new nonce behind it.
    await vi.advanceTimersByTimeAsync(12_000);
    expect(submitTx).toHaveBeenCalledTimes(2);
    expect(vi.mocked(submitTx).mock.calls[1]![1].replacement).toEqual({
      nonce: 0,
      priorMaxFeePerGas: 20n,
      priorMaxPriorityFeePerGas: 2n,
    });

    testState.lastEpochPaid = 19n;
    await vi.advanceTimersByTimeAsync(12_000);
  });

  it("recovers a fee-capped flight after its nonce is proven absent from pending", async () => {
    testState.lastEpochPaid = 18n;
    testState.submittedMaxPriorityFeePerGas = 50_100_000_000n;
    testState.submittedMaxFeePerGas = 250_100_000_000n;
    await startAt(epochStart(20) + 100n);
    expect(submitTx).toHaveBeenCalledTimes(1);

    // Replacement attempts are safely capped; no ever-higher transaction is
    // signed while the nonce reservation is still in its safety window.
    await vi.advanceTimersByTimeAsync(84_000);
    expect(submitTx).toHaveBeenCalledTimes(1);

    // At the 96s watchdog tick, confirmed and pending nonces are still 0 and the
    // reservation is no longer invisible. The stale flight is cleared and the
    // current state is submitted again without a fee above the ceiling.
    await vi.advanceTimersByTimeAsync(12_000);
    expect(submitTx).toHaveBeenCalledTimes(2);
    expect(vi.mocked(submitTx).mock.calls[1]![1].replacement).toBeUndefined();
  });

  it("clears the current same-nonce flight when an older attempt reverts and retries with a fresh nonce", async () => {
    const originalReceipt = deferred<{ status: "success" | "reverted"; blockNumber: bigint }>();
    const replacementReceipt = deferred<{ status: "success" | "reverted"; blockNumber: bigint }>();
    testState.submitTxHashes = [TX_HASH_0, TX_HASH_1];
    testState.receipts.set(TX_HASH_0, originalReceipt.promise);
    testState.receipts.set(TX_HASH_1, replacementReceipt.promise);
    testState.lastEpochPaid = 20n;
    const now = epochStart(22) + 100n;

    await startAt(now);
    expect(submitTx).toHaveBeenCalledTimes(1);

    // Audit defense urgently replaces the proactive attempt at the same nonce.
    testState.auditDueTimestamp = now + EPOCH_SECONDS;
    testState.estimatedPayWei = 2n * 22n * BASE_TAX_RATE_WEI;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(submitTx).toHaveBeenCalledTimes(2);
    expect(vi.mocked(submitTx).mock.calls[1]![1].replacement?.nonce).toBe(0);

    // If the older hash mines reverted, nonce 0 is consumed. Its replacement
    // can no longer land, even though that newer attempt is the tracked flight.
    originalReceipt.resolve({ status: "reverted", blockNumber: 101n });
    await vi.advanceTimersByTimeAsync(0);
    testState.auditDueTimestamp = 0n;

    await vi.advanceTimersByTimeAsync(12_000);
    expect(submitTx).toHaveBeenCalledTimes(3);
    expect(vi.mocked(submitTx).mock.calls[2]![1].replacement).toBeUndefined();
    expect(vi.mocked(submitTx).mock.results[2]?.value).toBeDefined();

    const third = await vi.mocked(submitTx).mock.results[2]!.value;
    expect(third.nonce).toBe(1);

    testState.lastEpochPaid = 21n;
    await vi.advanceTimersByTimeAsync(12_000);
  });

  it("uses a fresh nonce when a missed receipt consumed the old nonce without advancing taxes", async () => {
    testState.submitTxHashes = [TX_HASH_0, TX_HASH_1];
    testState.lastEpochPaid = 20n;
    await startAt(epochStart(22) + 100n);

    expect(submitTx).toHaveBeenCalledTimes(1);
    // Receipt tracking for TX_HASH_0 has already failed in the mock. A later
    // confirmed wallet nonce proves nonce 0 was mined/reverted elsewhere while
    // lastEpochPaid stayed unchanged.
    testState.confirmedNonce = 1;
    await vi.advanceTimersByTimeAsync(12_000);

    expect(submitTx).toHaveBeenCalledTimes(2);
    const second = vi.mocked(submitTx).mock.calls[1]![1];
    expect(second.replacement).toBeUndefined();
    const result = await vi.mocked(submitTx).mock.results[1]!.value;
    expect(result.nonce).toBe(1);
  });

  it("does not let a late receipt resurrect payment state after an identity reset", async () => {
    const oldReceipt = deferred<{ status: "success" | "reverted"; blockNumber: bigint }>();
    testState.submitTxHashes = [TX_HASH_0, TX_HASH_1];
    testState.receipts.set(TX_HASH_0, oldReceipt.promise);
    testState.lastEpochPaid = 20n;
    await startAt(epochStart(22) + 100n);
    expect(submitTx).toHaveBeenCalledTimes(1);

    resetPaymentTracking();
    oldReceipt.resolve({ status: "success", blockNumber: 101n });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(12_000);

    expect(submitTx).toHaveBeenCalledTimes(2);
    expect(vi.mocked(submitTx).mock.calls[1]![1].replacement).toBeUndefined();
  });

  it("does not duplicate a successful pre-boundary proactive payment while its on-chain state is still stale", async () => {
    testState.lastEpochPaid = 4n;
    await startAt(epochStart(6) - 10n);

    // Submit successfully three seconds before the boundary. The mocked chain
    // deliberately keeps lastEpochPaid at 4, representing a transaction in flight.
    await vi.advanceTimersByTimeAsync(7_000);
    expect(submitTx).toHaveBeenCalledTimes(1);

    // The 12-second regular poll lands two seconds into epoch 6. It must recognize
    // the pre-boundary submission as pending instead of submitting another payment.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(submitTx).toHaveBeenCalledTimes(1);
  });

  it("replaces a pending pre-boundary payment at the same nonce if an audit lands first", async () => {
    testState.lastEpochPaid = 4n;
    await startAt(epochStart(6) - 10n);

    await vi.advanceTimersByTimeAsync(7_000);
    expect(submitTx).toHaveBeenCalledTimes(1);

    // The audit changes the required payment while the nonce-0 transaction is
    // still pending. Defense must replace nonce 0, not queue nonce 1 behind a
    // payment that is now invalid at its original value.
    testState.auditDueTimestamp = epochStart(6) + EPOCH_SECONDS;
    testState.estimatedPayWei = 2n * 6n * BASE_TAX_RATE_WEI;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(submitTx).toHaveBeenCalledTimes(2);
    const [, replacementOpts] = vi.mocked(submitTx).mock.calls[1]!;
    expect(replacementOpts.replacement).toEqual({
      nonce: 0,
      priorMaxFeePerGas: 20n,
      priorMaxPriorityFeePerGas: 2n,
    });
  });

  it("submits only one payment when active-audit defense and armed JIT run in the same tick", async () => {
    const now = epochStart(11) + 100n;
    testState.lastEpochPaid = 9n;
    testState.auditDueTimestamp = now + EPOCH_SECONDS;
    testState.estimatedPayWei = 2n * 11n * BASE_TAX_RATE_WEI;
    configure({ proactivePay: false, jitEnabled: true, jitTargetEpoch: 11 });

    await startAt(now);

    expect(submitTx).toHaveBeenCalledTimes(1);
  });

  it("uses the epoch captured by a delayed pre-boundary timer instead of recomputing an N+2 value", async () => {
    testState.lastEpochPaid = 4n;
    vi.setSystemTime(new Date(Number(epochStart(6) - 10n) * 1000));
    runtime.running = true;
    runtime.gameState = 1;
    runtime.currentEpoch = 5n;
    runtime.startTime = START_TIME;
    runtime.citizensAddress = "0x00000000000000000000000000000000000000cc";
    runtime.balanceWei = 10_000_000_000_000_000_000n;

    schedulePreBoundaryPay();

    // Model another snapshot observing epoch 6 before the delayed callback runs.
    // The already-armed callback still belongs to the epoch-6 boundary.
    runtime.currentEpoch = 6n;
    await vi.advanceTimersByTimeAsync(7_000);

    expect(submitTx).toHaveBeenCalledTimes(1);
    const [intent, opts] = vi.mocked(submitTx).mock.calls[0]!;
    expect(intent.value).toBe(6n * BASE_TAX_RATE_WEI);
    expect(opts.simTimestamp).toBe(epochStart(6));
  });

  it("re-arms a capped long-delay pre-boundary timer instead of firing weeks early", async () => {
    testState.lastEpochPaid = 4n;
    vi.setSystemTime(new Date(Number(epochStart(5) + 100n) * 1000));
    runtime.running = true;
    runtime.gameState = 1;
    runtime.currentEpoch = 5n;
    runtime.startTime = START_TIME;
    runtime.citizensAddress = "0x00000000000000000000000000000000000000cc";
    runtime.balanceWei = 10_000_000_000_000_000_000n;
    configure({ proactivePay: false, jitEnabled: true, jitTargetEpoch: 40 });

    schedulePreBoundaryPay();
    await vi.advanceTimersByTimeAsync(2_000_000_000);

    expect(submitTx).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });

  it("keeps a queued JIT payment armed and retryable when the mainnet bundle flush fails", async () => {
    appConfig.mode = "mainnet";
    testState.lastEpochPaid = 11n;
    testState.estimatedPayWei = 12n * BASE_TAX_RATE_WEI;
    testState.submitQueued = true;
    testState.flushResults = new Map([[0, { ok: false, error: "no builder accepted" }]]);
    configure({ proactivePay: false, jitEnabled: true, jitTargetEpoch: 12 });

    await startAt(epochStart(12) + 100n);

    expect(flushBundle).toHaveBeenCalledTimes(1);
    expect(runtime.strategy.jitEnabled).toBe(true);

    await vi.advanceTimersByTimeAsync(12_000);
    expect(submitTx).toHaveBeenCalledTimes(2);
  });

  it("retries a proactive payment after its queued mainnet bundle flush fails", async () => {
    appConfig.mode = "mainnet";
    testState.lastEpochPaid = 12n;
    testState.estimatedPayWei = 14n * BASE_TAX_RATE_WEI;
    testState.submitQueued = true;
    testState.flushResults = new Map([[0, { ok: false, error: "no builder accepted" }]]);

    await startAt(epochStart(14) + 100n);
    expect(submitTx).toHaveBeenCalledTimes(1);
    expect(flushBundle).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(12_000);
    expect(submitTx).toHaveBeenCalledTimes(2);
  });

  it("defers offense until the mainnet defense nonce confirms", async () => {
    const now = epochStart(15) + 100n;
    appConfig.mode = "mainnet";
    testState.lastEpochPaid = 13n;
    testState.auditDueTimestamp = now + EPOCH_SECONDS;
    testState.estimatedPayWei = 2n * 15n * BASE_TAX_RATE_WEI;
    testState.submitQueued = true;
    testState.flushResults = new Map([
      [0, { ok: true }],
      [1, { ok: true }],
    ]);
    testState.candidateIds = [99n];
    testState.liveTargets = [{
      id: 99n,
      owner: "0x9999999999999999999999999999999999999999",
    }];
    testState.targetStatuses = [{
      tokenId: "99",
      owner: "0x9999999999999999999999999999999999999999",
      lastEpochPaid: "1",
      delinquent: true,
      epochsBehind: 14,
      auditable: false,
      auditDueTimestamp: (now - 1n).toString(),
      killable: true,
    }];
    configure({
      proactivePay: false,
      offenseEnabled: true,
      autoAudit: false,
      autoKill: true,
    });

    await startAt(now);

    expect(submitTx).toHaveBeenCalledTimes(1);
    expect(beginBundle).toHaveBeenCalledTimes(1);
    expect(flushBundle).toHaveBeenCalledTimes(1);
    expect(vi.mocked(submitTx).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(flushBundle).mock.invocationCallOrder[0]!,
    );
  });

  it("forces a public offense fallback while survival automation is active", async () => {
    const now = epochStart(15) + 100n;
    appConfig.mode = "mainnet";
    testState.lastEpochPaid = 15n; // owned Citizen is safe; no payment this tick
    testState.submitQueued = true;
    testState.flushResults = new Map([[0, { ok: true }]]);
    testState.candidateIds = [99n];
    testState.liveTargets = [{
      id: 99n,
      owner: "0x9999999999999999999999999999999999999999",
    }];
    testState.targetStatuses = [{
      tokenId: "99",
      owner: "0x9999999999999999999999999999999999999999",
      lastEpochPaid: "1",
      delinquent: true,
      epochsBehind: 14,
      auditable: false,
      auditDueTimestamp: (now - 1n).toString(),
      killable: true,
    }];
    configure({
      enabled: true,
      proactivePay: false,
      offenseEnabled: true,
      autoAudit: false,
      autoKill: true,
      racePublicMempool: false,
    });

    await startAt(now);

    expect(submitTx).toHaveBeenCalledTimes(1);
    expect(vi.mocked(submitTx).mock.calls[0]![1].race).toBe(true);
  });

  it("batches each pre-boundary kill deadline separately and re-arms the next cohort", async () => {
    const now = epochStart(15) + 100n;
    const firstDue = now + 10n;
    appConfig.mode = "mainnet";
    testState.lastEpochPaid = 15n;
    testState.submitQueued = true;
    testState.flushResults = new Map([[0, { ok: true }], [1, { ok: true }]]);
    testState.candidateIds = [99n, 100n];
    testState.liveTargets = [99n, 100n].map((id) => ({
      id,
      owner: "0x9999999999999999999999999999999999999999" as const,
    }));
    testState.targetStatuses = [
      {
        tokenId: "99",
        owner: "0x9999999999999999999999999999999999999999",
        lastEpochPaid: "1",
        delinquent: true,
        epochsBehind: 14,
        auditable: false,
        auditDueTimestamp: firstDue.toString(),
        killable: false,
      },
      {
        tokenId: "100",
        owner: "0x9999999999999999999999999999999999999999",
        lastEpochPaid: "1",
        delinquent: true,
        epochsBehind: 14,
        auditable: false,
        auditDueTimestamp: (firstDue + 1n).toString(),
        killable: false,
      },
    ];
    configure({
      enabled: false,
      offenseEnabled: true,
      autoAudit: false,
      autoKill: true,
      preBoundaryKill: true,
    });

    await startAt(now);
    expect(submitTx).not.toHaveBeenCalled();
    // Mainnet lead is 5s; the earliest deadline is 10s away.
    await vi.advanceTimersByTimeAsync(5_000);

    expect(submitTx).toHaveBeenCalledTimes(1);
    expect(vi.mocked(submitTx).mock.calls[0]![1].simTimestamp).toBe(firstDue + 1n);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(submitTx).toHaveBeenCalledTimes(2);
    expect(vi.mocked(submitTx).mock.calls[1]![1].simTimestamp).toBe(firstDue + 2n);
  });
});
