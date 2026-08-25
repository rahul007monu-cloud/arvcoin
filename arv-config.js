/* =========================================================
   arvcoin — central config

   A market research and investor education platform.
   Website + app.

   ⚠️ This file loads on the client. Never put secrets here.
   ========================================================= */
(function () {
  "use strict";

  /* ---------------------------------------------------------
     1) SEBI RESEARCH ANALYST REGISTRATION
     ---------------------------------------------------------
     Publishing buy/sell recommendations on securities for a fee
     requires registration under the SEBI (Research Analysts)
     Regulations, 2014.

     While `number` is empty the app runs in education mode:
     levels analysis, lessons and market recaps only.
  --------------------------------------------------------- */
  var RA_REGISTRATION = {
    number: "INH000021086",

    // ⚠️ FILL THESE THREE — they render on every published call
    //    and across the legal pages.
    entityName: "",             // exact registered entity name, per certificate
    analystName: "",            // principal / proprietor analyst name
    validTill: "",              // "YYYY-MM-DD", or "Perpetual"

    // Optional
    bseEnlistment: "",          // BSE Administration & Supervision enlistment no.
    registeredAddress: "",
    telephone: "",

    // Grievance details — required by SEBI
    grievanceEmail: "support@arvcoin.com",
    grievancePhone: "",
    grievanceOfficer: "",
    scoresUrl: "https://scores.sebi.gov.in",
    odrUrl: "https://smartodr.in"
  };

  function isRegistered() {
    return !!(RA_REGISTRATION.number && String(RA_REGISTRATION.number).trim().length >= 6);
  }

  /* Which required fields are still blank — surfaced in the admin panel */
  function missingRaFields() {
    var need = { entityName: "Entity name", analystName: "Analyst name", validTill: "Valid till" };
    var out = [];
    Object.keys(need).forEach(function (k) {
      if (!RA_REGISTRATION[k] || !String(RA_REGISTRATION[k]).trim()) out.push(need[k]);
    });
    return out;
  }

  /* ---------------------------------------------------------
     2) SEGMENTS AND INSTRUMENTS
  --------------------------------------------------------- */
  var SEGMENTS = {
    equity: {
      id: "equity", name: "Stocks", icon: "◈", color: "#7c5cff", regulated: true,
      blurb: "Cash equity across large, mid and small caps. Technical and fundamental basis.",
      exchanges: ["NSE", "BSE"],
      instruments: ["Large cap", "Mid cap", "Small cap", "Sectoral", "Index (NIFTY/BANKNIFTY)"]
    },
    options: {
      id: "options", name: "F&O / Options", icon: "◹", color: "#00e0ff", regulated: true,
      blurb: "Index and stock derivatives — futures, calls, puts and spreads.",
      exchanges: ["NSE", "BSE"],
      instruments: ["NIFTY options", "BANKNIFTY options", "FINNIFTY", "Stock futures", "Stock options", "Spreads"]
    },
    commodity: {
      id: "commodity", name: "Commodity", icon: "⛁", color: "#ffb020", regulated: true,
      blurb: "Metals, energy and agri — exchange-traded contracts on MCX and NCDEX.",
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
      id: "currency", name: "Currency", icon: "⇄", color: "#00ffa3", regulated: true,
      blurb: "Exchange-traded currency derivatives — INR pairs on Indian exchanges only.",
      exchanges: ["NSE", "BSE", "MSE"],
      instruments: ["USDINR", "EURINR", "GBPINR", "JPYINR"],
      note: "RBI-approved INR pairs on recognised Indian exchanges only. " +
            "Offshore and OTC forex platforms breach FEMA, with penalties of up to " +
            "three times the transaction value."
    },
    crypto: {
      id: "crypto", name: "Crypto", icon: "₿", color: "#f7931a", regulated: false,
      blurb: "Major digital assets. Outside SEBI's remit, but taxed at 30% plus 1% TDS.",
      exchanges: ["Crypto"],
      instruments: ["BTC", "ETH", "SOL", "XRP", "BNB"]
    }
  };

  var SEGMENT_ORDER = ["equity", "options", "commodity", "currency", "crypto"];

  /* ---------------------------------------------------------
     3) PLANS
  --------------------------------------------------------- */
  var PLAN_PRICES = {
    basic: {
      id: "basic", name: "Basic",
      priceInr: 499, durationDays: 30,
      segments: ["equity", "crypto"],
      tagline: "Start with stocks",
      features: [
        "Equity research",
        "Crypto insights",
        "Daily market recap",
        "Levels analysis"
      ],
      missing: ["F&O / Options", "Commodity (metals, energy)", "Currency"]
    },
    pro: {
      id: "pro", name: "Pro",
      priceInr: 999, durationDays: 30, popular: true,
      segments: ["equity", "options", "crypto"],
      tagline: "For active traders",
      features: [
        "Everything in Basic",
        "F&O and options research",
        "Index and stock derivatives",
        "Chart analysis",
        "Priority support"
      ],
      missing: ["Commodity (metals, energy)", "Currency"]
    },
    elite: {
      id: "elite", name: "Elite",
      priceInr: 1999, durationDays: 30,
      segments: ["equity", "options", "commodity", "currency", "crypto"],
      tagline: "Every segment",
      features: [
        "Everything in Pro",
        "Commodity — gold, silver, copper, zinc, crude",
        "Currency (INR pairs)",
        "Analyst Q&A access",
        "Early access to research"
      ],
      missing: []
    },
    quarterly: {
      id: "quarterly", name: "Elite Quarterly",
      priceInr: 4999, durationDays: 90,
      segments: ["equity", "options", "commodity", "currency", "crypto"],
      tagline: "Three months, best value",
      saveLabel: "Save 17%",
      features: [
        "Full Elite plan for three months",
        "Single payment",
        "Rate locked for the term"
      ],
      missing: []
    }
  };

  var PLAN_ORDER = ["basic", "pro", "elite", "quarterly"];

  // SEBI RA fee cap: ₹1,51,000 per year per family
  var ANNUAL_FEE_CAP_INR = 151000;
  var GST_PCT = 18;

  /* ---------------------------------------------------------
     4) PAYMENTS
     ---------------------------------------------------------
     ⚠️ Never trust a client-side "payment success" callback.
     Flow: create order (Cloud Function) → user pays →
     Razorpay webhook → verify signature server-side →
     activate subscriptions/{uid}. The client only reads status.
  --------------------------------------------------------- */
  var PAYMENTS = {
    provider: "razorpay",
    razorpayKeyId: "",          // rzp_live_... or rzp_test_...  (public key only)
    currency: "INR",
    createOrderUrl: "",         // e.g. https://asia-south1-arvcoin.cloudfunctions.net/createOrder
    verifyUrl: "",
    checkoutName: "arvcoin",
    checkoutDescription: "Research access subscription",
    themeColor: "#7c5cff",
    gstPct: 18
  };

  function paymentsReady() {
    return !!(PAYMENTS.razorpayKeyId && PAYMENTS.createOrderUrl);
  }

  function planTotal(planId) {
    var p = PLAN_PRICES[planId];
    if (!p) return null;
    var gst = Math.round(p.priceInr * PAYMENTS.gstPct / 100);
    return { base: p.priceInr, gst: gst, total: p.priceInr + gst };
  }

  /* ---------------------------------------------------------
     5) ACCESS — optional manual grant channel
  --------------------------------------------------------- */
  var ACCESS = {
    mode: "telegram",
    telegramUser: "arvcoin_support",
    telegramChannel: "arvcoin_research",
    telegramBot: "",
    whatsappNumber: "",
    messageTemplate:
      "Hi arvcoin team, I would like access to the {PLAN} plan.\n" +
      "Request code: {CODE}\n" +
      "Registered email: {EMAIL}",
    pendingNote: "Access is activated within 30 minutes of payment confirmation.",
    autoGrantEnabled: false
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
     6) MARKET DATA AND CHARTS
  --------------------------------------------------------- */
  var MARKET_DATA = {
    tradingViewEnabled: true,
    tvDefaultExchange: "NSE",
    coingeckoBase: "https://api.coingecko.com/api/v3",
    quotesProxyUrl: ""          // Cloud Function proxy — keep the API key server-side
  };

  /* ---------------------------------------------------------
     7) DISCLOSURES
  --------------------------------------------------------- */
  var DISCLOSURES = {
    educationOnly:
      "This platform is for information and education only. Nothing here is investment " +
      "advice or a recommendation to buy or sell any security. Do your own research " +
      "before making any decision.",

    notRegistered:
      "arvcoin is not currently registered with SEBI as a Research Analyst or Investment " +
      "Adviser. No buy or sell recommendations are published — educational content only.",

    registeredNote:
      "Research services are provided by a SEBI-registered Research Analyst. Registration " +
      "details are shown on every research note.",

    /* SEBI-mandated disclaimer for registered intermediaries.
       Do not shorten or reword this. */
    sebiMandated:
      "Registration granted by SEBI and certification from NISM in no way guarantee " +
      "performance of the intermediary or provide any assurance of returns to investors.",

    conflictDisclosure:
      "The Research Analyst and its associates or relatives may hold a position or interest " +
      "in a recommended security. This disclosure accompanies every research note.",

    standardCaution:
      "A research note is not an offer or solicitation to buy or sell any security. " +
      "Recommendations are general in nature and are prepared without regard to the " +
      "investment objectives, financial situation or risk profile of any individual.",

    marketRisk:
      "Investments are subject to market risk. Read all related documents carefully " +
      "before investing.",

    noGuarantee:
      "Past performance is not a guarantee of future results. No assured or guaranteed " +
      "returns are offered. Derivatives — F&O, commodity and currency — can result in the " +
      "loss of your entire capital.",

    noPersonalAdvice:
      "We do not provide personalised investment advice. Content is general research and " +
      "is not tailored to any individual's financial situation, risk profile or goals.",

    forexWarning:
      "Indian residents may trade currency derivatives only in RBI-approved INR pairs, on " +
      "recognised exchanges (NSE, BSE, MSE), through a SEBI-registered broker. Offshore and " +
      "OTC forex platforms breach FEMA, with penalties of up to three times the transaction value.",

    cryptoTax:
      "Crypto (virtual digital assets) is taxed in India at 30% plus 1% TDS. Crypto falls " +
      "outside SEBI's remit.",

    toolNotAdvice:
      "The levels calculator is a calculation tool. It derives levels from standard public " +
      "formulas and makes no recommendation. The same input always produces the same output.",

    paymentNote:
      "Charges are exclusive of GST. Payment is processed through a secure gateway " +
      "(Razorpay) — card and UPI details are never stored on our servers."
  };

  /* ---------------------------------------------------------
     8) BRAND
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

  function newRequestCode() {
    var s = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", out = "ARV-";
    for (var i = 0; i < 6; i++) out += s.charAt(Math.floor(Math.random() * s.length));
    return out;
  }

  window.ARV_CONFIG = {
    RA_REGISTRATION: RA_REGISTRATION,
    isRegistered: isRegistered,
    missingRaFields: missingRaFields,
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
