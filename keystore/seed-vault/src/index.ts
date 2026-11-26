/**
 * @module default
 * @packageDocumentation
 *
 * `@algorandecosystem/keystore-seed-vault` is a keystore whose keys live in
 * an external Seed Vault: private material never enters JavaScript and every
 * signature is produced by the vault. It is built in layers, each usable
 * without the one above it:
 *
 * 1. {@link SeedVaultBinding}: the vendor-specific vault integration.
 * 2. {@link withSubtleSeedVault}: a composable Subtle shim over the binding.
 * 3. {@link createSeedVaultKeyStore}: a `KeyStoreAPI` built on the shim.
 * 4. {@link WithSeedVaultKeyStore}: the Wallet Provider extension.
 */

import { WithSeedVaultKeyStore } from "./extension.ts";

export * from "./constants.ts";
export * from "./engine.ts";
export * from "./errors.ts";
export * from "./extension.ts";
export * from "./shim.ts";
export * from "./store.ts";
export * from "./types.ts";

export default WithSeedVaultKeyStore;
