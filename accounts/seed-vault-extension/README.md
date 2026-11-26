# @algorandecosystem/accounts-seed-vault-extension

Bridge between the Account Store and the Seed Vault keystore.

The [Seed Vault keystore](../../keystore/seed-vault) only knows pure keys: an
id, an algorithm and a public key. Addresses are not a keystore concern. This
extension builds accounts on top of those keys: it resolves an address for
each vault key and adds an account that signs transactions through the
keystore.

> [!NOTE]
> Experimental and not published.

## Features

- **Auto-population**: adds an account for every vault key the resolver knows
  an address for, and removes it when the vault stops authorizing the key.
- **Addresses stay in the accounts domain**: nothing is written to the key
  records.
- **Vault signing**: `account.sign(txns)` asks the vault to sign the
  transactions under one approval when the vault supports batches.

## Quick Start

The extension requires `WithSeedVaultKeyStore` and `WithAccountStore` to be
present on the provider, and must come after them.

```typescript
import { Provider } from "@algorandfoundation/wallet-provider";
import { WithAccountStore } from "@algorandfoundation/accounts-store";
import { WithSeedVaultKeyStore } from "@algorandecosystem/keystore-seed-vault";
import {
  type SeedVaultAccount,
  WithAccountsSeedVault,
} from "@algorandecosystem/accounts-seed-vault-extension";

const WalletProvider = Provider.withExtensions([
  WithSeedVaultKeyStore,
  WithAccountStore<SeedVaultAccount>,
  WithAccountsSeedVault,
] as const);

const provider = new WalletProvider(
  { id: "my-wallet", name: "My Wallet" },
  {
    keystore: { store: keyStore, hooks: keyStoreHooks, binding },
    accounts: {
      store: accountStore,
      hooks: accountHooks,
      seedVault: { address: (key) => addressesByKeyId.get(key.id) },
    },
  },
);

await provider.key.store.ready;
```

## Resolving addresses

`options.accounts.seedVault.address` receives a key record and returns the
address of the account it controls, or `undefined` when the key has no
account. It may be asynchronous.

Where the address comes from is up to the integration:

- **From the vault.** A vault that reports an address with each key keeps that
  listing on the accounts side and looks it up by key id.
- **From the public key.** Derive it with the chain's address scheme from
  `key.publicKey`.

A key the resolver returns `undefined` for stays a key without an account. A
resolver that throws is retried on the next keystore update.

## Accounts

```typescript
{
  type: "seed-vault-account",
  address,
  balance: 0n,
  assets: [],
  metadata: { keyId },
  sign: (txns) => Promise<Uint8Array[]>,
}
```

`sign` calls `provider.key.store.batchSign` with `{ intent: "transaction" }`,
so the vault shows its transaction approval screen. It resolves whatever the
vault produced for each transaction, in order.

Set `options.accounts.seedVault.autoPopulate` to `false` to keep the extension
from adding accounts.

Published on npm as `@mithiraj/accounts-seed-vault-extension`.
