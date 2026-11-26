import { readFileSync } from "node:fs";

import type { KeyStoreAPI, KeyStoreState } from "@algorandfoundation/keystore-core";
import { Provider } from "@algorandfoundation/wallet-provider";
import { Store } from "@tanstack/store";
import Hook from "before-after-hook";
import { describe, expect, it, vi } from "vitest";

import { createFakeVault } from "./__fixtures__.ts";
import { SEED_VAULT_ALGORITHM, SEED_VAULT_OWNER } from "./constants.ts";
import { WithSeedVaultKeyStore } from "./extension.ts";

const message = new TextEncoder().encode("the quick brown fox");
const config = { id: "test-wallet", name: "Test Wallet" };

const newStore = (): Store<KeyStoreState> => new Store<KeyStoreState>({ keys: [], status: "idle" });

describe("WithSeedVaultKeyStore", () => {
  it("mounts the keystore surface a local keystore extension would", async () => {
    const vault = createFakeVault();
    const key = vault.addFalconKey("seed-1/0");
    const store = newStore();
    const hooks = new Hook.Collection<any>();
    const WalletProvider = Provider.withExtensions([WithSeedVaultKeyStore]);

    const provider = new WalletProvider(config, {
      keystore: { store, hooks, binding: vault.binding },
    });
    await provider.key.store.ready;

    expect(provider.keys).toBe(store.state.keys);
    expect(provider.keys.map((k) => k.id)).toEqual([key.id]);
    expect(provider.status).toBe("idle");
    expect(provider.algorithms).toEqual([{ algorithm: SEED_VAULT_ALGORITHM, source: "shim" }]);
    expect(provider.key.store.hooks).toBe(hooks);
  });

  it("signs with the vault through provider.key.store", async () => {
    const vault = createFakeVault();
    const key = vault.addFalconKey("seed-1/0");
    const hooks = new Hook.Collection<any>();
    const before = vi.fn();
    hooks.before("sign", before);
    const WalletProvider = Provider.withExtensions([WithSeedVaultKeyStore]);
    const provider = new WalletProvider(config, {
      keystore: { store: newStore(), hooks, binding: vault.binding },
    });

    const signature = await provider.key.store.sign(key.id, message);

    expect(await provider.key.store.verify(key.id, message, signature)).toBe(true);
    expect(vault.requests).toHaveLength(1);
    expect(before).toHaveBeenCalledTimes(1);
  });

  it("reports an empty capability list until the keystore is ready", () => {
    const WalletProvider = Provider.withExtensions([WithSeedVaultKeyStore]);
    const provider = new WalletProvider(config, {
      keystore: {
        store: newStore(),
        hooks: new Hook.Collection<any>(),
        binding: createFakeVault().binding,
      },
    });

    expect(provider.algorithms).toEqual([]);
  });

  it("uses an injected keystore as-is", () => {
    const injected = { sign: vi.fn() } as unknown as KeyStoreAPI;
    const WalletProvider = Provider.withExtensions([WithSeedVaultKeyStore]);

    const provider = new WalletProvider(config, {
      api: { keystore: injected },
      keystore: { store: newStore(), hooks: new Hook.Collection<any>() },
    });

    expect(provider.key.store).toBe(injected);
  });

  it("requires a binding when no keystore is injected", () => {
    const WalletProvider = Provider.withExtensions([WithSeedVaultKeyStore]);

    expect(
      () =>
        new WalletProvider(config, {
          keystore: { store: newStore(), hooks: new Hook.Collection<any>() },
        }),
    ).toThrow("SeedVaultKeyStore extension requires options.keystore.binding.");
  });
});

describe("SEED_VAULT_OWNER", () => {
  it("is the name of this package", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(SEED_VAULT_OWNER).toBe(pkg.name);
  });
});
