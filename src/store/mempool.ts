import type { Transaction, UtxoEntry, UtxoSnapshot } from "../types.js";

function utxoKey(txid: string, index: number): string {
  return `${txid}:${index}`;
}

export class Mempool {
  private readonly txids = new Set<string>();
  private readonly utxoMap = new Map<string, UtxoEntry>();

  initialize(snapshot: UtxoSnapshot): void {
    this.txids.clear();
    this.utxoMap.clear();

    for (const entry of snapshot.entries) {
      this.utxoMap.set(utxoKey(entry.outpoint.txid, entry.outpoint.index), entry);
    }
  }

  getUtxoMap(): Map<string, UtxoEntry> {
    return this.utxoMap;
  }

  getTxids(): string[] {
    return [...this.txids];
  }

  has(txid: string): boolean {
    return this.txids.has(txid);
  }

  tryAddTransaction(txid: string, transaction: Transaction): boolean {
    if (!this.canApply(transaction)) {
      return false;
    }

    this.addTransaction(txid, transaction);
    return true;
  }

  addTransaction(txid: string, transaction: Transaction): void {
    this.txids.add(txid);

    for (const input of transaction.inputs) {
      this.utxoMap.delete(utxoKey(input.outpoint.txid, input.outpoint.index));
    }

    for (const [index, output] of transaction.outputs.entries()) {
      this.utxoMap.set(utxoKey(txid, index), {
        outpoint: { txid, index },
        output
      });
    }
  }

  rebuild(
    snapshot: UtxoSnapshot,
    candidates: { txid: string; transaction: Transaction }[]
  ): void {
    this.initialize(snapshot);

    const remaining = [...candidates];
    let appliedAny = true;

    while (appliedAny) {
      appliedAny = false;

      for (let index = 0; index < remaining.length; index += 1) {
        const candidate = remaining[index];
        if (candidate === undefined || !this.canApply(candidate.transaction)) {
          continue;
        }

        this.addTransaction(candidate.txid, candidate.transaction);
        remaining.splice(index, 1);
        index -= 1;
        appliedAny = true;
      }
    }
  }

  private canApply(transaction: Transaction): boolean {
    return transaction.inputs.every((input) =>
      this.utxoMap.has(utxoKey(input.outpoint.txid, input.outpoint.index))
    );
  }
}
