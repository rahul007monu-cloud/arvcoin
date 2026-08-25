/* =========================================================
   arvcoin — Levels Calculator (LTP / pivot engine)

   Ye ek DETERMINISTIC CALCULATOR hai, recommendation nahi.
   Aap OHLC daalte ho, ye formula se levels nikaalta hai.
   Same input -> same output, sabke liye. Koi curation nahi,
   koi "buy karo" nahi.

   Formulas standard aur public hain:
     Classic / Fibonacci / Camarilla pivots, CPR, Woodie.

   ⚠️ Output me "buy", "sell", "target", "stop loss" jaisi
   bhasha NA daalna. Sirf computed levels aur math-derived bias.
   ========================================================= */
(function () {
  "use strict";

  function n(v) { var x = parseFloat(v); return isNaN(x) ? null : x; }
  function r2(x) { return Math.round(x * 100) / 100; }

  /* ---------------------------------------------------------
     CLASSIC PIVOT
  --------------------------------------------------------- */
  function classic(h, l, c) {
    var p = (h + l + c) / 3;
    var range = h - l;
    return {
      pivot: p,
      r1: 2 * p - l,
      r2: p + range,
      r3: h + 2 * (p - l),
      r4: h + 3 * (p - l),
      s1: 2 * p - h,
      s2: p - range,
      s3: l - 2 * (h - p),
      s4: l - 3 * (h - p)
    };
  }

  /* ---------------------------------------------------------
     FIBONACCI PIVOT
  --------------------------------------------------------- */
  function fibonacci(h, l, c) {
    var p = (h + l + c) / 3;
    var range = h - l;
    return {
      pivot: p,
      r1: p + 0.382 * range,
      r2: p + 0.618 * range,
      r3: p + 1.000 * range,
      r4: p + 1.618 * range,
      s1: p - 0.382 * range,
      s2: p - 0.618 * range,
      s3: p - 1.000 * range,
      s4: p - 1.618 * range
    };
  }

  /* ---------------------------------------------------------
     CAMARILLA
  --------------------------------------------------------- */
  function camarilla(h, l, c) {
    var range = h - l;
    return {
      pivot: (h + l + c) / 3,
      r1: c + range * 1.1 / 12,
      r2: c + range * 1.1 / 6,
      r3: c + range * 1.1 / 4,
      r4: c + range * 1.1 / 2,
      s1: c - range * 1.1 / 12,
      s2: c - range * 1.1 / 6,
      s3: c - range * 1.1 / 4,
      s4: c - range * 1.1 / 2
    };
  }

  /* ---------------------------------------------------------
     WOODIE  (open chahiye)
  --------------------------------------------------------- */
  function woodie(h, l, c, o) {
    var p = (h + l + 2 * o) / 4;
    var range = h - l;
    return {
      pivot: p,
      r1: 2 * p - l,
      r2: p + range,
      r3: h + 2 * (p - l),
      r4: null,
      s1: 2 * p - h,
      s2: p - range,
      s3: l - 2 * (h - p),
      s4: null
    };
  }

  /* ---------------------------------------------------------
     CPR — Central Pivot Range
     Width se pata chalta hai din trending hoga ya rangebound.
  --------------------------------------------------------- */
  function cpr(h, l, c) {
    var p = (h + l + c) / 3;
    var bc = (h + l) / 2;
    var tc = p - bc + p;
    var top = Math.max(tc, bc);
    var bottom = Math.min(tc, bc);
    var width = top - bottom;
    var widthPct = c ? (width / c) * 100 : 0;

    var shape;
    if (widthPct < 0.15) shape = "very-narrow";
    else if (widthPct < 0.35) shape = "narrow";
    else if (widthPct < 0.8) shape = "moderate";
    else shape = "wide";

    return {
      pivot: p, tc: top, bc: bottom,
      width: width, widthPct: widthPct, shape: shape
    };
  }

  /* ---------------------------------------------------------
     BIAS — purely computed, no advice
     Sirf ye batata hai ki price pivot ke kahan hai aur
     range me kahan close hua. Koi action suggest nahi.
  --------------------------------------------------------- */
  function bias(h, l, c, ltp) {
    var p = (h + l + c) / 3;
    var ref = (ltp == null ? c : ltp);
    var range = h - l;

    // close ka position previous range me (0 = low, 1 = high)
    var posInRange = range > 0 ? (c - l) / range : 0.5;

    // ref price pivot se kitna door (% me)
    var distPct = p ? ((ref - p) / p) * 100 : 0;

    var label, tone, note;
    if (distPct > 0.6) {
      label = "Above pivot"; tone = "up";
      note = "Reference price computed pivot se upar hai.";
    } else if (distPct < -0.6) {
      label = "Below pivot"; tone = "down";
      note = "Reference price computed pivot se neeche hai.";
    } else {
      label = "Near pivot"; tone = "flat";
      note = "Reference price computed pivot ke aas-paas hai.";
    }

    var strength;
    if (posInRange > 0.75) strength = "Previous session upper range me band hua";
    else if (posInRange < 0.25) strength = "Previous session lower range me band hua";
    else strength = "Previous session mid range me band hua";

    return {
      label: label, tone: tone, note: note,
      distPct: distPct,
      posInRange: posInRange,
      strength: strength
    };
  }

  /* ---------------------------------------------------------
     MAIN
  --------------------------------------------------------- */
  function compute(input) {
    var h = n(input.high), l = n(input.low), c = n(input.close);
    var o = n(input.open), ltp = n(input.ltp);

    var errs = [];
    if (h == null) errs.push("High");
    if (l == null) errs.push("Low");
    if (c == null) errs.push("Close");
    if (errs.length) return { ok: false, errors: errs, message: "Ye values chahiye: " + errs.join(", ") };
    if (h < l) return { ok: false, errors: ["High/Low"], message: "High, Low se chhota nahi ho sakta." };
    if (c > h || c < l) return { ok: false, errors: ["Close"], message: "Close, High-Low range ke andar hona chahiye." };
    if (h === l) return { ok: false, errors: ["Range"], message: "High aur Low same hain — range zero hai." };

    var sets = {
      classic: classic(h, l, c),
      fibonacci: fibonacci(h, l, c),
      camarilla: camarilla(h, l, c)
    };
    if (o != null) sets.woodie = woodie(h, l, c, o);

    // rounding
    Object.keys(sets).forEach(function (k) {
      var s = sets[k];
      Object.keys(s).forEach(function (kk) {
        if (typeof s[kk] === "number") s[kk] = r2(s[kk]);
      });
    });

    var cp = cpr(h, l, c);
    ["pivot", "tc", "bc", "width"].forEach(function (k) { cp[k] = r2(cp[k]); });
    cp.widthPct = Math.round(cp.widthPct * 1000) / 1000;

    var b = bias(h, l, c, ltp);
    b.distPct = Math.round(b.distPct * 100) / 100;
    b.posInRange = Math.round(b.posInRange * 100) / 100;

    var range = r2(h - l);

    return {
      ok: true,
      input: { high: h, low: l, close: c, open: o, ltp: ltp },
      range: range,
      rangePct: c ? Math.round((range / c) * 10000) / 100 : 0,
      sets: sets,
      cpr: cp,
      bias: b,
      // downside/upside extent — computed levels, not predictions
      extent: {
        upperMost: sets.classic.r4 != null ? sets.classic.r4 : sets.classic.r3,
        lowerMost: sets.classic.s4 != null ? sets.classic.s4 : sets.classic.s3,
        nearestResistance: sets.classic.r1,
        nearestSupport: sets.classic.s1
      }
    };
  }

  /* CPR shape ka plain-language matlab (educational, no action) */
  function cprMeaning(shape) {
    switch (shape) {
      case "very-narrow":
        return "Bahut narrow CPR — historically aise din me range expansion dekhi jaati hai.";
      case "narrow":
        return "Narrow CPR — trending session ki possibility batayi jaati hai.";
      case "moderate":
        return "Moderate CPR width — mixed structure.";
      default:
        return "Wide CPR — historically rangebound / sideways sessions se associate ki jaati hai.";
    }
  }

  window.ARVLevels = {
    compute: compute,
    classic: classic,
    fibonacci: fibonacci,
    camarilla: camarilla,
    woodie: woodie,
    cpr: cpr,
    bias: bias,
    cprMeaning: cprMeaning
  };
})();
