# Real Web3Auth Wallet — Build Guide (Mac)

Ye guide website pe **asli non-custodial wallet** activate karne ke liye hai.
Ek baar build karna hai; uske baad `wallet-bundle.js` GitHub pe daal do.

> **Kyun build?** Web3Auth ka SDK bundler ke bina static site pe load nahi hota.
> Vite se ise ek single `wallet-bundle.js` me bundle kar dete hain, jo website seedha use karti hai.

---

## Step 0 — Node install hai? (ek baar)

Terminal (Mac: `Cmd + Space` -> "Terminal") me likho:

```bash
node -v
```

- Agar version dikhe (jaise `v20...`) -> ready ho, Step 1 pe jao.
- Agar "command not found" -> Node install karo: https://nodejs.org (LTS version download + install), phir Terminal band karke dobara kholo.

---

## Step 1 — Build folder me jao

Repo apne Mac pe clone/download karo (agar nahi hai), phir:

```bash
cd path/to/arvcoin/web3auth-build
```

(`path/to/arvcoin` ko apne actual folder path se replace karo. Tip: `cd ` likh ke folder ko terminal me drag-drop kar sakte ho.)

---

## Step 2 — Install + Build

```bash
npm install
npm run build
```

- `npm install` = dependencies download (1-2 min, internet chahiye).
- `npm run build` = bundle banata hai.
- Success pe ye file ban jayegi: **`../website/wallet-bundle.js`** (asli Web3Auth code ke saath).

---

## Step 3 — GitHub pe daalo (sabse easy tareeka)

1. Browser me jao: `github.com/rahul007monu-cloud/arvcoin` -> **website** folder
2. **Add file -> Upload files**
3. Apne Mac se `arvcoin/website/wallet-bundle.js` ko **drag-drop** karo (purani placeholder file replace ho jayegi)
4. **Commit changes** dabao

Bas! GitHub Pages / arvcoin.com pe agli load me **real wallet** chalu ho jayega.

---

## Step 4 — Test

1. Live site kholo (best: Incognito window, taaki cache saaf ho)
2. Login/Signup pe **Google** dabao
3. Ab **asli Web3Auth popup** aana chahiye -> Google chuno -> real wallet ban jayega
4. Dashboard me wallet address = asli blockchain address

> Agar koi error aaye -> `F12` -> Console -> error ka text Kiro ko bhej do, fix kar denge.

---

## Zaroori: Domains whitelist (ek baar)

developer.metamask.io -> project `arvtoken` -> **Domains** tab me ye add hone chahiye:
- `https://rahul007monu-cloud.github.io`
- `https://arvcoin.com`

(Warna "origin not whitelisted" error aayega.)
