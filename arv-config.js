/* =========================================================
   arvcoin — central config
   Ek jagah se sab control: RA registration, ARV credits, plans, bonus.
   Ye file client pe load hoti hai, isliye yahan koi secret NA rakhna.
   ========================================================= */
(function () {
  "use strict";

  /* ---------------------------------------------------------
     1) RA REGISTRATION  ← calls publish karne ke liye zaroori
     ---------------------------------------------------------
     SEBI (Research Analysts) Regulations, 2014 ke tehat fee lekar
     securities pe recommendation dene ke liye registration chahiye.

     Jab tak `number` khaali hai:
       - admin panel calls publish NAHI karega
       - app education-only mode me chalega

     Do options:
       (a) arvcoin ka khud ka RA number daalo, ya
       (b) partner RA/IA ka number (revenue-share arrangement)

     Har published call pe ye number dikhta hai — SEBI requirement hai,
     Stoxpro/Waya jaise registered apps me bhi aisa hi hota hai.
  --------------------------------------------------------- */
  var RA_REGISTRATION = {
    number: "",                 // e.g. "INH000012345"
    entityName: "",             // registered entity ka naam
    analystName: "",            // principal analyst
    validTill: "",              // "YYYY-MM-DD"
    bseEnlistment: "",          // BSE Administration & Supervision no. (agar hai)
    grievanceEmail: "support@arvcoin.com",
    grievancePhone: "",
    scoresUrl: "https://scores.sebi.gov.in",
    odrUrl: "https://smartodr.in"
  };

  function isRegistered() {
    return !!(RA_REGISTRATION.number && String(RA_REGISTRATION.number).trim().length >= 6);
  }

  /* ---------------------------------------------------------
     2) ARV CREDITS  — closed-loop prepaid credit
     ---------------------------------------------------------
     ⚠️ ARV_INR_RATE ek CONSTANT hai. Isko variable, admin-editable,
     ya market-linked NA banao. 1 ARV = ₹1, hamesha.
     ARV ek investment/asset/token NAHI hai — sirf platform credit hai.
  --------------------------------------------------------- */
  var ARV_INR_RATE = 1;         // 1 ARV = ₹1  (NEVER change to a variable)
  var ARV_SYMBOL = "ARV";

  /* Bonus credits — YE founder-tunable hai. Purchasing power badhao.
     Apni investment se fund karo, jitna chaaho.
     `minInr` se upar khareedne pe `bonusPct` extra ARV milta hai. */
  var BONUS_TIERS = [
    { minInr: 500,   bonusPct: 5,  label: "Starter" },
    { minInr: 1000,  bonusPct: 10, label: "Popular" },
    { minInr: 2500,  bonusPct: 18, label: "Value" },
    { minInr: 5000,  bonusPct: 25, label: "Best value" },
    { minInr: 10000, bonusPct: 35, label: "Max" }
  ];

  /* Promo / referral credits — gifted access */
  var PROMO_CREDITS = {
    signupBonus: 100,           // naya user — free trial credits
    referrerBonus: 200,         // jisne refer kiya
    refereeBonus: 100           // jo join hua
  };

  /* Founder rate lock — early users ka price permanently locked.
     Legal aur real: early buyers ko genuine fayda, bina fake appreciation. */
  var FOUNDER_LOCK = {
    enabled: true,
    maxUsers: 1000,             // pehle N users
    label: "Founder rate — locked forever"
  };

  /* ---------------------------------------------------------
     3) SEGMENTS  — content/calls ke categories
  --------------------------------------------------------- */
  var SEGMENTS = {
    equity:    { id: "equity",    name: "Stocks",      icon: "◈", color: "#7c5cff", regulated: true  },
    options:   { id: "options",   name: "F&O / Options", icon: "◹", color: "#00e0ff", regulated: true  },
    commodity: { id: "commodity", name: "Commodity",   icon: "⛁", color: "#ffb020", regulated: true  },
    currency:  { id: "currency",  name: "Currency",    icon: "⇄", color: "#00ffa3", regulated: true,
                 note: "Sirf INR pairs, Indian exchanges (NSE/BSE/MSE). Offshore forex FEMA ke against hai." },
    crypto:    { id: "crypto",    name: "Crypto",      icon: "₿", color: "#f7931a", regulated: false }
  };

  var SEGMENT_ORDER = ["equity", "options", "commodity", "currency", "crypto"];

  /* ---------------------------------------------------------
     4) PLANS  — price in ARV credits (founder-tunable)
  --------------------------------------------------------- */
  var PLAN_PRICES = {
    basic: {
      id: "basic",
      name: "Basic",
      priceArv: 499,
      durationDays: 30,
      segments: ["equity", "crypto"],
      callsPerMonth: "8-12",
      features: ["Equity research calls", "Crypto insights", "Daily market recap", "Email alerts"]
    },
    pro: {
      id: "pro",
      name: "Pro",
      priceArv: 999,
      durationDays: 30,
      popular: true,
      segments: ["equity", "options", "crypto"],
      callsPerMonth: "20-30",
      features: ["Sab Basic features", "F&O / Options calls", "Live chart analysis", "Push + WhatsApp alerts", "Priority support"]
    },
    elite: {
      id: "elite",
      name: "Elite",
      priceArv: 1999,
      durationDays: 30,
      segments: ["equity", "options", "commodity", "currency", "crypto"],
      callsPerMonth: "40+",
      features: ["Sab Pro features", "Commodity + Currency calls", "Analyst Q&A access", "Portfolio review session", "Early call access"]
    },
    quarterly: {
      id: "quarterly",
      name: "Pro Quarterly",
      priceArv: 2499,
      durationDays: 90,
      segments: ["equity", "options", "crypto"],
      callsPerMonth: "20-30",
      saveLabel: "Save 17%",
      features: ["Pro plan, 3 mahine", "Ek hi baar payment", "Rate locked"]
    }
  };

  var PLAN_ORDER = ["basic", "pro", "elite", "quarterly"];

  /* SEBI fee cap: ₹1,51,000 per year per family (RA regulations).
     Koi plan isse upar na jaaye. */
  var ANNUAL_FEE_CAP_INR = 151000;

  /* ---------------------------------------------------------
     5) PAYMENTS
  --------------------------------------------------------- */
  var PAYMENTS = {
    razorpayKeyId: "",          // rzp_live_... ya rzp_test_...  (public key only)
    currency: "INR",
    // Credits SIRF Cloud Function se mint hote hain, webhook signature
    // verify hone ke baad. Client "success" pe kabhi trust nahi.
    creditFunctionUrl: "",      // e.g. https://asia-south1-arvcoin.cloudfunctions.net/createOrder
    gstPct: 18
  };

  /* ---------------------------------------------------------
     6) MARKET DATA / CHARTS
  --------------------------------------------------------- */
  var MARKET_DATA = {
    // TradingView widgets — free, legal, stocks+F&O+commodity+currency+crypto sab cover
    tradingViewEnabled: true,
    tvDefaultExchange: "NSE",
    // Crypto spot (free)
    coingeckoBase: "https://api.coingecko.com/api/v3",
    // Indian equity/F&O ke liye licensed vendor ya broker API
    // (TrueData / Global Datafeeds / Dhan / Angel One / Upstox / Fyers)
    quotesProxyUrl: ""          // Cloud Function proxy — API key server pe rakho
  };

  /* ---------------------------------------------------------
     7) DISCLOSURES  — har call/content surface pe dikhte hain
  --------------------------------------------------------- */
  var DISCLOSURES = {
    marketRisk: "Investments are subject to market risk. Read all related documents carefully before investing.",
    noGuarantee: "Past performance kisi bhi future result ki guarantee nahi hai. Koi assured ya guaranteed return nahi.",
    educationOnly: "Ye content sirf information aur education ke liye hai. Koi bhi decision lene se pehle apni research karo.",
    notRegistered: "arvcoin abhi SEBI ke saath Research Analyst ya Investment Adviser ke roop me registered NAHI hai. Isliye abhi koi buy/sell recommendation publish nahi hoti — sirf educational content available hai.",
    registeredNote: "Research services SEBI-registered Research Analyst dwara provide ki jaati hain. Registration details har call pe di gayi hain.",
    forexWarning: "Indian residents sirf RBI-approved INR pairs me, recognised exchanges (NSE/BSE/MSE) pe SEBI-registered broker ke through currency derivatives trade kar sakte hain. Offshore/OTC forex platforms FEMA ke against hain — penalty transaction amount ke 3x tak.",
    arvNature: "ARV Coin ek prepaid platform credit hai (1 ARV = ₹1) jo sirf arvcoin subscription ke liye use hota hai. Ye koi investment, asset, security ya cryptocurrency NAHI hai. Iski value badhti nahi, ye transferable ya refundable nahi hai.",
    noPersonalAdvice: "Hum personalised investment advice nahi dete. Recommendations general research hain, kisi individual ki financial situation ke hisaab se nahi."
  };

  /* ---------------------------------------------------------
     8) BRAND / CONTACT
  --------------------------------------------------------- */
  var BRAND = {
    name: "arvcoin",
    domain: "arvcoin.com",
    supportEmail: "support@arvcoin.com",
    whatsappChannel: "",
    telegramChannel: ""
  };

  /* ---------------------------------------------------------
     Helpers
  --------------------------------------------------------- */
  function bonusFor(inr) {
    var pct = 0, tier = null, i;
    for (i = 0; i < BONUS_TIERS.length; i++) {
      if (inr >= BONUS_TIERS[i].minInr && BONUS_TIERS[i].bonusPct > pct) {
        pct = BONUS_TIERS[i].bonusPct;
        tier = BONUS_TIERS[i];
      }
    }
    return { pct: pct, tier: tier };
  }

  /* ₹ -> ARV credits (base + bonus) */
  function creditsFor(inr) {
    var base = Math.floor(inr / ARV_INR_RATE);
    var b = bonusFor(inr);
    var bonus = Math.floor(base * b.pct / 100);
    return { base: base, bonus: bonus, total: base + bonus, bonusPct: b.pct };
  }

  function plan(id) { return PLAN_PRICES[id] || null; }

  function planCovers(planId, segment) {
    var p = plan(planId);
    return !!(p && p.segments.indexOf(segment) > -1);
  }

  function segment(id) { return SEGMENTS[id] || null; }

  window.ARV_CONFIG = {
    RA_REGISTRATION: RA_REGISTRATION,
    isRegistered: isRegistered,
    ARV_INR_RATE: ARV_INR_RATE,
    ARV_SYMBOL: ARV_SYMBOL,
    BONUS_TIERS: BONUS_TIERS,
    PROMO_CREDITS: PROMO_CREDITS,
    FOUNDER_LOCK: FOUNDER_LOCK,
    SEGMENTS: SEGMENTS,
    SEGMENT_ORDER: SEGMENT_ORDER,
    PLAN_PRICES: PLAN_PRICES,
    PLAN_ORDER: PLAN_ORDER,
    ANNUAL_FEE_CAP_INR: ANNUAL_FEE_CAP_INR,
    PAYMENTS: PAYMENTS,
    MARKET_DATA: MARKET_DATA,
    DISCLOSURES: DISCLOSURES,
    BRAND: BRAND,
    bonusFor: bonusFor,
    creditsFor: creditsFor,
    plan: plan,
    planCovers: planCovers,
    segment: segment
  };
})();
