/**
 * Algorithm identifier used to route operations to the Seed Vault decorator
 * (see {@link import("./shim.ts").withSubtleSeedVault}).
 */
export const SEED_VAULT_ALGORITHM = "SeedVault";

/**
 * The name of this package, written to `metadata.owner` of every key record it
 * hydrates. A package only signs with, refreshes and removes the records it
 * owns, so keys written to the same store by another keystore are left alone.
 */
export const SEED_VAULT_OWNER = "@algorandecosystem/keystore-seed-vault";

/**
 * The `metadata.storage` value of a vault key: no material is held by any
 * storage driver, every private-key operation is delegated to the vault.
 */
export const SEED_VAULT_STORAGE = "external";
