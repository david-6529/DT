import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { z } from "zod";
import { generatePrivateKey } from "viem/accounts";
import { appConfig, loadSettings, saveSettings, deriveUrlsFromKey } from "./config.js";
import { publicClient, reinitClients, accountFromPrivateKey, makeWalletClient, getChainId } from "./chain.js";
import { runtime } from "./runtime.js";
import { activity } from "./activity.js";
import { logger } from "./logger.js";
import {
  encryptPrivateKey,
  decryptPrivateKey,
  saveKeystore,
  loadKeystore,
  keystoreExists,
  normalizePrivateKey,
} from "./keystore.js";
import { getGameSnapshot } from "./contract.js";
import { startEngine, stopEngine, waitForEngineIdle, scheduleJitBoundary, schedulePreBoundaryPay, schedulePreBoundaryAudit, resetJitState } from "./strategy.js";
import { readOwnedStatuses, readTargets } from "./service.js";
import { runPostMortem } from "./postmortem.js";

const strategyPatch = z
  .object({
    enabled: z.boolean(),
    dryRun: z.boolean(),
    auditSafetyBufferSeconds: z.number().int().min(0),
    proactivePay: z.boolean(),
    prepayEpochs: z.number().int().min(1).max(7),
    autoUseBribe: z.boolean(),
    maxAutoPayEpochs: z.number().int().min(1),
    jitEnabled: z.boolean(),
    jitTargetEpoch: z.number().int().min(1).nullable(),
    jitTokenIds: z.array(z.string().regex(/^\d+$/, "jitTokenIds must contain decimal integers")),
    preBoundaryPay: z.boolean(),
    preBoundaryLeadMs: z.number().int().min(250).max(8000),
    preBoundaryLeadMainnetMs: z.number().int().min(250).max(11000),
    offenseEnabled: z.boolean(),
    autoAudit: z.boolean(),
    autoKill: z.boolean(),
    endgameOnlyWithin: z.number().int().min(0).nullable(),
    offenseTargetTokenIds: z.array(z.string().regex(/^\d+$/, "offenseTargetTokenIds must contain decimal integers")),
    preBoundaryAudit: z.boolean(),
    preBoundaryKill: z.boolean(),
    maxBaseFeeGwei: z.number().positive(),
    priorityFeeGwei: z.number().min(0),
    minBalanceEth: z.number().min(0),
    separateOffenseGas: z.boolean(),
    offenseMaxBaseFeeGwei: z.number().positive(),
    offensePriorityFeeGwei: z.number().min(0),
    offenseDynamicTipEnabled: z.boolean(),
    offenseDynamicTipMaxGwei: z.number().positive(),
    offenseBoundaryScheduling: z.boolean(),
    racePublicMempool: z.boolean(),
    dynamicTipEnabled: z.boolean(),
    dynamicTipMaxGwei: z.number().positive(),
    maxPaymentEth: z.number().min(0),
  })
  .partial();

/** Extract the hostname from a Host header, dropping the port (handles [::1]). */
function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim();
  if (h.startsWith("[")) return h.slice(1, h.indexOf("]")).toLowerCase(); // [IPv6]:port
  const i = h.lastIndexOf(":");
  return (i >= 0 ? h.slice(0, i) : h).toLowerCase();
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  // Serialize lifecycle mutations so a later Stop/Lock cannot race an earlier
  // Settings/Unlock continuation that was waiting for the same old tick.
  let lifecycleTail: Promise<void> = Promise.resolve();
  const runLifecycle = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = lifecycleTail.then(operation, operation);
    lifecycleTail = run.then(() => undefined, () => undefined);
    return run;
  };

  // DNS-rebinding guard: when bound to loopback (the default, documented secure
  // setup), only accept requests whose Host header is a loopback name. This stops
  // a malicious web page from rebinding a domain to 127.0.0.1 and driving the
  // wallet API. If the operator deliberately bound to a non-loopback interface,
  // they've opted into exposure, so we don't second-guess their Host header.
  const boundToLoopback = ["127.0.0.1", "::1", "localhost"].includes(appConfig.host);
  if (boundToLoopback) {
    const allowedHosts = new Set(["127.0.0.1", "localhost", "::1"]);
    app.addHook("onRequest", async (req, reply) => {
      if (!allowedHosts.has(hostnameOf(req.headers.host ?? ""))) {
        return reply.code(403).send({ error: "Forbidden: unexpected Host header" });
      }
    });
  }

  // --- status & config ---
  app.get("/api/status", async () => runtime.status());
  app.get("/api/config", async () => runtime.strategy);

  app.post("/api/config", async (req, reply) => runLifecycle(async () => {
    const parsed = strategyPatch.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const wasRunning = runtime.running;
    if (wasRunning) stopEngine();
    // Always wait: another request may already have set running=false while its
    // old generation is still unwinding.
    await waitForEngineIdle();
    const prev = runtime.strategy;
    const next = runtime.saveStrategy(parsed.data);
    const wasActive = prev.enabled || prev.offenseEnabled || prev.jitEnabled;
    const nowActive = next.enabled || next.offenseEnabled || next.jitEnabled;
    const jitChanged = prev.jitEnabled !== next.jitEnabled
      || prev.jitTargetEpoch !== next.jitTargetEpoch
      || prev.jitTokenIds.join(",") !== next.jitTokenIds.join(",");
    if (jitChanged) resetJitState();
    // Only auto-start when a flag just turned on; don't restart a manually paused engine.
    if (
      nowActive
      && runtime.unlocked
      && (wasRunning || !wasActive)
      && !runtime.running
    ) {
      startEngine();
    }
    schedulePreBoundaryPay();
    scheduleJitBoundary();
    schedulePreBoundaryAudit();
    return next;
  }));

  // --- keystore lifecycle ---
  app.get("/api/keystore", async () => {
    const file = loadKeystore(appConfig.dataDir);
    return { exists: keystoreExists(appConfig.dataDir), address: file?.address ?? null };
  });

  app.post("/api/keystore", async (req, reply) => {
    const schema = z.object({
      mode: z.enum(["import", "generate"]),
      privateKey: z.string().optional(),
      passphrase: z.string().min(8),
      overwrite: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { mode, passphrase } = parsed.data;

    // Never silently clobber an existing keystore — that permanently discards the
    // old wallet's key (and access to any funds it holds). Require an explicit opt-in.
    if (keystoreExists(appConfig.dataDir) && !parsed.data.overwrite) {
      return reply.code(409).send({
        error: "A wallet keystore already exists. Overwriting permanently discards the old key — resend with overwrite:true to confirm.",
      });
    }

    let pk: `0x${string}`;
    if (mode === "generate") {
      pk = generatePrivateKey();
    } else {
      // Accept a 64-hex key with or without the 0x prefix (and stray whitespace).
      const normalized = parsed.data.privateKey ? normalizePrivateKey(parsed.data.privateKey) : null;
      if (!normalized) {
        return reply.code(400).send({ error: "Invalid private key (expected 64 hex characters, with or without a 0x prefix)" });
      }
      pk = normalized;
    }
    const account = accountFromPrivateKey(pk);
    const file = encryptPrivateKey(pk, passphrase, account.address);
    saveKeystore(appConfig.dataDir, file);
    logger.info(`Keystore created for ${account.address}`);
    return { address: account.address };
  });

  app.post("/api/unlock", async (req, reply) => runLifecycle(async () => {
    const schema = z.object({ passphrase: z.string() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const file = loadKeystore(appConfig.dataDir);
    if (!file) return reply.code(400).send({ error: "No keystore found" });
    try {
      const pk = decryptPrivateKey(file, parsed.data.passphrase);
      const account = accountFromPrivateKey(pk);
      // Freeze the active identity for every execution. A live tick may already
      // have fetched ownership and reserved a nonce for the old account.
      if (runtime.running) stopEngine();
      await waitForEngineIdle();
      runtime.account = account;
      runtime.walletClient = makeWalletClient(account);
      runtime.chainId = await getChainId();
      runtime.emitStatus();
      logger.info(`Wallet unlocked: ${account.address}`);
      // Populate chain state immediately so the UI can show epoch/countdown even
      // when the engine is paused.
      getGameSnapshot().then((snap) => {
        if (runtime.account?.address !== account.address) return;
        runtime.currentEpoch = snap.currentEpoch;
        runtime.startTime = snap.startTime;
        runtime.gameState = snap.state;
        runtime.citizenSupply = snap.citizenSupply;
        runtime.citizensAddress = snap.citizensAddress;
        runtime.emitStatus();
      }).catch(() => {});
      // Fetch the wallet balance up front too — otherwise it stays blank until
      // the engine is started (balance is otherwise only read inside tick()).
      publicClient.getBalance({ address: account.address }).then((bal) => {
        if (runtime.account?.address !== account.address) return;
        runtime.balanceWei = bal;
        runtime.emitStatus();
      }).catch(() => {});
      // Engine stays paused on unlock — user must press Start manually.
      return runtime.status();
    } catch {
      return reply.code(401).send({ error: "Incorrect passphrase" });
    }
  }));

  app.post("/api/lock", async () => runLifecycle(async () => {
    stopEngine();
    await waitForEngineIdle();
    runtime.lock();
    return { ok: true };
  }));

  // --- engine control ---
  app.post("/api/start", async (_req, reply) => runLifecycle(async () => {
    if (!runtime.unlocked) return reply.code(400).send({ error: "Unlock the wallet first" });
    startEngine();
    return runtime.status();
  }));

  app.post("/api/stop", async () => runLifecycle(async () => {
    stopEngine();
    await waitForEngineIdle();
    return runtime.status();
  }));

  // --- just-in-time single-epoch payment ---
  app.post("/api/jit", async (req, reply) => runLifecycle(async () => {
    const schema = z.object({
      enable: z.boolean(),
      targetEpoch: z.number().int().min(1).optional(),
      tokenIds: z.array(z.string().regex(/^\d+$/, "tokenIds must contain decimal integers")).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { enable, targetEpoch, tokenIds } = parsed.data;
    let target: number | null = null;
    if (enable) {
      if (!runtime.unlocked) return reply.code(400).send({ error: "Unlock the wallet first" });
      // Default target = the upcoming epoch.
      const current = runtime.currentEpoch !== null ? Number(runtime.currentEpoch) : null;
      target = targetEpoch ?? (current !== null ? current + 1 : null);
      if (target === null) {
        return reply.code(400).send({ error: "Unknown current epoch — start the bot once so it can read chain state" });
      }
    }
    const wasRunning = runtime.running;
    if (wasRunning) stopEngine();
    await waitForEngineIdle();

    if (!enable) {
      const next = runtime.saveStrategy({ jitEnabled: false, jitTargetEpoch: null });
      if (wasRunning && (next.enabled || next.offenseEnabled) && runtime.unlocked) startEngine();
      scheduleJitBoundary();
      schedulePreBoundaryPay();
      return runtime.status();
    }

    runtime.saveStrategy({
      jitEnabled: true,
      jitTargetEpoch: target!,
      jitTokenIds: tokenIds ?? [],
      enabled: true,
    });
    resetJitState(); // clear any prior submission bookkeeping for this epoch
    if (!runtime.running) startEngine();
    scheduleJitBoundary();
    schedulePreBoundaryPay();
    return runtime.status();
  }));

  // --- Alchemy / RPC settings ---
  app.get("/api/settings", async () => {
    const s = loadSettings();
    return {
      alchemyKeySet: !!s.alchemyApiKey || !!process.env.ALCHEMY_API_KEY,
      mode: appConfig.mode,
    };
  });

  app.post("/api/settings", async (req, reply) => runLifecycle(async () => {
    const schema = z.object({
      alchemyApiKey: z.string().min(1).optional(),
      mode: z.enum(["mainnet", "public"]).optional(),
    }).refine((d) => d.alchemyApiKey !== undefined || d.mode !== undefined, {
      message: "Provide at least one of: alchemyApiKey, mode",
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { alchemyApiKey, mode } = parsed.data;
    const wasRunning = runtime.running;
    if (wasRunning) {
      // Do not replace RPC clients or submission semantics underneath a batch
      // that has already synced a nonce and captured the current mode.
      stopEngine();
    }
    await waitForEngineIdle();

    const existing = loadSettings();
    try {
      if (alchemyApiKey) {
        saveSettings({ ...existing, alchemyApiKey, ...(mode ? { mode } : {}) });
        process.env.ALCHEMY_API_KEY = alchemyApiKey;
        const urls = deriveUrlsFromKey(alchemyApiKey);
        appConfig.httpUrl = urls.httpUrl;
        appConfig.wsUrl = urls.wsUrl;
        appConfig.nftUrl = urls.nftUrl;
        reinitClients(urls.httpUrl, urls.wsUrl);
        logger.info("Alchemy API key saved and RPC clients reinitialized.");
      }

      if (mode) {
        saveSettings({ ...existing, ...(alchemyApiKey ? { alchemyApiKey } : {}), mode });
        appConfig.mode = mode;
        logger.info(`Submission mode switched to: ${mode}`);
      }

      return { ok: true, mode: appConfig.mode };
    } finally {
      if (wasRunning && runtime.unlocked) startEngine();
    }
  }));

  // --- reads for the dashboard ---
  app.get("/api/tokens", async (_req, reply) => {
    if (!runtime.unlocked) return reply.code(400).send({ error: "locked" });
    try {
      return await readOwnedStatuses();
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  app.get("/api/targets", async (_req, reply) => {
    try {
      return await readTargets();
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  app.get("/api/activity", async (req) => {
    const limit = Number((req.query as { limit?: string }).limit ?? 200);
    return activity.recent(limit);
  });

  // --- race post-mortem: compare our tx(s) vs rival tx(s) on-chain ---
  app.post("/api/postmortem", async (req, reply) => {
    const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "invalid tx hash");
    const schema = z.object({
      ours: z.array(hash).min(1).max(20),
      rivals: z.array(hash).max(20).default([]),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    if (!appConfig.httpUrl) {
      return reply.code(400).send({ error: "No RPC configured — set the Alchemy key first." });
    }
    try {
      const result = await runPostMortem(
        parsed.data.ours as `0x${string}`[],
        parsed.data.rivals as `0x${string}`[],
      );
      return result;
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // --- websocket: push status + activity ---
  app.get("/ws", { websocket: true }, (socket) => {
    const send = (type: string, data: unknown) => {
      try {
        socket.send(JSON.stringify({ type, data }));
      } catch {
        /* ignore */
      }
    };
    send("status", runtime.status());
    send("activity-batch", activity.recent(100));
    const offStatus = runtime.onStatus((s) => send("status", s));
    const offActivity = activity.subscribe((e) => send("activity", e));
    socket.on("close", () => {
      offStatus();
      offActivity();
    });
  });

  return app;
}
