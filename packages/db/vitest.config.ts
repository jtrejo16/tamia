import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Las pruebas comparten una base real: se ejecutan en serie.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
