import {
  DuplicateKeyIdError,
  InvalidKeyDataError,
  type Key,
  type KeyId,
  type KeyStoreState,
} from "@algorandfoundation/keystore-core";
import type { Store } from "@tanstack/store";

import { SEED_VAULT_ALGORITHM, SEED_VAULT_OWNER, SEED_VAULT_STORAGE } from "./constants.ts";
import type { SeedVaultKey, SeedVaultKeyMetadata } from "./types.ts";

/**
 * Whether a key record was written by the Seed Vault keystore.
 *
 * @example
 * ```typescript
 * const vaultKeys = store.state.keys.filter(isSeedVaultKey);
 * ```
 */
export function isSeedVaultKey(key: Key): boolean {
  return key.metadata?.owner === SEED_VAULT_OWNER;
}

/**
 * Converts a key reported by the vault into a keystore record. The record is
 * public metadata only: the type, the algorithm and the public key.
 *
 * @throws {InvalidKeyDataError} If the key's algorithm is not supported.
 *
 * @example
 * ```typescript
 * const key = toKey({ id: "seed-1/0", algorithm: "Falcon-1024", publicKey });
 * key.type; // "falcon-1024"
 * ```
 */
export function toKey(vaultKey: SeedVaultKey): Key {
  const metadata: SeedVaultKeyMetadata = {
    ...vaultKey.metadata,
    ...(vaultKey.name !== undefined ? { name: vaultKey.name } : {}),
    storage: SEED_VAULT_STORAGE,
    owner: SEED_VAULT_OWNER,
  };
  const base = {
    id: vaultKey.id,
    keyUsages: ["sign", "verify"] as KeyUsage[],
    publicKey: Uint8Array.from(vaultKey.publicKey),
    extractable: false,
    metadata,
    version: 1,
  };
  switch (vaultKey.algorithm) {
    case "Falcon-1024":
      return { ...base, type: "falcon-1024", algorithm: "Falcon-1024" };
    case "Ed25519":
      return { ...base, type: "ed25519", algorithm: "EdDSA" };
    default:
      throw new InvalidKeyDataError(
        `Seed Vault key ${vaultKey.id} uses an unsupported algorithm: ${String(vaultKey.algorithm)}`,
      );
  }
}

/**
 * Replaces the vault's keys in the store with the given list and marks the
 * keystore idle. Records written by other packages are kept untouched.
 *
 * @returns The key records now held for the vault.
 * @throws {DuplicateKeyIdError} If two vault keys share an id.
 *
 * @example
 * ```typescript
 * hydrateKeys({ store, keys: await binding.keys() });
 * ```
 */
export function hydrateKeys({
  store,
  keys,
}: {
  store: Store<KeyStoreState>;
  keys: SeedVaultKey[];
}): Key[] {
  const seen = new Set<KeyId>();
  const hydrated = keys.map((vaultKey) => {
    if (seen.has(vaultKey.id)) throw new DuplicateKeyIdError(vaultKey.id);
    seen.add(vaultKey.id);
    return toKey(vaultKey);
  });
  store.setState((state) => ({
    ...state,
    keys: [...hydrated, ...state.keys.filter((key) => !isSeedVaultKey(key))],
    status: "idle",
    algorithms: [{ algorithm: SEED_VAULT_ALGORITHM, source: "shim" }],
  }));
  return hydrated;
}

/**
 * Looks up a vault key record by id. Records owned by other packages are not
 * returned.
 *
 * @example
 * ```typescript
 * const key = getKey({ store, id: "seed-1/0" });
 * ```
 */
export function getKey({ store, id }: { store: Store<KeyStoreState>; id: KeyId }): Key | undefined {
  return store.state.keys.find((key) => key.id === id && isSeedVaultKey(key));
}

/**
 * Removes a vault key record from the store.
 *
 * @example
 * ```typescript
 * removeKey({ store, id: "seed-1/0" });
 * ```
 */
export function removeKey({ store, id }: { store: Store<KeyStoreState>; id: KeyId }): void {
  store.setState((state) => ({
    ...state,
    keys: state.keys.filter((key) => !(key.id === id && isSeedVaultKey(key))),
  }));
}

/**
 * Sets the keystore's lifecycle status.
 *
 * @example
 * ```typescript
 * setStatus({ store, status: "signing" });
 * ```
 */
export function setStatus({
  store,
  status,
}: {
  store: Store<KeyStoreState>;
  status: string;
}): void {
  store.setState((state) => ({ ...state, status }));
}
