/**
 * Shared test fixtures: an in-memory stand-in for a Seed Vault.
 *
 * Excluded from the published build (see `tsconfig.build.json`) — these are
 * test-only helpers and must never ship in `dist/`.
 */

import * as falcon from "falcon-1024";

import type {
  SeedVaultBatchSignRequest,
  SeedVaultBinding,
  SeedVaultKey,
  SeedVaultSignRequest,
} from "./types.ts";

/** A request the fake vault received, for assertions. */
export type FakeVaultRequest =
  | ({ kind: "sign" } & SeedVaultSignRequest)
  | ({ kind: "signBatch" } & SeedVaultBatchSignRequest);

/** An in-memory vault: it owns the private keys and exposes only a binding. */
export interface FakeVault {
  /** The binding handed to the shim/keystore. */
  binding: SeedVaultBinding;
  /** Every signing request received, in order. */
  requests: FakeVaultRequest[];
  /** How many times the keys were listed. */
  listed: number;
  /** When true, the next signing requests are declined (resolve `null`). */
  declining: boolean;
  /** When set, listing keys rejects with this error. */
  unavailable: Error | undefined;
  /** Creates a Falcon-1024 key inside the vault. */
  addFalconKey(id: string, name?: string): SeedVaultKey;
  /** Creates an Ed25519 key inside the vault. */
  addEd25519Key(id: string, name?: string): Promise<SeedVaultKey>;
  /** Drops a key from the vault without telling the keystore. */
  revoke(id: string): void;
}

/**
 * Builds a {@link FakeVault}.
 *
 * @param options.batch - Whether the binding offers `signBatch`.
 * @param options.maxBatchSize - The binding's `maxBatchSize`, when any.
 * @param options.remove - Whether the binding offers `remove`.
 */
export function createFakeVault(
  options: { batch?: boolean; maxBatchSize?: number; remove?: boolean } = {},
): FakeVault {
  const keys = new Map<string, SeedVaultKey>();
  const signers = new Map<string, (data: Uint8Array) => Promise<Uint8Array>>();

  const signWith = async (id: string, data: Uint8Array): Promise<Uint8Array> => {
    const signer = signers.get(id);
    if (!signer) throw new Error(`fake vault holds no key ${id}`);
    return signer(data);
  };

  const vault: FakeVault = {
    requests: [],
    listed: 0,
    declining: false,
    unavailable: undefined,

    addFalconKey(id: string, name?: string): SeedVaultKey {
      const pair = falcon.generateKey();
      signers.set(id, async (data) => falcon.signCompressed(pair.privateKey, data));
      const key: SeedVaultKey = { id, algorithm: "Falcon-1024", publicKey: pair.publicKey, name };
      keys.set(id, key);
      return key;
    },

    async addEd25519Key(id: string, name?: string): Promise<SeedVaultKey> {
      const subtle = globalThis.crypto.subtle;
      const pair = (await subtle.generateKey({ name: "Ed25519" }, false, [
        "sign",
        "verify",
      ])) as CryptoKeyPair;
      signers.set(
        id,
        async (data) =>
          new Uint8Array(
            await subtle.sign({ name: "Ed25519" }, pair.privateKey, data as BufferSource),
          ),
      );
      const publicKey = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
      const key: SeedVaultKey = { id, algorithm: "Ed25519", publicKey, name };
      keys.set(id, key);
      return key;
    },

    revoke(id: string): void {
      keys.delete(id);
      signers.delete(id);
    },

    binding: {
      async keys(): Promise<SeedVaultKey[]> {
        vault.listed += 1;
        if (vault.unavailable) throw vault.unavailable;
        return [...keys.values()];
      },
      async sign(request: SeedVaultSignRequest): Promise<Uint8Array | null> {
        vault.requests.push({ kind: "sign", ...request });
        if (vault.declining) return null;
        return signWith(request.id, request.data);
      },
    },
  };

  if (options.batch) {
    vault.binding.maxBatchSize = options.maxBatchSize;
    vault.binding.signBatch = async (
      request: SeedVaultBatchSignRequest,
    ): Promise<Uint8Array[] | null> => {
      vault.requests.push({ kind: "signBatch", ...request });
      if (vault.declining) return null;
      return Promise.all(request.data.map((item) => signWith(request.id, item)));
    };
  }
  if (options.remove) {
    vault.binding.remove = async (id: string): Promise<void> => vault.revoke(id);
  }

  return vault;
}
