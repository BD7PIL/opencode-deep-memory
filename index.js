// Directory-plugin entry: opencode v2 resolves a directory target to
// `index.*` / `server.*` and never reads package.json. Package-name installs
// go through `main` (dist/index.js); this file makes the same tree loadable
// when a host points at the directory directly (air-gapped installs).
export { default } from "./dist/index.js";
