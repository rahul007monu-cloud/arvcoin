/* =========================================================
   arvcoin — compliance linter

   Checks content before publishing and blocks phrases that would
   create a problem with SEBI.

   ⚠️ Do NOT weaken this wordlist — extend it. This is the first
   filter protecting you from disgorgement and penalties.
   ========================================================= */
(function () {
  "use strict";

  /* ---------- HARD BLOCK: guaranteed / assured returns ----------
     Never permitted, registered or not. */
  var BANNED = [
    // guaranteed returns
    /\bguarantee(d|s)?\s+(return|profit|income|gain|money|paisa)/i,
    /\bassured\s+(return|profit|income|gain)/i,
    /\bfixed\s+(return|profit|income)\b/i,
    /\bconfirm(ed)?\s+(profit|return|target)\b/i,
    /\b(100|99|98|97|96|95)\s*%\s*(sure|accurate|accuracy|profit|guarantee|winning)/i,
    /\bsure\s*shot\b/i,
    /\bpakka\s+(profit|return|target|call)/i,
    /\bguarantee(d)?\s+tips?\b/i,
    /\bno\s*loss\b/i,
    /\bloss\s*nahi\s*hoga\b/i,
    /\bnuksan\s*nahi\s*hoga\b/i,
    /\bzero\s*risk\b/i,
    /\brisk\s*free\b/i,
    /\bdouble\s+(your\s+)?(money|paisa|investment)/i,
    /\bpaisa\s+double\b/i,

    // income promises
    /\b(daily|monthly|weekly)\s+(income|profit|earning|kamai)\s+(guarantee|assured|fixed|pakka)/i,
    /\bearn\s+₹?\s*\d+\s*(daily|per\s*day|monthly|roz)/i,
    /\broz\s+₹?\s*\d+\s+kama/i,

    // ARV coin appreciation — permanently banned
    /\barv\s*(coin)?\s*(ki\s*)?(value|price|rate)\s*(badh|increase|grow|upar|rise|appreciat)/i,
    /\barv\s*(coin)?\s*.{0,20}(investment|invest\s*karo|asset|token\s*sale)/i,
    /\barv\s*(coin)?\s*.{0,30}(backed\s*by|reserve)/i,
    /\binvest\s*in\s*arv\b/i,

    // pump language
    /\bmulti\s*bagger\s+guarantee/i,
    /\bjackpot\s+(call|stock|trade)/i,
    /\bblind(ly)?\s+(buy|kharido|lo)\b/i
  ];

  /* ---------- WARN: needs review, not blocked ----------
     These phrases depend on context. */
  var WARN = [
    /\bmulti\s*bagger\b/i,
    /\bhuge\s+(profit|gain|return)/i,
    /\bbumper\s+(profit|return)/i,
    /\bnot\s+to\s+be\s+missed\b/i,
    /\blast\s+chance\b/i,
    /\bhurry\b/i,
    /\bbest\s+stock\s+to\s+buy\b/i,
    /\btip\s+of\s+the\s+day\b/i,
    /\bmera\s+portfolio\b/i,
    /\bkya\s+karun\b/i
  ];

  /* ---------- Personalised-advice detection ----------
     RA registration covers research, not personalised advice — that
     requires IA registration. Block these questions and answers. */
  var PERSONAL = [
    /\bmera\s+(stock|share|portfolio|paisa|investment|position)\b/i,
    /\bmujhe\s+kya\s+(karna|lena|bechna)\b/i,
    /\bmy\s+portfolio\b.{0,30}\b(should\s+i|what\s+do)/i,
    /\bshould\s+i\s+(buy|sell|hold|exit)\b/i,
    /\bkya\s+(main|me)\s+(le|bech|kharid)/i
  ];

  function scan(text, patterns) {
    var hits = [], i, m;
    text = String(text || "");
    for (i = 0; i < patterns.length; i++) {
      m = text.match(patterns[i]);
      if (m) hits.push(m[0].trim());
    }
    return hits;
  }

  /**
   * check(text) -> { ok, hits, warnings, personal }
   *   ok === false  => block the publish
   */
  function check(text) {
    var hits = scan(text, BANNED);
    var warnings = scan(text, WARN);
    var personal = scan(text, PERSONAL);
    return {
      ok: hits.length === 0,
      hits: hits,
      warnings: warnings,
      personal: personal,
      hasPersonal: personal.length > 0
    };
  }

  /** Human-readable summary, for display in the admin panel. */
  function explain(res) {
    var out = [];
    if (res.hits.length) {
      out.push("🚫 BLOCKED — these phrases carry legal risk: " + res.hits.join(", ") +
               "\nGuaranteed or assured returns are never permitted (SEBI and consumer law).");
    }
    if (res.personal.length) {
      out.push("⚠️ Personalised advice detected: " + res.personal.join(", ") +
               "\nRA registration covers research, not personalised advice — that requires IA registration.");
    }
    if (res.warnings.length) {
      out.push("⚠️ Review — promotional language: " + res.warnings.join(", "));
    }
    if (!out.length) out.push("✅ Clean — no blocked phrases found.");
    return out.join("\n\n");
  }

  window.ARVLint = {
    check: check,
    explain: explain,
    BANNED: BANNED,
    WARN: WARN,
    PERSONAL: PERSONAL
  };
})();
