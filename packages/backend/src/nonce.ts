import type { Address } from "viem";
import { publicClient } from "./chain.js";

// Nonce state for the single hot wallet, held across engine ticks.
//
// Public submissions normally appear in `getTransactionCount(pending)`, while a
// private bundle does not. Either path can be ambiguous during a transport error
// or live mode/RPC switch, so a recent reservation is held until pending catches
// up or the safety window expires. This avoids handing a possibly-live nonce to a
// different action.

export type SubmitMode = "public" | "mainnet" | "local";

export class NonceManager {
  private address: Address | null = null;
  private next: number | null = null;
  private reservedCeil: number | null = null; // one past the highest nonce reserved this session
  private lastOnchain = -1;
  private invisibleReservation = false;
  // Age reservations from when WE created/refreshed them, not from the wallet's
  // last on-chain nonce change. A quiet wallet may have had the same nonce for
  // days before submitting a fresh private bundle; using chain inactivity would
  // incorrectly expire that new reservation on the very next tick.
  private reservationUpdatedAtMs = 0;
  // If pending hasn't advanced past our held reservation for this long after our
  // latest reserve/replacement, the private bundle has almost certainly dropped.
  private static readonly STALE_MS = 90_000;

  /** Re-sync at the start of a tick. `mode` remains part of the public API for
   *  diagnostics, but recent ambiguous reservations are protected in every mode. */
  async sync(address: Address, _mode: SubmitMode): Promise<void> {
    if (this.address !== null && this.address !== address) {
      // Nonces and private reservations are account-scoped. Never carry a
      // cursor from wallet A into a transaction signed by wallet B.
      this.next = null;
      this.reservedCeil = null;
      this.lastOnchain = -1;
      this.invisibleReservation = false;
      this.reservationUpdatedAtMs = 0;
    }
    this.address = address;
    const onchain = await publicClient.getTransactionCount({ address, blockTag: "pending" });
    const nowMs = Date.now();
    if (
      onchain > this.lastOnchain
      && this.reservedCeil !== null
      && onchain < this.reservedCeil
    ) {
      // Partial nonce progress proves the remaining suffix is still part of a
      // live sequence; give it a fresh stale window instead of expiring it based
      // on the original batch timestamp.
      this.reservationUpdatedAtMs = nowMs;
    }
    this.lastOnchain = onchain;

    const holding = this.reservedCeil !== null && onchain < this.reservedCeil;
    if (holding && nowMs - this.reservationUpdatedAtMs <= NonceManager.STALE_MS) {
      // Keep our reserved nonce — the chain just hasn't seen the bundle yet.
      this.next = Math.max(onchain, this.reservedCeil!);
      this.invisibleReservation = true;
    } else {
      // Chain caught up, or the reservation went stale. Self-heal the cursor.
      this.next = onchain;
      this.reservedCeil = null;
      this.reservationUpdatedAtMs = 0;
      this.invisibleReservation = false;
    }
  }

  /** Peek at the next nonce without consuming it (for simulation). */
  peek(): number {
    if (this.next === null) throw new Error("NonceManager.peek called before sync");
    return this.next;
  }

  /** Reserve the next nonce (call only after simulation passes). */
  reserve(): number {
    if (this.next === null) throw new Error("NonceManager.reserve called before sync");
    const n = this.next;
    this.next = n + 1;
    if (this.reservedCeil === null || this.next > this.reservedCeil) this.reservedCeil = this.next;
    this.reservationUpdatedAtMs = Date.now();
    return n;
  }

  /** Fence a same-nonce replacement from the ordinary allocator. This does not
   * consume a new nonce: it only guarantees that a later reserve() in this tick
   * cannot hand the replacement nonce to a different transaction. */
  ensureNextAbove(nonce: number): void {
    if (this.next === null) throw new Error("NonceManager.ensureNextAbove called before sync");
    const ceiling = nonce + 1;
    if (this.next < ceiling) this.next = ceiling;
    if (this.reservedCeil === null || this.reservedCeil < ceiling) this.reservedCeil = ceiling;
    this.reservationUpdatedAtMs = Date.now();
  }

  /** True after a sync sees reservations absent from the public pending nonce.
   * Fresh transactions must not be allocated above this gap; same-nonce
   * replacements remain safe. */
  hasInvisibleReservation(): boolean {
    return this.invisibleReservation;
  }

  /** Pending transaction count observed by the most recent sync. Used only to
   * prove that a stale flight is absent before reusing its same nonce. */
  pendingNonce(): number {
    if (this.lastOnchain < 0) throw new Error("NonceManager.pendingNonce called before sync");
    return this.lastOnchain;
  }

  /** Roll back a failed, never-delivered reservation batch. This is deliberately
   *  strict: every nonce must be unique/contiguous and the range must exactly
   *  match the top of both the working cursor and the held reservation ceiling.
   *  That makes it impossible to release a lower nonce while a later transaction
   *  may already have been prepared or submitted. */
  releaseContiguous(nonces: readonly number[]): boolean {
    if (this.next === null || this.reservedCeil === null || nonces.length === 0) return false;
    const sorted = [...nonces].sort((a, b) => a - b);
    if (new Set(sorted).size !== sorted.length) return false;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] !== sorted[i - 1]! + 1) return false;
    }

    const start = sorted[0]!;
    const end = sorted[sorted.length - 1]! + 1;
    if (this.next !== end || this.reservedCeil !== end) return false;

    this.next = start;
    // Preserve an older private reservation below this batch, if one exists.
    this.reservedCeil = start > this.lastOnchain ? start : null;
    if (this.reservedCeil === null) this.reservationUpdatedAtMs = 0;
    if (this.reservedCeil === null) this.invisibleReservation = false;
    return true;
  }

  /** End-of-tick reset of the working nonce. The reserved ceiling persists so a
   *  mainnet bundle's nonce isn't reused next tick before it mines. */
  reset(): void {
    this.next = null;
  }
}

export const nonceManager = new NonceManager();
