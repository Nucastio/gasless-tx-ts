import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // Live network tests share a pool wallet; running them in parallel would
    // make them fight over the same UTxOs.
    fileParallelism: false,
  },
});
