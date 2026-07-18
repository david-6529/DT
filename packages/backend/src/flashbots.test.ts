import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256, parseTransaction, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const h = vi.hoisted(() => {
  const publicClient = {
    estimateGas: vi.fn(),
    getBlockNumber: vi.fn(),
    call: vi.fn(),
    request: vi.fn(),
    sendRawTransaction: vi.fn(),
  };
  const nonceManager = {
    peek: vi.fn(),
    reserve: vi.fn(),
    ensureNextAbove: vi.fn(),
    releaseContiguous: vi.fn(),
  };
  return {
    appConfig: {
      mode: "mainnet" as "mainnet" | "public" | "local",
      dataDir: "/tmp/death-and-taxes-flashbots-test",
      flashbotsRelayUrl: "https://relay.test",
      builderUrls: ["https://builder-a.test", "https://builder-b.test"],
    },
    runtime: {
      account: null as ReturnType<typeof privateKeyToAccount> | null,
      strategy: {
        maxBaseFeeGwei: 100,
        priorityFeeGwei: 2,
        dynamicTipEnabled: false,
        dynamicTipMaxGwei: 50,
        separateOffenseGas: false,
      },
    },
    publicClient,
    nonceManager,
    getLatestBlockCached: vi.fn(),
    reputationKey: `0x${"22".repeat(32)}` as Hex,
  };
});

vi.mock("node:fs", () => {
  const fs = {
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => h.reputationKey),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
  return { default: fs, ...fs };
});

vi.mock("./chain.js", () => ({
  publicClient: h.publicClient,
  getLatestBlockCached: h.getLatestBlockCached,
}));
vi.mock("./config.js", () => ({ appConfig: h.appConfig }));
vi.mock("./runtime.js", () => ({ runtime: h.runtime }));
vi.mock("./nonce.js", () => ({ nonceManager: h.nonceManager }));
vi.mock("./logic.js", async () => {
  const actual = await vi.importActual<typeof import("./logic.js")>("./logic.js");
  return {
    ...actual,
    resolveGas: () => ({
      maxBaseFeeGwei: 100,
      priorityFeeGwei: 2,
      dynamicTipEnabled: false,
      dynamicTipMaxGwei: 50,
    }),
    effectiveTipGwei: () => 2,
  };
});
vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const {
  beginBundle,
  discardBundle,
  flushBundle,
  submitTx,
  waitForBundleFallbacks,
} = await import("./flashbots.js");

const ACCOUNT = privateKeyToAccount(`0x${"11".repeat(32)}`);
const TO = "0x00000000000000000000000000000000000000aa" as const;

type RpcCall = {
  url: string;
  method: string;
  params: any[];
  signal?: AbortSignal;
};

function rpcCall(url: string | URL | Request, init?: RequestInit): RpcCall {
  const body = JSON.parse(String(init?.body));
  return {
    url: String(url),
    method: body.method,
    params: body.params,
    signal: init?.signal ?? undefined,
  };
}

function response(result: unknown): Response {
  return { json: async () => ({ result }) } as Response;
}

function txHash(nonce: number): Hex {
  return `0x${nonce.toString(16).padStart(64, "0")}` as Hex;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function queueTwo(nonces = [7, 8]) {
  const remaining = [...nonces];
  h.nonceManager.peek.mockImplementation(() => remaining[0] ?? 99);
  h.nonceManager.reserve.mockImplementation(() => remaining.shift()!);
  beginBundle();
  const first = await submitTx({ to: TO, data: "0x01", value: 0n, gas: 50_000n }, { dryRun: false, race: true });
  const second = await submitTx({ to: TO, data: "0x02", value: 0n, gas: 50_000n }, { dryRun: false, race: true });
  return [first, second];
}

async function queueThree() {
  beginBundle();
  const results = [];
  for (const data of ["0x01", "0x02", "0x03"] as Hex[]) {
    results.push(await submitTx(
      { to: TO, data, value: 0n, gas: 50_000n },
      { dryRun: false, race: true },
    ));
  }
  return results;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.appConfig.mode = "mainnet";
  h.appConfig.builderUrls = ["https://builder-a.test", "https://builder-b.test"];
  h.runtime.account = ACCOUNT;
  h.getLatestBlockCached.mockResolvedValue({
    number: 100n,
    baseFeePerGas: 1_000_000_000n,
    gasUsed: 15_000_000n,
    gasLimit: 30_000_000n,
  });
  h.publicClient.getBlockNumber.mockResolvedValue(100n);
  h.publicClient.estimateGas.mockResolvedValue(50_000n);
  h.publicClient.call.mockResolvedValue({ data: "0x" });
  h.publicClient.request.mockResolvedValue("0x");
  h.nonceManager.peek.mockReturnValue(7);
  let nextNonce = 7;
  h.nonceManager.reserve.mockImplementation(() => nextNonce++);
  h.nonceManager.releaseContiguous.mockReturnValue(true);
  h.publicClient.sendRawTransaction.mockImplementation(async ({ serializedTransaction }) => {
    return txHash(parseTransaction(serializedTransaction).nonce!);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("queued mainnet bundle delivery", () => {
  it("simulates the nonce-sorted bundle as a whole, then fans out privately while mirroring publicly", async () => {
    const pendingBuilders: Array<(value: Response) => void> = [];
    const calls: RpcCall[] = [];
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      calls.push(call);
      if (call.method === "eth_callBundle") {
        const results = call.params[0].txs.map(() => ({ gasUsed: "0x1" }));
        return Promise.resolve(response({ results }));
      }
      return new Promise<Response>((resolve) => pendingBuilders.push(resolve));
    });

    // Deliberately reserve out of order: flushBundle must sort the signed txs.
    const queued = await queueTwo([8, 7]);
    expect(fetchMock).not.toHaveBeenCalled(); // assembly uses eth_call, not nonce-gap bundle sims
    expect(h.publicClient.call).toHaveBeenCalledTimes(2);

    const flushed = flushBundle();
    await vi.waitFor(() => {
      expect(pendingBuilders).toHaveLength(4); // 2 builders x next 2 blocks
      expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(2);
    });

    // Builder promises are still unresolved, proving the public mirror started
    // concurrently rather than waiting for private acknowledgements.
    expect(calls[0]?.method).toBe("eth_callBundle");
    const simulated = calls[0]!.params[0].txs as Hex[];
    expect(simulated.map((tx) => parseTransaction(tx).nonce)).toEqual([7, 8]);
    const hashByNonce = new Map(simulated.map((tx) => [parseTransaction(tx).nonce!, keccak256(tx)]));
    expect(queued.map((r) => r.txHash)).toEqual([
      hashByNonce.get(8),
      hashByNonce.get(7),
    ]);

    const sends = calls.filter((c) => c.method === "eth_sendBundle");
    expect(sends.map((c) => c.url).sort()).toEqual([
      "https://builder-a.test",
      "https://builder-a.test",
      "https://builder-b.test",
      "https://builder-b.test",
    ]);
    expect(sends.map((c) => c.params[0].blockNumber).sort()).toEqual(["0x65", "0x65", "0x66", "0x66"]);
    expect(sends.every((c) => !("revertingTxHashes" in c.params[0]))).toBe(true);
    for (const resolve of pendingBuilders) resolve(response({ bundleHash: "0xbundle" }));

    const result = await flushed;
    expect([...result.keys()]).toEqual([7, 8]);
    expect([...result.values()].every((r) => r.ok && r.bundleHash === "0xbundle")).toBe(true);
    expect([...result.entries()].every(([nonce, r]) => r.txHash === hashByNonce.get(nonce))).toBe(true);
    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
  });

  it("tolerates a revertible audit while protecting and publicly mirroring only the payment prefix", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_005_000);
    const calls: RpcCall[] = [];
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      calls.push(call);
      if (call.method === "eth_callBundle") {
        return Promise.resolve(response({ results: [{}, { revert: "audit lost the race" }] }));
      }
      return Promise.resolve(response({ bundleHash: "0xpayment-safe" }));
    });

    beginBundle();
    const payment = await submitTx(
      { to: TO, data: "0x61", value: 1n, gas: 50_000n },
      { dryRun: false, race: true, simTimestamp: 1_005n },
    );
    const audit = await submitTx(
      { to: TO, data: "0x62", value: 0n, gas: 50_000n },
      {
        dryRun: false,
        race: false,
        offense: true,
        revertible: true,
        simTimestamp: 1_005n,
      },
    );

    const result = await flushBundle();
    const sends = calls.filter((c) => c.method === "eth_sendBundle");
    expect(sends).toHaveLength(4);
    for (const send of sends) {
      expect(send.params[0].minTimestamp).toBe(1_005);
      expect(send.params[0].revertingTxHashes).toEqual([audit.txHash]);
    }

    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(1);
    const [{ serializedTransaction }] = h.publicClient.sendRawTransaction.mock.calls[0]!;
    expect(parseTransaction(serializedTransaction).nonce).toBe(payment.nonce);

    // Keep the optional audit private for one full slot, then publish it so its
    // reserved nonce cannot invisibly fence a later survival transaction.
    await vi.advanceTimersByTimeAsync(11_999);
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(2);
    const [{ serializedTransaction: auditFallback }] = h.publicClient.sendRawTransaction.mock.calls[1]!;
    expect(parseTransaction(auditFallback).nonce).toBe(audit.nonce);

    expect(result.get(payment.nonce)).toMatchObject({ ok: true, bundleHash: "0xpayment-safe" });
    expect(result.get(audit.nonce)).toMatchObject({ ok: true, bundleHash: "0xpayment-safe" });
    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
  });

  it("aborts and releases the whole batch when a mandatory payment reverts", async () => {
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      expect(call.method).toBe("eth_callBundle");
      return Promise.resolve(response({
        results: [
          { revert: "mandatory payment failed" },
          { revert: "optional audit failed" },
        ],
      }));
    });

    beginBundle();
    const payment = await submitTx(
      { to: TO, data: "0x63", value: 1n, gas: 50_000n },
      { dryRun: false, race: true },
    );
    const audit = await submitTx(
      { to: TO, data: "0x64", value: 0n, gas: 50_000n },
      { dryRun: false, race: false, offense: true, revertible: true },
    );

    const result = await flushBundle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(result.get(payment.nonce)).toMatchObject({
      ok: false,
      error: expect.stringContaining("mandatory payment failed"),
    });
    expect(result.get(audit.nonce)).toMatchObject({
      ok: false,
      error: expect.stringContaining("mandatory payment failed"),
    });
    expect(h.nonceManager.releaseContiguous).toHaveBeenCalledWith([7, 8]);
  });

  it("strips and releases only a structurally invalid audit suffix while delivering the payment prefix", async () => {
    const calls: RpcCall[] = [];
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      calls.push(call);
      if (call.method === "eth_callBundle") {
        return Promise.resolve(response({
          results: [{ gasUsed: "0x1" }, { error: "invalid nonce: expected 8" }],
        }));
      }
      return Promise.resolve(response({ bundleHash: "0xpayment-only" }));
    });

    beginBundle();
    const payment = await submitTx(
      { to: TO, data: "0x67", value: 1n, gas: 50_000n },
      { dryRun: false, race: true },
    );
    const audit = await submitTx(
      { to: TO, data: "0x68", value: 0n, gas: 50_000n },
      { dryRun: false, race: false, offense: true, revertible: true },
    );

    const result = await flushBundle();

    const sends = calls.filter((call) => call.method === "eth_sendBundle");
    expect(sends).toHaveLength(4);
    expect(sends.every((send) => send.params[0].txs.length === 1)).toBe(true);
    expect(sends.every((send) => !("revertingTxHashes" in send.params[0]))).toBe(true);
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(1);
    const [{ serializedTransaction }] = h.publicClient.sendRawTransaction.mock.calls[0]!;
    expect(parseTransaction(serializedTransaction).nonce).toBe(payment.nonce);

    expect(result.get(payment.nonce)).toMatchObject({ ok: true, bundleHash: "0xpayment-only" });
    expect(result.get(audit.nonce)).toMatchObject({
      ok: false,
      error: expect.stringContaining("optional revertible suffix removed"),
    });
    expect(h.nonceManager.releaseContiguous).toHaveBeenCalledTimes(1);
    expect(h.nonceManager.releaseContiguous).toHaveBeenCalledWith([audit.nonce]);
  });

  it("waits for a delayed audit fallback and for its in-flight public send", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_005_000);
    const auditSend = deferred<Hex>();
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      if (call.method === "eth_callBundle") {
        return Promise.resolve(response({ results: [{}, {}] }));
      }
      return Promise.resolve(response({ bundleHash: "0xprivate" }));
    });
    h.publicClient.sendRawTransaction
      .mockImplementationOnce(async ({ serializedTransaction }) => (
        txHash(parseTransaction(serializedTransaction).nonce!)
      ))
      .mockImplementationOnce(() => auditSend.promise);

    beginBundle();
    const payment = await submitTx(
      { to: TO, data: "0x69", value: 1n, gas: 50_000n },
      { dryRun: false, race: true, simTimestamp: 1_005n },
    );
    const audit = await submitTx(
      { to: TO, data: "0x6a", value: 0n, gas: 50_000n },
      { dryRun: false, race: false, offense: true, revertible: true, simTimestamp: 1_005n },
    );
    await flushBundle();

    let settled = false;
    const waiting = waitForBundleFallbacks().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(11_999);
    expect(settled).toBe(false);
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(parseTransaction(
      h.publicClient.sendRawTransaction.mock.calls[0]![0].serializedTransaction,
    ).nonce).toBe(payment.nonce);

    await vi.advanceTimersByTimeAsync(1);
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(parseTransaction(
      h.publicClient.sendRawTransaction.mock.calls[1]![0].serializedTransaction,
    ).nonce).toBe(audit.nonce);
    expect(settled).toBe(false);

    auditSend.resolve(txHash(audit.nonce));
    await waiting;
    expect(settled).toBe(true);
  });

  it("aborts a still-scheduled audit fallback before it can publish", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_005_000);
    const controller = new AbortController();
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      if (call.method === "eth_callBundle") {
        return Promise.resolve(response({ results: [{}, {}] }));
      }
      return Promise.resolve(response({ bundleHash: "0xprivate" }));
    });

    beginBundle();
    await submitTx(
      { to: TO, data: "0x6b", value: 1n, gas: 50_000n },
      { dryRun: false, race: true, simTimestamp: 1_005n },
    );
    await submitTx(
      { to: TO, data: "0x6c", value: 0n, gas: 50_000n },
      {
        dryRun: false,
        race: false,
        offense: true,
        revertible: true,
        simTimestamp: 1_005n,
        signal: controller.signal,
      },
    );
    await flushBundle();

    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(1);
    const waiting = waitForBundleFallbacks();
    controller.abort();
    await waiting;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("does not publish an audit suffix when the public payment prefix is uncertain", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_005_000);
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      if (call.method === "eth_callBundle") {
        return Promise.resolve(response({ results: [{}, {}] }));
      }
      return Promise.resolve(response({ bundleHash: "0xprivate" }));
    });
    h.publicClient.sendRawTransaction.mockRejectedValue(new Error("public transport reset"));

    beginBundle();
    const payment = await submitTx(
      { to: TO, data: "0x6d", value: 1n, gas: 50_000n },
      { dryRun: false, race: true, simTimestamp: 1_005n },
    );
    await submitTx(
      { to: TO, data: "0x6e", value: 0n, gas: 50_000n },
      { dryRun: false, race: false, offense: true, revertible: true, simTimestamp: 1_005n },
    );

    const result = await flushBundle();
    expect(result.get(payment.nonce)).toMatchObject({ ok: true, bundleHash: "0xprivate" });
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(1);

    await waitForBundleFallbacks();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("rejects a mandatory transaction queued after a revertible suffix", async () => {
    beginBundle();
    await submitTx(
      { to: TO, data: "0x65", value: 0n, gas: 50_000n },
      { dryRun: false, race: false, offense: true, revertible: true },
    );
    await submitTx(
      { to: TO, data: "0x66", value: 1n, gas: 50_000n },
      { dryRun: false, race: true },
    );

    const result = await flushBundle();

    expect(h.publicClient.getBlockNumber).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect([...result.values()].every(
      (r) => !r.ok && r.error === "bundle contains a mandatory transaction after a revertible suffix",
    )).toBe(true);
    expect(h.nonceManager.releaseContiguous).toHaveBeenCalledWith([7, 8]);
  });

  it("accepts partial private fanout success even when public mirrors fail", async () => {
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      if (call.method === "eth_callBundle") {
        return Promise.resolve(response({ results: [{}, {}] }));
      }
      if (call.url === "https://builder-a.test") {
        return Promise.resolve(response("0xstring-bundle-hash"));
      }
      return Promise.reject(new Error("builder offline"));
    });
    h.publicClient.sendRawTransaction.mockRejectedValue(new Error("nonce too low"));

    await queueTwo();
    const result = await flushBundle();

    expect([...result.values()].every((r) => r.ok)).toBe(true);
    expect([...result.values()].every((r) => r.bundleHash === "0xstring-bundle-hash")).toBe(true);
    expect([...result.values()].every((r) => r.txHash !== undefined)).toBe(true);
  });

  it("uses successful public mirrors when every private builder fails", async () => {
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      if (call.method === "eth_callBundle") {
        return Promise.resolve(response({ results: [{}, {}] }));
      }
      return Promise.reject(new Error("builder offline"));
    });

    await queueTwo();
    const result = await flushBundle();

    expect([...result.values()].every((r) => r.ok && r.txHash !== undefined)).toBe(true);
    expect([...result.values()].every((r) => r.bundleHash === undefined)).toBe(true);
  });

  it("broadcasts only a contiguous public prefix and retains mixed outcomes", async () => {
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      if (call.method === "eth_callBundle") {
        return Promise.resolve(response({ results: [{}, {}, {}] }));
      }
      return Promise.reject(new Error("builder offline"));
    });
    h.publicClient.sendRawTransaction
      .mockResolvedValueOnce(txHash(7))
      .mockRejectedValueOnce(new Error("public transport reset"));

    await queueThree();
    const result = await flushBundle();

    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(2); // nonce 9 remains untouched
    expect(result.get(7)).toMatchObject({ ok: true, uncertain: undefined });
    expect(result.get(8)).toMatchObject({ ok: true, uncertain: true });
    expect(result.get(9)).toMatchObject({ ok: true, uncertain: true });
    expect(result.get(8)?.txHash).toBeDefined();
    expect(result.get(9)?.txHash).toBeDefined();
    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
  });

  it("treats already-known as accepted and continues the nonce prefix", async () => {
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      if (call.method === "eth_callBundle") return Promise.resolve(response({ results: [{}, {}] }));
      return Promise.reject(new Error("builder offline"));
    });
    h.publicClient.sendRawTransaction
      .mockRejectedValueOnce(new Error("already known"))
      .mockResolvedValueOnce(txHash(8));

    await queueTwo();
    const result = await flushBundle();

    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(2);
    expect([...result.values()].every((r) => r.ok && !r.uncertain)).toBe(true);
    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
  });

  it("keeps deterministic uncertain results when every attempted delivery is ambiguous", async () => {
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      if (call.method === "eth_callBundle") {
        return Promise.resolve(response({ results: [{}, {}] }));
      }
      return Promise.reject(new Error("builder offline"));
    });
    h.publicClient.sendRawTransaction.mockRejectedValue(new Error("nonce too low"));

    await queueTwo();
    const result = await flushBundle();

    expect([...result.values()].every((r) => r.ok && r.uncertain && r.txHash !== undefined)).toBe(true);
    expect(result.get(7)?.error).toContain("nonce too low");
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(1); // stop at the first uncertainty
    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
  });

  it("does not submit a bundle or public transactions when whole-bundle simulation reverts", async () => {
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      expect(call.method).toBe("eth_callBundle");
      return Promise.resolve(response({ results: [{}, { revert: "second tx failed" }] }));
    });

    await queueTwo();
    const result = await flushBundle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect([...result.values()].every((r) => !r.ok && r.error?.includes("second tx failed"))).toBe(true);
    expect(h.nonceManager.releaseContiguous).toHaveBeenCalledWith([7, 8]);
  });

  it("rolls back without sending when queued transactions require conflicting timestamps", async () => {
    beginBundle();
    await submitTx(
      { to: TO, data: "0x01", value: 0n, gas: 50_000n },
      { dryRun: false, race: true, simTimestamp: 1_000n },
    );
    await submitTx(
      { to: TO, data: "0x02", value: 0n, gas: 50_000n },
      { dryRun: false, race: true, simTimestamp: 2_000n },
    );

    const result = await flushBundle();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect([...result.values()].every((r) => !r.ok && r.error?.includes("conflicting"))).toBe(true);
    expect(h.nonceManager.releaseContiguous).toHaveBeenCalledWith([7, 8]);
  });

  it("discards an unsent open bundle and releases only its fresh reservations", async () => {
    await queueTwo();

    const result = discardBundle("generation invalidated");

    expect([...result.values()].every((r) => !r.ok && r.error === "generation invalidated")).toBe(true);
    expect(h.nonceManager.releaseContiguous).toHaveBeenCalledWith([7, 8]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(await flushBundle()).toEqual(new Map());
  });

  it("cancels after whole-bundle simulation if the engine stops before delivery", async () => {
    const generation = new AbortController();
    let finishSimulation!: (value: Response) => void;
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      expect(call.method).toBe("eth_callBundle");
      return new Promise<Response>((resolve) => { finishSimulation = resolve; });
    });
    beginBundle();
    await submitTx(
      { to: TO, data: "0x45", value: 0n, gas: 50_000n },
      { dryRun: false, race: true, signal: generation.signal },
    );

    const flushed = flushBundle();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    generation.abort();
    finishSimulation(response({ results: [{}] }));
    const result = await flushed;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(result.get(7)).toMatchObject({
      ok: false,
      error: "bundle submission aborted before delivery",
    });
    expect(h.nonceManager.releaseContiguous).toHaveBeenCalledWith([7]);
  });

  it("fails open on a whole-bundle nonce mismatch so a replacement reaches the txpool", async () => {
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      if (call.method === "eth_callBundle") {
        return Promise.resolve(response({ results: [{ error: "nonce too low" }] }));
      }
      return Promise.reject(new Error("builder offline"));
    });
    beginBundle();
    const queued = await submitTx(
      { to: TO, data: "0x44", value: 0n, gas: 50_000n },
      {
        dryRun: false,
        race: true,
        replacement: {
          nonce: 5,
          priorMaxFeePerGas: 3_000_000_000n,
          priorMaxPriorityFeePerGas: 2_000_000_000n,
        },
      },
    );

    const result = await flushBundle();

    expect(queued.nonce).toBe(5);
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(result.get(5)).toMatchObject({ ok: true, uncertain: undefined, txHash: queued.txHash });
    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
  });

  it("adds minTimestamp privately and delays the public mirror until that timestamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const calls: RpcCall[] = [];
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      calls.push(call);
      if (call.method === "eth_callBundle") return Promise.resolve(response({ results: [{}] }));
      return Promise.resolve(response({ bundleHash: "0xfuture" }));
    });
    beginBundle();
    await submitTx(
      { to: TO, data: "0x55", value: 0n, gas: 50_000n },
      { dryRun: false, race: true, simTimestamp: 1_005n },
    );

    const flushed = flushBundle();
    await vi.advanceTimersByTimeAsync(0);
    const sends = calls.filter((c) => c.method === "eth_sendBundle");
    expect(sends).toHaveLength(4);
    expect(sends.every((c) => c.params[0].minTimestamp === 1_005)).toBe(true);
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(4_999);
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const result = await flushed;
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(result.get(7)?.ok).toBe(true);
  });

  it("cancels a delayed queued mirror without releasing its ambiguous nonce", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const generation = new AbortController();
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      if (call.method === "eth_callBundle") return Promise.resolve(response({ results: [{}] }));
      return Promise.reject(new Error("builder offline"));
    });
    beginBundle();
    await submitTx(
      { to: TO, data: "0x56", value: 0n, gas: 50_000n },
      { dryRun: false, race: true, simTimestamp: 1_005n, signal: generation.signal },
    );

    const flushed = flushBundle();
    await vi.advanceTimersByTimeAsync(0);
    generation.abort();
    await vi.advanceTimersByTimeAsync(0);
    const result = await flushed;

    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(result.get(7)).toMatchObject({
      ok: true,
      uncertain: true,
      error: "public broadcast aborted",
    });
    expect(result.get(7)?.txHash).toBeDefined();
    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
  });

  it("times out whole-bundle simulation after 500ms and fails open to dual delivery", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      if (call.method === "eth_callBundle") {
        return new Promise<Response>((_resolve, reject) => {
          call.signal?.addEventListener("abort", () => reject(new Error("sim timeout")), { once: true });
        });
      }
      return Promise.resolve(response({ bundleHash: "0xafter-timeout" }));
    });

    await queueTwo();
    const flushed = flushBundle();
    await vi.advanceTimersByTimeAsync(499);
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    const result = await flushed;
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(2);
    expect([...result.values()].every((r) => r.ok && r.bundleHash === "0xafter-timeout")).toBe(true);
    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
  });

  it("bounds slow private builders and preserves successful public delivery", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      if (call.method === "eth_callBundle") {
        return Promise.resolve(response({ results: [{}, {}] }));
      }
      return new Promise<Response>((_resolve, reject) => {
        call.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });

    await queueTwo();
    const flushed = flushBundle();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2_999);
    let settled = false;
    void flushed.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const result = await flushed;
    expect([...result.values()].every((r) => r.ok && r.txHash !== undefined)).toBe(true);
  });
});

describe("direct future-timestamp delivery", () => {
  it.each(["public", "local"] as const)("delays %s raw broadcast until simTimestamp", async (mode) => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    h.appConfig.mode = mode;

    const submitted = submitTx(
      { to: TO, data: "0x77", value: 0n, gas: 50_000n },
      { dryRun: false, race: true, simTimestamp: 2_003n },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_999);
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    const result = await submitted;
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, uncertain: undefined });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("releases a direct public reservation when cancellation happens before broadcast", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    h.appConfig.mode = "public";
    const generation = new AbortController();

    const submitted = submitTx(
      { to: TO, data: "0x78", value: 0n, gas: 50_000n },
      { dryRun: false, race: true, simTimestamp: 2_003n, signal: generation.signal },
    );
    await vi.advanceTimersByTimeAsync(0);
    generation.abort();
    await vi.advanceTimersByTimeAsync(0);

    await expect(submitted).resolves.toMatchObject({
      ok: false,
      error: "public broadcast aborted",
    });
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(h.nonceManager.releaseContiguous).toHaveBeenCalledWith([7]);
  });
});

describe("same-nonce replacement", () => {
  it("reuses the nonce, bumps both EIP-1559 fees by at least 12.5%, and exposes the signed hash", async () => {
    h.appConfig.mode = "public";
    const priorMaxFeePerGas = 10_000_000_001n;
    const priorMaxPriorityFeePerGas = 4_000_000_001n;

    const result = await submitTx(
      { to: TO, data: "0x99", value: 123n, gas: 50_000n },
      {
        dryRun: false,
        race: true,
        replacement: { nonce: 42, priorMaxFeePerGas, priorMaxPriorityFeePerGas },
      },
    );

    expect(h.nonceManager.reserve).not.toHaveBeenCalled();
    expect(h.nonceManager.ensureNextAbove).toHaveBeenCalledWith(42);
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(1);
    const [{ serializedTransaction }] = h.publicClient.sendRawTransaction.mock.calls[0]!;
    const parsed = parseTransaction(serializedTransaction);
    expect(parsed.nonce).toBe(42);
    expect(parsed.maxFeePerGas).toBe((priorMaxFeePerGas * 9n) / 8n + 1n);
    expect(parsed.maxPriorityFeePerGas).toBe((priorMaxPriorityFeePerGas * 9n) / 8n + 1n);
    expect(result.maxFeePerGas).toBe(parsed.maxFeePerGas);
    expect(result.maxPriorityFeePerGas).toBe(parsed.maxPriorityFeePerGas);
    expect(result.txHash).toBe(keccak256(serializedTransaction));
    expect(result.ok).toBe(true);
  });

  it("strictly exceeds 12.5% for divisible fees and refuses to cross configured ceilings", async () => {
    h.appConfig.mode = "public";
    const first = await submitTx(
      { to: TO, data: "0x9a", value: 0n, gas: 50_000n },
      {
        dryRun: false,
        race: true,
        replacement: {
          nonce: 42,
          priorMaxFeePerGas: 8_000_000_000n,
          priorMaxPriorityFeePerGas: 8_000_000_000n,
        },
      },
    );
    expect(first.maxFeePerGas).toBe(9_000_000_001n);
    expect(first.maxPriorityFeePerGas).toBe(9_000_000_001n);

    vi.clearAllMocks();
    h.getLatestBlockCached.mockResolvedValue({
      number: 100n,
      baseFeePerGas: 1_000_000_000n,
      gasUsed: 15_000_000n,
      gasLimit: 30_000_000n,
    });
    h.publicClient.estimateGas.mockResolvedValue(50_000n);
    const capped = await submitTx(
      { to: TO, data: "0x9b", value: 0n, gas: 50_000n },
      {
        dryRun: false,
        race: true,
        replacement: {
          nonce: 42,
          priorMaxFeePerGas: 250_000_000_000n,
          priorMaxPriorityFeePerGas: 50_000_000_000n,
        },
      },
    );
    expect(capped).toMatchObject({ ok: false, error: "replacement fee ceiling reached" });
    expect(h.nonceManager.ensureNextAbove).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
  });
});

describe("single private bundle delivery", () => {
  it("returns the deterministic signed hash when only a private builder accepts", async () => {
    const calls: RpcCall[] = [];
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      calls.push(call);
      if (call.method === "eth_callBundle") return Promise.resolve(response({ results: [{}] }));
      if (call.url === "https://builder-a.test") {
        return Promise.resolve(response({ bundleHash: "0xprivate-only" }));
      }
      return Promise.reject(new Error("builder offline"));
    });
    h.publicClient.sendRawTransaction.mockRejectedValue(new Error("public RPC offline"));

    const result = await submitTx(
      { to: TO, data: "0xab", value: 0n, gas: 50_000n },
      { dryRun: false, race: true },
    );

    const sent = calls.find((c) => c.method === "eth_sendBundle")!.params[0].txs[0] as Hex;
    expect(result.ok).toBe(true);
    expect(result.bundleHash).toBe("0xprivate-only");
    expect(result.txHash).toBe(keccak256(sent));
    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
  });

  it("retains an uncertain reservation when neither delivery path acknowledges", async () => {
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      if (call.method === "eth_callBundle") return Promise.resolve(response({ results: [{}] }));
      return Promise.reject(new Error("builder offline"));
    });
    h.publicClient.sendRawTransaction.mockRejectedValue(new Error("public RPC offline"));

    const result = await submitTx(
      { to: TO, data: "0xcd", value: 0n, gas: 50_000n },
      { dryRun: false, race: true },
    );

    expect(result.ok).toBe(true);
    expect(result.uncertain).toBe(true);
    expect(result.txHash).toBeDefined();
    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
  });
});
