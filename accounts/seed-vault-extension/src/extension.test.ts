import {
  type KeystoreAccount,
  WithAccountsKeystore,
} from "@algorandfoundation/accounts-keystore-extension";
import {
  type AccountStoreExtension,
  type AccountStoreState,
  WithAccountStore,
} from "@algorandfoundation/accounts-store";
import type {
  Key,
  KeyStoreAPI,
  KeyStoreExtension,
  KeyStoreState,
} from "@algorandfoundation/keystore-core";
import {
  type SeedVaultBatchSignRequest,
  type SeedVaultBinding,
  type SeedVaultKey,
  type SeedVaultKeyStore,
  type SeedVaultSignRequest,
  toKey,
  WithSeedVaultKeyStore,
} from "@algorandecosystem/keystore-seed-vault";
import { Provider } from "@algorandfoundation/wallet-provider";
import { base64 } from "@scure/base";
import { Store } from "@tanstack/store";
import Hook from "before-after-hook";
import { describe, expect, it, vi } from "vitest";

import { isSeedVaultAccount, WithAccountsSeedVault } from "./extension.ts";
import type { SeedVaultAccount, SeedVaultAddressResolver } from "./types.ts";

const config = { id: "test-wallet", name: "Test Wallet" };
const encoder = new TextEncoder();

/**
 * A stand-in for a vault. It reports pure keys; the address of each key is
 * only known to `addresses`, which plays the accounts side of a vendor bridge.
 */
function createVault(options: { batch?: boolean } = {}) {
  const keys: SeedVaultKey[] = [];
  const addresses = new Map<string, string>();
  const signRequests: SeedVaultSignRequest[] = [];
  const batchRequests: SeedVaultBatchSignRequest[] = [];
  const signature = (id: string, data: Uint8Array): Uint8Array =>
    encoder.encode(`${id}:${data.join(",")}`);

  const binding: SeedVaultBinding = {
    keys: async () => [...keys],
    sign: async (request) => {
      signRequests.push(request);
      return signature(request.id, request.data);
    },
  };
  if (options.batch) {
    binding.signBatch = async (request) => {
      batchRequests.push(request);
      return request.data.map((item) => signature(request.id, item));
    };
  }

  return {
    binding,
    addresses,
    signRequests,
    batchRequests,
    signature,
    add(id: string, address?: string, algorithm: SeedVaultKey["algorithm"] = "Falcon-1024") {
      const publicKey = crypto.getRandomValues(new Uint8Array(32));
      keys.push({ id, algorithm, publicKey });
      if (address) addresses.set(id, address);
      return publicKey;
    },
    revoke(id: string) {
      keys.splice(
        keys.findIndex((key) => key.id === id),
        1,
      );
    },
  };
}

function createProvider(
  vault: ReturnType<typeof createVault>,
  seedVault: { address?: SeedVaultAddressResolver; autoPopulate?: boolean } = {},
) {
  const keyStore = new Store<KeyStoreState>({ keys: [], status: "idle" });
  const accountStore = new Store<AccountStoreState<SeedVaultAccount>>({ accounts: [] });
  const WalletProvider = Provider.withExtensions([
    WithSeedVaultKeyStore,
    WithAccountStore<SeedVaultAccount>,
    WithAccountsSeedVault,
  ] as const);
  const provider = new WalletProvider(config, {
    keystore: { store: keyStore, hooks: new Hook.Collection<any>(), binding: vault.binding },
    accounts: {
      store: accountStore,
      hooks: new Hook.Collection<any>(),
      seedVault: { address: (key: Key) => vault.addresses.get(key.id), ...seedVault },
    },
  });
  return { provider, keyStore, accountStore, keystore: provider.key.store as SeedVaultKeyStore };
}

describe("WithAccountsSeedVault", () => {
  it("builds accounts on the vault's keys, keeping addresses out of the keystore", async () => {
    const vault = createVault();
    vault.add("seed-1/0", "FALCONADDRESS0");
    vault.add("seed-1/1", "FALCONADDRESS1");
    const { provider, keyStore, keystore } = createProvider(vault);

    await keystore.ready;
    await vi.waitFor(() => expect(provider.accounts).toHaveLength(2));

    expect(provider.accounts.every(isSeedVaultAccount)).toBe(true);
    expect(
      provider.accounts.map((account) => [account.address, account.metadata?.keyId]).sort(),
    ).toEqual([
      ["FALCONADDRESS0", "seed-1/0"],
      ["FALCONADDRESS1", "seed-1/1"],
    ]);
    // The keystore records stay pure keys: nothing in them mentions an address.
    expect(JSON.stringify(keyStore.state.keys)).not.toContain("FALCONADDRESS");
    for (const key of keyStore.state.keys) {
      expect(key).not.toHaveProperty("address");
      expect(key.metadata).not.toHaveProperty("address");
    }
  });

  it("gives no account to a key the resolver does not know", async () => {
    const vault = createVault();
    vault.add("seed-1/0", "FALCONADDRESS0");
    vault.add("identity/0");
    const { provider, keystore } = createProvider(vault);

    await keystore.ready;
    await vi.waitFor(() => expect(provider.accounts).toHaveLength(1));

    expect(provider.keys).toHaveLength(2);
    expect(provider.accounts[0]?.metadata?.keyId).toBe("seed-1/0");
  });

  it("supports an asynchronous resolver and retries a key whose lookup failed", async () => {
    const vault = createVault();
    vault.add("seed-1/0", "FALCONADDRESS0");
    let failing = true;
    const address = vi.fn(async (key: Key) => {
      if (failing) throw new Error("vault busy");
      return vault.addresses.get(key.id);
    });
    const { provider, keystore } = createProvider(vault, { address });

    await keystore.ready;
    await vi.waitFor(() => expect(address).toHaveBeenCalledTimes(1));
    expect(provider.accounts).toHaveLength(0);

    failing = false;
    await keystore.refresh();
    await vi.waitFor(() => expect(provider.accounts).toHaveLength(1));
  });

  it("signs transactions through the keystore under one vault approval", async () => {
    const vault = createVault({ batch: true });
    vault.add("seed-1/0", "FALCONADDRESS0");
    const { provider, keystore } = createProvider(vault);
    await keystore.ready;
    await vi.waitFor(() => expect(provider.accounts).toHaveLength(1));
    const txns = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];

    const signed = await provider.accounts[0]!.sign(txns);

    expect(vault.batchRequests).toEqual([{ id: "seed-1/0", data: txns, intent: "transaction" }]);
    expect(vault.signRequests).toHaveLength(0);
    expect(signed).toEqual(txns.map((txn) => vault.signature("seed-1/0", txn)));
  });

  it("signs one transaction at a time when the vault has no batch call", async () => {
    const vault = createVault();
    vault.add("seed-1/0", "FALCONADDRESS0");
    const { provider, keystore } = createProvider(vault);
    await keystore.ready;
    await vi.waitFor(() => expect(provider.accounts).toHaveLength(1));
    const txns = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];

    const signed = await provider.accounts[0]!.sign(txns);

    expect(vault.signRequests).toEqual(
      txns.map((data) => ({ id: "seed-1/0", data, intent: "transaction" })),
    );
    expect(signed).toEqual(txns.map((txn) => vault.signature("seed-1/0", txn)));
  });

  it("falls back to sign when the keystore offers no batchSign", async () => {
    const sign = vi.fn(async (id: string, data: Uint8Array) => encoder.encode(`${id}:${data}`));
    const keyStore = new Store<KeyStoreState>({
      keys: [toKey({ id: "seed-1/0", algorithm: "Falcon-1024", publicKey: new Uint8Array(32) })],
      status: "idle",
    });
    const WalletProvider = Provider.withExtensions([
      WithSeedVaultKeyStore,
      WithAccountStore<SeedVaultAccount>,
      WithAccountsSeedVault,
    ] as const);
    const provider = new WalletProvider(config, {
      api: { keystore: { sign } as unknown as KeyStoreAPI },
      keystore: { store: keyStore, hooks: new Hook.Collection<any>() },
      accounts: {
        store: new Store<AccountStoreState<SeedVaultAccount>>({ accounts: [] }),
        hooks: new Hook.Collection<any>(),
        seedVault: { address: () => "FALCONADDRESS0" },
      },
    });
    await vi.waitFor(() => expect(provider.accounts).toHaveLength(1));
    const txns = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];

    await provider.accounts[0]!.sign(txns);

    expect(sign.mock.calls).toEqual(
      txns.map((txn) => ["seed-1/0", txn, undefined, { intent: "transaction" }]),
    );
  });

  it("follows the vault when keys are authorized or revoked", async () => {
    const vault = createVault();
    vault.add("seed-1/0", "FALCONADDRESS0");
    const { provider, keystore } = createProvider(vault);
    await keystore.ready;
    await vi.waitFor(() => expect(provider.accounts).toHaveLength(1));

    vault.add("seed-1/1", "FALCONADDRESS1");
    vault.revoke("seed-1/0");
    await keystore.refresh();

    await vi.waitFor(() =>
      expect(provider.accounts.map((account) => account.address)).toEqual(["FALCONADDRESS1"]),
    );
  });

  it("leaves accounts it does not own alone", async () => {
    const vault = createVault();
    vault.add("seed-1/0", "FALCONADDRESS0");
    const { provider, keystore, accountStore } = createProvider(vault);
    const watched = { address: "WATCHED", type: "watch", assets: [], balance: BigInt(0) };
    accountStore.setState((state) => ({
      ...state,
      accounts: [watched as unknown as SeedVaultAccount],
    }));
    await keystore.ready;
    await vi.waitFor(() => expect(provider.accounts).toHaveLength(2));

    vault.revoke("seed-1/0");
    await keystore.refresh();

    await vi.waitFor(() => expect(provider.accounts).toEqual([watched]));
  });

  it("does not populate accounts when autoPopulate is off", async () => {
    const vault = createVault();
    vault.add("seed-1/0", "FALCONADDRESS0");
    const { provider, keystore } = createProvider(vault, { autoPopulate: false });

    await keystore.ready;
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(provider.keys).toHaveLength(1);
    expect(provider.accounts).toHaveLength(0);
  });

  it("requires the account store, the keystore and an address resolver", () => {
    const vault = createVault();
    const keystore = {
      store: new Store<KeyStoreState>({ keys: [], status: "idle" }),
      hooks: new Hook.Collection<any>(),
      binding: vault.binding,
    };
    const accounts = {
      store: new Store<AccountStoreState<SeedVaultAccount>>({ accounts: [] }),
      hooks: new Hook.Collection<any>(),
    };
    const seedVault = { address: () => undefined };

    const WithoutAccounts = Provider.withExtensions([
      WithSeedVaultKeyStore,
      WithAccountsSeedVault,
    ] as const);
    expect(
      () => new WithoutAccounts(config, { keystore, accounts: { ...accounts, seedVault } }),
    ).toThrow("requires WithAccountStore");

    const WithoutKeystore = Provider.withExtensions([
      WithAccountStore<SeedVaultAccount>,
      WithAccountsSeedVault,
    ] as const);
    expect(
      () => new WithoutKeystore(config, { keystore, accounts: { ...accounts, seedVault } }),
    ).toThrow("requires WithSeedVaultKeyStore");

    const WithoutResolver = Provider.withExtensions([
      WithSeedVaultKeyStore,
      WithAccountStore<SeedVaultAccount>,
      WithAccountsSeedVault,
    ] as const);
    expect(() => new WithoutResolver(config, { keystore, accounts })).toThrow(
      "requires options.accounts.seedVault.address",
    );
  });
});

describe("replacing the local keystore", () => {
  it("serves an existing key consumer through the same provider.key.store surface", async () => {
    // The reference accounts bridge was written against the local keystore. It
    // only reads the keys store and calls `provider.key.store.sign`, so it works
    // unchanged when the Seed Vault keystore takes the local keystore's place.
    const vault = createVault();
    const publicKey = vault.add("seed-1/0", undefined, "Ed25519");
    const keyStore = new Store<KeyStoreState>({ keys: [], status: "idle" });
    const accountStore = new Store<AccountStoreState<KeystoreAccount>>({ accounts: [] });
    const WalletProvider = Provider.withExtensions([
      WithSeedVaultKeyStore,
      WithAccountStore<KeystoreAccount>,
      WithAccountsKeystore,
    ] as const);
    // The reference bridge is declared `Extension<unknown>`, which erases the
    // composed type, so the surface is spelled out here.
    const provider = new WalletProvider(config, {
      keystore: { store: keyStore, hooks: new Hook.Collection<any>(), binding: vault.binding },
      accounts: { store: accountStore, hooks: new Hook.Collection<any>(), keystore: {} },
    }) as unknown as KeyStoreExtension & AccountStoreExtension<KeystoreAccount>;
    await provider.key.store.ready;

    expect(provider.accounts).toHaveLength(1);
    const account = provider.accounts[0]!;
    expect(account.address).toBe(base64.encode(publicKey));
    expect(account.metadata?.keyId).toBe("seed-1/0");

    const txn = new Uint8Array([9, 9, 9]);
    expect(await account.sign([txn])).toEqual([vault.signature("seed-1/0", txn)]);
    expect(vault.signRequests).toEqual([{ id: "seed-1/0", data: txn, intent: "bytes" }]);
  });
});
