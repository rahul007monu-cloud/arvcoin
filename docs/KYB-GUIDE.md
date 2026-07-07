# Transak KYB — Step-by-Step Guide (arvcoin)

Yeh guide tab use karo jab **test key se sab ready** ho jaye aur tumhe **live (real paisa)**
jaana ho. KYB = Know Your Business (business verification).

> ⏱️ Test/staging key ke liye KYB **nahi** chahiye. KYB sirf **production** (real money) ke liye.

---

## 🟢 Phase 0 — Test key se shuru (abhi, no KYB)
1. https://transak.com → **"Get started" / Partner** pe signup
2. Partner dashboard → **API key (STAGING)** copy karo
3. Key daalo:
   - Website: `website/transak.js` → `CONFIG.apiKey`
   - App: `mobile/src/transak.ts` → `TRANSAK_CONFIG.apiKey`
   - `environment` = `"STAGING"` rakho
4. Ab app me test payment se pura flow chalega (real paisa nahi)

---

## 🟡 Phase 1 — Business ready karo (KYB se pehle)
Yeh documents ready rakho:
1. **Business registration** — Proprietorship / Pvt Ltd / LLP
   - (Naye ho to proprietorship sabse fast: GST + Udyam/MSME se ho jaata hai)
2. **PAN** — business ka (proprietorship me personal PAN chal jaata hai)
3. **Current/business bank account**
4. **Owner ID** — Aadhaar + PAN
5. **Website/app** — arvcoin.com live ho (KYB me link maangte hain)
6. **Use-case note** — 1 line: *"Micro-investment app; users Transak widget se crypto khareedte/bechte hain."*

---

## 🟠 Phase 2 — KYB submit (Transak dashboard)
1. Transak Partner dashboard → **Settings → Compliance / KYB**
2. Business type select karo (Company / Sole proprietor)
3. Upload karo: registration proof, PAN, bank proof, owner ID
4. Website + use-case daalo
5. **Submit** → review shuru (usually kuch business days)

**Review ke dauraan:** Transak team extra info/clarification maang sakti hai — jaldi reply karo, kaam fast hoga.

---

## 🟢 Phase 3 — Production key + go live
1. KYB approve hote hi → dashboard se **PRODUCTION API key** milegi
2. Key replace karo:
   - `website/transak.js` → `CONFIG.apiKey` = production key
   - `website/transak.js` → `CONFIG.environment` = `"PRODUCTION"`
   - Same `mobile/src/transak.ts` me
3. **Partner fee set karo** (tumhari kamai): Dashboard → **Settings → Fee** → percentage (max 5%)
4. Ek test transaction karo (chhoti amount) → confirm sab kaam kar raha hai
5. 🚀 **Live!**

---

## 💸 Kamai (partner fee)
- Transak dashboard me **partner fee (up to 5%)** set karo
- Har buy/sell pe **automatically** milega tumhe
- Alag referral link ki zaroorat nahi — API key se built-in

---

## ⚖️ Legal checklist (peace of mind)
- ✅ Transak FIU-registered hai → crypto compliance unki
- ✅ Tumhe apni crypto license **nahi** chahiye
- ✅ Bas: business register + GST/income tax (normal)
- 🚫 **Kabhi bhi users ka paisa/crypto khud mat rakhna** — sab Transak ke through

---

## 🆘 Common issues
| Problem | Fix |
|---------|-----|
| KYB delay | Docs complete + clear use-case do; reply fast |
| No registered business | Proprietorship register karo (sabse fast) |
| Website live nahi | Pehle arvcoin.com pe site deploy karo (Hostinger/Pages) |
| Wallet address chahiye | Embedded wallet (WaaS) integrate karo — crypto kahan aayega |

---

**Ek line:** Test key se abhi bana lo → business register → KYB submit → production key daalo → live. 🎯
