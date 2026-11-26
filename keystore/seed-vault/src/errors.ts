import { KeyStoreError } from "@algorandfoundation/keystore-core";

/**
 * Error thrown when the vault cannot be reached or queried: it is not
 * installed, the app is not authorized, or the binding failed to list keys.
 *
 * @example
 * ```typescript
 * try {
 *   await keystore.ready;
 * } catch (error) {
 *   if (error instanceof SeedVaultUnavailableError) showInstallPrompt();
 * }
 * ```
 */
export class SeedVaultUnavailableError extends KeyStoreError {
  /**
   * @param reason - A description of why the vault is unavailable.
   * @param cause - The underlying error raised by the binding, if any.
   */
  constructor(reason: string, cause?: Error) {
    super(`Seed Vault unavailable: ${reason}`, "SeedVaultUnavailableError", cause);
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, SeedVaultUnavailableError);
    }
  }
}

/**
 * Error thrown when the vault did not produce a signature: the user declined
 * the request, or the request was dismissed or superseded.
 *
 * A binding either throws this error itself or resolves `null`/`undefined`,
 * which the shim converts into this error.
 *
 * @example
 * ```typescript
 * try {
 *   await keystore.sign(id, data);
 * } catch (error) {
 *   if (error instanceof SeedVaultRejectedError) return; // the user said no
 *   throw error;
 * }
 * ```
 */
export class SeedVaultRejectedError extends KeyStoreError {
  /**
   * @param keyId - The ID of the key the request was made for.
   * @param cause - The underlying error raised by the binding, if any.
   */
  constructor(keyId: string, cause?: Error) {
    super(`Seed Vault request was not approved for key: ${keyId}`, "SeedVaultRejectedError", cause);
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, SeedVaultRejectedError);
    }
  }
}

/**
 * Error thrown for a keystore operation the vault does not offer. Keys are
 * created, imported and derived inside the vault, never through the keystore.
 *
 * @example
 * ```typescript
 * await keystore.generate(options); // rejects with SeedVaultUnsupportedError
 * ```
 */
export class SeedVaultUnsupportedError extends KeyStoreError {
  /**
   * @param operation - The name of the unsupported operation (e.g. `"generate"`).
   * @param cause - The underlying error that caused this error, if any.
   */
  constructor(operation: string, cause?: Error) {
    super(
      `Seed Vault keystore does not support "${operation}": keys are created and held by the vault`,
      "SeedVaultUnsupportedError",
      cause,
    );
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, SeedVaultUnsupportedError);
    }
  }
}
