import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Integration tests run against the real local Supabase stack (`supabase start`).
// They are serial and use unique, throwaway users; they never touch hosted services.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
