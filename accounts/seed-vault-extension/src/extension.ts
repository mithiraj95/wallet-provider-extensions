import {
  type Account,
  type AccountStoreExtension,
  type AccountStoreState,
  addAccount,
  removeAccount,
} from "@algorandfoundation/accounts-store";
import type { Key, KeyStoreExtension, KeyStoreState } from "@algorandfoundation/keystore-core";
import { isSeedVaultKey, type SeedVaultContext } from "@algorandecosystem/keystore-seed-vault";
import type { LogStoreApi, LogStoreExtension } from "@algorandfoundation/log-store";
import type { Extension } from "@algorandfoundation/wallet-provider";
import type { Store } from "@tanstack/store";
import type { AccountsSeedVaultExtensionOptions, SeedVaultAccount } from "./types.ts";

/**
 * Whether an account is backed by a key held in a Seed Vault.
 *
 * @example
 * ```typescript
 * const vaultAccounts = provider.accounts.filter(isSeedVaultAccount);
 * ```
 */
export function isSeedVaultAccount(account: Account): account is SeedVaultAccount {
  return account.type === "seed-vault-account";
}

/**
 * Extension that bridges the account store and the Seed Vault keystore.
 *
 * The keystore only knows pure keys. This extension builds accounts on top of
 * them: for every vault key in the keystore it resolves an address through
 * `options.accounts.seedVault.address` and adds an account whose `sign` asks
 * the vault, through the keystore, to sign transactions.
 *
 * @example
 * ```typescript
 * const WalletProvider = Provider.withExtensions([
 *   WithSeedVaultKeyStore,
 *   WithAccountStore,
 *   WithAccountsSeedVault,
 * ]);
 * const provider = new WalletProvider(config, {
 *   keystore: { store: keyStore, hooks: keyStoreHooks, binding },
 *   accounts: {
 *     store: accountStore,
 *     hooks: accountHooks,
 *     seedVault: { address: (key) => addressesByKeyId.get(key.id) },
 *   },
 * });
 * ```
 */
export const WithAccountsSeedVault: Extension<Record<never, never>> = (
  provider: KeyStoreExtension & AccountStoreExtension<SeedVaultAccount> & LogStoreExtension,
  options: AccountsSeedVaultExtensionOptions,
) => {
  // Ensure dependencies are present
  if (!provider.account) {
    throw new Error(
      "AccountsSeedVault extension requires WithAccountStore extension to be present on the provider.",
    );
  }
  if (!provider.key) {
    throw new Error(
      "AccountsSeedVault extension requires WithSeedVaultKeyStore extension to be present on the provider.",
    );
  }

  const log: LogStoreApi | undefined = provider.log;

  const keyStore: Store<KeyStoreState> = options.keystore.store;
  const accountStore: Store<AccountStoreState<SeedVaultAccount>> = options.accounts.store;
  const resolveAddress = options.accounts.seedVault?.address;
  const autoPopulate = options.accounts.seedVault?.autoPopulate ?? true;
  if (typeof resolveAddress !== "function") {
    throw new Error("AccountsSeedVault extension requires options.accounts.seedVault.address.");
  }

  const keys: Key[] = [];

  /**
   * Creates an account object for a given key ID and address.
   */
  const createKeyAccount = (keyId: string, address: string): SeedVaultAccount => ({
    address,
    type: "seed-vault-account",
    assets: [],
    metadata: { keyId },
    balance: BigInt(0),
    sign: async (txns: Uint8Array[]) => {
      // Read the keystore at call time and tell the vault these are transactions
      const keystore = provider.key.store;
      const ctx: SeedVaultContext = { intent: "transaction" };
      if (keystore.batchSign) {
        return keystore.batchSign(
          txns.map(() => keyId),
          txns,
          ctx,
        );
      }
      const signedTxns: Uint8Array[] = [];
      for (const txn of txns) {
        const signed = await keystore.sign(keyId, txn, undefined, ctx);
        signedTxns.push(signed);
      }
      return signedTxns;
    },
  });

  // Initial population if enabled
  if (autoPopulate) {
    let isProcessing = false;
    let nextKeys: Key[] | null = null;

    const processUpdates = async (allKeys: Key[]) => {
      // Only the keys the vault keystore owns produce vault accounts
      const newKeys = allKeys.filter(isSeedVaultKey);
      if (isProcessing) {
        nextKeys = newKeys;
        return;
      }
      isProcessing = true;
      try {
        nextKeys = null;

        // Find added keys
        const addedKeys = newKeys.filter(
          (newKey) => !keys.some((existingKey) => existingKey.id === newKey.id),
        );

        // Find removed keys
        const removedKeys = keys.filter(
          (existingKey) => !newKeys.some((newKey) => newKey.id === existingKey.id),
        );

        if (addedKeys.length === 0 && removedKeys.length === 0) {
          return;
        }

        // Update the local cache of keys BEFORE processing to ensure consistency
        keys.length = 0;
        newKeys.forEach((k) => keys.push(k));

        // Remove accounts for removed keys
        for (const k of removedKeys) {
          const account = accountStore.state.accounts.find(
            (a) => isSeedVaultAccount(a) && a.metadata?.keyId === k.id,
          );
          if (account) {
            log?.info(`Removing account for key ${k.id}-${k.type}...`);
            removeAccount<SeedVaultAccount>({ store: accountStore, address: account.address });
          }
        }

        // Process only the newly added keys
        for (const k of addedKeys) {
          let address: string | undefined;
          try {
            address = await resolveAddress(k);
          } catch (error) {
            log?.error(`Failed to resolve an address for key ${k.id}-${k.type}`, { error });
            // Forget the key so the next keystore update retries it
            keys.splice(keys.indexOf(k), 1);
            continue;
          }

          // Skip keys without an account, and accounts that already exist
          if (address && !accountStore.state.accounts.some((a) => a.address === address)) {
            log?.info(`Adding account for key ${k.id}-${k.type}...`);
            addAccount<SeedVaultAccount>({
              store: accountStore,
              account: createKeyAccount(k.id, address),
            });
          }
        }
      } finally {
        isProcessing = false;
        if (nextKeys) {
          const k = nextKeys;
          nextKeys = null;
          void processUpdates(k);
        }
      }
    };

    void processUpdates(keyStore.state.keys);

    keyStore.subscribe((state) => {
      if (state.status !== "ready" && state.status !== "idle") {
        return;
      }
      void processUpdates(state.keys);
    });
  }

  return {};
};
