// Minimal electron stub for unit tests (vitest aliases "electron" here).
// Only the surface referenced by electron/llm-connection.ts is provided.
import * as os from "os";

export const app = {
  getPath: () => os.tmpdir(),
  getName: () => "LM_Browser",
  getAppPath: () => process.cwd(),
  whenReady: () => Promise.resolve(),
  on: () => {},
};

export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (value: string) => Buffer.from(value),
  decryptString: (buffer: Buffer) => buffer.toString(),
};

export const shell = {
  openPath: async () => "",
  openExternal: async () => {},
};
