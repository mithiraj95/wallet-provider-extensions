import type {
  KeyStore,
  KeyStoreOptions,
  KeyStoreState,
  SubtleShim,
} from "@algorandfoundation/keystore-core";
import type { Store } from "@tanstack/store";
import type { HookCollection } from "before-after-hook";

import type { SEED_VAULT_ALGORITHM, SEED_VAULT_OWNER, SEED_VAULT_STORAGE } from "./constants.ts";

/**
 * The signature algorithms a vault key can use. They decide how the key is
 * recorded (`type`/`algorithm`) and how its signatures are verified.
 */
export type SeedVaultAlgorithm = "Falcon-1024" | "Ed25519";

/**
 * What a signing request carries, so the vault can show the matching approval
 * screen: opaque `"bytes"` or a `"transaction"` it can decode for the user.
 */
export type SeedVaultIntent = "bytes" | "transaction";

/**
 * A key held by the vault, as the binding reports it.
 *
 * It is a pure key: an identifier, an algorithm and a public key. Anything
 * built on a key (an on-chain address, a DID) belongs to the extension of that
 * domain and must not be carried here.
 *
 * @example
 * ```typescript
 * const key: SeedVaultKey = {
 *   id: "seed-1/0",
 *   algorithm: "Falcon-1024",
 *   publicKey,
 *   name: "Main seed",
 * };
 * ```
 */
export interface SeedVaultKey {
  /**
   * Stable identifier of the key inside the vault (e.g. `"<seed>/<index>"`).
   * It becomes the `KeyId` in the keystore and is handed back to the binding
   * on every request, so it must be unique within the store.
   */
  id: string;
  /** The signature algorithm of the key. */
  algorithm: SeedVaultAlgorithm;
  /** The raw public key bytes. */
  publicKey: Uint8Array;
  /** Optional human-readable label. */
  name?: string;
  /** Optional non-secret data the binding wants mirrored into the key record. */
  metadata?: Record<string, unknown>;
}

/**
 * A request to sign one payload with a vault key.
 */
export interface SeedVaultSignRequest {
  /** The {@link SeedVaultKey.id} of the key to sign with. */
  id: string;
  /** The payload to sign. */
  data: Uint8Array;
  /** What the payload is, for the vault's approval screen. */
  intent: SeedVaultIntent;
}

/**
 * A request to sign several payloads with one vault key under one approval.
 */
export interface SeedVaultBatchSignRequest {
  /** The {@link SeedVaultKey.id} of the key to sign with. */
  id: string;
  /** The payloads to sign, in order. */
  data: Uint8Array[];
  /** What the payloads are, for the vault's approval screen. */
  intent: SeedVaultIntent;
}

/**
 * The surface a vault integration implements. It is the only vendor-specific
 * piece: a native module (or a test double) is adapted to this interface and
 * injected, the same way a primitive binding is injected into a core shim.
 *
 * The binding owns everything about reaching the vault: connecting, asking
 * the user to approve, and translating a key `id` into whatever the vault's
 * own API addresses a key by.
 *
 * @example
 * ```typescript
 * const binding: SeedVaultBinding = {
 *   keys: async () => [{ id: "seed-1/0", algorithm: "Falcon-1024", publicKey }],
 *   sign: async ({ id, data, intent }) => native.sign(id, data, intent),
 * };
 * ```
 */
export interface SeedVaultBinding {
  /**
   * Lists the keys this app is authorized to use, connecting to the vault
   * first when needed. Rejects when the vault cannot be reached.
   */
  keys(): Promise<SeedVaultKey[]>;
  /**
   * Asks the vault to sign one payload. Resolves the signature; a rejected or
   * dismissed request either throws or resolves `null`/`undefined`.
   */
  sign(request: SeedVaultSignRequest): Promise<Uint8Array | null | undefined>;
  /**
   * Asks the vault to sign several payloads with one key under a single
   * approval. Resolves one signature per payload, in order. Optional: without
   * it a batch falls back to one {@link sign} request per payload.
   */
  signBatch?(request: SeedVaultBatchSignRequest): Promise<Uint8Array[] | null | undefined>;
  /**
   * The largest number of payloads one {@link signBatch} request may carry.
   * Larger batches are split into several requests. Unlimited when omitted.
   */
  maxBatchSize?: number;
  /**
   * Revokes this app's access to a key. Optional: without it
   * `KeyStoreAPI.remove` is not supported.
   */
  remove?(id: string): Promise<void>;
}

/**
 * Parameters accepted for Seed Vault `sign` calls on the shim.
 *
 * Unlike the material-injecting shims, no key material is passed: `id` is a
 * locator the binding resolves inside the vault.
 *
 * @example
 * ```typescript
 * await subtle.sign({ name: "SeedVault", id: "seed-1/0", intent: "bytes" }, handle, data);
 * ```
 */
export interface SeedVaultParams {
  name: typeof SEED_VAULT_ALGORITHM;
  /** The {@link SeedVaultKey.id} of the key to sign with. */
  id: string;
  /** What the payload is. Defaults to `"bytes"`. */
  intent?: SeedVaultIntent;
}

/**
 * The per-operation context of the Seed Vault keystore, passed as the `ctx`
 * argument of `sign`/`batchSign`.
 *
 * @example
 * ```typescript
 * await keystore.sign(id, transaction, undefined, { intent: "transaction" });
 * ```
 */
export interface SeedVaultContext {
  /** What the payload is. Defaults to `"bytes"`. */
  intent?: SeedVaultIntent;
}

/**
 * The `metadata` of a key record hydrated from the vault.
 */
export interface SeedVaultKeyMetadata {
  /** No driver holds material for this key; the vault performs every operation. */
  storage: typeof SEED_VAULT_STORAGE;
  /** The package that wrote the record. */
  owner: typeof SEED_VAULT_OWNER;
  /** The label reported by the binding, when any. */
  name?: string;
  [key: string]: unknown;
}

/**
 * Options for {@link import("./engine.ts").createSeedVaultKeyStore}.
 *
 * @example
 * ```typescript
 * const options: CreateSeedVaultKeyStoreOptions = { binding, store, hooks };
 * ```
 */
export interface CreateSeedVaultKeyStoreOptions {
  /** The vault integration every private-key operation is delegated to. */
  binding: SeedVaultBinding;
  /** Reactive store mirroring the vault's key metadata. */
  store: Store<KeyStoreState>;
  /** Host Subtle implementation; defaults to `globalThis.crypto.subtle`. */
  subtle?: SubtleCrypto;
  /**
   * Composable Subtle decorators used to **verify** signatures (the vault only
   * signs). Defaults to Falcon-1024 through the optional `falcon-1024` peer
   * dependency, skipped when it is not installed. May be a (possibly async)
   * factory, resolved once as part of `ready`.
   */
  shims?: SubtleShim[] | (() => SubtleShim[] | Promise<SubtleShim[]>);
  /**
   * Optional hook collection applied at creation. When provided, every
   * operation is wrapped so `before`/`after`/`error` hooks can intercept it,
   * and the collection is exposed as `keystore.hooks`.
   */
  hooks?: HookCollection<any>;
}

/**
 * The Seed Vault keystore: a `KeyStore` whose signing is performed by the
 * vault, plus a {@link refresh} to re-read the authorized keys.
 */
export type SeedVaultKeyStore = KeyStore<SeedVaultContext> & {
  /**
   * Re-reads the authorized keys from the vault and updates the store, e.g.
   * after the user authorized another seed. Also recovers a keystore whose
   * first load failed.
   */
  refresh(): Promise<void>;
};

/**
 * Options for the Seed Vault keystore extension. It takes the same
 * `options.keystore` block as the local keystore it replaces, plus the vault
 * `binding`.
 *
 * @example
 * ```typescript
 * const provider = new WalletProvider(config, {
 *   keystore: { store, hooks, binding },
 * });
 * ```
 */
export interface SeedVaultKeyStoreOptions extends KeyStoreOptions {
  keystore: KeyStoreOptions["keystore"] & {
    /** The vault integration. Required unless `api.keystore` is injected. */
    binding?: SeedVaultBinding;
  };
}
