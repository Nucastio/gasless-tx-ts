import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    client: "src/client.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  splitting: false,
  target: "node18",
  // tsup strips `node:` prefixes by default; keeping them means the import can
  // never be shadowed by an npm package called `http`.
  removeNodeProtocol: false,
  // Peer-heavy Cardano serialization stays external: bundling it would balloon
  // the tarball and break consumers that already depend on it.
  external: ["@meshsdk/core-cst", "@meshsdk/common"],
});
