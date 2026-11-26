# @algorandecosystem/keystore-seed-vault

A keystore whose keys live in an external **Seed Vault**.

Private key material never enters JavaScript: the vault holds the keys, shows
the approval screen and produces every signature. This package is the
provider-facing side of that arrangement. It has no storage driver, no master
key and no local unlock prompt, and it does not depend on any vault vendor.

> [!NOTE]
> Experimental and not published. It **replaces** the local keystore on a
> provider; running it beside a local keystore is not supported yet (see
> [Replacement, not coexistence](#replacement-not-coexistence)). It targets the
> Wallet Provider canary; see
> [Migration notes](#migration-notes-wallet-provider-100) for what the 1.0.0
> keystore release changes.

## Layers

The package is built in four layers. Each one is usable without the one above it.

| Layer     | Export                                       | What it is                                             |
| --------- | -------------------------------------------- | ------------------------------------------------------ |
| Binding   | `SeedVaultBinding`                           | The vault integration. The only vendor-specific piece. |
| Shim      | `withSubtleSeedVault`, `createSeedVaultShim` | A composable Subtle decorator over the binding.        |
| Keystore  | `createSeedVaultKeyStore`                    | A `KeyStoreAPI` built on the shim.                     |
| Extension | `WithSeedVaultKeyStore`                      | The Wallet Provider extension.                         |

## Pure keys

A vault key is recorded as a key and nothing else: an id, a type, an algorithm
and a public key.

```typescript
{
  id: "seed-1/0",
  type: "falcon-1024",
  algorithm: "Falcon-1024",
  keyUsages: ["sign", "verify"],
  publicKey,
  extractable: false,
  metadata: { storage: "external", owner: "@algorandecosystem/keystore-seed-vault" },
  version: 1,
}
```

There is no address on a key. An address belongs to an account, and accounts
are built on keys by an accounts extension, for example
[`@algorandecosystem/accounts-seed-vault-extension`](../../accounts/seed-vault-extension).
Other abstractions (identities, device-bound credentials) build on the same
keys without inheriting anything account-shaped.

## 1. Binding

Adapt the vault's native module to `SeedVaultBinding` and inject it. The
binding reports pure keys and signs with the key an `id` names.

```typescript
import type { SeedVaultBinding } from "@algorandecosystem/keystore-seed-vault";

export const binding: SeedVaultBinding = {
  // Connect, then list what this app is authorized to use.
  async keys() {
    await native.bind();
    const seeds = await native.getAuthorizedSeeds();
    return seeds.flatMap((seed) =>
      seed.accounts.map((entry) => ({
        id: `${seed.id}/${entry.index}`,
        algorithm: "Falcon-1024" as const,
        publicKey: base64.decode(entry.publicKey),
        name: seed.name,
      })),
    );
  },
  // One call per signature: ask for approval, then sign.
  async sign({ id, data, intent }) {
    const locator = locatorFor(id); // whatever the native API addresses a key by
    return intent === "transaction"
      ? native.signTransaction(locator, data)
      : native.signBytes(locator, data);
  },
};
```

A vault whose own API addresses keys by something else (an on-chain address,
an auth token) keeps that translation inside the binding. A rejected request
either throws or resolves `null`; both surface as `SeedVaultRejectedError`.

Optional members:

- `signBatch` and `maxBatchSize`: sign several payloads with one key under a
  single approval.
- `remove`: revoke this app's access to a key.

## 2. Shim

The shim works with any `SubtleCrypto`, with or without a keystore.

```typescript
import { createKeyHandle } from "@algorandfoundation/keystore-core";
import { withSubtleSeedVault } from "@algorandecosystem/keystore-seed-vault";

const subtle = withSubtleSeedVault(crypto.subtle, binding);
const handle = createKeyHandle("private", { name: "SeedVault" }, false, ["sign"]);

const signature = await subtle.sign({ name: "SeedVault", id: "seed-1/0" }, handle, message);
```

It differs from the other keystore shims in one way. They receive key material
through the algorithm parameters for the duration of a call; this one receives
a locator (`id`) and the binding signs inside the vault. `generateKey`,
`importKey` and `exportKey` throw `MaterialAccessError` for `"SeedVault"`.
`verify` is not handled: verify with the key's own algorithm and public key.

`createSeedVaultShim(binding)` returns the same decorator as a tagged
`SubtleShim`.

## 3. Keystore

```typescript
import { Store } from "@tanstack/store";
import { createSeedVaultKeyStore } from "@algorandecosystem/keystore-seed-vault";

const store = new Store({ keys: [], status: "idle" });
const keystore = createSeedVaultKeyStore({ binding, store, hooks });

await keystore.ready;
const [key] = store.state.keys;
const signature = await keystore.sign(key.id, message);
await keystore.verify(key.id, message, signature); // local, no vault request
```

| `KeyStoreAPI`                                | Seed Vault keystore                                             |
| -------------------------------------------- | --------------------------------------------------------------- |
| `ready`                                      | Lists the vault's keys and hydrates the store                   |
| `refresh()`                                  | Lists them again, e.g. after the user authorized another seed   |
| `sign`                                       | Performed by the vault                                          |
| `batchSign`                                  | One vault approval per key; results keep the caller's order     |
| `verify`                                     | Local, against the public key                                   |
| `export`                                     | Public metadata only                                            |
| `remove`                                     | Through `binding.remove`, otherwise `SeedVaultUnsupportedError` |
| `generate`, `import`                         | `SeedVaultUnsupportedError`                                     |
| `importSeed`, `deriveFromSeed`, `secrets`, … | Not present                                                     |

The `ctx` argument of `sign` and `batchSign` tells the vault what it is
signing, so it can show the matching approval screen:

```typescript
await keystore.sign(key.id, transaction, undefined, { intent: "transaction" });
```

Verification uses the Subtle shims passed as `shims`. By default Falcon-1024 is
enabled when the optional `falcon-1024` peer dependency is installed; pass your
own array to use a platform-native binding.

When the vault cannot be reached, `ready` rejects with
`SeedVaultUnavailableError` and the store's `status` becomes `"unavailable"`.
Call `refresh()` to try again.

## 4. Extension

```typescript
import { Provider } from "@algorandfoundation/wallet-provider";
import { WithSeedVaultKeyStore } from "@algorandecosystem/keystore-seed-vault";

const WalletProvider = Provider.withExtensions([WithSeedVaultKeyStore]);
const provider = new WalletProvider(
  { id: "my-wallet", name: "My Wallet" },
  { keystore: { store, hooks, binding } },
);

await provider.key.store.ready;
provider.keys; // the vault's keys
await provider.key.store.sign(provider.keys[0].id, message);
```

### Replacement, not coexistence

`WithSeedVaultKeyStore` mounts the same surface as the local keystore
extension (`keys`, `status`, `algorithms`, `key.store`) and reads the same
`options.keystore` block. Extensions written against `provider.key.store`
therefore work unchanged, and a provider loads **one** keystore extension.

Loading it next to a local keystore is not supported. On the Wallet Provider
canary this repository builds against, the later extension silently shadows
the earlier one's `key.store`.

## Migration notes: Wallet Provider 1.0.0

This package targets the Wallet Provider canary (`1.0.0-canary.5`), like the
rest of the repository. The 1.0.0 keystore release will be bound to Wallet
Provider 1.0.0, and this package and its accounts bridge have to move with it.
What changes:

- **Extension signature.** `Extension` becomes
  `(provider: NamespaceHost, options: ExtensionOptions) => T`, so
  `WithSeedVaultKeyStore` and `WithAccountsSeedVault` no longer type-check with
  their own parameter types. `options.keystore.binding` and
  `options.accounts.seedVault` have to be registered on the `ExtensionOptions`
  registry by declaration merging, next to the `keystore` and `accounts` blocks
  their owning packages register.
- **Mounting.** Return `extendNamespace(provider, "key", { … })` instead of a
  fresh `key` object, once the keystore core registers `key` on `Namespaces`.
  A provider then rejects a second extension that returns `keys`, `status`,
  `algorithms` or a new `key` with a `MountError` instead of shadowing the
  first.
- **Coexistence becomes possible.** A vault mounted on its own branch survives
  next to the local keystore (`provider.key` holds both `store` and the vault
  branch). The branch name is a decision for the keystore core, which owns the
  `key` namespace.
- **Ownership.** Records carry `metadata.owner` today. Wallet Provider 1.0.0
  makes `owner` a top-level field of every entry (`Entity`), so it moves out of
  `metadata`, `isSeedVaultKey` becomes `ownedBy(SEED_VAULT_OWNER)`, and the
  package registers its metadata shape on `Owners`.
- **Shared store fields.** `hydrateKeys` already replaces only the records this
  package owns. `status` and `algorithms` are still written for the whole
  store, which is correct for a replacement and has to be merged before two
  keystores share one store.

The test suites of this package and of the accounts bridge pass unchanged
against the Wallet Provider 1.0.0 runtime. The type-level changes above are
the blocking part.

## Errors

| Error                       | When                                                         |
| --------------------------- | ------------------------------------------------------------ |
| `SeedVaultUnavailableError` | The vault's keys could not be listed                         |
| `SeedVaultRejectedError`    | The vault produced no signature (declined, dismissed)        |
| `SeedVaultUnsupportedError` | The operation does not exist for vault keys                  |
| `KeyNotFoundError`          | The id is unknown, or the record belongs to another keystore |

All of them extend the core `KeyStoreError`.
