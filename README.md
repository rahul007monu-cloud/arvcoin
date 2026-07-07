# arvcoin

**Chhoti UPI payment, bada future.** India ka micro-investment super app (Paytm-style):
UPI/QR se INR pay karo → paisa auto-invest ho jaye **crypto** (BTC/ETH/SOL) ya
**Indian stocks & mutual funds** me — user ki choice pe.

> Yeh ek **mock demo prototype** hai (no API keys needed). Real launch pe
> partner integrations plug-in ho jayenge — code us tarah structured hai.

---

## 📦 Repo structure

```
arvcoin/
├── website/      → Premium 3D-animated landing page (static, Hostinger-ready)
├── mobile/       → Expo React Native app (Android + iOS + web)
└── README.md
```

---

## 🌐 Website (`/website`)

Pure **HTML + CSS + JS** — koi build step nahi. Three.js se 3D coin + particle
background, glassmorphism, scroll animations, live-ish price ticker, phone mockup,
waitlist form (demo, localStorage me save hota hai).

### Locally dekhna
```bash
cd website
# koi bhi static server, ya seedha index.html browser me kholo
python3 -m http.server 8080
# phir kholo: http://localhost:8080
```

### Hostinger pe deploy (arvcoin.com)
1. **hPanel → Files → File Manager** kholo.
2. `arvcoin.com` ke `public_html` folder me jao.
3. **Purani site ka backup pehle lo** (neeche "Data shift" dekho).
4. `website/` folder ke saare files (`index.html`, `styles.css`, `main.js`, `3d.js`)
   `public_html` me upload kar do.
5. Hostinger **free SSL** (https) auto-enable ho jayega. Done ✅

> Note: Website ko internet chahiye (Google Fonts + Three.js CDN). Fully offline
> chahiye to in files ko locally host kar sakte hain — bolna, kar dunga.

---

## 📱 Mobile app (`/mobile`)

**Expo (React Native) + expo-router + TypeScript.** Screens:
`Portfolio dashboard → Pay (UPI/QR) → Choose investment → Review → Success`.
Crypto-first (stocks "coming soon" jab tak broker/smallcase KYC approve na ho).

### Run karna (apne laptop pe)
```bash
cd mobile
npm install
npx expo start
```
- Phone pe **Expo Go** app install karo → terminal me aaye **QR code scan** karo.
- Ya `w` dabao browser me chalane ke liye, `a` Android emulator, `i` iOS simulator.

### Build APK / store ke liye (baad me)
```bash
npm install -g eas-cli
eas build -p android    # APK/AAB
eas build -p ios        # iOS
```

---

## 🔌 Real integrations (Phase 2 — mock hatao, real lagao)

Sab mock functions ek jagah hain, easily swappable:

| Kaam | Abhi (mock) | Real (Phase 2) |
|------|-------------|----------------|
| Payments | `store.invest()` simulate | **Razorpay** order + webhook |
| Crypto buy | mock units calc | **Onramp.money** API → user wallet (ya CoinDCX referral) |
| Stocks/MF | locked "coming soon" | **smallcase Gateway** / broker API (Zerodha/Angel/Upstox) |
| Prices | `mockData.jitterPrice()` | CoinGecko / exchange feeds |

**Files to touch:** `mobile/src/mockData.ts` (data) aur `mobile/src/store.tsx` (`invest`).

---

## 🔁 Purani website ka data shift (Hostinger)

Naya arvcoin site daalne se pehle purana data safe karo:

1. **Backup**: hPanel → *Files → Backups* se poora backup download karo,
   ya File Manager me `public_html` ko select → **Compress** (zip) → download.
2. **Purani site bachani hai?** Ek free **subdomain** bana lo:
   - hPanel → *Domains → Subdomains* → naam `old` → domain `arvcoin.com` → **Create**
   - Purana content `public_html/old` me move kar do → `old.arvcoin.com` pe chalega.
3. **Naya daalo**: `public_html` (root) me arvcoin website upload karo.

> Subdomain + SSL dono **free** hain, same hosting plan me. Zero data loss.

---

## ⚖️ Legal model (short)

Partner licenses use hote hain — apni license baad me:
- **Crypto** → Onramp.money (FIU-registered) / CoinDCX. Non-custodial, seedha user wallet.
- **Stocks/MF** → SEBI-compliant broker/smallcase. Paisa seedha user ke demat me
  (third-party deposit allowed nahi, isliye partner route).
- **Payments** → Razorpay.

*Investments are subject to market risk. Yeh demo preview hai.*
