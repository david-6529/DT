import fs from "node:fs";
import path from "node:path";
import type { WalletClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { VERSION, type BotStatus, type StrategyConfig } from "@dat-bot/shared";
import { appConfig } from "./config.js";
import { logger } from "./logger.js";
import { ownershipIndexingAvailable } from "./index-tokens.js";

// Central mutable runtime state. Single hot wallet, single strategy config.

// Curated rival token IDs ship in git (data/rival-targets.json, unlike the
// gitignored data/config.json) so a fresh clone has offense targets without
// needing to `cp data/config.example.json data/config.json` first.
function loadDefaultRivalTargets(): string[] {
  try {
    const p = path.join(appConfig.dataDir, "rival-targets.json");
    if (fs.existsSync(p)) {
      const ids = JSON.parse(fs.readFileSync(p, "utf8"));
      if (Array.isArray(ids)) return ids.map(String);
    }
  } catch (err) {
    logger.warn("Could not load default rival targets:", (err as Error).message);
  }
  return [];
}

export const DEFAULT_STRATEGY: StrategyConfig = {
  enabled: false,
  dryRun: true,
  auditSafetyBufferSeconds: 24 * 60 * 60, // clear a fresh 24h audit immediately
  proactivePay: true,
  prepayEpochs: 1,
  autoUseBribe: false, // never auto-spend bribes; pay taxes to clear audits instead
  maxAutoPayEpochs: 1, // auto-payments cover at most 1 epoch (1 day) each; JIT always fires
  jitEnabled: false,
  jitTargetEpoch: null,
  jitTokenIds: [],
  preBoundaryPay: true,
  preBoundaryLeadMs: 3000,
  preBoundaryLeadMainnetMs: 5000,
  // Offense stays OFF by default (it spends ETH and is a game strategy, not a
  // profit engine) — but when a user turns it on, these are the settings that
  // actually work, so they're pre-armed rather than left for them to discover.
  offenseEnabled: false,
  autoAudit: true,
  autoKill: true,
  endgameOnlyWithin: null,
  offenseTargetTokenIds: loadDefaultRivalTargets(),
  preBoundaryAudit: true,
  preBoundaryKill: true,
  // Payment gas — tuned to win the boundary bundle race: a ~15 gwei tip clears
  // the observed batch-audit bundles (~3 gwei) with margin, dynamic tip scales it
  // up in contested boundary blocks, and the base-fee cap is generous (boundary
  // blocks run near-empty at <1 gwei, but the cap protects against a fee spike).
  maxBaseFeeGwei: 69.1,
  priorityFeeGwei: 15.1,
  minBalanceEth: 0.01,
  // Offense (audit/kill) bids its own gas, independent of payments — it's a race
  // against rivals where a payment isn't, so it carries a higher static tip and a
  // tighter base-fee cap.
  separateOffenseGas: true,
  offenseMaxBaseFeeGwei: 25.1,
  offensePriorityFeeGwei: 10.1,
  offenseDynamicTipEnabled: true,
  offenseDynamicTipMaxGwei: 20.1,
  offenseBoundaryScheduling: false,
  racePublicMempool: true,
  dynamicTipEnabled: true,
  dynamicTipMaxGwei: 50.1,
  maxPaymentEth: 0, // 0 = no cap (opt-in guardrail)
};

class Runtime {
  account: PrivateKeyAccount | null = null;
  walletClient: WalletClient | null = null;
  strategy: StrategyConfig = { ...DEFAULT_STRATEGY };

  running = false;

  // status fields
  chainId: number | null = null;
  balanceWei: bigint | null = null;
  currentEpoch: bigint | null = null;
  gameState: number | null = null;
  citizenSupply: bigint | null = null;
  citizensAddress: string | null = null;
  lastBlock: bigint | null = null;
  startTime: bigint | null = null;

  // spend tracking
  private spentThisEpoch = 0n;
  private spendEpoch: bigint | null = null;

  private statusListeners = new Set<(s: BotStatus) => void>();

  constructor() {
    this.loadStrategy();
  }

  get unlocked(): boolean {
    return this.account !== null;
  }

  private configPath(): string {
    return path.join(appConfig.dataDir, "config.json");
  }

  loadStrategy(): void {
    try {
      const p = this.configPath();
      if (fs.existsSync(p)) {
        const saved = JSON.parse(fs.readFileSync(p, "utf8"));
        this.strategy = { ...DEFAULT_STRATEGY, ...saved };
      }
    } catch (err) {
      logger.warn("Could not load strategy config:", (err as Error).message);
    }
  }

  saveStrategy(next: Partial<StrategyConfig>): StrategyConfig {
    this.strategy = { ...this.strategy, ...next };
    try {
      fs.mkdirSync(appConfig.dataDir, { recursive: true });
      fs.writeFileSync(this.configPath(), JSON.stringify(this.strategy, null, 2));
    } catch (err) {
      logger.warn("Could not save strategy config:", (err as Error).message);
    }
    this.emitStatus();
    return this.strategy;
  }

  /** Track spend for the current epoch; resets automatically on epoch change. */
  recordSpend(wei: bigint): void {
    if (this.spendEpoch !== this.currentEpoch) {
      this.spendEpoch = this.currentEpoch;
      this.spentThisEpoch = 0n;
    }
    this.spentThisEpoch += wei;
  }

  spentThisEpochWei(): bigint {
    if (this.spendEpoch !== this.currentEpoch) return 0n;
    return this.spentThisEpoch;
  }

  status(): BotStatus {
    return {
      version: VERSION,
      running: this.running,
      unlocked: this.unlocked,
      dryRun: this.strategy.dryRun,
      address: this.account?.address ?? null,
      balanceWei: this.balanceWei?.toString() ?? null,
      chainId: this.chainId,
      currentEpoch: this.currentEpoch?.toString() ?? null,
      gameState: this.gameState,
      citizenSupply: this.citizenSupply?.toString() ?? null,
      citizensAddress: this.citizensAddress,
      lastBlock: this.lastBlock?.toString() ?? null,
      spentThisEpochWei: this.spentThisEpochWei().toString(),
      startTime: this.startTime?.toString() ?? null,
      jitEnabled: this.strategy.jitEnabled,
      jitTargetEpoch: this.strategy.jitTargetEpoch,
      nftConfigured: ownershipIndexingAvailable(),
    };
  }

  onStatus(l: (s: BotStatus) => void): () => void {
    this.statusListeners.add(l);
    return () => this.statusListeners.delete(l);
  }

  emitStatus(): void {
    const s = this.status();
    for (const l of this.statusListeners) {
      try {
        l(s);
      } catch {
        /* ignore */
      }
    }
  }

  lock(): void {
    this.account = null;
    this.walletClient = null;
    this.running = false;
    this.emitStatus();
  }
}

export const runtime = new Runtime();
