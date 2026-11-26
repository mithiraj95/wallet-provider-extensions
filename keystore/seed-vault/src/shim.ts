import {
  InvalidKeyDataError,
  MaterialAccessError,
  type SubtleShim,
  tagShim,
} from "@algorandfoundation/keystore-core";

import { SEED_VAULT_ALGORITHM } from "./constants.ts";
import { SeedVaultRejectedError } from "./errors.ts";
import type { SeedVaultBinding, SeedVaultIntent, SeedVaultParams } from "./types.ts";

/** Resolves the string name of an {@link AlgorithmIdentifier}. */
function algorithmName(algorithm: AlgorithmIdentifier): string {
  return typeof algorithm === "string" ? algorithm : algorithm.name;
}

/** Normalises any {@link BufferSource} into a `Uint8Array` view. */
function toBytes(data: BufferSource): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** Copies a `Uint8Array` into a standalone `ArrayBuffer`. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/**
 * Wraps a host {@link SubtleCrypto} so that `overrides` take precedence while
 * every other member delegates to the host (preserving `this` binding).
 */
function extendSubtle(host: SubtleCrypto, overrides: Partial<SubtleCrypto>): SubtleCrypto {
  return new Proxy(host, {
    get(target: SubtleCrypto, property: string | symbol): unknown {
      if (Object.prototype.hasOwnProperty.call(overrides, property)) {
        return (overrides as Record<string | symbol, unknown>)[property];
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as SubtleCrypto;
}

/**
 * Extends a host {@link SubtleCrypto} with signing through an external Seed
 * Vault, delegating every other algorithm to the host untouched.
 *
 * The decorator adds responsibility for the `"SeedVault"` algorithm to `sign`.
 * It differs from the material-injecting shims in one way: nothing secret is
 * passed through the algorithm parameters. {@link SeedVaultParams.id} is a
 * locator, and the injected binding asks the vault to sign with the key it
 * names, so private material never enters JavaScript. The `key` argument is an
 * opaque metadata handle (see `createKeyHandle` in the keystore core).
 *
 * The vault only signs. `verify` is not handled here: verify with the key's own
 * algorithm (`"Falcon-1024"` through its shim, `"Ed25519"` through the host)
 * and its public key. `generateKey`, `importKey` and `exportKey` throw
 * `MaterialAccessError` for `"SeedVault"`: keys are created and kept inside
 * the vault.
 *
 * It neither reads globals nor mutates the host, so it composes with other
 * decorators and works with any `SubtleCrypto`, with or without a keystore.
 *
 * @param host - The Subtle implementation to extend (e.g. `crypto.subtle`).
 * @param binding - The vault integration that performs the signing.
 * @returns A new `SubtleCrypto` that also understands `"SeedVault"`.
 *
 * @example
 * ```typescript
 * import { createKeyHandle } from "@algorandfoundation/keystore-core";
 *
 * const subtle = withSubtleSeedVault(crypto.subtle, binding);
 * const handle = createKeyHandle("private", { name: "SeedVault" }, false, ["sign"]);
 * const signature = await subtle.sign({ name: "SeedVault", id: "seed-1/0" }, handle, message);
 * ```
 */
export function withSubtleSeedVault(host: SubtleCrypto, binding: SeedVaultBinding): SubtleCrypto {
  const refuse = (operation: string): never => {
    throw new MaterialAccessError(
      `Seed Vault key material is created and kept inside the vault; ${operation} is not supported`,
    );
  };

  const generateKey = async (
    algo: AlgorithmIdentifier,
    extractable: boolean,
    keyUsages: KeyUsage[],
  ): Promise<CryptoKeyPair | CryptoKey> => {
    if (algorithmName(algo) !== SEED_VAULT_ALGORITHM) {
      return host.generateKey(algo as AlgorithmIdentifier, extractable as boolean, keyUsages);
    }
    return refuse("generateKey");
  };

  const importKey = async (
    format: KeyFormat,
    keyData: BufferSource | JsonWebKey,
    algo: AlgorithmIdentifier,
    extractable: boolean,
    keyUsages: KeyUsage[],
  ): Promise<CryptoKey> => {
    if (algorithmName(algo) !== SEED_VAULT_ALGORITHM) {
      return host.importKey(
        format as "raw",
        keyData as BufferSource,
        algo as AlgorithmIdentifier,
        extractable,
        keyUsages,
      );
    }
    return refuse("importKey");
  };

  const exportKey = async (
    format: KeyFormat,
    key: CryptoKey,
  ): Promise<ArrayBuffer | JsonWebKey> => {
    if (key.algorithm.name !== SEED_VAULT_ALGORITHM) {
      return host.exportKey(format as "raw", key);
    }
    return refuse("exportKey");
  };

  const sign = async (
    algo: AlgorithmIdentifier,
    key: CryptoKey,
    data: BufferSource,
  ): Promise<ArrayBuffer> => {
    if (algorithmName(algo) !== SEED_VAULT_ALGORITHM) {
      return host.sign(algo, key, data);
    }
    const { id, intent } = algo as unknown as Partial<SeedVaultParams>;
    if (typeof id !== "string" || id.length === 0) {
      throw new InvalidKeyDataError(
        'algorithm parameter "id" is required and must name the vault key to sign with',
      );
    }
    const requested: SeedVaultIntent = intent ?? "bytes";
    const signature = await binding.sign({ id, data: toBytes(data), intent: requested });
    if (signature === null || signature === undefined) {
      throw new SeedVaultRejectedError(id);
    }
    return toArrayBuffer(signature);
  };

  return extendSubtle(host, {
    generateKey,
    importKey,
    exportKey,
    sign,
  } as unknown as Partial<SubtleCrypto>);
}

/**
 * Builds the Seed Vault decorator as a tagged, composable {@link SubtleShim}
 * with its binding applied, ready to be layered over a host or placed in a
 * keystore's `shims` array.
 *
 * @param binding - The vault integration that performs the signing.
 * @returns A {@link SubtleShim} carrying `algorithm: "SeedVault"`.
 *
 * @example
 * ```typescript
 * const shim = createSeedVaultShim(binding);
 * shim.algorithm; // "SeedVault"
 * const subtle = shim(crypto.subtle);
 * ```
 */
export function createSeedVaultShim(binding: SeedVaultBinding): SubtleShim {
  return tagShim(SEED_VAULT_ALGORITHM, (host) => withSubtleSeedVault(host, binding));
}
