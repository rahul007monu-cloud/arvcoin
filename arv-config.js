/* =========================================================
   arvcoin — central config

   Ek advisory platform. Website + app.
   Payment website pe NAHI hota — user Telegram/WhatsApp pe
   connect hota hai, wahan pay karta hai, phir access milta hai.

   ⚠️ Ye file client pe load hoti hai — koi secret NA rakhna.
   ========================================================= */
(function () {
  "use strict";

  /* ---------------------------------------------------------
     1) RA REGISTRATION — calls publish karne ka gate
     ---------------------------------------------------------
     SEBI (Research Analysts) Regulations, 2014: fee lekar
     securities pe buy/sell recommendation dene ke liye
     registration zaroori hai.

     ⚠️ Payment Telegram pe shift karne se ye requirement
     khatam NAHI hoti. Fee fee hai, chahe kahin bhi lo.
     SEBI ke maximum orders Telegram/WhatsApp advisory pe hi aate hain.

     Jab tak `number` khaali hai:
       - admin panel se call publish nahi hoga
       - app education mode me chalega (lessons + recap)
  --------------------------------------------------------- */
  var RA_REGISTRATION = {
    number: "",                 // e.g. "INH000012345"
    entityName: "",
    analystName: "",
    validTill: "",
    bseEnlistment: "",
    grievanceEmail: "support@arvcoin.com",
    grievancePhone: "",
    scoresUrl: "https://scores.sebi.gov.in",
    odrUrl: "https://smartodr.in"
  };

  function isRegistered() {
    return !!(RA_REGISTRATION.number && String(RA_REGISTRATION.number).trim().length >= 6);
  }

  /* ---------------------------------------------------------
     2) ACCESS — Telegram / WhatsApp funnel
     ---------------------------------------------------------
     Website pe koi payment gateway nahi. User "Unlock" dabata hai:
       1. accessRequests/{id} doc banta hai (uid + plan + code)
       2. Telegram pe redirect, message me uska code prefilled
       3. Aap Telegram pe charges batate ho, payment lete ho
       4. Admin panel se access grant -> subscriptions/{uid} active
          (ya bot webhook se automatic)
  --------------------------------------------------------- */
  var ACCESS = {
    mode: "telegram",                          // "telegram" | "whatsapp" | "both"

    telegramUser: "arvcoin_support",           // @username (bina @)
    telegramChannel: "arvcoin_research",       // public channel
    telegramBot: "",                           // bot username — auto-access ke liye

    whatsappNumber: "",                        // 91XXXXXXXXXX (country code ke saath)

    // Telegram/WhatsApp pe bheja jaane wala prefilled message
    messageTemplate:
      "Hi arvcoin team! Mujhe {PLAN} plan ka access chahiye.\n" +
      "Request code: {CODE}\n" +
      "Registered email: {EMAIL}",

    // Access grant hone ke baad UI kya kahe
    pendingNote: "Payment confirm hone ke baad aapka access 30 minute me activate ho jaata hai.",

    autoGrantEnabled: false                    // bot webhook + Cloud Function chahiye
  };

  function telegramUrl(planName, code, email) {
    var msg = ACCESS.messageTemplate
      .replace("{PLAN}", planName || "—")
      .replace("{CODE}", code || "—")
      .replace("{EMAIL}", email || "—");
    var user = ACCESS.telegramBot || ACCESS.telegramUser;
    return "https://t.me/" + user + "?text=" + encodeURIComponent(msg);
  }

  function whatsappUrl(planName, code, email) {
    var msg = ACCESS.messageTemplate
      .replace("{PLAN}", planName || "—")
      .replace("{CODE}", code || "—")
      .replace("{EMAIL}", email || "—");
    return "https://wa.me/" + ACCESS.whatsappNumber + "?text=" + encodeURIComponent(msg);
  }

  /* ---------------------------------------------------------
     3) SEGMENTS + INSTRUMENTS
     Stocks, Options, Commodity (metals/copper/energy),
     Currency, Crypto — sab kuch.
  --------------------------------------------------------- */
  var SEGMENTS = {
    equity: {
      id: "equity", name: "Stocks", icon: "◈", color: "#7c5cff", regulated: true,
      blurb: "Cash equity — large, mid aur small cap. Technical + fundamental basis.",
      exchanges: ["NSE", "BSE"],
      instruments: ["Large cap", "Mid cap", "Small cap", "Sectoral", "Index (NIFTY/BANKNIFTY)"]
    },
    options: {
      id: "options", name: "F&O / Options", icon: "◹", color: "#00e0ff", regulated: true,
      blurb: "Index aur stock derivatives — futures, calls, puts, spreads.",
      exchanges: ["NSE", "BSE"],
      instruments: ["NIFTY options", "BANKNIFTY options", "FINNIFTY", "Stock futures", "Stock options", "Spreads"]
    },
    commodity: {
      id: "commodity", name: "Commodity", icon: "⛁", color: "#ffb020", regulated: true,
      blurb: "Metals, energy aur agri — MCX/NCDEX exchange-traded contracts.",
      exchanges: ["MCX", "NCDEX"],
      instruments: [
        "Gold", "Silver", "Copper", "Zinc", "Lead", "Aluminium", "Nickel",
        "Crude oil", "Natural gas", "Cotton", "Guar", "Soybean"
      ],
      groups: {
        "Precious metals": ["Gold", "Silver"],
        "Base metals": ["Copper", "Zinc", "Lead", "Aluminium", "Nickel"],
        "Energy": ["Crude oil", "Natural gas"],
        "Agri": ["Cotton", "Guar", "Soybean"]
      }
    },
    currency: {
      id: "currency", name: "Currency / Forex", icon: "⇄", color: "#00ffa3", regulated: true,
      blurb: "Exchange-traded currency derivatives — sirf INR pairs, Indian exchanges.",
      exchanges: ["NSE", "BSE", "MSE"],
      instruments: ["USDINR", "EURINR", "GBPINR", "JPYINR"],
      note: "Sirf RBI-approved INR pairs, recognised Indian exchanges pe. " +
            "Offshore/OTC forex platforms FEMA ke against hain — penalty transaction amount ke 3x tak."
    },
    crypto: {
      id: "crypto", name: "Crypto", icon: "₿", color: "#f7931a", regulated: false,
      blurb: "Major digital assets. SEBI ke dayre me nahi, par 30% VDA tax + 1% TDS lagta hai.",
      exchanges: ["Crypto"],
      instruments: ["BTC", "ETH", "SOL", "XRP", "BNB"]
    }
  };

  var SEGMENT_ORDER = ["equity", "options", "commodity", "currency", "crypto"];

  /* ---------------------------------------------------------
     4) PLANS — charges site pe dikhte hain, payment Telegram pe
  --------------------------------------------------------- */
  var PLAN_PRICES = {
    basic: {
      id: "basic", name: "Basic",
      priceInr: 499, durationDays: 30,
      segments: ["equity", "crypto"],
      tagline: "Stocks se shuruaat",
      features: [
        "Equity research calls",
        "Crypto insights",
        "Daily market recap",
        "Telegram group access"
      ],
      missing: ["F&O / Options", "Commodity (metals, copper, energy)", "Currency"]
    },
    pro: {
      id: "pro", name: "Pro",
      priceInr: 999, durationDays: 30, popular: true,
      segments: ["equity", "options", "crypto"],
      tagline: "Traders ke liye",
      features: [
        "Sab Basic features",
        "F&O / Options calls",
        "Index + stock derivatives",
        "Chart analysis",
        "Priority Telegram support"
      ],
      missing: ["Commodity (metals, copper, energy)", "Currency"]
    },
    elite: {
      id: "elite", name: "Elite",
      priceInr: 1999, durationDays: 30,
      segments: ["equity", "options", "commodity", "currency", "crypto"],
      tagline: "Sab kuch, sab segment",
      features: [
        "Sab Pro features",
        "Commodity — gold, silver, copper, zinc, crude",
        "Currency (INR pairs)",
        "Analyst Q&A access",
        "Early call access"
      ],
      missing: []
    },
    quarterly: {
      id: "quarterly", name: "Elite Quarterly",
      priceInr: 4999, durationDays: 90,
      segments: ["equity", "options", "commodity", "currency", "crypto"],
      tagline: "3 mahine, best value",
      saveLabel: "Save 17%",
      features: [
        "Poora Elite plan, 3 mahine",
        "Ek hi baar payment",
        "Rate locked"
      ],
      missing: []
    }
  };

  var PLAN_ORDER = ["basic", "pro", "elite", "quarterly"];

  // SEBI RA fee cap: ₹1,51,000 per year per family
  var ANNUAL_FEE_CAP_INR = 151000;
  var GST_PCT = 18;

  /* ---------------------------------------------------------
     4b) PAYMENTS — website pe hi
     ---------------------------------------------------------
     Razorpay. Public key yahan, secret SIRF server pe.

     ⚠️ Client ke "payment success" pe kabhi trust nahi.
     Flow: order banao (Cloud Function) -> user pay kare ->
     Razorpay webhook -> signature verify (server) ->
     subscriptions/{uid} activate. Client sirf status padhta hai.
  --------------------------------------------------------- */
  var PAYMENTS = {
    provider: "razorpay",
    razorpayKeyId: "",          // rzp_live_... ya rzp_test_...  (public key only)
    currency: "INR",
    // Cloud Function endpoints
    createOrderUrl: "",         // e.g. https://asia-south1-arvcoin.cloudfunctions.net/createOrder
    verifyUrl: "",              // e.g. .../verifyPayment
    checkoutName: "arvcoin",
    checkoutDescription: "Research access subscription",
    themeColor: "#7c5cff",
    gstPct: 18
  };

  function paymentsReady() {
    return !!(PAYMENTS.razorpayKeyId && PAYMENTS.createOrderUrl);
  }

  /* Plan ka final amount GST ke saath */
  function planTotal(planId) {
    var p = PLAN_PRICES[planId];
    if (!p) return null;
    var gst = Math.round(p.priceInr * PAYMENTS.gstPct / 100);
    return { base: p.priceInr, gst: gst, total: p.priceInr + gst };
  }

  /* ---------------------------------------------------------
     5) MARKET DATA / CHARTS
  --------------------------------------------------------- */
  var MARKET_DATA = {
    tradingViewEnabled: true,
    tvDefaultExchange: "NSE",
    coingeckoBase: "https://api.coingecko.com/api/v3",
    quotesProxyUrl: ""          // Cloud Function proxy — API key server pe
  };

  /* ---------------------------------------------------------
     6) DISCLOSURES
  --------------------------------------------------------- */
  var DISCLOSURES = {
    educationOnly:
      "Ye platform sirf education aur information ke liye hai. Yahan diya gaya koi bhi " +
      "content investment advice nahi hai aur kisi security ko khareedne ya bechne ki " +
      "sifarish nahi hai. Koi bhi decision lene se pehle apni research karo.",
    notRegistered:
      "arvcoin abhi SEBI ke saath Research Analyst ya Investment Adviser ke roop me " +
      "registered NAHI hai. Isliye abhi koi buy/sell recommendation publish nahi hoti — " +
      "sirf educational content available hai.",
    registeredNote:
      "Research services SEBI-registered Research Analyst dwara provide ki jaati hain. " +
      "Registration details har call pe di gayi hain.",
    marketRisk:
      "Investments are subject to market risk. Read all related documents carefully before investing.",
    noGuarantee:
      "Past performance kisi bhi future result ki guarantee nahi hai. Koi assured ya " +
      "guaranteed return nahi. Derivatives (F&O, commodity, currency) me poora capital " +
      "doob sakta hai.",
    noPersonalAdvice:
      "Hum personalised investment advice nahi dete. Content general research hai, kisi " +
      "individual ki financial situation, risk profile ya goals ke hisaab se nahi.",
    forexWarning:
      "Indian residents sirf RBI-approved INR pairs me, recognised exchanges (NSE/BSE/MSE) pe " +
      "SEBI-registered broker ke through currency derivatives trade kar sakte hain. " +
      "Offshore/OTC forex platforms FEMA ke against hain — penalty transaction amount ke 3x tak.",
    cryptoTax:
      "Crypto (VDA) pe India me 30% tax + 1% TDS lagta hai. Crypto SEBI ke dayre me nahi aata.",
    toolNotAdvice:
      "Levels calculator ek calculation tool hai. Ye standard public formulas se levels " +
      "compute karta hai — koi recommendation nahi deta. Same input pe sabko same output milta hai.",
    paymentNote:
      "Subscription charges GST ke alawa hain. Payment secure gateway (Razorpay) ke through " +
      "hoti hai — card/UPI details humare server pe store nahi hoti."
  };

  /* ---------------------------------------------------------
     7) BRAND
  --------------------------------------------------------- */
  var BRAND = {
    name: "arvcoin",
    tagline: "Market research desk",
    domain: "arvcoin.com",
    supportEmail: "support@arvcoin.com"
  };

  /* ---------------------------------------------------------
     Helpers
  --------------------------------------------------------- */
  function plan(id) { return PLAN_PRICES[id] || null; }
  function planCovers(planId, segment) {
    var p = plan(planId);
    return !!(p && p.segments.indexOf(segment) > -1);
  }
  function segment(id) { return SEGMENTS[id] || null; }
  function inrFmt(n) {
    return "\u20B9" + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });
  }
  /** Chhota readable request code — Telegram message me jaata hai */
  function newRequestCode() {
    var s = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", out = "ARV-";
    for (var i = 0; i < 6; i++) out += s.charAt(Math.floor(Math.random() * s.length));
    return out;
  }

  window.ARV_CONFIG = {
    RA_REGISTRATION: RA_REGISTRATION,
    isRegistered: isRegistered,
    ACCESS: ACCESS,
    telegramUrl: telegramUrl,
    whatsappUrl: whatsappUrl,
    SEGMENTS: SEGMENTS,
    SEGMENT_ORDER: SEGMENT_ORDER,
    PLAN_PRICES: PLAN_PRICES,
    PLAN_ORDER: PLAN_ORDER,
    ANNUAL_FEE_CAP_INR: ANNUAL_FEE_CAP_INR,
    GST_PCT: GST_PCT,
    PAYMENTS: PAYMENTS,
    paymentsReady: paymentsReady,
    planTotal: planTotal,
    MARKET_DATA: MARKET_DATA,
    DISCLOSURES: DISCLOSURES,
    BRAND: BRAND,
    plan: plan,
    planCovers: planCovers,
    segment: segment,
    inrFmt: inrFmt,
    newRequestCode: newRequestCode
  };
})();
