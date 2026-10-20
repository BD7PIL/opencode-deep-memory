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
  // `tool` comes from src/shared/tool.ts; its only runtime dependency is zod,
  // which is bundled here so a directory install needs no node_modules at all.
  noExternal: ["zod"],
  banner: {
    js: "/* opencode-deep-memory — zero runtime dependencies */",
  },
});
