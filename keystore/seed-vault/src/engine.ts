import {
  createFalconBinding,
  createKeyHandle,
  type ExportOptions,
  FALCON_ALGORITHM,
  type GenerateOptions,
  InvalidKeyDataError,
  type Key,
  type KeyData,
  type KeyFormat,
  type KeyId,
  KeyNotFoundError,
  KeyStoreError,
  type SubtleShim,
  tagShim,
  withSubtleFalcon1024,
} from "@algorandfoundation/keystore-core";

import { SEED_VAULT_ALGORITHM } from "./constants.ts";
import {
  SeedVaultRejectedError,
  SeedVaultUnavailableError,
  SeedVaultUnsupportedError,
} from "./errors.ts";
import { withSubtleSeedVault } from "./shim.ts";
import { getKey, hydrateKeys, removeKey, setStatus } from "./store.ts";
import type {
  CreateSeedVaultKeyStoreOptions,
  SeedVaultContext,
  SeedVaultIntent,
  SeedVaultKeyStore,
} from "./types.ts";

/**
 * Casts a `Uint8Array` to the strict `BufferSource` overload WebCrypto expects.
 */
function bs(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}

/**
 * Builds the default verification shims: Falcon-1024 through the optional
 * `falcon-1024` peer dependency, left out when it is not installed.
 */
async function createDefaultVerifyShims(): Promise<SubtleShim[]> {
  const falcon = await createFalconBinding();
  return falcon ? [tagShim(FALCON_ALGORITHM, (host) => withSubtleFalcon1024(host, falcon))] : [];
}

/**
 * Creates a keystore whose keys live in an external Seed Vault.
 *
 * It fulfils the `KeyStoreAPI` without a storage driver: there is no material
 * to seal, no master key and no local unlock prompt. The reactive `store`
 * mirrors the public metadata of the keys the vault authorized, `sign` and
 * `batchSign` are delegated to the vault through the
 * {@link withSubtleSeedVault} shim, and `verify` runs locally against the
 * public key. Records are pure keys: they carry no address or other data of a
 * domain built on top of them.
 *
 * | Operation | Behaviour |
 * |---|---|
 * | `ready` | Lists the vault's keys and hydrates the store |
 * | `refresh` | Lists them again |
 * | `sign` / `batchSign` | Performed by the vault |
 * | `verify` | Local, with the key's own algorithm; no vault request |
 * | `export` | Public metadata only |
 * | `remove` | Through the binding's `remove`, otherwise unsupported |
 * | `generate` / `import` | Unsupported: keys are created inside the vault |
 *
 * @param options - {@link CreateSeedVaultKeyStoreOptions}.
 * @returns A {@link SeedVaultKeyStore}.
 * @throws {SeedVaultUnavailableError} From `ready`, `refresh` and every
 *   operation, when the vault's keys cannot be listed.
 *
 * @example
 * ```typescript
 * import { Store } from "@tanstack/store";
 *
 * const store = new Store({ keys: [], status: "idle" });
 * const keystore = createSeedVaultKeyStore({ binding, store });
 * await keystore.ready;
 * const [key] = store.state.keys;
 * const signature = await keystore.sign(key.id, new TextEncoder().encode("hi"));
 * const ok = await keystore.verify(key.id, new TextEncoder().encode("hi"), signature);
 * ```
 */
export function createSeedVaultKeyStore(
  options: CreateSeedVaultKeyStoreOptions,
): SeedVaultKeyStore {
  const { binding, store } = options;
  const host = options.subtle ?? globalThis.crypto.subtle;

  // The verification shims may load an optional library lazily, so layering is
  // async. Every operation awaits it (through `loading`) before using `subtle`.
  let subtle = host;
  const layered = (async (): Promise<void> => {
    const shimsOption = options.shims;
    const shims =
      shimsOption === undefined
        ? await createDefaultVerifyShims()
        : typeof shimsOption === "function"
          ? await shimsOption()
          : shimsOption;
    for (const shim of shims) subtle = shim(subtle);
    subtle = withSubtleSeedVault(subtle, binding);
  })();

  const load = async (): Promise<void> => {
    await layered;
    let keys;
    try {
      keys = await binding.keys();
    } catch (error) {
      setStatus({ store, status: "unavailable" });
      if (error instanceof KeyStoreError) throw error;
      throw new SeedVaultUnavailableError(
        error instanceof Error ? error.message : String(error),
        error instanceof Error ? error : undefined,
      );
    }
    hydrateKeys({ store, keys });
  };

  // The latest load. Operations await it, so a `refresh` after a failed first
  // load recovers the keystore while `ready` keeps describing the first one.
  let loading = load();
  const ready = loading;
  // The caller decides whether to await `ready`; an unobserved failure must not
  // surface as an unhandled rejection (the status reports it instead).
  ready.catch(() => undefined);

  const requireKey = (id: KeyId): Key => {
    const key = getKey({ store, id });
    if (!key) throw new KeyNotFoundError(id);
    return key;
  };

  const signWithVault = async (
    id: KeyId,
    data: Uint8Array,
    intent: SeedVaultIntent,
  ): Promise<Uint8Array> => {
    const handle = createKeyHandle("private", { name: SEED_VAULT_ALGORITHM }, false, ["sign"]);
    const signature = await subtle.sign(
      { name: SEED_VAULT_ALGORITHM, id, intent } as unknown as AlgorithmIdentifier,
      handle,
      bs(data),
    );
    return new Uint8Array(signature);
  };

  const api: SeedVaultKeyStore = {
    ready,

    refresh(): Promise<void> {
      loading = load();
      return loading;
    },

    async generate(_options: GenerateOptions): Promise<KeyId> {
      throw new SeedVaultUnsupportedError("generate");
    },

    async import(
      _data: (Omit<KeyData, "id"> & { id?: KeyId }) | Uint8Array | string,
      _format?: KeyFormat,
    ): Promise<KeyId> {
      throw new SeedVaultUnsupportedError("import");
    },

    async export(id: KeyId, _options?: ExportOptions): Promise<KeyData> {
      await loading;
      return { ...requireKey(id) } as KeyData;
    },

    async remove(id: KeyId): Promise<void> {
      await loading;
      const key = requireKey(id);
      if (!binding.remove) throw new SeedVaultUnsupportedError("remove");
      setStatus({ store, status: "removing" });
      try {
        await binding.remove(key.id);
        removeKey({ store, id: key.id });
      } finally {
        setStatus({ store, status: "idle" });
      }
    },

    async sign(
      id: KeyId,
      data: Uint8Array,
      _algorithm?: string,
      ctx?: SeedVaultContext,
    ): Promise<Uint8Array> {
      await loading;
      const key = requireKey(id);
      setStatus({ store, status: "signing" });
      try {
        return await signWithVault(key.id, data, ctx?.intent ?? "bytes");
      } finally {
        setStatus({ store, status: "idle" });
      }
    },

    async verify(
      id: KeyId,
      data: Uint8Array,
      signature: Uint8Array,
      _algorithm?: string,
    ): Promise<boolean> {
      await loading;
      const key = requireKey(id);
      if (!key.publicKey) throw new InvalidKeyDataError("missing public key for verify");
      setStatus({ store, status: "verifying" });
      try {
        if (key.type === "falcon-1024") {
          const handle = createKeyHandle("public", { name: FALCON_ALGORITHM }, true, ["verify"]);
          return await subtle.verify(
            { name: FALCON_ALGORITHM, publicKey: key.publicKey } as unknown as AlgorithmIdentifier,
            handle,
            bs(signature),
            bs(data),
          );
        }
        const publicKey = await host.importKey(
          "raw",
          bs(key.publicKey),
          { name: "Ed25519" },
          true,
          ["verify"],
        );
        return await host.verify({ name: "Ed25519" }, publicKey, bs(signature), bs(data));
      } finally {
        setStatus({ store, status: "idle" });
      }
    },

    async batchSign(
      ids: KeyId[],
      data: Uint8Array[],
      ctx?: SeedVaultContext,
    ): Promise<Uint8Array[]> {
      if (ids.length !== data.length) {
        throw new InvalidKeyDataError("batchSign requires exactly one data item per key id");
      }
      await loading;
      // A vault approval covers one key, so group the items by key (keeping
      // each item's position) and resolve every key before asking for anything.
      const groups = new Map<KeyId, number[]>();
      ids.forEach((id, position) => {
        const key = requireKey(id);
        groups.set(key.id, [...(groups.get(key.id) ?? []), position]);
      });
      const intent = ctx?.intent ?? "bytes";
      const signatures: Uint8Array[] = Array.from({ length: ids.length });
      setStatus({ store, status: "signing" });
      try {
        for (const [id, positions] of groups) {
          if (!binding.signBatch || positions.length === 1) {
            for (const position of positions) {
              signatures[position] = await signWithVault(id, data[position] as Uint8Array, intent);
            }
            continue;
          }
          const size = binding.maxBatchSize ?? positions.length;
          if (!Number.isInteger(size) || size < 1) {
            throw new InvalidKeyDataError("the binding's maxBatchSize must be a positive integer");
          }
          for (let start = 0; start < positions.length; start += size) {
            const chunk = positions.slice(start, start + size);
            const signed = await binding.signBatch({
              id,
              data: chunk.map((position) => data[position] as Uint8Array),
              intent,
            });
            if (!signed || signed.length !== chunk.length || signed.some((s) => !s)) {
              throw new SeedVaultRejectedError(id);
            }
            chunk.forEach((position, index) => {
              signatures[position] = Uint8Array.from(signed[index] as Uint8Array);
            });
          }
        }
        return signatures;
      } finally {
        setStatus({ store, status: "idle" });
      }
    },
  };

  // No hooks requested: return the bare keystore.
  if (!options.hooks) return api;

  // Hooks were bound at creation. Wrap each operation so `before`/`after`/
  // `error` hooks can intercept it, and expose the collection as
  // `keystore.hooks`. The operation ids match the core engine's.
  const hooks = options.hooks;
  const run = hooks as unknown as (
    name: string,
    method: () => Promise<unknown>,
    opts: Record<string, unknown>,
  ) => Promise<unknown>;

  const intercept =
    <A extends unknown[], R>(name: string, method: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> =>
      run(name, () => method.apply(api, args), { args }) as Promise<R>;

  const wrapped: SeedVaultKeyStore = { ...api, hooks };
  wrapped.refresh = intercept("refresh", api.refresh.bind(api));
  wrapped.generate = intercept("generate", api.generate.bind(api));
  wrapped.import = intercept("import", api.import.bind(api));
  wrapped.export = intercept("export", api.export.bind(api));
  wrapped.remove = intercept("remove", api.remove.bind(api));
  wrapped.sign = intercept("sign", api.sign.bind(api));
  wrapped.verify = intercept("verify", api.verify.bind(api));
  wrapped.batchSign = intercept("batchSign", api.batchSign!.bind(api));

  return wrapped;
}
