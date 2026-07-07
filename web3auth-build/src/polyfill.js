/* Browser polyfill fixes for Web3Auth.
   readable-stream / BasePostMessageStream ko process.nextTick chahiye,
   jo default browser build me missing hota hai -> "nextTick is not a function".
   Ye file SABSE PEHLE import hoti hai (main.js me), taaki connect() se pehle patch lag jaye. */
import process from "process";

var g = typeof globalThis !== "undefined" ? globalThis : (typeof window !== "undefined" ? window : this);

function nextTick(cb) {
  var args = Array.prototype.slice.call(arguments, 1);
  Promise.resolve().then(function () { cb.apply(null, args); });
}

// imported process shim ko patch karo (readable-stream isi instance ko use karta hai)
if (process && typeof process.nextTick !== "function") {
  process.nextTick = nextTick;
}
if (process && typeof process.env === "undefined") {
  process.env = {};
}

// global process bhi ensure karo
if (!g.process) { g.process = process; }
if (g.process && typeof g.process.nextTick !== "function") {
  g.process.nextTick = nextTick;
}
if (typeof g.global === "undefined") { g.global = g; }
