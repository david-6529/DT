import { useEffect, useState } from "react";
import type { StrategyConfig } from "@dat-bot/shared";
import { api } from "./api.js";

const MODE_TIPS: Record<"public" | "mainnet", string> = {
  public:
    "Fastest path — transaction goes directly to the public mempool and every block builder sees it immediately. " +
    "Recommended for this game since you're racing a clock, not a MEV searcher. " +
    "Anyone can see the tx before it lands, but frontrunning tax payments isn't a meaningful risk here.",
  mainnet:
    "Sends your transaction privately to the Flashbots relay as a bundle. " +
    "Nobody sees it until it lands in a block, so it can't be frontrun. " +
    "Adds ~100–200 ms relay round-trip overhead and submits to the next two blocks for inclusion odds. " +
    "Only useful if you have a specific reason to hide the transaction.",
};

function AlchemyKeySection({ initialMode }: { initialMode: "mainnet" | "public" }) {
  const [key, setKey] = useState("");
  const [mode, setMode] = useState<"mainnet" | "public">(initialMode);
  const [busyKey, setBusyKey] = useState(false);
  const [busyMode, setBusyMode] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // useState's initial value is only read on mount, so when the parent loads the
  // real mode from the backend (GET /api/settings) after this component has already
  // mounted, reflect it here — otherwise the buttons stay stuck on the seed value.
  useEffect(() => setMode(initialMode), [initialMode]);

  const saveKey = async () => {
    if (!key.trim()) return;
    setBusyKey(true);
    setMsg(null);
    try {
      await api.saveAlchemyKey(key.trim());
      setMsg("Saved — RPC clients updated.");
      setKey("");
    } catch (e) {
      setMsg(`Error: ${(e as Error).message}`);
    } finally {
      setBusyKey(false);
    }
  };

  const switchMode = async (next: "mainnet" | "public") => {
    setMode(next);
    setBusyMode(true);
    setMsg(null);
    try {
      await api.saveMode(next);
      setMsg(`Mode switched to ${next}.`);
    } catch (e) {
      setMsg(`Error: ${(e as Error).message}`);
      setMode(mode); // revert on failure
    } finally {
      setBusyMode(false);
    }
  };

  return (
    <>
      <div className="spacer" />
      <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>RPC / ALCHEMY</div>

      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Submission mode</div>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          {(["public", "mainnet"] as const).map((m) => (
            <button
              key={m}
              onClick={() => switchMode(m)}
              disabled={busyMode || mode === m}
              style={{
                padding: "4px 14px",
                borderRadius: 6,
                border: mode === m ? "2px solid var(--accent, #6c7)" : "1px solid #555",
                fontWeight: mode === m ? 700 : 400,
                opacity: busyMode ? 0.6 : 1,
                cursor: mode === m ? "default" : "pointer",
              }}
            >
              {m}
            </button>
          ))}
        </div>
        <p style={{ fontSize: 12, color: "#aaa", margin: 0, lineHeight: 1.5 }}>
          {MODE_TIPS[mode]}
        </p>
      </div>

      <label className="field">
        Update Alchemy API key
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="paste new key to replace"
        />
      </label>
      {msg && <p className={msg.startsWith("Error") ? "err" : "hint"}>{msg}</p>}
      <button onClick={saveKey} disabled={busyKey || key.trim().length < 10} style={{ marginBottom: 8 }}>
        {busyKey ? "Saving…" : "Update key"}
      </button>
    </>
  );
}

// Strategy configuration form. Persists via POST /api/config.
export function Config({ initial }: { initial: StrategyConfig }) {
  const [cfg, setCfg] = useState<StrategyConfig>(initial);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  // Seed with the actual shipped default (mainnet) so the panel doesn't briefly
  // misreport before GET /api/settings resolves; corrected on load if it differs.
  const [currentMode, setCurrentMode] = useState<"mainnet" | "public">("mainnet");

  useEffect(() => setCfg(initial), [initial]);

  useEffect(() => {
    api.getSettings().then((s) => setCurrentMode(s.mode)).catch(() => {});
  }, []);

  const set = <K extends keyof StrategyConfig>(k: K, v: StrategyConfig[K]) => {
    setCfg((c) => ({ ...c, [k]: v }));
    setSaved(false);
  };

  const save = async () => {
    setBusy(true);
    setSaveErr(null);
    try {
      await api.setConfig(cfg);
      setSaved(true);
    } catch (e) {
      setSaveErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const num = (k: keyof StrategyConfig) => (e: React.ChangeEvent<HTMLInputElement>) =>
    set(k, Number(e.target.value) as never);
  const chk = (k: keyof StrategyConfig) => (e: React.ChangeEvent<HTMLInputElement>) =>
    set(k, e.target.checked as never);

  return (
    <div className="panel">
      <h2>Strategy</h2>
      <p className="muted" style={{ fontSize: 11, margin: "0 0 4px 0" }}>
        Dry-run / live-fire is toggled from the badge in the top bar.
      </p>

      <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>OFFENSE (optional)</div>
      <label className="check">
        <input type="checkbox" checked={cfg.offenseEnabled} onChange={chk("offenseEnabled")} />
        Enable offense
      </label>
      <label className="check">
        <input type="checkbox" checked={cfg.autoAudit} onChange={chk("autoAudit")} disabled={!cfg.offenseEnabled} />
        Auto-audit delinquent rivals ({(0.00069).toString()} ETH each)
      </label>
      <label className="check">
        <input type="checkbox" checked={cfg.autoKill} onChange={chk("autoKill")} disabled={!cfg.offenseEnabled} />
        Auto-kill expired-audit tokens (free, gas only)
      </label>
      <label className="check">
        <input type="checkbox" checked={cfg.preBoundaryAudit} onChange={chk("preBoundaryAudit")} disabled={!cfg.offenseEnabled || !cfg.autoAudit} />
        ⚠ Race audits into the boundary block (advanced)
      </label>
      <label className="check">
        <input type="checkbox" checked={cfg.preBoundaryKill} onChange={chk("preBoundaryKill")} disabled={!cfg.offenseEnabled || !cfg.autoKill} />
        ⚠ Race kills into the first block after expiry (advanced)
      </label>
      <p style={{ fontSize: 11, color: "var(--muted)", margin: "0 0 8px 24px", lineHeight: 1.5 }}>
        Pre-submit audits/kills ~{cfg.preBoundaryLeadMs}ms before the deadline so they land in the first
        eligible block ahead of rivals, instead of the block after. Each is validated by simulating at the
        boundary/expiry instant, so an invalid one is skipped before spending gas. Lead is shared with the
        JIT boundary race. Note: at the boundary, block position is decided by builder orderflow more than
        tip — a defender who pre-pays can still beat your audit.
      </p>
      <label className="field">
        Only run offense when supply is within N of 69 winners (blank = always)
        <input
          type="number" min={0}
          value={cfg.endgameOnlyWithin ?? ""}
          onChange={(e) => set("endgameOnlyWithin", e.target.value === "" ? null : Number(e.target.value))}
        />
      </label>
      <label className="field">
        Rival token IDs to target (one per line or comma-separated — blank = all delinquent rivals)
        <textarea
          rows={5}
          style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, resize: "vertical" }}
          value={cfg.offenseTargetTokenIds.join("\n")}
          onChange={(e) => {
            const ids = e.target.value.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
            set("offenseTargetTokenIds", ids);
          }}
          disabled={!cfg.offenseEnabled}
          placeholder={"42\n137\n501"}
        />
        <span className="muted" style={{ fontSize: 11 }}>
          {cfg.offenseTargetTokenIds.length} token{cfg.offenseTargetTokenIds.length !== 1 ? "s" : ""}
        </span>
      </label>

      <div className="spacer" />
      <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>OFFENSE GAS (audit / kill)</div>
      <label className="check">
        <input
          type="checkbox"
          checked={cfg.separateOffenseGas}
          onChange={chk("separateOffenseGas")}
        />
        Separate gas for audit / kill
      </label>
      <p style={{ fontSize: 11, color: "var(--muted)", margin: "0 0 8px 24px", lineHeight: 1.5 }}>
        Audit and kill are races; tax payments are not. Turn this on to bid gas independently for
        offense. When off, audit/kill use the same payment gas (set in the JIT payment panel).
      </p>
      <label className="field">
        Max base fee — offense (gwei)
        <input
          type="number"
          min={0}
          value={cfg.offenseMaxBaseFeeGwei}
          onChange={num("offenseMaxBaseFeeGwei")}
          disabled={!cfg.separateOffenseGas}
        />
      </label>
      <label className="field">
        Priority fee / bundle tip — offense (gwei)
        <input
          type="number"
          min={0}
          step={0.1}
          value={cfg.offensePriorityFeeGwei}
          onChange={num("offensePriorityFeeGwei")}
          disabled={!cfg.separateOffenseGas}
        />
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={cfg.offenseDynamicTipEnabled}
          onChange={chk("offenseDynamicTipEnabled")}
          disabled={!cfg.separateOffenseGas}
        />
        Dynamic priority tip — offense
      </label>
      <label className="field" style={{ marginLeft: 24 }}>
        Max dynamic tip — offense (gwei)
        <input
          type="number"
          min={0}
          step={1}
          value={cfg.offenseDynamicTipMaxGwei}
          onChange={num("offenseDynamicTipMaxGwei")}
          disabled={!cfg.separateOffenseGas || !cfg.offenseDynamicTipEnabled}
        />
      </label>

      <div className="spacer" />
      <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>LATENCY (offense)</div>
      <label className="check">
        <input
          type="checkbox"
          checked={cfg.offenseBoundaryScheduling}
          onChange={chk("offenseBoundaryScheduling")}
          disabled={!cfg.offenseEnabled}
        />
        Pre-schedule offense at deadlines
      </label>
      <p style={{ fontSize: 11, color: "var(--muted)", margin: "0 0 8px 24px", lineHeight: 1.5 }}>
        Fires a tick just before each audit-expiry / epoch boundary so kills and audits compete in the
        first eligible block instead of the block after (~12s sooner).
      </p>
      <label className="check">
        <input
          type="checkbox"
          checked={cfg.racePublicMempool}
          onChange={chk("racePublicMempool")}
          disabled={!cfg.offenseEnabled}
        />
        Race public mempool (mainnet mode)
      </label>
      <p style={{ fontSize: 11, color: "var(--muted)", margin: "0 0 8px 24px", lineHeight: 1.5 }}>
        Also broadcasts time-critical offense txs to the public mempool alongside the Flashbots bundle,
        so any builder can include them next block. Trades bundle privacy for speed. While defense/JIT is
        active this fallback is always used, so a private offense nonce cannot block an emergency payment.
        No effect in public mode.
      </p>

      {/* DEFENSE is intentionally not rendered — it's rarely touched, and arming a
          JIT payment enables it automatically. The values still apply and remain
          editable in data/config.json (enabled, proactivePay,
          auditSafetyBufferSeconds, prepayEpochs, autoUseBribe). autoUseBribe is OFF
          by default (pay taxes to clear audits, never auto-spend a bribe). The
          per-payment epoch cap (maxAutoPayEpochs) is edited in the Just-in-time
          panel. */}

      <div className="spacer" />
      <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>GUARDRAILS</div>
      <p style={{ fontSize: 11, color: "var(--muted)", margin: "0 0 8px 0", lineHeight: 1.5 }}>
        Payment gas (base fee cap, priority tip, dynamic tip) now lives under <b>Just-in-time epoch
        payment → Payment gas</b>, next to the arm button.
      </p>
      <label className="field">
        Min wallet balance floor (ETH)
        <input type="number" min={0} step={0.01} value={cfg.minBalanceEth} onChange={num("minBalanceEth")} />
      </label>
      <label className="field">
        Max single payment (ETH) — 0 disables
        <input type="number" min={0} step={0.01} value={cfg.maxPaymentEth} onChange={num("maxPaymentEth")} />
      </label>
      <p style={{ fontSize: 11, color: "var(--muted)", margin: "0 0 8px 0", lineHeight: 1.5 }}>
        Hard cap on any one transaction's value. A payment above this is skipped, not sent — a backstop
        against a bad estimate or a badly-delinquent token draining the wallet in one shot.
      </p>

      <button className="primary" onClick={save} disabled={busy}>
        {busy ? "Saving…" : saved ? "Saved ✓" : "Save strategy"}
      </button>
      {saveErr && <p className="err" style={{ marginTop: 6 }}>{saveErr}</p>}

      <AlchemyKeySection initialMode={currentMode} />
    </div>
  );
}
