import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { fileURLToPath, URL } from "node:url";

// Web3Auth ko ek single IIFE file (wallet-bundle.js) me bundle karke
// seedha /website folder me daal deta hai. node polyfills (Buffer/process/crypto)
// vite-plugin-node-polyfills apne aap handle karta hai.
export default defineConfig({
  // Buffer/global/process sab polyfill karo (Web3Auth ke liye zaroori)
  plugins: [
    nodePolyfills({
      globals: { Buffer: true, global: true, process: true },
      protocolImports: true
    })
  ],
  build: {
    lib: {
      entry: fileURLToPath(new URL("./src/main.js", import.meta.url)),
      name: "ARVWalletBundle",
      formats: ["iife"],
      fileName: () => "wallet-bundle.js"
    },
    outDir: fileURLToPath(new URL("..", import.meta.url)), // repo root (site ab root pe hai)
    emptyOutDir: false // baaki site files delete na ho
  }
});
