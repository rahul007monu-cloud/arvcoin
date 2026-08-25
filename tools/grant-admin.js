#!/usr/bin/env node
/* =========================================================
   arvcoin — grant analyst/admin access to a user

   Firebase Console me custom claims set karne ka UI nahi hota,
   isliye ye script chahiye. Ek baar chalao, kaam ho gaya.

   ---------------------------------------------------------
   SETUP (ek baar)
   ---------------------------------------------------------
   1) Service account key download karo:
      Firebase Console -> Project settings -> Service accounts
      -> "Generate new private key" -> JSON download hoga

   2) Us file ko is folder me rakho aur naam do:
      serviceAccountKey.json

      ⚠️ Ye file GIT ME KABHI COMMIT NA KARO. .gitignore me
      already added hai.

   3) Dependency install karo:
      cd tools
      npm install firebase-admin

   ---------------------------------------------------------
   CHALAO
   ---------------------------------------------------------
      node grant-admin.js your@email.com

   Ye analyst + admin dono claims set kar dega.

   Sirf analyst (publish kar sakta hai, par access grant nahi):
      node grant-admin.js someone@email.com --analyst-only

   Access hatane ke liye:
      node grant-admin.js someone@email.com --revoke

   Kaun kaun admin hai dekhne ke liye:
      node grant-admin.js --list

   ---------------------------------------------------------
   IMPORTANT: claim set hone ke baad us user ko LOGOUT aur
   dobara LOGIN karna padega — token refresh hone ke liye.
   ========================================================= */

const path = require("path");
const fs = require("fs");

const KEY_PATH = path.join(__dirname, "serviceAccountKey.json");

if (!fs.existsSync(KEY_PATH)) {
  console.error("\n❌ serviceAccountKey.json nahi mili.\n");
  console.error("   Firebase Console -> Project settings -> Service accounts");
  console.error("   -> Generate new private key -> JSON ko yahan rakho:\n");
  console.error("   " + KEY_PATH + "\n");
  process.exit(1);
}

let admin;
try {
  admin = require("firebase-admin");
} catch (e) {
  console.error("\n❌ firebase-admin install nahi hai. Chalao:\n");
  console.error("   cd " + __dirname);
  console.error("   npm install firebase-admin\n");
  process.exit(1);
}

const serviceAccount = require(KEY_PATH);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const args = process.argv.slice(2);
const email = args.find((a) => a.indexOf("@") > -1);
const analystOnly = args.indexOf("--analyst-only") > -1;
const revoke = args.indexOf("--revoke") > -1;
const list = args.indexOf("--list") > -1;

async function listPrivileged() {
  console.log("\nPrivileged users:\n");
  let count = 0;
  let token;
  do {
    const res = await admin.auth().listUsers(1000, token);
    res.users.forEach((u) => {
      const c = u.customClaims || {};
      if (c.admin || c.analyst) {
        const roles = [c.admin && "admin", c.analyst && "analyst"]
          .filter(Boolean).join(" + ");
        console.log("  " + (u.email || u.uid).padEnd(38) + roles);
        count++;
      }
    });
    token = res.pageToken;
  } while (token);

  if (!count) console.log("  (koi nahi — pehle grant karo)");
  console.log("");
}

async function main() {
  if (list) {
    await listPrivileged();
    return;
  }

  if (!email) {
    console.error("\n❌ Email do.\n");
    console.error("   node grant-admin.js your@email.com");
    console.error("   node grant-admin.js your@email.com --analyst-only");
    console.error("   node grant-admin.js your@email.com --revoke");
    console.error("   node grant-admin.js --list\n");
    process.exit(1);
  }

  let user;
  try {
    user = await admin.auth().getUserByEmail(email);
  } catch (e) {
    console.error("\n❌ User nahi mila: " + email);
    console.error("   Pehle website pe signup karo, phir ye script chalao.\n");
    process.exit(1);
  }

  const claims = revoke
    ? { analyst: false, admin: false }
    : (analystOnly ? { analyst: true } : { analyst: true, admin: true });

  await admin.auth().setCustomUserClaims(user.uid, claims);

  console.log("\n✅ Ho gaya\n");
  console.log("   User:   " + email);
  console.log("   UID:    " + user.uid);
  console.log("   Claims: " + JSON.stringify(claims));
  console.log("\n⚠️  Ab us account se LOGOUT karo aur dobara LOGIN karo —");
  console.log("   token refresh hone ke baad hi claim effect me aayega.\n");

  if (!revoke) {
    console.log("   Uske baad kholo:  arvcoin.com/admin.html\n");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\n❌ Error:", e.message, "\n");
    process.exit(1);
  });
