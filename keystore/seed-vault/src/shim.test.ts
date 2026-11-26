import {
  createKeyHandle,
  InvalidKeyDataError,
  MaterialAccessError,
  withSubtleFalcon1024,
} from "@algorandfoundation/keystore-core";
import * as falcon from "falcon-1024";
import { describe, expect, it } from "vitest";

import { createFakeVault } from "./__fixtures__.ts";
import { SEED_VAULT_ALGORITHM } from "./constants.ts";
import { SeedVaultRejectedError } from "./errors.ts";
import { createSeedVaultShim, withSubtleSeedVault } from "./shim.ts";
import type { SeedVaultParams } from "./types.ts";

const host: SubtleCrypto = crypto.subtle;
const message = new TextEncoder().encode("the quick brown fox");

const params = (fields: Omit<SeedVaultParams, "name">): AlgorithmIdentifier =>
  ({ name: SEED_VAULT_ALGORITHM, ...fields }) as unknown as AlgorithmIdentifier;

const handle = (): CryptoKey =>
  createKeyHandle("private", { name: SEED_VAULT_ALGORITHM }, false, ["sign"]);

describe("withSubtleSeedVault", () => {
  it("signs through the vault, standalone with any SubtleCrypto", async () => {
    const vault = createFakeVault();
    const key = vault.addFalconKey("seed-1/0");
    const subtle = withSubtleSeedVault(host, vault.binding);

    const signature = new Uint8Array(await subtle.sign(params({ id: key.id }), handle(), message));

    expect(vault.requests).toEqual([
      { kind: "sign", id: "seed-1/0", data: message, intent: "bytes" },
    ]);
    expect(falcon.verifyCompressed(key.publicKey, signature, message)).toBe(true);
  });

  it("passes the intent of the payload to the vault", async () => {
    const vault = createFakeVault();
    const key = vault.addFalconKey("seed-1/0");
    const subtle = withSubtleSeedVault(host, vault.binding);

    await subtle.sign(params({ id: key.id, intent: "transaction" }), handle(), message);

    expect(vault.requests[0]?.intent).toBe("transaction");
  });

  it("requires the id of the vault key", async () => {
    const vault = createFakeVault();
    const subtle = withSubtleSeedVault(host, vault.binding);

    await expect(subtle.sign(SEED_VAULT_ALGORITHM, handle(), message)).rejects.toBeInstanceOf(
      InvalidKeyDataError,
    );
    expect(vault.requests).toHaveLength(0);
  });

  it("turns a declined request into a typed error", async () => {
    const vault = createFakeVault();
    const key = vault.addFalconKey("seed-1/0");
    vault.declining = true;
    const subtle = withSubtleSeedVault(host, vault.binding);

    await expect(subtle.sign(params({ id: key.id }), handle(), message)).rejects.toBeInstanceOf(
      SeedVaultRejectedError,
    );
  });

  it("never moves key material across the Subtle surface", async () => {
    const subtle = withSubtleSeedVault(host, createFakeVault().binding);

    await expect(subtle.generateKey(SEED_VAULT_ALGORITHM, false, ["sign"])).rejects.toBeInstanceOf(
      MaterialAccessError,
    );
    await expect(
      subtle.importKey("raw", new Uint8Array(32), SEED_VAULT_ALGORITHM, false, ["sign"]),
    ).rejects.toBeInstanceOf(MaterialAccessError);
    await expect(subtle.exportKey("raw", handle())).rejects.toBeInstanceOf(MaterialAccessError);
  });

  it("delegates every other algorithm to the host", async () => {
    const vault = createFakeVault();
    const subtle = withSubtleSeedVault(host, vault.binding);

    const pair = (await subtle.generateKey({ name: "Ed25519" }, false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const signature = await subtle.sign({ name: "Ed25519" }, pair.privateKey, message);

    expect(await subtle.verify({ name: "Ed25519" }, pair.publicKey, signature, message)).toBe(true);
    expect(vault.requests).toHaveLength(0);
  });

  it("composes with other shims", async () => {
    const vault = createFakeVault();
    const key = vault.addFalconKey("seed-1/0");
    const subtle = withSubtleSeedVault(withSubtleFalcon1024(host, falcon), vault.binding);

    const signature = await subtle.sign(params({ id: key.id }), handle(), message);
    const verified = await subtle.verify(
      { name: "Falcon-1024", publicKey: key.publicKey } as unknown as AlgorithmIdentifier,
      createKeyHandle("public", { name: "Falcon-1024" }, true, ["verify"]),
      signature,
      message,
    );

    expect(verified).toBe(true);
  });
});

describe("createSeedVaultShim", () => {
  it("builds a tagged shim with the binding applied", async () => {
    const vault = createFakeVault();
    const key = await vault.addEd25519Key("seed-1/0");
    const shim = createSeedVaultShim(vault.binding);

    expect(shim.algorithm).toBe(SEED_VAULT_ALGORITHM);

    const signature = await shim(host).sign(params({ id: key.id }), handle(), message);
    const publicKey = await host.importKey(
      "raw",
      key.publicKey as BufferSource,
      { name: "Ed25519" },
      true,
      ["verify"],
    );
    expect(await host.verify({ name: "Ed25519" }, publicKey, signature, message)).toBe(true);
  });
});
