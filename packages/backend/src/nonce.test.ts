import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./chain.js", () => ({
  publicClient: { getTransactionCount: vi.fn() },
}));

const { publicClient } = await import("./chain.js");
const { NonceManager } = await import("./nonce.js");
const getCount = vi.mocked(publicClient.getTransactionCount);
const ADDR = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const OTHER_ADDR = "0x2222222222222222222222222222222222222222" as `0x${string}`;

describe("NonceManager", () => {
  let nm: InstanceType<typeof NonceManager>;
  beforeEach(() => {
    getCount.mockReset();
    nm = new NonceManager();
  });

  it("public mode holds an unseen reservation briefly, then self-heals", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      getCount.mockResolvedValue(5);
      await nm.sync(ADDR, "public");
      expect(nm.reserve()).toBe(5);
      nm.reset();

      vi.setSystemTime(30_000);
      await nm.sync(ADDR, "public");
      expect(nm.peek()).toBe(6); // don't collide with a possibly accepted tx
      nm.reset();

      vi.setSystemTime(90_001);
      await nm.sync(ADDR, "public");
      expect(nm.peek()).toBe(5); // stale + absent from pending => safe to reuse
    } finally {
      vi.useRealTimers();
    }
  });

  it("mainnet mode holds the reserved ceiling so a bundle's nonce isn't reused", async () => {
    getCount.mockResolvedValue(5); // pending stays 5 — a private bundle isn't in the mempool
    await nm.sync(ADDR, "mainnet");
    expect(nm.reserve()).toBe(5); // submit bundle at nonce 5
    nm.reset();

    await nm.sync(ADDR, "mainnet"); // pending still 5
    expect(nm.peek()).toBe(6); // NOT 5 — we hold our reservation
    expect(nm.reserve()).toBe(6);
    nm.reset();

    await nm.sync(ADDR, "mainnet");
    expect(nm.reserve()).toBe(7); // keeps advancing, no reuse
  });

  it("keeps a live private reservation fenced after switching to public mode", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      getCount.mockResolvedValue(5);
      await nm.sync(ADDR, "mainnet");
      expect(nm.reserve()).toBe(5);
      nm.reset();

      vi.setSystemTime(1_000);
      await nm.sync(ADDR, "public");
      expect(nm.hasInvisibleReservation()).toBe(true);
      expect(nm.pendingNonce()).toBe(5);
      expect(nm.peek()).toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it("mainnet mode resyncs once a held bundle lands", async () => {
    getCount.mockResolvedValueOnce(5);
    await nm.sync(ADDR, "mainnet");
    expect(nm.reserve()).toBe(5);
    nm.reset();

    getCount.mockResolvedValueOnce(6); // bundle mined -> pending advanced
    await nm.sync(ADDR, "mainnet");
    expect(nm.reserve()).toBe(6);
  });

  it("mainnet mode releases a stale reservation (dropped bundle) after the timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      getCount.mockResolvedValue(5); // pending stuck at 5 forever
      await nm.sync(ADDR, "mainnet");
      expect(nm.reserve()).toBe(5);
      nm.reset();

      vi.setSystemTime(30_000); // within the stale window -> still holding
      await nm.sync(ADDR, "mainnet");
      expect(nm.peek()).toBe(6);
      nm.reset();

      vi.setSystemTime(200_000); // past it -> bundle assumed dropped, nonce released
      await nm.sync(ADDR, "mainnet");
      expect(nm.peek()).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ages a fresh reservation from reserve time, not old on-chain inactivity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      getCount.mockResolvedValue(5);
      await nm.sync(ADDR, "mainnet");

      // The wallet can remain quiet far longer than STALE_MS before it submits.
      vi.setSystemTime(500_000);
      expect(nm.reserve()).toBe(5);
      nm.reset();

      vi.setSystemTime(500_001);
      await nm.sync(ADDR, "mainnet");
      expect(nm.peek()).toBe(6); // the one-millisecond-old reservation is held

      nm.reset();
      vi.setSystemTime(590_000);
      await nm.sync(ADDR, "mainnet");
      expect(nm.peek()).toBe(6); // inclusive 90-second safety window

      nm.reset();
      vi.setSystemTime(590_001);
      await nm.sync(ADDR, "mainnet");
      expect(nm.peek()).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes the stale window when part of a reserved nonce sequence advances", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      getCount.mockResolvedValue(5);
      await nm.sync(ADDR, "mainnet");
      expect(nm.reserve()).toBe(5);
      expect(nm.reserve()).toBe(6);
      nm.reset();

      vi.setSystemTime(80_000);
      getCount.mockResolvedValue(6); // nonce 5 landed; nonce 6 is still outstanding
      await nm.sync(ADDR, "mainnet");
      expect(nm.peek()).toBe(7);

      nm.reset();
      vi.setSystemTime(100_000); // 100s from reserve, only 20s from progress
      await nm.sync(ADDR, "mainnet");
      expect(nm.peek()).toBe(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a private reservation that is absent from the public pending nonce", async () => {
    getCount.mockResolvedValue(5);
    await nm.sync(ADDR, "mainnet");
    expect(nm.hasInvisibleReservation()).toBe(false);
    expect(nm.reserve()).toBe(5);
    nm.reset();

    await nm.sync(ADDR, "mainnet");
    expect(nm.hasInvisibleReservation()).toBe(true);

    getCount.mockResolvedValue(6);
    nm.reset();
    await nm.sync(ADDR, "mainnet");
    expect(nm.hasInvisibleReservation()).toBe(false);
  });

  it("never carries a reserved cursor into a different wallet", async () => {
    getCount.mockResolvedValueOnce(50);
    await nm.sync(ADDR, "mainnet");
    expect(nm.reserve()).toBe(50);
    nm.reset();

    getCount.mockResolvedValueOnce(3);
    await nm.sync(OTHER_ADDR, "mainnet");
    expect(nm.peek()).toBe(3);
    expect(nm.hasInvisibleReservation()).toBe(false);
  });

  it("fences a replacement nonce without allocating a different nonce", async () => {
    getCount.mockResolvedValue(5);
    await nm.sync(ADDR, "mainnet");

    nm.ensureNextAbove(7);
    expect(nm.peek()).toBe(8);
    expect(nm.reserve()).toBe(8);

    // Re-fencing an older replacement never moves the allocator backwards.
    nm.ensureNextAbove(6);
    expect(nm.peek()).toBe(9);
  });

  it("rolls back an untouched contiguous reservation batch", async () => {
    getCount.mockResolvedValue(5);
    await nm.sync(ADDR, "mainnet");
    expect(nm.reserve()).toBe(5);
    expect(nm.reserve()).toBe(6);

    expect(nm.releaseContiguous([5, 6])).toBe(true);
    expect(nm.peek()).toBe(5);
    expect(nm.reserve()).toBe(5);
  });

  it("preserves an older held reservation when rolling back only the newest batch", async () => {
    getCount.mockResolvedValue(5);
    await nm.sync(ADDR, "mainnet");
    expect(nm.reserve()).toBe(5); // earlier private tx may still land
    nm.reset();

    await nm.sync(ADDR, "mainnet");
    expect(nm.reserve()).toBe(6);
    expect(nm.reserve()).toBe(7);
    expect(nm.releaseContiguous([6, 7])).toBe(true);
    expect(nm.peek()).toBe(6);

    nm.reset();
    await nm.sync(ADDR, "mainnet");
    expect(nm.peek()).toBe(6); // nonce 5 remains protected
  });

  it("refuses partial, duplicate, non-contiguous, or non-top rollback", async () => {
    getCount.mockResolvedValue(5);
    await nm.sync(ADDR, "mainnet");
    expect(nm.reserve()).toBe(5);
    expect(nm.reserve()).toBe(6);
    expect(nm.reserve()).toBe(7);

    expect(nm.releaseContiguous([5, 6])).toBe(false); // not the whole top range
    expect(nm.releaseContiguous([5, 5, 6, 7])).toBe(false);
    expect(nm.releaseContiguous([5, 7])).toBe(false);
    expect(nm.releaseContiguous([])).toBe(false);
    expect(nm.peek()).toBe(8);
  });
});
