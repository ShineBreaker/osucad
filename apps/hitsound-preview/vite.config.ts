/// <reference types='vitest' />
import { defaultClientConditions, defineConfig } from "vite";
import ConditionalCompile from "vite-plugin-conditional-compiler";

export default defineConfig(() => ({
  root: __dirname,
  base: "./",
  cacheDir: "../../node_modules/.vite/apps/hitsound-preview",
  resolve: {
    conditions: [
      ...defaultClientConditions,
      "source",
    ],
  },
  server: {
    port: 4201,
    host: "localhost",
  },
  plugins: [ConditionalCompile()],
  worker: {
    format: "es" as const,
  },
  esbuild: {
    target: "chrome138",
  },
  build: {
    outDir: "./dist",
    emptyOutDir: true,
    reportCompressedSize: true,
    target: "esnext",
    minify: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },
}));
