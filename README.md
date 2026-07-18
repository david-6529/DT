# Death & Taxes Bot

A self-hosted automation bot for the on-chain game **[Death & Taxes](https://etherscan.io/address/0xa448c7f618087dDa1a3B128cAd8A424fBae4B71F)** by Transient Labs. It watches the game for you and acts automatically:

- **Defense (primary):** reduce the chance that one of your Citizen tokens is killed. By default, the bot reacts as soon as it observes a fresh 24-hour audit and tries to clear it by **paying taxes**. It also pays proactively at each boundary where a token would otherwise become auditable, and can prepay up to 7 epochs to lock the current (lower) tax rate. It **won't spend a held bribe** to clear an audit unless you opt in (`autoUseBribe`, off by default) — a bribe is free but consumed and leaves the token still delinquent.
- **Just-in-time epoch payment (one-shot):** arm the bot for a single upcoming epoch and it pays exactly one epoch for each of your citizens as that epoch begins on-chain, then auto-disarms. E.g. arm for epoch 133 and it pays `133 × 0.00069 = 0.09177 ETH` per citizen. A boundary pre-submit uses the deterministic upcoming-epoch amount and validates it by simulation; the post-boundary fallback reads the current estimate on-chain. Each JIT payment advances the citizen one epoch, even if it is momentarily 2 epochs behind, and never becomes a multi-day charge — see the **per-payment epoch cap** below.
- **Offense (optional):** audit delinquent rivals and `kill` expired-audit tokens to thin the field toward the winning 69. It audits **multiple rivals per epoch** — up to each eligible citizen's **`auditLimit`** (auditor-role tokens can audit several times per epoch; the bot reads each token's remaining capacity and uses all of it), instead of just one. This is a game strategy, not a profit engine — see below.
- **Reliable submission paths:** choose **`mainnet`** (the default: private **bundles** fanned out to several block builders, with tax payments also mirrored to the public mempool as a fallback) or **`public`** (mempool only, seated after every bundle). Latency edges let payments/offense compete in the *first eligible block* instead of the block after (see [Latency edges](#latency-edges)); neither path guarantees inclusion.
- **Live activity log:** every action is timestamped with its status; submitted transactions link to Etherscan and auto-update from **submitted → included / reverted** once the receipt lands.
- **Race post-mortem:** after the fact, paste your tx hash and a rival's to see whether you lost on **timing** (later block) or **fee** (same block, out-priced) — in the dashboard or from the CLI.

You run it on your own machine with your own key. It ships with a local web dashboard.

> ⚠️ **This is not a money-printer.** In Death & Taxes, `audit` and `kill` pay the
> caller **nothing** — there is no arbitrage/MEV profit per transaction. The bot's
> value is *keeping your tokens alive* and *helping you play toward being one of the
> 69 survivors*. It spends ETH (taxes, audit fees, gas); it does not earn any.

---

## How the game works (what the bot automates)

| Concept | Detail |
| --- | --- |
| Epoch | 24 hours. Tax rate for an epoch = `epoch × 0.00069 ETH`, so daily cost **rises over time**. |
| Delinquent | A token that is ≥ 2 epochs behind on taxes. Delinquent tokens can be audited by anyone. |
| Audit | Costs `0.00069 ETH`. Starts a **24h countdown** on a delinquent target. 1 audit per token per epoch. |
| Kill | Free, callable by **anyone** once a token's audit countdown expires. Turns the Citizen into a dead "Evader". |
| Clear an audit | The target `payTaxes` (pays back-taxes) or `useBribe` (free, if it holds a bribe) before expiry. |
| Life insurance | **Cosmetic only** — it changes the dead-Evader artwork. It does **not** prevent death. |
| Winning | The game ends when the Citizen supply drops to **69**; the survivors win. |

---

## Architecture

npm workspaces monorepo:

```text
packages/
  shared/    # Contract ABI, game constants, shared TypeScript types
  backend/   # The bot: chain reads, encrypted keystore, Flashbots submitter,
             # strategy engine, and a local REST + WebSocket API
  web/       # React + Vite dashboard (talks to the backend API)
```

The backend holds an **encrypted hot-wallet key** (scrypt + AES-256-GCM) and signs
transactions locally with [viem](https://viem.sh). Ownership is indexed via the
**Alchemy NFT API**; chain state via your Alchemy RPC (WSS + HTTPS).

---

## Setup

**Requirements:** Node.js ≥ 20, and an [Alchemy](https://alchemy.com) API key
(free tier is fine) for the Ethereum mainnet RPC + NFT API.

```bash
git clone <this-repo> && cd death-and-taxes-bot
npm install
cp .env.example .env        # then edit .env and set ALCHEMY_API_KEY
npm run dev                 # starts backend (:8787) + dashboard (:5173)
```

Open the dashboard at **`http://localhost:5173`** and:

1. **Create a hot wallet** — generate a fresh burner or import a private key. It's
   encrypted at rest with a passphrase you choose. **Use a dedicated burner funded
   only with what you're willing to spend.** **This wallet must hold the Citizen
   tokens you want defended** — the bot only pays taxes for and defends Citizens
   owned by the wallet it unlocks. A freshly generated burner owns none until you
   transfer Citizens into it, so to protect Citizens you already hold, import that
   wallet's key.
2. **Unlock** it with your passphrase.
3. Configure your **strategy** (defense buffers, offense toggles, spend caps).
4. Leave **Dry-run ON** first to watch what the bot *would* do — toggle it from the **DRY-RUN / LIVE FIRE** badge in the top bar (going live asks for confirmation). Turn it off to go live.
5. Click **Start bot**.

Fund the wallet with a little ETH for taxes/audits/gas. Keep the dashboard's
**spend cap** and **min-balance floor** set to values you're comfortable with.

### Production run

```bash
npm run build
npm start          # backend only; serve packages/web/dist with any static host
```

### Versioning & releases

The bot has a single version string (`VERSION` in
`packages/shared/src/constants.ts`). It's shown **in the dashboard header** (next to
the title) and **logged at startup**, so you can always confirm which build you're
running — and the dashboard flags a warning if the running backend's version
doesn't match the dashboard's (e.g. a half-updated copy).

To cut a release zip:

```bash
npm run package    # writes release/death-and-taxes-bot-v<VERSION>.zip
```

The zip is named after the version, so recipients can tell an old build from a new
one at a glance. It's built with `git archive`, so it contains only committed,
tracked files — no `node_modules`, no `.env`, and none of your local
`data/settings.json` or keystore. When you ship a new build, bump `VERSION` (and the
matching `package.json` `version` fields — `npm run package` refuses to run if they
disagree) and commit before packaging.

**Tag it so GitHub serves a versioned download.** GitHub's green *Code → Download
ZIP* button always gives `DT-<branch>.zip` (a branch has no version). To get a
version in the filename, push a tag:

```bash
git tag -a v0.2.0 -m "v0.2.0"
git push origin v0.2.0
```

GitHub then serves the tagged source archive as **`DT-0.2.0.zip`** (leading `v`
stripped) from the repo's **Tags**/**Releases** page and at
`https://github.com/<owner>/DT/archive/refs/tags/v0.2.0.zip`. For a published
**Release** with the nicer `death-and-taxes-bot-v<VERSION>.zip` name, draft a
release on that tag and upload the `npm run package` artifact as an asset (via the
web UI or `gh release create`).

---

## Configuration (`.env`)

| Var | Purpose |
| --- | --- |
| `ALCHEMY_API_KEY` | Derives the mainnet HTTPS/WSS RPC and NFT API endpoints. |
| `RPC_HTTP_URL` / `RPC_WS_URL` / `ALCHEMY_NFT_URL` | Explicit overrides (any RPC). |
| `MODE` | `mainnet` (**default** — private bundles to `BUILDER_URLS`; payments also mirror to the mempool for broader inclusion coverage), `public` (mempool only), or `local` (anvil fork). Also switchable at runtime from the dashboard. |
| `BUILDER_URLS` | Comma-separated builders that receive your bundle in `mainnet` mode. Only the builder that **wins the slot** can include it, so the bot submits to **all** in parallel and succeeds if any accepts. Defaults to Flashbots, **BuilderNet**, beaverbuild and Titan (all verified live). Endpoints do change — verify against each builder's docs. |
| `PORT` / `HOST` | Local API bind (default `127.0.0.1:8787`). |
| `OWNED_TOKENS` / `TARGET_TOKENS` | Comma-separated tokenId overrides for local testing without the NFT API. |

Secrets live in `.env` and `data/` (the encrypted keystore + a Flashbots
reputation key). Both are git-ignored. **Never commit them.**

Strategy settings are edited from the dashboard and saved to `data/config.json`
(also git-ignored, since it holds your live strategy). With no such file the bot
starts from safe defaults — dry-run on, offense/defense off. To seed a starting
point, copy the template:

```bash
cp data/config.example.json data/config.json
```

---

## Safety model

- **You are the sole custodian.** The key never leaves your machine and is only
  decrypted in memory after you enter your passphrase. An existing keystore is
  never silently overwritten — re-creating a wallet requires an explicit confirm,
  so you can't accidentally discard the old key.
- **Guardrails:** min-balance floor, max base-fee, an optional **max single-payment
  cap** (skips any tax payment above a set ETH value — a backstop against a bad
  estimate or a badly-delinquent token draining the wallet in one shot; `0` = off),
  a global **pause/kill switch**, and a **dry-run** mode that simulates without sending.
  The min-balance floor is enforced **cumulatively** — several payments in one
  cycle can't sneak the wallet below it. Same-nonce fee bumps stop at the configured
  maximum base-fee/dynamic-tip ceilings instead of escalating without bound.
- **Audit response window (`auditSafetyBufferSeconds`, default `86400`):** an audit
  has a 24-hour deadline, so the default makes a newly observed audit eligible for
  immediate clearing. Lower values wait until the deadline is within that buffer.
- **Per-payment epoch cap (`maxAutoPayEpochs`, default `1`):** the most epochs a
  single **automatic** payment may cover. On-chain, `payTaxes(tokenId, n)` costs
  `n × currentEpoch × base` and advances the token `n` epochs, so this caps the ETH
  spent per auto payment. At the default of `1`, auto-payments never spend more than
  one day's taxes at once — a lost/failed payment never balloons into a multi-day
  charge. **JIT and the pre-boundary race always pay exactly one epoch and are never
  blocked by this**, so the single-epoch payment for the upcoming epoch still fires
  even when a citizen is momentarily 2 epochs behind at the boundary (the tax-skip
  case). The cap only limits the multi-epoch paths — proactive-pay and defense —
  which otherwise pay `prepayEpochs`; raise it to let those auto-catch-up several
  epochs in one payment. Edited in the **Just-in-time epoch payment** panel.
- **Separate offense gas (audit/kill):** audit/kill bid their own gas,
  independent of payments — it's a race against rivals where a payment isn't, so
  it carries a different tip and base-fee cap. **On by default**; turn off
  **Separate gas for audit / kill** to make one set of gas settings apply to
  everything. The shipped payment defaults are tuned to win the boundary bundle
  race (a ~15 gwei tip clears the observed batch-audit bundles at ~3 gwei, with
  dynamic tip scaling it up in contested blocks); offense carries its own tip and
  a tighter base-fee cap. Payment gas is edited under **Just-in-time epoch
  payment → Payment gas**; offense gas under **Offense**.
- **Simulate-before-send:** every transaction is checked first (`eth_call` in
  public/local mode, `eth_callBundle` for bundles). This catches deterministic
  reverts before submission, but state can still change between simulation and
  inclusion, so it is a guardrail rather than a guarantee.
- **Payments get a public fallback in `mainnet` mode.** A bundle is only included if a
  builder you sent it to wins the slot, so a bundle-only payment can silently fail
  to land — which can cost a citizen. Tax payments are therefore **always** mirrored
  to the public mempool alongside the bundle (identical tx, so only one can land).
  This improves inclusion coverage but does not guarantee that either path lands.
  There's nothing to protect by hiding a tax payment: rivals already see the
  delinquency on-chain.
- **Connection watchdog:** WebSocket block events trigger low-latency ticks, and a
  12-second poll runs alongside them so a silent provider subscription cannot stop
  the engine indefinitely.
- **One active wallet per instance.** To automate multiple wallets, use separate
  processes with separate data directories, ports, and keystores.
- **Keep the host clock synchronized.** Boundary timers use Unix time. Private
  bundles carry an on-chain timestamp floor and normal ticks recover from a miss,
  but meaningful system-clock skew can still make a first-block attempt late.
- **Pending campaigns are process-memory state.** Pause/resume in the same process
  preserves deduplication; a process restart does not persist that metadata. After
  an unexpected restart, inspect the wallet's pending transactions before assuming
  a boundary payment was lost.
- **Local-only by default.** The API binds to `127.0.0.1`; when bound to loopback
  it also rejects requests with an unexpected `Host` header, blocking DNS-rebinding
  from a malicious web page. Do not expose it to the internet.

---

## Latency edges

Rivals often win by landing in an *earlier block*, not by paying more. These
configurable edges close that gap (configure them in the dashboard):

- **Pre-schedule offense at deadlines** — fires an extra tick just before each
  offense deadline (the nearest audit expiry, or the next epoch boundary) so kills
  and audits compete in the **first eligible block** instead of the block after. A
  boundary tick is never dropped just because a routine tick is mid-flight — it
  retries as soon as the engine is free, so the race isn't lost to bad luck.
- **Race the public mempool** (`mainnet` mode only) — also broadcasts a
  time-critical **offense** tx to the public mempool alongside the bundle, so *any*
  builder can include it next block. The tx is identical (same nonce), so only one
  can ever land. Trades bundle privacy for lower inclusion latency. It's opt-in for
  offense because a *visible pending audit* lets the target escape by paying first.
  When defense or JIT is active, safety takes priority and offense is mirrored even
  if this toggle is off, preventing a private-only offense nonce from blocking an
  emergency tax payment.
  **Payments don't need this toggle** — in `mainnet` mode they always mirror to the
  mempool (see below), and both paths fire concurrently so neither waits on the other.
- **Dynamic priority tip** — scales the tip up as the latest block fills past 50%,
  up to a configurable ceiling, to stay competitive in contested blocks. When off,
  the static priority fee is always used. It applies to **tax payments** too (set
  under *Just-in-time epoch payment → Payment gas*) — useful when a boundary-timed
  payment has to out-order a rival's batch-audit in the first block of an epoch.
- **Race tax payments into the boundary block** (`preBoundaryPay`, enabled in the
  shipped defaults) — this is not limited to one-shot JIT. The scheduler re-arms
  for every upcoming boundary and pre-submits one epoch for each owned token that
  would otherwise cross from its grace period into auditable delinquency; it also
  includes any armed JIT tokens due at that boundary. The upcoming-epoch value is
  validated by **simulating at the boundary timestamp** (`eth_call` block overrides,
  plus whole-bundle simulation on mainnet). If the pre-submit is missed or fails,
  regular block/poll ticks detect the delinquency and retry from fresh on-chain data
  immediately instead of waiting for another boundary. During a running engine
  session, the payment paths share per-token pending/submission tracking so stale
  chain reads do not stack another payment and definite failures can be retried.
  Future-valid public transactions are built early but held until the boundary;
  mainnet bundles carry the same timestamp as their minimum inclusion time.
- **Atomic multi-tx bundles (`mainnet` mode, automatic)** — every Citizen you hold
  is owned by the same wallet, so paying/auditing several in one cycle produces
  multiple txs on a single nonce sequence. Sent as independent one-tx bundles, only
  the first (nonce == chain nonce) is a self-valid bundle; the rest carry a nonce
  gap and won't be placed top-of-block by builders. The bot instead collects a
  cycle's txs and submits them as **one atomic bundle** (txs in nonce order). This
  gives builders a valid ordered sequence and avoids nonce gaps, but it does not
  guarantee inclusion or a particular position in the block. Tax payments also
  use a nonce-ordered public fallback. No configuration; always on in `mainnet`
  mode.
- **Race audits/kills into the first block** (advanced, opt-in) — the offense
  equivalents. *Race audits* pre-submits audits just before the epoch boundary so
  they land the instant rivals become delinquent (like a batch-auditor); *race
  kills* pre-submits a `kill` just before a target's audit-expiry so it lands in
  the first eligible block. Both are validated by simulating at the boundary/expiry
  instant, reuse the shared pre-submit lead, and fall back to the normal
  post-deadline offense. Off by default; enable under *Offense*. Note: boundary
  block position is driven by **builder orderflow**, not tip — a defender who
  pre-pays will beat your audit regardless of gas, so this is lower-value than the
  payment race. **When a mainnet payment race is armed for the same boundary, one
  already-discovered audit may ride inside the payment's bundle** (see next).
- **Payment + audit in one atomic bundle (`mainnet`, automatic)** — payment and
  audit from the same wallet share a nonce sequence, so sending them as two
  separate bundles can leave the audit bundle nonce-gapped and can hurt payment
  placement. If optional discovery has already finished with enough time left, the
  bot puts the **payment(s) first, then at most one audit** in one bundle. The audit
  is marked **allowed-to-revert** (`revertingTxHashes`) and withheld from the
  immediate public payment prefix. A structural audit failure removes only that
  optional suffix, so the valid payment prefix can still be sent. If the public
  payment prefix is accepted, a delayed fallback may publish the audit 12 seconds
  later to retire its reserved nonce. This trades some later privacy for payment
  safety, and a reverted audit still consumes gas if included. Builders still
  decide whether and where to include any bundle. Always on in `mainnet` mode.
- **Salted rival sweep order** — every bot sees the same candidate list in the
  same order (same indexer, same on-chain enumeration), so without this every
  instance would sweep the same tokens first, piling onto identical targets while
  starving whichever ones are late in the list once the auditor-token pool runs
  out. Each engine start picks a random salt and uses it to reorder the sweep
  (offense, pre-boundary audit, pre-boundary kill) for that run — stable for the
  run's lifetime, but different across restarts and across users. Always on, not
  configurable.

## Race post-mortem

Compare your transaction against a rival's to diagnose *why* you lost a race —
**timing** (you landed in a later block; more gas wouldn't have helped) vs **fee**
(same block, out-priced). Available in the dashboard, or from the CLI:

```bash
# your tx first, then one or more rival txs
npx tsx packages/backend/src/postmortem.ts <yourTx> <rivalTx> [<rivalTx> ...]
```

It reports each tx's block, index, and effective priority tip, then a per-pair
verdict and a summary. Needs an RPC (`ALCHEMY_API_KEY` or `RPC_HTTP_URL`).

---

## Verification

```bash
npm test                    # unit tests: keystore round-trip, epoch/delinquency
                            # math, audit-expiry classification, spend guardrails
```

**Live read check** (no key, no spend) — confirms the read layer against mainnet:

```bash
RPC_HTTP_URL=<your-rpc> npx tsx packages/backend/src/probe.ts
```

**Mainnet-fork end-to-end** (exercises real `payTaxes` / `audit` / `kill` signing
and broadcast) — requires [Foundry](https://book.getfoundry.sh/):

```bash
# 1. Fork mainnet locally
anvil --fork-url <your-mainnet-rpc>

# 2. Point the bot at the fork; hardcode a token you'll test against
#    (impersonate/fund it with cast). No NFT API needed in local mode.
MODE=local RPC_HTTP_URL=http://127.0.0.1:8545 \
  OWNED_TOKENS=<tokenId> TARGET_TOKENS=<delinquentTokenId> \
  npm run dev

# 3. In the dashboard, turn Dry-run OFF and Start. Use `cast rpc evm_increaseTime`
#    to warp past an audit deadline and watch the kill path fire.
```

In `local` and `public` modes the submitter broadcasts the signed tx directly
(anvil has no Flashbots relay); on `mainnet` it submits via the relay.

---

## Disclaimer

This software is provided "as is", without warranty of any kind (see `LICENSE`).
It is an unofficial tool for interacting with a third-party game contract using
its public functions. It spends real ETH and offers **no guarantee** of keeping
any token alive or winning the game. Blockchain transactions are irreversible.
You are solely responsible for your keys, your funds, and your use of this tool.
Not financial advice.
