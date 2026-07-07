import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { fileURLToPath, URL } from "node:url";

// Web3Auth ko ek single IIFE file (wallet-bundle.js) me bundle karke
// seedha /website folder me daal deta hai. node polyfills (Buffer/process/crypto)
// vite-plugin-node-polyfills apne aap handle karta hai.
export default defineConfig({
  plugins: [nodePolyfills()],
  define: { global: "globalThis" },
  build: {
    lib: {
      entry: fileURLToPath(new URL("./src/main.js", import.meta.url)),
      name: "ARVWalletBundle",
      formats: ["iife"],
      fileName: () => "wallet-bundle.js"
    },
    outDir: fileURLToPath(new URL("../website", import.meta.url)),
    emptyOutDir: false // baaki website files delete na ho
  }
});
