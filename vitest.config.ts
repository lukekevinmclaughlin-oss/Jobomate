import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      // electron/llm-connection.ts imports electron APIs (app, safeStorage, shell);
      // unit tests run in plain node, so map "electron" to a small stub.
      electron: path.resolve(__dirname, "tests/stubs/electron.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 20000,
  },
});
