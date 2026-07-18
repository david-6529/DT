import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const strategy = {
    enabled: false,
    offenseEnabled: false,
    jitEnabled: false,
    jitTargetEpoch: null as number | null,
    jitTokenIds: [] as string[],
  };
  const runtime = {
    strategy,
    unlocked: true,
    running: false,
    account: null as { address: `0x${string}` } | null,
    walletClient: null as unknown,
    chainId: null as number | null,
    currentEpoch: 9n as bigint | null,
    startTime: 0n as bigint | null,
    gameState: 1 as number | null,
    citizenSupply: 100n as bigint | null,
    citizensAddress: "0x00000000000000000000000000000000000000cc" as `0x${string}` | null,
    balanceWei: null as bigint | null,
    saveStrategy: vi.fn((patch: Record<string, unknown>) => {
      runtime.strategy = { ...runtime.strategy, ...patch } as typeof strategy;
      return runtime.strategy;
    }),
    emitStatus: vi.fn(),
    status: vi.fn(() => ({ running: runtime.running })),
    lock: vi.fn(),
    onStatus: vi.fn(() => () => {}),
  };
  const appConfig = {
    host: "127.0.0.1",
    mode: "mainnet" as "mainnet" | "public",
    dataDir: "/tmp/dat-api-test",
    httpUrl: "https://old.test",
    wsUrl: "wss://old.test",
    nftUrl: "https://old-nft.test",
  };
  return {
    runtime,
    strategy,
    appConfig,
    startEngine: vi.fn(() => { runtime.running = true; }),
    stopEngine: vi.fn(() => { runtime.running = false; }),
    waitForEngineIdle: vi.fn(async () => {}),
    scheduleJitBoundary: vi.fn(),
    schedulePreBoundaryPay: vi.fn(),
    schedulePreBoundaryAudit: vi.fn(),
    resetJitState: vi.fn(),
    saveSettings: vi.fn(),
    reinitClients: vi.fn(),
    loadKeystore: vi.fn((): Record<string, unknown> | null => null),
    decryptPrivateKey: vi.fn(() => `0x${"11".repeat(32)}` as `0x${string}`),
    accountFromPrivateKey: vi.fn(() => ({
      address: "0x2222222222222222222222222222222222222222" as const,
    })),
  };
});

vi.mock("./config.js", () => ({
  appConfig: h.appConfig,
  loadSettings: vi.fn(() => ({})),
  saveSettings: h.saveSettings,
  deriveUrlsFromKey: vi.fn(() => ({
    httpUrl: "https://new.test",
    wsUrl: "wss://new.test",
    nftUrl: "https://new-nft.test",
  })),
}));
vi.mock("./runtime.js", () => ({ runtime: h.runtime }));
vi.mock("./strategy.js", () => ({
  startEngine: h.startEngine,
  stopEngine: h.stopEngine,
  waitForEngineIdle: h.waitForEngineIdle,
  scheduleJitBoundary: h.scheduleJitBoundary,
  schedulePreBoundaryPay: h.schedulePreBoundaryPay,
  schedulePreBoundaryAudit: h.schedulePreBoundaryAudit,
  resetJitState: h.resetJitState,
}));
vi.mock("./chain.js", () => ({
  publicClient: { getBalance: vi.fn(async () => 0n) },
  reinitClients: h.reinitClients,
  accountFromPrivateKey: h.accountFromPrivateKey,
  makeWalletClient: vi.fn(),
  getChainId: vi.fn(async () => 1),
}));
vi.mock("./activity.js", () => ({
  activity: {
    recent: vi.fn(() => []),
    subscribe: vi.fn(() => () => {}),
  },
}));
vi.mock("./keystore.js", () => ({
  encryptPrivateKey: vi.fn(),
  decryptPrivateKey: h.decryptPrivateKey,
  saveKeystore: vi.fn(),
  loadKeystore: h.loadKeystore,
  keystoreExists: vi.fn(() => false),
  normalizePrivateKey: vi.fn(),
}));
vi.mock("./contract.js", () => ({
  getGameSnapshot: vi.fn(async () => ({
    state: 1,
    currentEpoch: 10n,
    startTime: 0n,
    citizensAddress: "0x00000000000000000000000000000000000000cc",
    citizenSupply: 100n,
  })),
}));
vi.mock("./service.js", () => ({
  readOwnedStatuses: vi.fn(async () => []),
  readTargets: vi.fn(async () => []),
}));
vi.mock("./postmortem.js", () => ({ runPostMortem: vi.fn() }));
vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { buildServer } = await import("./api.js");

describe("API execution lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(h.strategy, {
      enabled: false,
      offenseEnabled: false,
      jitEnabled: false,
      jitTargetEpoch: null,
      jitTokenIds: [],
    });
    h.runtime.strategy = h.strategy;
    h.runtime.unlocked = true;
    h.runtime.running = false;
    h.runtime.account = null;
    h.appConfig.mode = "mainnet";
    h.loadKeystore.mockReturnValue(null);
    h.waitForEngineIdle.mockResolvedValue(undefined);
  });

  it("treats JIT-only configuration as active and starts the engine", async () => {
    const app = await buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/api/config",
      headers: { host: "localhost" },
      payload: { jitEnabled: true, jitTargetEpoch: 10 },
    });

    expect(response.statusCode).toBe(200);
    expect(h.startEngine).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("waits for the active engine to become idle before changing submission mode", async () => {
    let release!: () => void;
    h.runtime.running = true;
    h.waitForEngineIdle.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const app = await buildServer();

    const pending = app.inject({
      method: "POST",
      url: "/api/settings",
      headers: { host: "localhost" },
      payload: { mode: "public" },
    });
    await vi.waitFor(() => expect(h.stopEngine).toHaveBeenCalledTimes(1));
    expect(h.appConfig.mode).toBe("mainnet");

    release();
    const response = await pending;
    expect(response.statusCode).toBe(200);
    expect(h.appConfig.mode).toBe("public");
    expect(h.startEngine).toHaveBeenCalledTimes(1);
    expect(h.waitForEngineIdle.mock.invocationCallOrder[0]).toBeLessThan(
      h.startEngine.mock.invocationCallOrder[0]!,
    );
    await app.close();
  });

  it("does not replace the active wallet until a running tick is idle", async () => {
    let release!: () => void;
    const oldAccount = {
      address: "0x1111111111111111111111111111111111111111" as const,
    };
    h.runtime.account = oldAccount;
    h.runtime.running = true;
    h.loadKeystore.mockReturnValue({ address: "encrypted" });
    h.waitForEngineIdle.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const app = await buildServer();

    const pending = app.inject({
      method: "POST",
      url: "/api/unlock",
      headers: { host: "localhost" },
      payload: { passphrase: "correct horse" },
    });
    await vi.waitFor(() => expect(h.stopEngine).toHaveBeenCalledTimes(1));
    expect(h.runtime.account).toBe(oldAccount);

    release();
    const response = await pending;
    expect(response.statusCode).toBe(200);
    expect(h.runtime.account?.address).toBe("0x2222222222222222222222222222222222222222");
    await app.close();
  });

  it("does not apply a live strategy patch until the old execution is idle", async () => {
    let release!: () => void;
    h.runtime.running = true;
    h.strategy.enabled = true;
    h.waitForEngineIdle.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const app = await buildServer();

    const pending = app.inject({
      method: "POST",
      url: "/api/config",
      headers: { host: "localhost" },
      payload: { dryRun: true },
    });
    await vi.waitFor(() => expect(h.stopEngine).toHaveBeenCalledTimes(1));
    expect(h.runtime.saveStrategy).not.toHaveBeenCalled();

    release();
    const response = await pending;
    expect(response.statusCode).toBe(200);
    expect(h.runtime.saveStrategy).toHaveBeenCalledWith({ dryRun: true });
    expect(h.startEngine).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("serializes an overlapping settings change and later stop so stop wins", async () => {
    let releaseFirst!: () => void;
    h.runtime.running = true;
    h.waitForEngineIdle
      .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseFirst = resolve; }))
      .mockResolvedValue(undefined);
    const app = await buildServer();

    const settings = app.inject({
      method: "POST",
      url: "/api/settings",
      headers: { host: "localhost" },
      payload: { mode: "public" },
    });
    await vi.waitFor(() => expect(h.stopEngine).toHaveBeenCalledTimes(1));
    const stop = app.inject({
      method: "POST",
      url: "/api/stop",
      headers: { host: "localhost" },
    });

    releaseFirst();
    const [settingsResponse, stopResponse] = await Promise.all([settings, stop]);
    expect(settingsResponse.statusCode).toBe(200);
    expect(stopResponse.statusCode).toBe(200);
    expect(h.startEngine).toHaveBeenCalledTimes(1);
    expect(h.stopEngine).toHaveBeenCalledTimes(2);
    expect(h.runtime.running).toBe(false);
    await app.close();
  });
});
