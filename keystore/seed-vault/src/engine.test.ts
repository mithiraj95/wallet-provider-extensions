import {
  DuplicateKeyIdError,
  InvalidKeyDataError,
  type Key,
  KeyNotFoundError,
  type KeyStoreState,
} from "@algorandfoundation/keystore-core";
import { Store } from "@tanstack/store";
import Hook from "before-after-hook";
import * as falcon from "falcon-1024";
import { describe, expect, it, vi } from "vitest";

import { createFakeVault } from "./__fixtures__.ts";
import { SEED_VAULT_ALGORITHM, SEED_VAULT_OWNER, SEED_VAULT_STORAGE } from "./constants.ts";
import { createSeedVaultKeyStore } from "./engine.ts";
import {
  SeedVaultRejectedError,
  SeedVaultUnavailableError,
  SeedVaultUnsupportedError,
} from "./errors.ts";
import { isSeedVaultKey } from "./store.ts";
import type { SeedVaultKey } from "./types.ts";

const message = new TextEncoder().encode("the quick brown fox");
const other = new TextEncoder().encode("jumps over the lazy dog");

const newStore = (keys: Key[] = []): Store<KeyStoreState> =>
  new Store<KeyStoreState>({ keys, status: "idle" });

describe("createSeedVaultKeyStore", () => {
  describe("ready", () => {
    it("hydrates the store with the vault's keys as pure key records", async () => {
      const vault = createFakeVault();
      const falconKey = vault.addFalconKey("seed-1/0", "Main seed");
      const edKey = await vault.addEd25519Key("seed-2/0");
      const store = newStore();

      const keystore = createSeedVaultKeyStore({ binding: vault.binding, store });
      await keystore.ready;

      expect(store.state.status).toBe("idle");
      expect(store.state.algorithms).toEqual([{ algorithm: SEED_VAULT_ALGORITHM, source: "shim" }]);
      expect(store.state.keys).toEqual([
        {
          id: "seed-1/0",
          type: "falcon-1024",
          algorithm: "Falcon-1024",
          keyUsages: ["sign", "verify"],
          publicKey: falconKey.publicKey,
          extractable: false,
          metadata: { name: "Main seed", storage: SEED_VAULT_STORAGE, owner: SEED_VAULT_OWNER },
          version: 1,
        },
        {
          id: "seed-2/0",
          type: "ed25519",
          algorithm: "EdDSA",
          keyUsages: ["sign", "verify"],
          publicKey: edKey.publicKey,
          extractable: false,
          metadata: { storage: SEED_VAULT_STORAGE, owner: SEED_VAULT_OWNER },
          version: 1,
        },
      ]);
    });

    it("mirrors the binding's metadata without letting it claim ownership", async () => {
      const vault = createFakeVault();
      const key = vault.addFalconKey("seed-1/0");
      key.metadata = { seed: 1, index: 0, owner: "someone-else", storage: "bytes" };
      const store = newStore();

      await createSeedVaultKeyStore({ binding: vault.binding, store }).ready;

      expect(store.state.keys[0]?.metadata).toEqual({
        seed: 1,
        index: 0,
        storage: SEED_VAULT_STORAGE,
        owner: SEED_VAULT_OWNER,
      });
    });

    it("keeps records written to the store by another package", async () => {
      const foreign: Key = {
        id: "local-1",
        type: "ed25519",
        algorithm: "EdDSA",
        extractable: false,
        metadata: { storage: "bytes" },
      };
      const vault = createFakeVault();
      vault.addFalconKey("seed-1/0");
      const store = newStore([foreign]);

      const keystore = createSeedVaultKeyStore({ binding: vault.binding, store });
      await keystore.ready;

      expect(store.state.keys.map((key) => key.id)).toEqual(["seed-1/0", "local-1"]);
      expect(store.state.keys.filter(isSeedVaultKey).map((key) => key.id)).toEqual(["seed-1/0"]);
      // It only operates on the records it owns.
      await expect(keystore.sign("local-1", message)).rejects.toBeInstanceOf(KeyNotFoundError);
      expect(vault.requests).toHaveLength(0);
    });

    it("rejects with a typed error and reports the status when the vault is unavailable", async () => {
      const vault = createFakeVault();
      vault.unavailable = new Error("Seed Vault is not installed");
      const store = newStore();

      const keystore = createSeedVaultKeyStore({ binding: vault.binding, store });

      await expect(keystore.ready).rejects.toBeInstanceOf(SeedVaultUnavailableError);
      await expect(keystore.ready).rejects.toThrow("Seed Vault is not installed");
      expect(store.state.status).toBe("unavailable");
      await expect(keystore.sign("seed-1/0", message)).rejects.toBeInstanceOf(
        SeedVaultUnavailableError,
      );
    });

    it("rejects keys the binding reports twice or with an unknown algorithm", async () => {
      const duplicated = createFakeVault();
      const key = duplicated.addFalconKey("seed-1/0");
      duplicated.binding.keys = async () => [key, key];
      await expect(
        createSeedVaultKeyStore({ binding: duplicated.binding, store: newStore() }).ready,
      ).rejects.toBeInstanceOf(DuplicateKeyIdError);

      const unknown = createFakeVault();
      unknown.binding.keys = async () => [
        { ...key, algorithm: "secp256k1" } as unknown as SeedVaultKey,
      ];
      await expect(
        createSeedVaultKeyStore({ binding: unknown.binding, store: newStore() }).ready,
      ).rejects.toBeInstanceOf(InvalidKeyDataError);
    });
  });

  describe("refresh", () => {
    it("picks up newly authorized keys and drops revoked ones", async () => {
      const vault = createFakeVault();
      vault.addFalconKey("seed-1/0");
      const store = newStore();
      const keystore = createSeedVaultKeyStore({ binding: vault.binding, store });
      await keystore.ready;

      vault.addFalconKey("seed-1/1");
      vault.revoke("seed-1/0");
      await keystore.refresh();

      expect(store.state.keys.map((key) => key.id)).toEqual(["seed-1/1"]);
      expect(vault.listed).toBe(2);
    });

    it("recovers a keystore whose first load failed", async () => {
      const vault = createFakeVault();
      const key = vault.addFalconKey("seed-1/0");
      vault.unavailable = new Error("not authorized");
      const store = newStore();
      const keystore = createSeedVaultKeyStore({ binding: vault.binding, store });
      await expect(keystore.ready).rejects.toBeInstanceOf(SeedVaultUnavailableError);

      vault.unavailable = undefined;
      await keystore.refresh();

      expect(store.state.status).toBe("idle");
      const signature = await keystore.sign(key.id, message);
      expect(await keystore.verify(key.id, message, signature)).toBe(true);
    });
  });

  describe("sign", () => {
    it("delegates to the vault and never holds key material", async () => {
      const vault = createFakeVault();
      const key = vault.addFalconKey("seed-1/0");
      const store = newStore();
      const keystore = createSeedVaultKeyStore({ binding: vault.binding, store });

      const statuses: string[] = [];
      store.subscribe((state) => {
        statuses.push(state.status);
      });
      const signature = await keystore.sign(key.id, message);

      expect(vault.requests).toEqual([
        { kind: "sign", id: key.id, data: message, intent: "bytes" },
      ]);
      expect(falcon.verifyCompressed(key.publicKey, signature, message)).toBe(true);
      expect(statuses).toContain("signing");
      expect(store.state.status).toBe("idle");
    });

    it("threads the intent from the operation context", async () => {
      const vault = createFakeVault();
      const key = vault.addFalconKey("seed-1/0");
      const keystore = createSeedVaultKeyStore({ binding: vault.binding, store: newStore() });

      await keystore.sign(key.id, message, undefined, { intent: "transaction" });

      expect(vault.requests[0]?.intent).toBe("transaction");
    });

    it("throws a typed error when the request is declined, and returns to idle", async () => {
      const vault = createFakeVault();
      const key = vault.addFalconKey("seed-1/0");
      vault.declining = true;
      const store = newStore();
      const keystore = createSeedVaultKeyStore({ binding: vault.binding, store });

      await expect(keystore.sign(key.id, message)).rejects.toBeInstanceOf(SeedVaultRejectedError);
      expect(store.state.status).toBe("idle");
    });

    it("throws KeyNotFoundError for an unknown key without asking the vault", async () => {
      const vault = createFakeVault();
      const keystore = createSeedVaultKeyStore({ binding: vault.binding, store: newStore() });

      await expect(keystore.sign("missing", message)).rejects.toBeInstanceOf(KeyNotFoundError);
      expect(vault.requests).toHaveLength(0);
    });
  });

  describe("verify", () => {
    it("verifies Falcon-1024 and Ed25519 signatures locally", async () => {
      const vault = createFakeVault();
      const falconKey = vault.addFalconKey("seed-1/0");
      const edKey = await vault.addEd25519Key("seed-2/0");
      const keystore = createSeedVaultKeyStore({ binding: vault.binding, store: newStore() });

      for (const key of [falconKey, edKey]) {
        const signature = await keystore.sign(key.id, message);
        const requests = vault.requests.length;

        expect(await keystore.verify(key.id, message, signature)).toBe(true);
        expect(await keystore.verify(key.id, other, signature)).toBe(false);
        expect(vault.requests).toHaveLength(requests);
      }
    });

    it("uses the verification shims it is given", async () => {
      const vault = createFakeVault();
      const key = vault.addFalconKey("seed-1/0");
      // No Falcon shim: the host's own "unsupported algorithm" error surfaces.
      const keystore = createSeedVaultKeyStore({
        binding: vault.binding,
        store: newStore(),
        shims: [],
      });

      const signature = await keystore.sign(key.id, message);
      await expect(keystore.verify(key.id, message, signature)).rejects.toThrow();
    });
  });

  describe("batchSign", () => {
    it("asks for one approval per key and keeps the caller's order", async () => {
      const vault = createFakeVault({ batch: true });
      const first = vault.addFalconKey("seed-1/0");
      const second = await vault.addEd25519Key("seed-2/0");
      const keystore = createSeedVaultKeyStore({ binding: vault.binding, store: newStore() });
      const payloads = [message, other, message];

      const signatures = await keystore.batchSign!([first.id, second.id, first.id], payloads, {
        intent: "transaction",
      });

      expect(vault.requests).toEqual([
        { kind: "signBatch", id: first.id, data: [message, message], intent: "transaction" },
        { kind: "sign", id: second.id, data: other, intent: "transaction" },
      ]);
      expect(await keystore.verify(first.id, message, signatures[0]!)).toBe(true);
      expect(await keystore.verify(second.id, other, signatures[1]!)).toBe(true);
      expect(await keystore.verify(first.id, message, signatures[2]!)).toBe(true);
    });

    it("splits a batch that exceeds the binding's limit", async () => {
      const vault = createFakeVault({ batch: true, maxBatchSize: 2 });
      const key = await vault.addEd25519Key("seed-1/0");
      const keystore = createSeedVaultKeyStore({ binding: vault.binding, store: newStore() });
      const payloads = [0, 1, 2, 3, 4].map((n) => new Uint8Array([n]));

      const signatures = await keystore.batchSign!(
        payloads.map(() => key.id),
        payloads,
      );

      expect(vault.requests.map((request) => request.data)).toEqual([
        [payloads[0], payloads[1]],
        [payloads[2], payloads[3]],
        [payloads[4]],
      ]);
      for (const [index, payload] of payloads.entries()) {
        expect(await keystore.verify(key.id, payload, signatures[index]!)).toBe(true);
      }
    });

    it("falls back to one request per item when the binding has no batch call", async () => {
      const vault = createFakeVault();
      const key = await vault.addEd25519Key("seed-1/0");
      const keystore = createSeedVaultKeyStore({ binding: vault.binding, store: newStore() });

      const signatures = await keystore.batchSign!([key.id, key.id], [message, other]);

      expect(vault.requests.map((request) => request.kind)).toEqual(["sign", "sign"]);
      expect(await keystore.verify(key.id, other, signatures[1]!)).toBe(true);
    });

    it("validates the whole batch before asking the vault for anything", async () => {
      const vault = createFakeVault({ batch: true });
      const key = vault.addFalconKey("seed-1/0");
      const keystore = createSeedVaultKeyStore({ binding: vault.binding, store: newStore() });

      await expect(keystore.batchSign!([key.id], [message, other])).rejects.toBeInstanceOf(
        InvalidKeyDataError,
      );
      await expect(
        keystore.batchSign!([key.id, "missing"], [message, other]),
      ).rejects.toBeInstanceOf(KeyNotFoundError);
      expect(vault.requests).toHaveLength(0);
    });

    it("throws a typed error when the batch is declined", async () => {
      const vault = createFakeVault({ batch: true });
      const key = vault.addFalconKey("seed-1/0");
      vault.declining = true;
      const keystore = createSeedVaultKeyStore({ binding: vault.binding, store: newStore() });

      await expect(keystore.batchSign!([key.id, key.id], [message, other])).rejects.toBeInstanceOf(
        SeedVaultRejectedError,
      );
    });
  });

  describe("export", () => {
    it("releases public metadata only", async () => {
      const vault = createFakeVault();
      const key = vault.addFalconKey("seed-1/0");
      const store = newStore();
      const keystore = createSeedVaultKeyStore({ binding: vault.binding, store });

      const exported = await keystore.export(key.id);

      expect(exported).toEqual(store.state.keys[0]);
      expect(exported.privateKey).toBeUndefined();
    });
  });

  describe("remove", () => {
    it("revokes the key through the binding and drops its record", async () => {
      const vault = createFakeVault({ remove: true });
      const key = vault.addFalconKey("seed-1/0");
      const store = newStore();
      const keystore = createSeedVaultKeyStore({ binding: vault.binding, store });

      await keystore.remove(key.id);

      expect(store.state.keys).toEqual([]);
      await keystore.refresh();
      expect(store.state.keys).toEqual([]);
    });

    it("is unsupported when the binding cannot revoke", async () => {
      const vault = createFakeVault();
      const key = vault.addFalconKey("seed-1/0");
      const store = newStore();
      const keystore = createSeedVaultKeyStore({ binding: vault.binding, store });

      await expect(keystore.remove(key.id)).rejects.toBeInstanceOf(SeedVaultUnsupportedError);
      expect(store.state.keys).toHaveLength(1);
    });
  });

  describe("unsupported operations", () => {
    it("refuses to create or import keys and offers no seed operations", async () => {
      const keystore = createSeedVaultKeyStore({
        binding: createFakeVault().binding,
        store: newStore(),
      });

      await expect(
        keystore.generate({
          type: "falcon-1024",
          algorithm: "Falcon-1024",
          extractable: false,
          keyUsages: ["sign", "verify"],
        }),
      ).rejects.toBeInstanceOf(SeedVaultUnsupportedError);
      await expect(keystore.import(new Uint8Array(32))).rejects.toBeInstanceOf(
        SeedVaultUnsupportedError,
      );
      expect(keystore.importSeed).toBeUndefined();
      expect(keystore.deriveFromSeed).toBeUndefined();
      expect(keystore.clear).toBeUndefined();
      expect(keystore.secrets).toBeUndefined();
    });
  });

  describe("hooks", () => {
    it("intercepts operations under the core engine's operation ids", async () => {
      const vault = createFakeVault({ batch: true });
      const key = vault.addFalconKey("seed-1/0");
      const hooks = new Hook.Collection<any>();
      const keystore = createSeedVaultKeyStore({
        binding: vault.binding,
        store: newStore(),
        hooks,
      });
      const before = vi.fn();
      const beforeBatch = vi.fn();
      hooks.before("sign", before);
      hooks.before("batchSign", beforeBatch);

      await keystore.sign(key.id, message);
      await keystore.batchSign!([key.id, key.id], [message, other]);

      expect(keystore.hooks).toBe(hooks);
      expect(before).toHaveBeenCalledTimes(1);
      expect(before.mock.calls[0]?.[0]).toEqual({ args: [key.id, message] });
      expect(beforeBatch).toHaveBeenCalledTimes(1);
    });

    it("lets a before hook block a signature before the vault is asked", async () => {
      const vault = createFakeVault();
      const key = vault.addFalconKey("seed-1/0");
      const hooks = new Hook.Collection<any>();
      const keystore = createSeedVaultKeyStore({
        binding: vault.binding,
        store: newStore(),
        hooks,
      });
      hooks.before("sign", () => {
        throw new Error("blocked by policy");
      });

      await expect(keystore.sign(key.id, message)).rejects.toThrow("blocked by policy");
      expect(vault.requests).toHaveLength(0);
    });
  });
});
