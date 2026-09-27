import { safeStorage } from 'electron';
import type { SecretCipher } from './config.service';

/**
 * Electron safeStorage uses DPAPI on Windows, Keychain on macOS and libsecret/kwallet on Linux.
 * On Linux without a keyring Electron falls back to a hard-coded key ("basic_text"), which is
 * obfuscation rather than encryption, so we treat that as unavailable.
 * Ciphertext is stored base64-encoded in electron-store.
 */
export const safeStorageCipher: SecretCipher = {
  isAvailable: () =>
    safeStorage.isEncryptionAvailable() &&
    !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text'),
  encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
  decrypt: (encrypted) => safeStorage.decryptString(Buffer.from(encrypted, 'base64')),
};
