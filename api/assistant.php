<?php
/**
 * Support assistant — answers customer questions about ARV.
 *
 * Two ways it can answer, in order:
 *   1. If an operator has saved a Gemini API key (setting `gemini_api_key`), the
 *      question is sent to Gemini with a grounding system prompt built from the
 *      SAME live facts below, so the answer is specific to this platform.
 *   2. Otherwise (or if Gemini is unreachable), a built-in knowledge base answers
 *      by intent-matching the question against curated ARV topics. This means the
 *      assistant works out of the box with no key and no external dependency.
 *
 * It is read-only: it never touches money, orders, or accounts. Public, so a
 * visitor can ask before signing up; rate-limited per IP.
 */

declare(strict_types=1);

require __DIR__ . '/_boot.php';

const SUPPORT_EMAIL = 'info@ARVcoin.com';

$action = $_GET['action'] ?? 'ask';

switch ($action) {
    case 'ask': handle_ask(); break;
    default:
        json_fail(400, 'Unknown action.');
}

/* ============================================================= handler ===== */

function handle_ask(): void
{
    require_method('POST');
    // Generous, but stops a script hammering an upstream LLM on the operator's key.
    rate_limit('assistant', 20, 60, 60);

    if (!setting_b('assistant_enabled', true)) {
        json_fail(403, 'The assistant is turned off right now.');
    }

    $q = input_str('question');
    if ($q === '') {
        json_fail(422, 'Type a question first.');
    }
    if (mb_strlen($q) > 500) {
        $q = mb_substr($q, 0, 500);
    }
    $history = input('history', []);
    if (!is_array($history)) {
        $history = [];
    }

    $facts = assistant_facts();
    $kb    = assistant_kb($facts);

    // Prefer Gemini when a key is configured; fall back to the knowledge base on
    // any error so the assistant never simply fails.
    $key = trim((string)setting('gemini_api_key', ''));
    if ($key !== '') {
        $answer = gemini_answer($key, $q, $history, assistant_system_prompt($facts, $kb));
        if ($answer !== null && trim($answer) !== '') {
            json_ok(['answer' => $answer, 'source' => 'gemini']);
        }
    }

    $hit = kb_match($q, $kb);
    if ($hit !== null) {
        json_ok(['answer' => $hit['answer'], 'source' => 'kb', 'topic' => $hit['title']]);
    }

    json_ok(['answer' => assistant_fallback($kb), 'source' => 'kb']);
}

/* =============================================================== facts ===== */

/** Live numbers, so every answer quotes what the platform actually charges. */
function assistant_facts(): array
{
    $launch = (string)setting('launch_at', '2015-07-20 00:00:00');
    return [
        'entryFeePct'   => rtrim(rtrim(number_format(setting_f('entry_fee_pct', 0.5), 2, '.', ''), '0'), '.'),
        'exitFeePct'    => rtrim(rtrim(number_format(setting_f('exit_fee_pct', 0.5), 2, '.', ''), '0'), '.'),
        'gstPct'        => rtrim(rtrim(number_format(setting_f('gst_pct', 18), 2, '.', ''), '0'), '.'),
        'vdaGainPct'    => rtrim(rtrim(number_format(setting_f('vda_gain_pct', 30), 2, '.', ''), '0'), '.'),
        'cessPct'       => rtrim(rtrim(number_format(setting_f('cess_pct', 4), 2, '.', ''), '0'), '.'),
        'tdsPct'        => rtrim(rtrim(number_format(setting_f('tds_pct', 1), 2, '.', ''), '0'), '.'),
        'tdsNoPanPct'   => rtrim(rtrim(number_format(setting_f('tds_pct_no_pan', 20), 2, '.', ''), '0'), '.'),
        'minOrder'      => fmt_paise((int)setting_f('min_order_paise', 10000)),
        'minWithdraw'   => fmt_paise((int)setting_f('min_withdraw_paise', 10000)),
        // Peer-to-peer is how trading actually happens now, so the numbers the
        // assistant quotes have to be the P2P ones. entry_fee_pct/exit_fee_pct above
        // belong to the legacy index path, which no longer has a form on any page.
        'p2pFeePct'     => rtrim(rtrim(number_format(setting_f('p2p_fee_pct', 1), 2, '.', ''), '0'), '.'),
        'p2pTdsPct'     => rtrim(rtrim(number_format(setting_f('p2p_tds_pct', 0), 2, '.', ''), '0'), '.'),
        'p2pPayMin'     => (int)setting_f('p2p_pay_ttl_minutes', 60),
        'p2pConfirmHrs' => (int)setting_f('p2p_confirm_ttl_hours', 4),
        'p2pOpenHrs'    => (int)setting_f('p2p_match_ttl_hours', 24),
        'trustHours'    => (int)setting_f('trust_hours', 720),
        'launchDate'    => date('j F Y', strtotime($launch) ?: time()),
        'support'       => SUPPORT_EMAIL,
    ];
}

function fmt_paise(int $paise): string
{
    return '₹' . number_format($paise / 100, 0, '.', ',');
}

/* ========================================================= knowledge ======= */

/**
 * The curated topics. Each entry has trigger keywords, a title, and an answer
 * written in plain language and grounded in the live facts.
 *
 * @return array<int,array{keys:array<int,string>,title:string,answer:string}>
 */
function assistant_kb(array $f): array
{
    return [
        [
            'keys'  => ['what is arv', 'about arv', 'explain arv', 'arv coin', 'what is this', 'how does arv work', 'index'],
            'title' => 'What ARV is',
            'answer' => "ARV is an index unit whose rupee price tracks Bitcoin one-for-one. "
                . "It launched on {$f['launchDate']} and since then its price is exactly Bitcoin's "
                . "percentage move, applied in rupees. If Bitcoin rises 5%, ARV rises 5%; if Bitcoin "
                . "falls 5%, ARV falls 5%. Nothing else moves the price — not demand, not deposits, "
                . "not the platform. It is not a blockchain token; it is a contractual claim on the "
                . "platform for the rupee value of your units.",
        ],
        [
            'keys'  => ['how to buy', 'buy arv', 'purchase', 'invest', 'buying'],
            'title' => 'Buying ARV',
            'answer' => "Trading is peer-to-peer, so you pay a seller directly — you do not need a "
                . "rupee balance on the platform first. Open Trade, enter the amount and confirm; you are "
                . "matched with someone holding ARV at the live index price and their units go into "
                . "escrow. You then pay their UPI ID or bank account from your own bank, enter the "
                . "reference, and the escrow is released to you. You have {$f['p2pPayMin']} minutes to pay "
                . "after matching. A platform fee of {$f['p2pFeePct']}% is taken from the ARV you receive, "
                . "never from your rupees, and it is shown before you confirm. The minimum order is "
                . "{$f['minOrder']}.",
        ],
        [
            'keys'  => ['how to sell', 'sell arv', 'selling', 'cash out', 'exit'],
            'title' => 'Selling ARV',
            'answer' => "To sell you need a payment method saved (your UPI ID or bank account) so a "
                . "buyer knows where to pay. Open Trade, switch to Sell, enter the units and confirm. Your "
                . "units go into escrow and the order waits for a buyer — it stays open for up to "
                . "{$f['p2pOpenHrs']} hours, and if nobody takes it the escrow returns to you. When a "
                . "buyer matches, they pay you directly and you confirm once the money is actually in "
                . "your account; you have {$f['p2pConfirmHrs']} hours to do that. Be aware there is no "
                . "guaranteed instant exit — a sell needs a buyer. Tax still applies to the sale (see "
                . "tax).",
        ],
        [
            'keys'  => ['deposit', 'add money', 'add funds', 'upi', 'put money', 'fund'],
            'title' => 'Deposits',
            'answer' => "You do not need to deposit anything to buy ARV — trading is peer-to-peer, so "
                . "you pay the seller directly from your own bank and the units come to you from escrow. "
                . "There is no step where you fund a balance here first. If you already hold a rupee "
                . "balance on the platform from earlier, it stays yours and you can withdraw it.",
        ],
        [
            'keys'  => ['withdraw', 'withdrawal', 'take out', 'payout', 'bank', 'redeem'],
            'title' => 'Withdrawals',
            'answer' => "Selling ARV does not pay into a platform balance any more — a peer-to-peer "
                . "buyer pays your own UPI ID or bank account directly, so the money arrives in your bank "
                . "without a withdrawal step. Withdrawals only apply to a rupee balance you already hold "
                . "here from earlier: request it from the Withdraw page and it is paid after an operator "
                . "approves it, with a minimum of {$f['minWithdraw']}. A pending request stays visible "
                . "until it is paid — that is normal, not an error.",
        ],
        [
            'keys'  => ['fee', 'fees', 'charge', 'charges', 'commission', 'gst', 'cost to trade'],
            'title' => 'Fees',
            'answer' => "On a peer-to-peer buy the platform fee is {$f['p2pFeePct']}%"
                . ((float)$f['p2pTdsPct'] > 0 ? " plus {$f['p2pTdsPct']}% TDS" : "")
                . ", and it is taken out of the ARV you receive rather than your rupees — the seller gets "
                . "the full amount you send them. A seller pays no platform fee. Nothing is deducted from "
                . "the money leaving your bank, and the exact figures are itemised on the order before you "
                . "confirm it, so there are no hidden charges.",
        ],
        [
            'keys'  => ['tax', 'taxes', 'tds', 'vda', 'capital gain', '30%', 'cess', 'pan'],
            'title' => 'Tax & TDS',
            'answer' => "On every sale, {$f['tdsPct']}% TDS is withheld (s.194S) and credited against your "
                . "tax — it is {$f['tdsNoPanPct']}% if no PAN is on file. Any gains may also be taxable "
                . "under India's Virtual Digital Asset rules, which you settle when you file; your Tax "
                . "statement page totals everything for the year with a FIFO cost basis. This is general "
                . "information, not tax advice — please check with your accountant for your own situation.",
        ],
        [
            'keys'  => ['otp', 'login', 'sign in', 'code', 'trusted device', 'verify', 'two factor', '2fa'],
            'title' => 'Login & OTP',
            'answer' => "You verify with an emailed code the first time you sign in on a new device. After "
                . "that the device is trusted for about " . round($f['trustHours'] / 24) . " days, so you "
                . "are not asked for a code every time on the same device. Signing out does not forget the "
                . "device.",
        ],
        [
            'keys'  => ['safe', 'security', 'legal', 'sebi', 'rbi', 'registered', 'regulated', 'risk', 'guarantee'],
            'title' => 'Safety & legal',
            'answer' => "Be clear-eyed: ARV is not registered with SEBI or the RBI, it is not a blockchain "
                . "token, and there is no capital protection — if Bitcoin falls, ARV falls the same. It is a "
                . "contractual claim on the platform for the rupee value of your units. Your money path uses "
                . "integer rupee accounting with an append-only ledger, and only the last four digits of "
                . "Aadhaar are ever stored.",
        ],
        [
            'keys'  => ['price', 'nav', 'how much', 'rate', 'value', 'current price', 'today'],
            'title' => 'The price',
            'answer' => "ARV's live price is on the home page and the Trade screen, in rupees (with the "
                . "dollar value beside it). It moves exactly with Bitcoin, tick by tick. The chart shows "
                . "the full history at every timeframe, matching Bitcoin's shape.",
        ],
        [
            'keys'  => ['order book', 'market', 'spread', 'depth', 'open order'],
            'title' => 'Orders & the market',
            'answer' => "There is no bid/ask spread — every trade settles at the index price, so there is "
                . "nothing to negotiate. An order rests until someone on the other side takes it, for up to "
                . "{$f['p2pOpenHrs']} hours, after which it expires and any escrow returns. Once matched it "
                . "becomes a trade with its own payment and confirmation window. The Orders page shows your "
                . "own resting orders and every trade you are in; it says 'None open' when you have none.",
        ],
        [
            'keys'  => ['contact', 'support', 'help', 'email', 'reach', 'complaint', 'problem'],
            'title' => 'Contact support',
            'answer' => "You can reach a human at {$f['support']}. Tell them your registered email and what "
                . "happened, and they will help.",
        ],
    ];
}

/** Intent match: score each topic by how many of its keywords the question hits. */
function kb_match(string $q, array $kb): ?array
{
    $ql = ' ' . mb_strtolower($q) . ' ';
    $best = null;
    $bestScore = 0;

    foreach ($kb as $entry) {
        $score = 0;
        foreach ($entry['keys'] as $k) {
            if (mb_strpos($ql, mb_strtolower($k)) !== false) {
                // Longer phrases are stronger signals than single words.
                $score += 1 + (mb_substr_count($k, ' '));
            }
        }
        if ($score > $bestScore) {
            $bestScore = $score;
            $best = $entry;
        }
    }
    return $bestScore > 0 ? $best : null;
}

function assistant_fallback(array $kb): string
{
    $topics = array_map(static fn($e) => $e['title'], $kb);
    // Drop the meta "what ARV is" duplication noise; keep it readable.
    $list = implode(', ', array_slice($topics, 0, 8));
    return "I can help with things like: {$list}. Try asking in a few more words — for example "
        . "\"how do I buy?\", \"what are the fees?\", or \"how is tax calculated?\". For anything else, "
        . "email " . SUPPORT_EMAIL . ".";
}

/* ============================================================== gemini ===== */

function assistant_system_prompt(array $f, array $kb): string
{
    $facts = "LIVE FACTS (use these exact numbers):\n"
        . "- Launch date: {$f['launchDate']}. ARV price = Bitcoin's percentage move since launch, in rupees.\n"
        // These are the facts the model answers from, so they describe the flow that
        // actually exists. Previously this block still said buys fill instantly and
        // sells fall back to the treasury, which is the legacy index path — the model
        // was being handed stale facts and was confidently telling customers to fund
        // a rupee balance that cannot buy anything.
        . "- Trading is PEER-TO-PEER and settles at the index price. A buyer is matched with a holder, "
        . "the holder's units go into escrow, the buyer pays that holder DIRECTLY (UPI/bank) from their "
        . "own bank, enters the reference, and the escrow is then released to the buyer.\n"
        . "- A buyer does NOT need an on-platform rupee balance. Never tell anyone to deposit before "
        . "buying. Rupees move bank-to-bank between the two people; the platform holds only the units.\n"
        . "- A seller must have a payment method saved (UPI/bank) to receive payment.\n"
        . "- P2P platform fee {$f['p2pFeePct']}%"
        . ((float)$f['p2pTdsPct'] > 0 ? " plus {$f['p2pTdsPct']}% TDS" : "")
        . ", deducted from the ARV the BUYER receives, never from rupees. Sellers pay no platform fee. "
        . "GST {$f['gstPct']}% and the entry/exit fees apply only to the legacy index path, which has no "
        . "form on any page — do not quote them as what a user will pay.\n"
        . "- Timers: an unmatched order rests up to {$f['p2pOpenHrs']}h; a matched buyer has "
        . "{$f['p2pPayMin']} minutes to pay; the seller then has {$f['p2pConfirmHrs']}h to confirm before "
        . "the trade goes to support to settle. Unpaid matches return the escrow to the seller.\n"
        . "- There is NO guaranteed instant exit on a sell: it waits for a buyer. Do not promise that the "
        . "platform or treasury will buy it back.\n"
        . "- Tax: {$f['vdaGainPct']}% + {$f['cessPct']}% cess on gains (s.115BBH); {$f['tdsPct']}% TDS per sale "
        . "(s.194S), {$f['tdsNoPanPct']}% without PAN; FIFO cost basis; losses not set off.\n"
        . "- Minimum order {$f['minOrder']}, minimum withdrawal {$f['minWithdraw']}.\n"
        . "- Deposit/withdraw still exist but only for a rupee balance held from earlier; they are not "
        . "part of buying or selling. Trusted device ~"
        . round($f['trustHours'] / 24) . " days.\n"
        . "- Not registered with SEBI/RBI; not a blockchain token; no capital protection. Support: {$f['support']}.\n";

    return "You are the support assistant for ARV Coin, an INR-denominated index unit that tracks "
        . "Bitcoin one-for-one. Answer ONLY questions about ARV and using the platform, in a friendly, "
        . "concise way (2-5 sentences). Use the live facts below and never invent fees, taxes, or promises. "
        . "You may reply in the user's language (English or Hindi/Hinglish). For tax or legal specifics, "
        . "give the factual rule and add that it is general information, not personal advice. If a question "
        . "is unrelated to ARV, gently steer back or point to {$f['support']}. Never claim ARV is a "
        . "registered/regulated security or guarantees returns.\n\n" . $facts;
}

/**
 * Ask Gemini. Returns the text answer, or null on any failure (caller then uses
 * the knowledge base). The API key stays server-side and is never returned.
 */
function gemini_answer(string $key, string $q, array $history, string $system): ?string
{
    $contents = [];
    // A little recent context helps follow-ups; cap it and only trust our shape.
    foreach (array_slice($history, -6) as $m) {
        if (!is_array($m) || !isset($m['role'], $m['text'])) {
            continue;
        }
        $role = $m['role'] === 'assistant' ? 'model' : 'user';
        $contents[] = ['role' => $role, 'parts' => [['text' => mb_substr((string)$m['text'], 0, 800)]]];
    }
    $contents[] = ['role' => 'user', 'parts' => [['text' => $q]]];

    $payload = json_encode([
        'systemInstruction' => ['parts' => [['text' => $system]]],
        'contents'          => $contents,
        'generationConfig'  => ['temperature' => 0.4, 'maxOutputTokens' => 500],
    ]);

    $model = 'gemini-1.5-flash';
    $url = 'https://generativelanguage.googleapis.com/v1beta/models/' . $model
         . ':generateContent?key=' . urlencode($key);

    $raw = assistant_http_post($url, $payload);
    if ($raw === null) {
        return null;
    }
    $data = json_decode($raw, true);
    if (!is_array($data) || !isset($data['candidates'][0]['content']['parts'])) {
        return null;
    }
    $text = '';
    foreach ($data['candidates'][0]['content']['parts'] as $part) {
        if (isset($part['text'])) {
            $text .= $part['text'];
        }
    }
    $text = trim($text);
    return $text === '' ? null : $text;
}

function assistant_http_post(string $url, string $json, int $timeout = 15): ?string
{
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => $json,
            CURLOPT_TIMEOUT        => $timeout,
            CURLOPT_CONNECTTIMEOUT => 6,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_USERAGENT      => 'ARV/3.0 (+assistant)',
            CURLOPT_HTTPHEADER     => ['Content-Type: application/json', 'Accept: application/json'],
        ]);
        $body = curl_exec($ch);
        $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        return ($body !== false && $code === 200) ? (string)$body : null;
    }

    $ctx = stream_context_create([
        'http' => [
            'method'  => 'POST',
            'header'  => "Content-Type: application/json\r\nAccept: application/json\r\n",
            'content' => $json,
            'timeout' => $timeout,
            'ignore_errors' => true,
        ],
        'ssl' => ['verify_peer' => true, 'verify_peer_name' => true],
    ]);
    $body = @file_get_contents($url, false, $ctx);
    return $body === false ? null : (string)$body;
}
