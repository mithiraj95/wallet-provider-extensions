import type { KeyStoreExtension } from "@algorandfoundation/keystore-core";
import type { Extension, Provider } from "@algorandfoundation/wallet-provider";

import { createSeedVaultKeyStore } from "./engine.ts";
import type { SeedVaultKeyStoreOptions } from "./types.ts";

/**
 * Wallet Provider Extension that adds a keystore backed by an external Seed
 * Vault.
 *
 * It **replaces** the local keystore extension: it mounts the same
 * {@link KeyStoreExtension} surface (reactive `keys`/`status`/`algorithms` and
 * the `key.store` API) and reads the same `options.keystore` block, so
 * extensions that build on keys (accounts, identities) work unchanged. Load
 * one keystore extension per provider.
 *
 * The extension is a thin wrapper around {@link createSeedVaultKeyStore}:
 *
 * - If a concrete keystore is injected via `options.api.keystore`, it is used
 *   as-is.
 * - Otherwise the extension builds the Seed Vault keystore from the
 *   `options.keystore` block (the reactive `store`, the `hooks` collection,
 *   the vault `binding`, and optionally a host `subtle` and verification
 *   `shims`).
 *
 * @param _provider - The host provider.
 * @param options - {@link SeedVaultKeyStoreOptions}. `options.keystore.store`
 *   is required, and so is `options.keystore.binding` unless a keystore is
 *   injected.
 * @returns The {@link KeyStoreExtension} surface.
 *
 * @example
 * ```typescript
 * const WalletProvider = Provider.withExtensions([WithSeedVaultKeyStore]);
 * const provider = new WalletProvider(
 *   { id: "my-wallet", name: "My Wallet" },
 *   { keystore: { store, hooks, binding } },
 * );
 *
 * await provider.key.store.ready;
 * const signature = await provider.key.store.sign(provider.keys[0].id, data);
 * ```
 */
export const WithSeedVaultKeyStore: Extension<KeyStoreExtension> = (
  _provider: Provider<any>,
  options: SeedVaultKeyStoreOptions,
) => {
  const keyStore = options.keystore.store;

  // Single source of the API: use an injected backend when present, otherwise
  // build the Seed Vault keystore and let it own every operation.
  let keystore = options?.api?.keystore;
  if (!keystore) {
    const binding = options.keystore.binding;
    if (!binding) {
      throw new Error("SeedVaultKeyStore extension requires options.keystore.binding.");
    }
    keystore = createSeedVaultKeyStore({
      store: keyStore,
      binding,
      subtle: options.keystore.subtle,
      shims: options.keystore.shims,
      hooks: options.keystore.hooks,
    });
  }

  return {
    /** Reactive state of all keys authorized by the vault. */
    get keys() {
      return keyStore.state.keys;
    },
    /** Reactive status of the keystore (e.g. 'idle', 'signing', 'unavailable'). */
    get status() {
      return keyStore.state.status;
    },
    /** Reactive list of the keystore's capabilities, populated once it is ready. */
    get algorithms() {
      return keyStore.state.algorithms ?? [];
    },
    /** The Keystore API; every private-key operation is performed by the vault. */
    key: {
      store: keystore,
    },
  } as KeyStoreExtension;
};
