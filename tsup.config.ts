import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["@opencode-ai/plugin", "@opencode-ai/sdk"],
  // No noExternal needed: zero runtime deps.
  // tsup will tree-shake and bundle our own src into a single ESM file.
  banner: {
    js: "/* opencode-deep-memory — zero runtime dependencies */",
  },
});
