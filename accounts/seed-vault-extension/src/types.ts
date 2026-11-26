import type { Account, AccountStoreOptions } from "@algorandfoundation/accounts-store";
import type { Key, KeyStoreOptions } from "@algorandfoundation/keystore-core";
import type { ExtensionOptions } from "@algorandfoundation/wallet-provider";

/**
 * Represents an account whose signing key is held by a Seed Vault.
 *
 * The address lives here, in the accounts domain. The key it is built on is a
 * pure key in the keystore, referenced by `metadata.keyId`.
 */
export interface SeedVaultAccount extends Account {
  type: "seed-vault-account";
  /**
   * Account metadata. Includes the id of the vault key the account signs with.
   */
  metadata?: {
    keyId: string;
    [key: string]: unknown;
  };
  /**
   * Asks the vault to sign a transaction or a set of transactions under one
   * approval.
   *
   * @param txns - The transactions to sign.
   * @returns What the vault produced for each transaction, in order.
   */
  sign: (txns: Uint8Array[]) => Promise<Uint8Array[]>;
}

/**
 * Resolves the address of the account a vault key controls, or `undefined`
 * when the key has no account.
 *
 * How an address is obtained is a decision of the accounts domain: look it up
 * in the vault's own account listing, or derive it from `key.publicKey` with
 * the address scheme of the chain.
 *
 * @example
 * ```typescript
 * const address: SeedVaultAddressResolver = (key) => addressesByKeyId.get(key.id);
 * ```
 */
export type SeedVaultAddressResolver = (
  key: Key,
) => string | undefined | Promise<string | undefined>;

/**
 * Options for the AccountsSeedVault extension.
 *
 * @example
 * ```typescript
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
export interface AccountsSeedVaultExtensionOptions
  extends ExtensionOptions, AccountStoreOptions<SeedVaultAccount>, KeyStoreOptions {
  accounts: AccountStoreOptions<SeedVaultAccount>["accounts"] & {
    seedVault: {
      /**
       * Resolves the address for each vault key. Keys it resolves to
       * `undefined` get no account.
       */
      address: SeedVaultAddressResolver;
      /**
       * Whether to automatically add accounts for the vault keys in the keystore.
       * Defaults to true.
       */
      autoPopulate?: boolean;
    };
  };
}
