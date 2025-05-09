import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import typescript from "@rollup/plugin-typescript";
import pkg from "./package.json";
import json from "@rollup/plugin-json";

export default [
  // browser-friendly UMD build
  {
    input: "src/client.ts",
    output: [
      { file: 'dist/browser/gaslessClient.mjs', format: 'es',  sourcemap: true },
    ],
    plugins: [
      resolve({ browser: true }), //
      commonjs(),
      json(),
      typescript({ tsconfig: "./tsconfig.json" }),
    ],
    external: ["express"],
  },

  // CommonJS (for Node) and ES module (for bundlers) build.
  {
    input: "src/index.ts",
    output: [
      { file: pkg.main, format: "cjs", sourcemap: true },
      { file: pkg.module, format: "es", sourcemap: true },
    ],
    plugins: [typescript({ tsconfig: "./tsconfig.json" })],
  },
];
