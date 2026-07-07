import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { fileURLToPath, URL } from "node:url";

// Web3Auth ko ek single IIFE file (wallet-bundle.js) me bundle karta hai.
//
// FIX (Google login hang): default node polyfill ka `process` shim me
// `nextTick` MISSING hota hai -> "e0.nextTick is not a function" -> wallet crash.
// Isliye process ko poori real library (process/browser, jisme nextTick hai) se
// alias kar rahe hain. Banner ek extra safety hai (globalThis.process.nextTick).

var PROCESS_BANNER =
  "(function(){var g=typeof globalThis!=='undefined'?globalThis:this;" +
  "if(!g.process){g.process={};}" +
  "if(!g.process.env){g.process.env={};}" +
  "if(typeof g.process.nextTick!=='function'){g.process.nextTick=function(cb){" +
  "var a=Array.prototype.slice.call(arguments,1);" +
  "Promise.resolve().then(function(){cb.apply(null,a);});};}" +
  "if(typeof g.global==='undefined'){g.global=g;}})();";

export default defineConfig({
  // process ko poori library se replace karo (nextTick ke saath)
  resolve: {
    alias: {
      process: "process/browser"
    }
  },
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
    emptyOutDir: false, // baaki site files delete na ho
    rollupOptions: {
      output: {
        banner: PROCESS_BANNER
      }
    }
  }
});
