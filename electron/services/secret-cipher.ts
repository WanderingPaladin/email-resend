import { safeStorage } from 'electron';
import type { SecretCipher } from './config.service';

/**
 * Electron safeStorage uses DPAPI on Windows, Keychain on macOS and libsecret/kwallet on Linux.
 * Ciphertext is stored base64-encoded in electron-store.
 */
export const safeStorageCipher: SecretCipher = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
  decrypt: (encrypted) => safeStorage.decryptString(Buffer.from(encrypted, 'base64')),
};
