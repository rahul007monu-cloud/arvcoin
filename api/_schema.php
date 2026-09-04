<?php
/**
 * Database schema.
 *
 * Returned as an ordered list of statements so the installer can apply them and
 * the admin panel can verify them. Every statement is idempotent — safe to run
 * against an existing database.
 *
 * Conventions that hold everywhere:
 *
 *   Money is BIGINT paise. Never DECIMAL, never FLOAT, never "rupees". A float
 *   money column eventually produces a ledger that does not balance, and in a
 *   financial product that is not a rounding bug — it is missing money.
 *
 *   ARV units are DECIMAL(28,8). Exact decimal, so the database is the source of
 *   truth and PHP rounding cannot drift away from it.
 *
 *   Prices are DECIMAL(20,8).
 *
 *   Every table is InnoDB, so transactions and row locking actually work. The
 *   matching engine depends on SELECT ... FOR UPDATE; on MyISAM it would happily
 *   fill the same order twice under concurrency.
 */

declare(strict_types=1);

/**
 * Bumped whenever arv_schema() or arv_migrations() changes, so an operator can see
 * at a glance whether a deployment has caught up with its own database.
 */
// Bumped whenever a migration or one-time repair is added, since the catch-up is
// gated on it. 7 re-queues the weekly backfill on installs that finished before
// 1W joined the chain. 8 rescales the index to ~₹1000 and moves the launch anchor
// back to 2015-07-20: it migrates the four anchor settings (only if still on the
// old defaults), rescales existing holding UNIT COUNTS by the NAV factor F so
// value and paise cost basis are preserved, and re-queues the full backfill so
// arv_candles are rebuilt for the new base and deeper launch.
// 9 is a CORRECTIVE anchor + full candle rebuild: it retargets today's NAV to
// ~₹10,000 (arv_base_inr 1.78 → 17.83) and FORCE-sets the four anchor settings
// unconditionally (settings carry no money), then re-queues an UNCONDITIONAL
// candle rebuild so the mixed-anchor arv_candles left by v8 (old-anchor history
// that backfill skipped on row count, new-anchor fresh minutes → an end-of-chart
// spike) are all recomputed to the single current anchor. It does NOT re-run the
// v8 unit rescale and never touches wallets, lots, or the ledger — only candles,
// backfill scheduling, and settings.
//
// 10 is a FORCEFUL CANDLE REBUILD and retarget to ~$100 USD today (~₹9,000):
// The v9 rebuild flag arv_candles_rebuild_v9 was set but NEVER consumed because
// auto_backfill_step() early-returns when auto_backfill_next is 'done' or
// 'stalled' (leftover from the v8 run) — the rebuild flag was set but the chain
// never advanced past that early-return to read it. Old ₹2 candles survived,
// new-anchor ingest wrote recent minutes only → the end-of-chart spike.
// This migration: (a) guards units_rescaled_v8 (never re-rescale), (b) DELETES
// all arv_candles rows outright (candles carry no money — safe), (c) force-sets
// all four anchor settings to the $100-today anchor (arv_base_inr=21.08), and
// (d) resets the backfill chain from '1D' so the full rebuild runs cleanly.
// Also: a self-healing check is added at the TOP of auto_backfill_step() so that
// if the chain is 'done'/'stalled' but candles_wiped_v10 is set, it is reset to
// '1D' immediately, catching any future deploy-ordering edge case.
//
// 11 makes the ARV CHART DERIVE FROM BTC's asset_candles instead of the fragile
// separate arv_candles series (see market.php handle_candles()). ARV is BTC
// scaled by a constant, so the chart is now built on the fly from the same
// reliably-backfilled asset_candles that power the coin charts — always as full
// as the BTC chart, at every timeframe, with no dependency on the
// arv_candles backfill/wipe/chain that broke the chart repeatedly. For that BTC
// must have full asset_candles history at every timeframe; it previously did not
// (ingest wrote only BTC 1m; backfill_asset_tf()/rollup_assets()/
// auto_backfill_after() excluded it). Those now include BTC, and this migration
// re-queues the backfill chain from the head so the new BTC asset steps actually
// run on installs whose chain had already reached 'done'. Candles/scheduling/
// settings only — no wallet, lot, ledger, or unit writes.
//
// 12 is a CORRECTIVE UNIT RESCALE — a money-path repair. Schema-8 correctly
// paired its anchor move (arv_base_inr 1.0 → 1.78) with a rescale of every
// holding's UNIT COUNT by F = newNav/oldNav, so value = units × NAV and paise
// cost basis were preserved. But schema-9 (1.78 → 17.83) and schema-10
// (17.83 → 21.08) BOTH changed the anchor WITHOUT rescaling units. So on the
// live DB the anchor is 21.08 while unit counts are still at the 1.78 scale
// (last rescaled at v8): NAV = base × (BTC market terms that CANCEL) is
// (21.08/1.78) ≈ 11.84× too high relative to the units, so value = units × NAV
// is inflated ~11.84× while invested_paise (real rupees) is unchanged → a
// phantom unrealised profit of ~11.84×. Schema-12 fixes ONLY the unit counts:
// it divides qualifying old-anchor unit counts by F = 21.08/1.78, multiplies
// their lots.nav by F, recomputes each wallet from its own lots, posts one
// compensating append-only ledger 'adjustment' per affected holder (ref
// rescale_v12) so the reconcile stays balanced, and zeroes dust — mirroring v8
// EXACTLY. It does NOT change any anchor setting (21.08 is correct) and never
// touches invested_paise / cost_paise / realised P&L.
//
// !!!  INVARIANT FOR ALL FUTURE MIGRATIONS  !!!
// NAV = arv_base_inr × (BTC_now_inr / BTC_launch_inr). ANY change to
// arv_base_inr (or the launch/base_btc_usd/base_fx_usd_inr anchors that define
// NAV) rescales every existing holding's value by a constant factor F. A change
// to those settings MUST be paired with a unit-count rescale like schema-8/12
// (divide unit counts by F, multiply lots.nav by F, post a compensating ledger
// adjustment, recompute wallets from lots), or every existing holding's value —
// and its unrealised P&L — is silently multiplied by F. Schema-9 and schema-10
// forgot this and created the very bug schema-12 repairs. Do NOT repeat it.
const ARV_SCHEMA_VERSION = 12;

function arv_schema(): array
{
    return [

    /* ==================================================== settings ======== */
    // Server-side source of truth for anything that decides money. arv-config.js
    // is a convenience copy for the UI; when the two disagree, this wins.
    "CREATE TABLE IF NOT EXISTS settings (
        skey            VARCHAR(64)  NOT NULL PRIMARY KEY,
        svalue          TEXT         NOT NULL,
        updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
                        ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

    /* ======================================================= users ======== */
    "CREATE TABLE IF NOT EXISTS users (
        id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        email           VARCHAR(190) NOT NULL,
        pass_hash       VARCHAR(255) NOT NULL,
        full_name       VARCHAR(120) NOT NULL DEFAULT '',
        phone           VARCHAR(20)  NOT NULL DEFAULT '',

        email_verified  TINYINT(1)   NOT NULL DEFAULT 0,

        -- Google's account identifier (the `sub` claim), for people who signed in
        -- with Google. NULL for everyone else, and unique so one Google account
        -- cannot be attached to two local accounts.
        --
        -- Matched on in preference to the email address, because an email address
        -- is not a stable identity: Google accounts can change theirs, and a
        -- corporate address can be reassigned to a different person entirely.
        -- `sub` never changes and is never reused.
        google_sub      VARCHAR(40)  NULL,
        referral_code   VARCHAR(16)  NOT NULL,
        referred_by     BIGINT UNSIGNED NULL,

        -- Earned from referred volume. Decides the fee discount.
        tier_id         VARCHAR(24)  NOT NULL DEFAULT '',
        tier_earned_at  DATETIME     NULL,

        is_admin        TINYINT(1)   NOT NULL DEFAULT 0,
        is_specified_person TINYINT(1) NOT NULL DEFAULT 0,
        status          ENUM('active','suspended','closed') NOT NULL DEFAULT 'active',

        last_login_at   DATETIME     NULL,
        created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
                        ON UPDATE CURRENT_TIMESTAMP,

        UNIQUE KEY uq_users_email (email),
        UNIQUE KEY uq_users_refcode (referral_code),
        UNIQUE KEY uq_users_google (google_sub),
        KEY idx_users_referred_by (referred_by),
        CONSTRAINT fk_users_referrer FOREIGN KEY (referred_by)
            REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

    /* ======================================================== otps ======== */
    // Codes are stored hashed. An OTP table in plaintext is a password table in
    // plaintext with a shorter lifetime.
    "CREATE TABLE IF NOT EXISTS otps (
        id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id         BIGINT UNSIGNED NOT NULL,
        purpose         ENUM('signup','login','withdraw','email_change') NOT NULL,
        code_hash       VARCHAR(255) NOT NULL,
        attempts        INT UNSIGNED NOT NULL DEFAULT 0,
        expires_at      DATETIME     NOT NULL,
        used_at         DATETIME     NULL,
        created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

        -- Delivery, and the escape hatch when it fails.
        --
        -- A code that cannot be emailed locks the account out of its own signin,
        -- and because the first login always needs one, a server with broken mail
        -- locks out *everybody* — including the operator, who is then unable to
        -- reach the settings page that would tell them why. That is a dead end with
        -- no way back in.
        --
        -- So when delivery fails the code is written here in plain text, where the
        -- person holding the database can read it and get in. That is not a
        -- weakening: anyone with write access to this table could already replace a
        -- password hash. It is only ever populated when the email did not go, it is
        -- cleared the moment the code is used or expires, and admin.php reports it
        -- loudly so it cannot sit unnoticed.
        delivered       TINYINT(1)   NOT NULL DEFAULT 1,
        undelivered_code VARCHAR(6)  NOT NULL DEFAULT '',

        KEY idx_otps_lookup (user_id, purpose, used_at),
        KEY idx_otps_expiry (expires_at),
        CONSTRAINT fk_otps_user FOREIGN KEY (user_id)
            REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

    /* ========================================================= kyc ======== */
    //
    // PAN is stored: it is required to apply the correct TDS rate, and holding it
    // is lawful.
    //
    // Aadhaar is NOT stored. Only the last four digits, for display, plus a
    // reference returned by a licensed verification provider. Keeping a full
    // Aadhaar number or image without being a licensed KUA/AUA is an offence
    // under the Aadhaar Act, 2016 and carries imprisonment — so the column to
    // hold one deliberately does not exist. Do not add it.
    //
    "CREATE TABLE IF NOT EXISTS kyc (
        user_id         BIGINT UNSIGNED NOT NULL PRIMARY KEY,
        status          ENUM('none','pending','verified','rejected') NOT NULL DEFAULT 'none',

        full_name       VARCHAR(120) NOT NULL DEFAULT '',
        dob             DATE         NULL,
        pan             VARCHAR(10)  NOT NULL DEFAULT '',
        pan_verified    TINYINT(1)   NOT NULL DEFAULT 0,

        address_line    VARCHAR(255) NOT NULL DEFAULT '',
        city            VARCHAR(80)  NOT NULL DEFAULT '',
        state           VARCHAR(80)  NOT NULL DEFAULT '',
        pincode         VARCHAR(10)  NOT NULL DEFAULT '',

        aadhaar_last4   CHAR(4)      NOT NULL DEFAULT '',
        aadhaar_provider VARCHAR(40) NOT NULL DEFAULT '',
        aadhaar_ref     VARCHAR(120) NOT NULL DEFAULT '',
        aadhaar_verified TINYINT(1)  NOT NULL DEFAULT 0,

        upi_vpa         VARCHAR(120) NOT NULL DEFAULT '',

        submitted_at    DATETIME     NULL,
        reviewed_at     DATETIME     NULL,
        reviewed_by     BIGINT UNSIGNED NULL,
        reject_reason   VARCHAR(255) NOT NULL DEFAULT '',

        KEY idx_kyc_status (status),
        KEY idx_kyc_pan (pan),
        CONSTRAINT fk_kyc_user FOREIGN KEY (user_id)
            REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

    /* ===================================================== wallets ======== */
    //
    // Two balances per currency: available and locked.
    //
    // Locking is what makes an order book safe. When a sell order rests, its
    // units move from available to locked; when a buy order rests, its rupees do.
    // Without that split a user could place ten sell orders for the same units
    // and the engine would fill all ten.
    //
    "CREATE TABLE IF NOT EXISTS wallets (
        user_id             BIGINT UNSIGNED NOT NULL PRIMARY KEY,

        inr_paise           BIGINT NOT NULL DEFAULT 0,
        inr_locked_paise    BIGINT NOT NULL DEFAULT 0,

        arv_units           DECIMAL(28,8) NOT NULL DEFAULT 0,
        arv_locked_units    DECIMAL(28,8) NOT NULL DEFAULT 0,

        -- Cost basis of currently held units, for unrealised P&L.
        invested_paise      BIGINT NOT NULL DEFAULT 0,
        realised_pnl_paise  BIGINT NOT NULL DEFAULT 0,

        updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                            ON UPDATE CURRENT_TIMESTAMP,

        CONSTRAINT fk_wallets_user FOREIGN KEY (user_id)
            REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT chk_wallet_nonneg CHECK (
            inr_paise >= 0 AND inr_locked_paise >= 0
            AND arv_units >= 0 AND arv_locked_units >= 0
        )
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

    /* ======================================================== lots ======== */
    // FIFO cost basis. Each buy fill creates one; each sell fill consumes the
    // oldest open lots first. The lot's cost is the net rupees that bought it and
    // nothing else, because s.115BBH allows only cost of acquisition.
    "CREATE TABLE IF NOT EXISTS lots (
        id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id         BIGINT UNSIGNED NOT NULL,
        units           DECIMAL(28,8) NOT NULL,
        units_remaining DECIMAL(28,8) NOT NULL,
        cost_paise      BIGINT       NOT NULL,
        nav             DECIMAL(20,8) NOT NULL,
        trade_id        BIGINT UNSIGNED NULL,
        acquired_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

        KEY idx_lots_fifo (user_id, acquired_at),
        KEY idx_lots_open (user_id, units_remaining),
        CONSTRAINT fk_lots_user FOREIGN KEY (user_id)
            REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT chk_lots_remaining CHECK (units_remaining >= 0 AND units_remaining <= units)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

    /* ====================================================== orders ======== */
    //
    // A 'limit' order here is a TRIGGER, not a price offer. Because every match
    // settles at the index price, "limit" means "act when the index reaches this
    // level" — buy at or below, sell at or above. There is no price to negotiate,
    // so there is nothing for a counterparty to accept or reject.
    //
    "CREATE TABLE IF NOT EXISTS orders (
        id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        ref             VARCHAR(32)  NOT NULL,
        user_id         BIGINT UNSIGNED NOT NULL,

        side            ENUM('buy','sell') NOT NULL,
        otype           ENUM('market','limit') NOT NULL,

        -- For buys the user names an amount of rupees; for sells, units.
        amount_paise    BIGINT       NULL,
        units           DECIMAL(28,8) NULL,

        trigger_nav     DECIMAL(20,8) NULL,

        filled_units    DECIMAL(28,8) NOT NULL DEFAULT 0,
        filled_paise    BIGINT       NOT NULL DEFAULT 0,

        -- What is held in escrow while this order rests.
        locked_paise    BIGINT       NOT NULL DEFAULT 0,
        locked_units    DECIMAL(28,8) NOT NULL DEFAULT 0,

        status          ENUM('open','triggered','partial','filled','cancelled','expired')
                        NOT NULL DEFAULT 'open',

        -- When the treasury may step in as counterparty for an unmatched sell.
        fallback_at     DATETIME     NULL,
        expires_at      DATETIME     NULL,

        created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
                        ON UPDATE CURRENT_TIMESTAMP,

        UNIQUE KEY uq_orders_ref (ref),
        -- The matching engine's hot path: open orders on one side, oldest first.
        KEY idx_orders_book (status, side, created_at),
        KEY idx_orders_user (user_id, created_at),
        KEY idx_orders_fallback (status, fallback_at),
        CONSTRAINT fk_orders_user FOREIGN KEY (user_id)
            REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

    /* ====================================================== trades ======== */
    //
    // One row per fill. `counterparty` records whether the other side was a real
    // user or the treasury — the difference matters for reconciliation, because a
    // treasury fill changes how much Bitcoin must be held.
    //
    "CREATE TABLE IF NOT EXISTS trades (
        id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        ref             VARCHAR(32)  NOT NULL,

        buy_order_id    BIGINT UNSIGNED NULL,
        sell_order_id   BIGINT UNSIGNED NULL,
        buyer_id        BIGINT UNSIGNED NULL,
        seller_id       BIGINT UNSIGNED NULL,

        counterparty    ENUM('user','treasury') NOT NULL,

        units           DECIMAL(28,8) NOT NULL,
        nav             DECIMAL(20,8) NOT NULL,
        gross_paise     BIGINT       NOT NULL,

        buyer_fee_paise BIGINT       NOT NULL DEFAULT 0,
        buyer_gst_paise BIGINT       NOT NULL DEFAULT 0,

        seller_fee_paise BIGINT      NOT NULL DEFAULT 0,
        seller_gst_paise BIGINT      NOT NULL DEFAULT 0,
        seller_tds_paise BIGINT      NOT NULL DEFAULT 0,
        seller_net_paise BIGINT      NOT NULL DEFAULT 0,

        -- Seller's tax position on this fill. The 30% + cess is reported, never
        -- withheld: it is the holder's own liability at filing.
        cost_basis_paise BIGINT      NULL,
        realised_pnl_paise BIGINT    NULL,
        tax_paise       BIGINT       NULL,
        cess_paise      BIGINT       NULL,

        fy              VARCHAR(9)   NOT NULL DEFAULT '',
        created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

        UNIQUE KEY uq_trades_ref (ref),
        KEY idx_trades_time (created_at),
        KEY idx_trades_buyer (buyer_id, created_at),
        KEY idx_trades_seller (seller_id, created_at),
        KEY idx_trades_fy (seller_id, fy)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

    /* ==================================================== deposits ======== */
    //
    // A UPI QR returns nothing to the server — no callback, no signature. So a
    // deposit is never credited because a QR was displayed. The user submits a
    // UTR or a screenshot, and an operator matches it against the bank statement.
    //
    "CREATE TABLE IF NOT EXISTS deposits (
        id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        ref             VARCHAR(32)  NOT NULL,
        user_id         BIGINT UNSIGNED NOT NULL,

        amount_paise    BIGINT       NOT NULL,
        status          ENUM('awaiting_payment','submitted','confirmed','rejected','expired')
                        NOT NULL DEFAULT 'awaiting_payment',

        utr             VARCHAR(40)  NOT NULL DEFAULT '',
        screenshot_path VARCHAR(255) NOT NULL DEFAULT '',
        qr_payload      TEXT         NULL,

        submitted_at    DATETIME     NULL,
        confirmed_at    DATETIME     NULL,
        confirmed_by    BIGINT UNSIGNED NULL,
        reject_reason   VARCHAR(255) NOT NULL DEFAULT '',
        expires_at      DATETIME     NULL,

        created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

        UNIQUE KEY uq_deposits_ref (ref),
        KEY idx_deposits_user (user_id, created_at),
        KEY idx_deposits_queue (status, submitted_at),
        -- A UTR identifies exactly one bank transfer, so the same one must never
        -- credit two deposits. Empty strings are excluded by the app, not here,
        -- because MySQL treats every '' as equal.
        KEY idx_deposits_utr (utr),
        CONSTRAINT fk_deposits_user FOREIGN KEY (user_id)
            REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

    /* ================================================= withdrawals ======== */
    "CREATE TABLE IF NOT EXISTS withdrawals (
        id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        ref             VARCHAR(32)  NOT NULL,
        user_id         BIGINT UNSIGNED NOT NULL,

        amount_paise    BIGINT       NOT NULL,
        upi_vpa         VARCHAR(120) NOT NULL,

        status          ENUM('requested','approved','paid','rejected') NOT NULL DEFAULT 'requested',

        utr             VARCHAR(40)  NOT NULL DEFAULT '',
        approved_at     DATETIME     NULL,
        paid_at         DATETIME     NULL,
        handled_by      BIGINT UNSIGNED NULL,
        reject_reason   VARCHAR(255) NOT NULL DEFAULT '',

        -- The window promised to the user when they requested it.
        promised_by     DATETIME     NULL,

        created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

        UNIQUE KEY uq_withdrawals_ref (ref),
        KEY idx_withdrawals_user (user_id, created_at),
        KEY idx_withdrawals_queue (status, created_at),
        CONSTRAINT fk_withdrawals_user FOREIGN KEY (user_id)
            REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

    /* ====================================================== ledger ======== */
    //
    // Every movement of rupees or units, once, append-only. This is the book of
    // record: wallets are a cached balance, and the ledger is what they must add
    // up to. The reconciliation view in the admin panel is exactly that check.
    //
    // A correction is a new compensating entry, never an edit. Enforced by
    // trigger below, not by convention.
    //
    "CREATE TABLE IF NOT EXISTS ledger (
        id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id         BIGINT UNSIGNED NULL,
        kind            ENUM(
                          'deposit','withdrawal',
                          'buy','sell',
                          'fee','gst','tds',
                          'referral_commission',
                          'adjustment','reversal'
                        ) NOT NULL,

        -- Signed from the user's point of view: positive is into their balance.
        inr_delta_paise BIGINT       NOT NULL DEFAULT 0,
        arv_delta_units DECIMAL(28,8) NOT NULL DEFAULT 0,

        nav             DECIMAL(20,8) NULL,
        ref             VARCHAR(32)  NOT NULL DEFAULT '',
        related_id      BIGINT UNSIGNED NULL,
        note            VARCHAR(255) NOT NULL DEFAULT '',
        fy              VARCHAR(9)   NOT NULL DEFAULT '',
        created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

        KEY idx_ledger_user (user_id, created_at),
        KEY idx_ledger_kind (kind, created_at),
        KEY idx_ledger_ref (ref)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

    /* =================================================== referrals ======== */
    "CREATE TABLE IF NOT EXISTS referrals (
        id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        referrer_id       BIGINT UNSIGNED NOT NULL,
        referee_id        BIGINT UNSIGNED NOT NULL,

        -- The referee's first confirmed deposit, and the commission it earned.
        trigger_deposit_id BIGINT UNSIGNED NULL,
        base_paise        BIGINT       NOT NULL DEFAULT 0,
        commission_paise  BIGINT       NOT NULL DEFAULT 0,
        commission_pct    DECIMAL(6,3) NOT NULL DEFAULT 0,

        status            ENUM('pending','paid','void') NOT NULL DEFAULT 'pending',
        paid_at           DATETIME     NULL,
        created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

        -- One commission per referred user, ever. The config says first deposit
        -- only; this makes it structurally true.
        UNIQUE KEY uq_referrals_referee (referee_id),
        KEY idx_referrals_referrer (referrer_id, status),
        CONSTRAINT fk_ref_referrer FOREIGN KEY (referrer_id)
            REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT fk_ref_referee FOREIGN KEY (referee_id)
            REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

    /* ================================================ market data ========= */
    "CREATE TABLE IF NOT EXISTS arv_candles (
        tf              VARCHAR(4)   NOT NULL,
        ts              DATETIME     NOT NULL,
        open            DECIMAL(20,8) NOT NULL,
        high            DECIMAL(20,8) NOT NULL,
        low             DECIMAL(20,8) NOT NULL,
        close           DECIMAL(20,8) NOT NULL,
        volume          DECIMAL(28,8) NOT NULL DEFAULT 0,
        fx_rate         DECIMAL(20,8) NULL,
        is_final        TINYINT(1)   NOT NULL DEFAULT 1,
        source          VARCHAR(24)  NOT NULL DEFAULT '',
        PRIMARY KEY (tf, ts),
        KEY idx_arv_candles_desc (tf, ts DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

    "CREATE TABLE IF NOT EXISTS asset_candles (
        asset_key       VARCHAR(12)  NOT NULL,
        tf              VARCHAR(4)   NOT NULL,
        ts              DATETIME     NOT NULL,
        open            DECIMAL(20,8) NOT NULL,
        high            DECIMAL(20,8) NOT NULL,
        low             DECIMAL(20,8) NOT NULL,
        close           DECIMAL(20,8) NOT NULL,
        volume          DECIMAL(28,8) NOT NULL DEFAULT 0,
        source          VARCHAR(24)  NOT NULL DEFAULT '',
        PRIMARY KEY (asset_key, tf, ts)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

    // Per-day USD/INR. Historical candles must be valued at the rate of their
    // own day; applying today's rate to old candles rewrites the currency move
    // as though it were a Bitcoin move.
    "CREATE TABLE IF NOT EXISTS fx_rates (
        day             DATE         NOT NULL PRIMARY KEY,
        usd_inr         DECIMAL(20,8) NOT NULL,
        source          VARCHAR(40)  NOT NULL DEFAULT '',
        created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

    /* ================================================== audit log ========= */
    "CREATE TABLE IF NOT EXISTS audit_log (
        id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        actor_id        BIGINT UNSIGNED NULL,
        action          VARCHAR(64)  NOT NULL,
        entity          VARCHAR(40)  NOT NULL DEFAULT '',
        entity_id       VARCHAR(64)  NOT NULL DEFAULT '',
        detail          TEXT         NULL,
        ip              VARCHAR(45)  NOT NULL DEFAULT '',
        user_agent      VARCHAR(255) NOT NULL DEFAULT '',
        created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        KEY idx_audit_time (created_at),
        KEY idx_audit_actor (actor_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

    /* =============================================== rate limiting ======== */
    // Login, OTP send and order placement all need a brake. Kept in the database
    // rather than in memory because shared hosting gives no shared cache.
    "CREATE TABLE IF NOT EXISTS rate_limits (
        bucket          VARCHAR(120) NOT NULL PRIMARY KEY,
        hits            INT UNSIGNED NOT NULL DEFAULT 0,
        window_start    DATETIME     NOT NULL,
        blocked_until   DATETIME     NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

    /* ================================================== cron runs ========= */
    // So the admin panel can say when the price feed last succeeded — and so
    // trading can refuse to price anything from a stale feed.
    "CREATE TABLE IF NOT EXISTS cron_runs (
        job             VARCHAR(40)  NOT NULL PRIMARY KEY,
        last_run_at     DATETIME     NULL,
        last_ok_at      DATETIME     NULL,
        last_status     VARCHAR(16)  NOT NULL DEFAULT '',
        last_message    VARCHAR(255) NOT NULL DEFAULT '',
        run_count       BIGINT UNSIGNED NOT NULL DEFAULT 0,
        fail_count      BIGINT UNSIGNED NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
    ];
}

/**
 * Triggers that make the ledger genuinely append-only.
 *
 * Kept apart from the tables because some shared hosts disable trigger creation
 * for the database user. If these fail the installer says so rather than
 * pretending the guarantee exists — the application never updates the ledger
 * either way, but a guarantee enforced only by application code is a guarantee
 * that survives exactly until someone opens phpMyAdmin.
 */
function arv_triggers(): array
{
    return [
        "DROP TRIGGER IF EXISTS trg_ledger_no_update",
        "CREATE TRIGGER trg_ledger_no_update BEFORE UPDATE ON ledger
         FOR EACH ROW
         SIGNAL SQLSTATE '45000'
         SET MESSAGE_TEXT = 'ledger is append-only: post a compensating entry instead of editing'",

        "DROP TRIGGER IF EXISTS trg_ledger_no_delete",
        "CREATE TRIGGER trg_ledger_no_delete BEFORE DELETE ON ledger
         FOR EACH ROW
         SIGNAL SQLSTATE '45000'
         SET MESSAGE_TEXT = 'ledger is append-only: rows cannot be deleted'",

        "DROP TRIGGER IF EXISTS trg_trades_no_update",
        "CREATE TRIGGER trg_trades_no_update BEFORE UPDATE ON trades
         FOR EACH ROW
         SIGNAL SQLSTATE '45000'
         SET MESSAGE_TEXT = 'trades are immutable once recorded'",

        "DROP TRIGGER IF EXISTS trg_trades_no_delete",
        "CREATE TRIGGER trg_trades_no_delete BEFORE DELETE ON trades
         FOR EACH ROW
         SIGNAL SQLSTATE '45000'
         SET MESSAGE_TEXT = 'trades are immutable once recorded'",
    ];
}

/**
 * Server-side defaults.
 *
 * These mirror arv-config.js but are what actually decides money. Written once
 * at install; the admin panel edits them afterwards.
 */
function arv_default_settings(): array
{
    return [
        // Launch is ~ten years back (2015-07-20, Coinbase's BTC-USD listing day
        // and the earliest date a free exchange API reliably serves daily BTC
        // candles) so the chart carries several full cycles. Both figures are
        // real, published observations for that date — BTC/USD daily open ≈ $277.89,
        // USD/INR ≈ 63.50 — and neither is ever revised, because the whole index
        // hangs off them. arv_base_inr is chosen with the launch so today's price
        // sits near ₹10,000: NAV_today = base * (btcNowInr / (base_btc_usd*base_fx)).
        // With btcNow≈$110k and fx≈90 the now/launch multiple is ~561, so
        // 17.83 * 561 ≈ 10,000. Because NAV_launch == arv_base_inr, the launch
        // value honestly reads ~₹17.83 — the real consequence of tracking BTC's
        // genuine ~560x run. Deep history is daily/weekly only; no free source
        // serves minute data this far back (see README, "A note on history depth").
        'arv_base_inr'          => '21.08',
        'launch_at'             => '2015-07-20 00:00:00',
        'base_btc_usd'          => '277.89',
        'base_fx_usd_inr'       => '63.50',
        'quote'                 => 'INR',

        'entry_fee_pct'         => '0.5',
        'exit_fee_pct'          => '0.5',
        'gst_pct'               => '18',
        'slippage_pct'          => '0.05',

        'vda_gain_pct'          => '30',
        'cess_pct'              => '4',
        'tds_pct'              => '1',
        'tds_pct_no_pan'        => '20',
        'tds_threshold_paise'   => '1000000',
        'tds_threshold_specified_paise' => '5000000',

        'min_order_paise'       => '10000',
        'min_withdraw_paise'    => '10000',
        'match_at_index_price'  => '1',
        'buy_fills_from_treasury' => '1',
        'sell_fallback_to_treasury' => '1',
        'sell_fallback_minutes' => '60',
        'order_expiry_hours'    => '168',

        'deposit_min_minutes'   => '2',
        'deposit_max_minutes'   => '15',
        'withdraw_min_minutes'  => '5',
        'withdraw_max_minutes'  => '60',

        'referral_enabled'      => '1',
        'referral_pct'          => '5',
        'referral_max_paise'    => '5000000',

        'kyc_required'          => '1',
        'upi_vpa'               => '',
        'payee_name'            => 'ARV Coin',

        // Trading refuses to price anything from a feed older than this. Better a
        // visible pause than a fill at yesterday's number.
        'price_max_age_seconds' => '600',

        // The chart builds itself over the first few cron runs after an install,
        // one timeframe at a time: daily, weekly, hourly, 15m, 5m, then minute,
        // then 'done'. The deep daily/weekly series reaches back to launch (~2015);
        // the sub-hour series only cover the recent window a free API will page.
        // Nobody should have to press a button to get history the launch date
        // already determines.
        'auto_backfill'         => '1',
        'auto_backfill_next'    => '1D',
        'auto_backfill_fails'   => '0',

        // Fallback scheduling. A page request that finds the price behind refreshes
        // it, so the platform works before a cron exists and keeps working if one
        // stops. The cron is still the reliable path — this only runs when somebody
        // visits, so an idle site has an idle chart. Set to 0 once the scheduler is
        // known good and you would rather no visitor ever pays for a fetch.
        'web_tick'              => '1',
        'web_tick_min_seconds'  => '45',
        'web_tick_at'           => '0',

        // How long a device that has entered a code is left alone.
        //
        // Applied automatically, so the common case — the same phone, several
        // times a day — is one code and then nothing. Asking every time trains
        // people to copy six digits out of a notification without reading the
        // message, which is exactly the reflex an OTP phishing attempt needs.
        // 30 days. Long enough that a personal phone is genuinely not nagged, which
        // was the whole complaint. Not cleared on sign-out — device trust waives
        // only the emailed code, never the password — so signing out and back in
        // does not re-trigger it. The shared-computer opt-out on the form is how
        // someone declines it, and login_otp_always forces a code regardless.
        'trust_hours'           => '720',

        // Google sign-in. Empty means the feature is off and the button is not
        // rendered at all — not shown-and-broken. The client ID is public by
        // design (it ships to the browser), which is why it lives here rather
        // than in config.local.php; there is no client *secret* in this flow.
        'google_client_id'      => '',
        'google_jwks'           => '',
        'google_jwks_at'        => '0',

        'maintenance_mode'      => '0',
        'schema_version'        => (string)ARV_SCHEMA_VERSION,
    ];
}


/* ========================================================== migrations ===== */

/**
 * Bring an existing database up to the current schema.
 *
 * `arv_schema()` is all `CREATE TABLE IF NOT EXISTS`, which is exactly right for a
 * fresh install and useless for an existing one: a new column on a table that
 * already exists is silently skipped, and the code that expects it then fails at
 * runtime on the live site.
 *
 * Every step here is written to be safe to run repeatedly and safe to run out of
 * order, because that is the only kind of migration that survives contact with a
 * shared host — there is no reliable place to record "step 4 ran" that cannot
 * itself be lost, so each step asks the database what it actually looks like
 * instead of trusting a version number.
 *
 * Called once per cron run. The cost when there is nothing to do is one query
 * against information_schema.
 *
 * @return string[] Descriptions of what was changed, empty when already current.
 */
function arv_migrations(PDO $pdo): array
{
    $done = [];

    $hasColumn = static function (string $table, string $column) use ($pdo): bool {
        $st = $pdo->prepare(
            'SELECT 1 FROM information_schema.columns
              WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?'
        );
        $st->execute([$table, $column]);
        return (bool)$st->fetchColumn();
    };

    // Added when it became clear that a host with broken mail locks every account,
    // operator included, out of a login it can never complete.
    if (!$hasColumn('otps', 'delivered')) {
        $pdo->exec('ALTER TABLE otps
                      ADD COLUMN delivered TINYINT(1) NOT NULL DEFAULT 1,
                      ADD COLUMN undelivered_code VARCHAR(6) NOT NULL DEFAULT \'\'');
        $done[] = 'otps: added delivered, undelivered_code';
    }

    // Google sign-in. Nullable and unique: NULL for every password account, and
    // one Google account can only ever point at one local account.
    if (!$hasColumn('users', 'google_sub')) {
        $pdo->exec('ALTER TABLE users
                      ADD COLUMN google_sub VARCHAR(40) NULL AFTER email_verified,
                      ADD UNIQUE KEY uq_users_google (google_sub)');
        $done[] = 'users: added google_sub';
    }

    // Repair, not a schema change: give every account the rows it cannot work
    // without.
    //
    // `kyc` and `wallets` are one-per-user and created alongside the user, so in
    // principle nobody can be missing one. In practice an account was, and the
    // consequences were invisible until the worst moment: submitting KYC updated
    // no row, discarded the details, and answered with a generic 500, while a
    // missing wallet reports a null balance rather than an error.
    //
    // Cheap and idempotent — two anti-joins that select nothing once everybody has
    // both — so it runs on every catch-up rather than once, and an account that
    // loses a row later is repaired the next time anybody loads a page.
    $missingKyc = (int)$pdo->query(
        'SELECT COUNT(*) FROM users u LEFT JOIN kyc k ON k.user_id = u.id WHERE k.user_id IS NULL'
    )->fetchColumn();
    if ($missingKyc > 0) {
        $pdo->exec('INSERT INTO kyc (user_id, status, full_name)
                    SELECT u.id, "none", u.full_name FROM users u
                     LEFT JOIN kyc k ON k.user_id = u.id
                     WHERE k.user_id IS NULL');
        $done[] = "kyc: created {$missingKyc} missing row(s)";
    }

    $missingWallet = (int)$pdo->query(
        'SELECT COUNT(*) FROM users u LEFT JOIN wallets w ON w.user_id = u.id WHERE w.user_id IS NULL'
    )->fetchColumn();
    if ($missingWallet > 0) {
        $pdo->exec('INSERT INTO wallets (user_id)
                    SELECT u.id FROM users u
                     LEFT JOIN wallets w ON w.user_id = u.id
                     WHERE w.user_id IS NULL');
        $done[] = "wallets: created {$missingWallet} missing row(s)";
    }

    // Nudge the weekly history into existence on sites that finished backfilling
    // before 1W was part of the chain. Their auto_backfill_next reads "done", so
    // the new 1W step would never run on its own — yet 1D is full and 1W has a
    // single candle, which is the long-range chart showing almost nothing. If that
    // is the shape, point the backfill back at 1W; the next cron run or page visit
    // builds it and moves on.
    $daily  = (int)$pdo->query("SELECT COUNT(*) FROM arv_candles WHERE tf = '1D'")->fetchColumn();
    $weekly = (int)$pdo->query("SELECT COUNT(*) FROM arv_candles WHERE tf = '1W'")->fetchColumn();
    $next   = (string)(setting('auto_backfill_next', '1D'));
    if ($daily > 100 && $weekly < 10 && in_array($next, ['done', 'stalled'], true)) {
        setting_set('auto_backfill_next', '1W');
        setting_set('auto_backfill_fails', '0');
        $done[] = 'backfill: re-queued 1W (weekly history was missing)';
    }

    // ---------------------------------------------------------------------
    // Schema 8: rescale the index to ~₹1000 and deepen the launch to 2015.
    //
    // Two things move together and both are money-critical, so this is written
    // very defensively:
    //
    //   (a) the four anchor settings — arv_base_inr, launch_at, base_btc_usd,
    //       base_fx_usd_inr — move from the old 2021/₹1 anchor to the new
    //       2015/₹1.78 anchor. Only migrated when they still hold the exact old
    //       defaults, so an operator who tuned them by hand is never clobbered.
    //
    //   (b) NAV = base * (btcNow*fxNow) / (baseUsd*baseFx). Changing the anchor
    //       multiplies today's NAV by a constant factor F that does NOT depend on
    //       the current market (the btcNow*fxNow term cancels):
    //
    //           F = newNav/oldNav
    //             = (newBase / (newBaseUsd*newBaseFx)) / (oldBase / (oldBaseUsd*oldBaseFx))
    //
    //       Existing holdings were issued at the OLD (low) NAV, so wallets hold
    //       many units. If we only moved the anchor, value = units * newNav would
    //       balloon by F and unrealised P&L (derived from invested_paise vs value)
    //       would be nonsense. Cost basis in paise is IMMUTABLE, so instead we
    //       divide the unit COUNTS by F and multiply lots.nav by F. Then
    //       units_new * newNav == units_old * oldNav: holding value and paise cost
    //       basis are preserved, only the printed unit count and per-unit price
    //       change. The append-only, trigger-protected ledger is NOT touched — its
    //       historical paise movements stay historically accurate.
    //
    // Guarded by its own settings flag so it runs exactly once even though the
    // rest of this function is re-entrant, and wrapped in a transaction. The unit
    // division is done in SQL against the DECIMAL(28,8)/DECIMAL(20,8) columns, so
    // no PHP float ever touches a stored unit count.
    $rescaleFlag = 'units_rescaled_v8';
    if (!setting_b($rescaleFlag, false)) {
        // Old defaults this migration knows how to move. If any anchor has been
        // customised we still record the flag (so we never try again) but leave
        // both the settings and the units alone — we cannot know F safely.
        $oldBaseInr = '1.0';
        $oldLaunch  = '2021-09-01 00:00:00';
        $oldBaseUsd = '47110.33';
        $oldBaseFx  = '73.073';

        $curBaseInr = (string)setting('arv_base_inr', '');
        $curLaunch  = (string)setting('launch_at', '');
        $curBaseUsd = (string)setting('base_btc_usd', '');
        $curBaseFx  = (string)setting('base_fx_usd_inr', '');

        $onOldDefaults =
            $curBaseInr === $oldBaseInr &&
            $curLaunch  === $oldLaunch  &&
            $curBaseUsd === $oldBaseUsd &&
            $curBaseFx  === $oldBaseFx;

        if ($onOldDefaults) {
            // New anchor (kept in lock-step with arv_default_settings() above).
            $newBaseInr = '1.78';
            $newLaunch  = '2015-07-20 00:00:00';
            $newBaseUsd = '277.89';
            $newBaseFx  = '63.50';

            // F = newNav/oldNav. Computed once, in a single DECIMAL expression, so
            // the rescale factor is exact to the DB's precision rather than a PHP
            // float. F ≈ 1.78 * (47110.33*73.073) / (277.89*63.50) ≈ 347.2.
            $pdo->beginTransaction();
            try {
                // Move the four anchor settings (correct column names skey/svalue).
                $up = $pdo->prepare('UPDATE settings SET svalue = ? WHERE skey = ?');
                $up->execute([$newBaseInr, 'arv_base_inr']);
                $up->execute([$newLaunch,  'launch_at']);
                $up->execute([$newBaseUsd, 'base_btc_usd']);
                $up->execute([$newBaseFx,  'base_fx_usd_inr']);

                // F as a SQL DECIMAL. Bind the anchor numbers as strings and let
                // MySQL do the arithmetic in DECIMAL, so no float round-trip.
                //   F = (newBaseInr / (newBaseUsd*newBaseFx))
                //       / (oldBaseInr / (oldBaseUsd*oldBaseFx))
                $fExpr = '((CAST(? AS DECIMAL(30,10)) / (CAST(? AS DECIMAL(30,10)) * CAST(? AS DECIMAL(30,10))))'
                       . ' / (CAST(? AS DECIMAL(30,10)) / (CAST(? AS DECIMAL(30,10)) * CAST(? AS DECIMAL(30,10)))))';
                $fArgs = [$newBaseInr, $newBaseUsd, $newBaseFx, $oldBaseInr, $oldBaseUsd, $oldBaseFx];

                // The ledger is the book of record and the admin reconcile view
                // asserts Σ wallets.arv_units == Σ ledger.arv_delta_units. Dividing
                // the wallet units by F without touching the (append-only) ledger
                // would leave that check permanently unbalanced by the whole
                // rescale, not the sub-1e-8 truncation noise. So BEFORE rescaling,
                // post one compensating 'adjustment' entry per holder recording the
                // exact unit change the rescale is about to make:
                //     delta = new_total - old_total = old_total/F - old_total
                // computed in SQL against the DECIMAL columns (no PHP float, and the
                // append-only INSERT is the sanctioned way to correct the ledger).
                // The delta is stored to DECIMAL(28,8), the same precision as the
                // wallet columns, so the post-rescale wallet sum and the ledger sum
                // agree to the last representable digit.
                $ledgerAdj = $pdo->prepare(
                    "INSERT INTO ledger (user_id, kind, inr_delta_paise, arv_delta_units, nav, ref, note, fy)
                     SELECT user_id, 'adjustment', 0,
                            (ROUND(arv_units / {$fExpr}, 8) + ROUND(arv_locked_units / {$fExpr}, 8))
                                - (arv_units + arv_locked_units),
                            NULL, 'rescale_v8',
                            'Index rescaled to the 2015 / 1.78 rupee anchor: unit count divided by F, holding value and paise cost basis unchanged.',
                            ''
                       FROM wallets
                      WHERE (arv_units + arv_locked_units) <> 0"
                );
                $ledgerAdj->execute(array_merge($fArgs, $fArgs));

                // Divide the unit COUNTS by F (value preserved, cost basis paise
                // untouched). All divisions happen inside MySQL on the DECIMAL
                // columns.
                $w = $pdo->prepare(
                    "UPDATE wallets SET arv_units = arv_units / {$fExpr},
                                        arv_locked_units = arv_locked_units / {$fExpr}"
                );
                $w->execute(array_merge($fArgs, $fArgs));

                // lots: divide unit counts by F, multiply per-lot nav by F. cost_paise
                // is left exactly as it was.
                $l = $pdo->prepare(
                    "UPDATE lots SET units = units / {$fExpr},
                                     units_remaining = units_remaining / {$fExpr},
                                     nav = nav * {$fExpr}"
                );
                $l->execute(array_merge($fArgs, $fArgs, $fArgs));

                // Dust coherence. Dividing a DECIMAL(28,8) unit count by F ≈ 347
                // truncates at 8 decimals, so any holding below ~3.5e-6 old units
                // floors to exactly 0 units. Cost basis in paise is deliberately
                // untouched, which for such a holding would leave a positive
                // invested_paise / cost_paise with zero units — value = units×nav = 0
                // while invested > 0, so avgCostNav (invested ÷ units) and unrealised
                // P&L become incoherent (a phantom -100% position). The residual is
                // genuine dust (worth a small fraction of a paise at any NAV), so we
                // collapse it to a clean zero: when units floor to 0 we also zero the
                // matching cost basis. The ledger adjustment above already accounts
                // for the unit change; the paise here never moved a real balance.
                //
                // Lots first: a lot with no remaining units carries no live cost
                // basis (consume_lots only ever reads units_remaining > 0), so its
                // cost_paise is set to 0 once it has floored out.
                $pdo->prepare(
                    'UPDATE lots SET cost_paise = 0 WHERE units_remaining = 0 AND cost_paise <> 0'
                )->execute();

                // Wallets: when a holder has floored to zero total units, drop the
                // stranded invested_paise so invested is 0 alongside 0 units. Any
                // realised P&L already booked stays as-is.
                $pdo->prepare(
                    'UPDATE wallets SET invested_paise = 0
                      WHERE (arv_units + arv_locked_units) = 0 AND invested_paise <> 0'
                )->execute();

                $pdo->commit();
                $done[] = 'index: rescaled anchor to 2015/₹1.78, divided holding units by F, '
                        . 'posted per-holder ledger adjustments, and zeroed dust cost basis '
                        . '(value + paise cost basis preserved for non-dust holdings)';
            } catch (Throwable $e) {
                if ($pdo->inTransaction()) {
                    $pdo->rollBack();
                }
                throw $e;
            }

            // Rebuild the candle series for the new base + deeper launch. Option B:
            // re-queue the full backfill from '1D' and clear the fail counter. The
            // backfill writes with ON DUPLICATE KEY UPDATE, so old rows (computed
            // with the old base and clamped at 2021) are overwritten with new-base
            // values and the deeper 2015 history is filled in on subsequent runs.
            setting_set('auto_backfill_next', '1D');
            setting_set('auto_backfill_fails', '0');
            $done[] = 'backfill: re-queued full rebuild for new base + 2015 launch';
        } else {
            $done[] = 'index: anchor settings were customised — skipped rescale, left settings and units untouched';
        }

        // Record the flag regardless, so the rescale can never run twice.
        setting_set($rescaleFlag, '1');
    }

    // ---------------------------------------------------------------------
    // Schema 9: corrective anchor + full candle rebuild to the ₹10,000 anchor.
    //
    // Why this exists. v8 moved the anchor settings and re-queued the backfill
    // expecting ON DUPLICATE KEY UPDATE to overwrite old candles. But
    // auto_backfill_step() SKIPS any timeframe whose stored row count already
    // exceeds its floor (`if ($have >= auto_backfill_floor($tf)) advance`), so a
    // pre-existing full 1m/1D series (computed on the OLD anchor) was advanced
    // past WITHOUT recompute, while every fresh ingest minute is computed on the
    // NEW anchor. The result is a MIXED-ANCHOR series: an old-anchor historical
    // body meeting new-anchor recent minutes at a vertical right-edge spike, and
    // a nonsense since-launch % (the ~₹758 / +34027% the user saw).
    //
    // The fix here does two things and BOTH are candle/display only:
    //   (a) FORCE-set the four anchor settings to the new canonical values. This
    //       is unconditional (unlike v8's "only if on old defaults" guard):
    //       settings carry no money, and we must repair installs left in ANY
    //       partial state by v8. Retargets today's NAV to ~₹10,000
    //       (arv_base_inr 1.78 → 17.83) while keeping the 2015 launch and the
    //       real BTC/fx anchors, so the chart still traces Bitcoin's true ~560x.
    //   (b) Re-queue an UNCONDITIONAL full candle rebuild by pointing the
    //       backfill at '1D' and raising a rebuild flag that auto_backfill_step()
    //       reads to overwrite ARV candles regardless of row count. Every ARV
    //       timeframe is then recomputed by index_price() against the current
    //       anchor → a single continuous, BTC-matched series with no end spike.
    //
    // CRITICAL — this block touches ONLY candles + backfill scheduling +
    // settings. It does NOT re-run the v8 unit rescale and it NEVER writes to
    // wallets, lots, or the append-only ledger. Unit balances were already
    // rescaled by v8 (units_rescaled_v8, left untouched here); the money value
    // of a holding = units * NAV is preserved because we change only the printed
    // per-unit NAV/candles, not the unit counts. There is no re-division of
    // units and no ledger entry from this migration.
    //
    // !!!  BUG THAT SCHEMA-12 HAD TO REPAIR  !!!  Changing arv_base_inr here
    // (1.78 → 17.83) multiplied NAV — and therefore value = units × NAV — by
    // 17.83/1.78 ≈ 10× for EVERY existing holding, while invested_paise stayed
    // fixed, producing phantom unrealised profit. Because this block left the
    // unit counts alone, that inflation went live. An anchor change MUST be
    // paired with a unit rescale (see schema-8 and the corrective schema-12);
    // "settings carry no money" is true of the setting ROW, but the NAV it
    // defines most certainly does. Do NOT change an anchor without a rescale.
    //
    // Guarded by its own flag so it runs exactly once and is idempotent.
    $anchorFlag = 'anchor_recomputed_v9';
    if (!setting_b($anchorFlag, false)) {
        // (a) Force-set the four canonical anchor settings (kept in lock-step
        // with arv_default_settings() above). Unconditional: settings hold no
        // money, so overwriting them is always safe and repairs any partial v8.
        setting_set('arv_base_inr',    '17.83');
        setting_set('launch_at',       '2015-07-20 00:00:00');
        setting_set('base_btc_usd',    '277.89');
        setting_set('base_fx_usd_inr', '63.50');

        // (b) Re-queue a FULL candle rebuild from the head of the chain and clear
        // the fail state so the chain can run cleanly.
        setting_set('auto_backfill_next', '1D');
        setting_set('auto_backfill_fails', '0');
        setting_set('auto_backfill_fail_step', '');

        // (c) Rebuild flag read by auto_backfill_step(): while set, ARV
        // timeframes are recomputed regardless of row count so the stranded
        // old-anchor candles are actually overwritten. The step clears this flag
        // once the ARV chain has been fully rebuilt.
        setting_set('arv_candles_rebuild_v9', '1');

        // (d) One-shot guard so the corrective anchor never runs twice.
        setting_set($anchorFlag, '1');
        $done[] = 'index: corrective anchor to 2015/₹17.83 (~₹10,000 today), '
                . 're-queued UNCONDITIONAL full candle rebuild (candles/settings only; '
                . 'no unit rescale, no wallet/lot/ledger writes)';
    }

    // ---------------------------------------------------------------------
    // Schema 10: forceful candle wipe + retarget to ~$100 USD today (~₹9,000).
    //
    // Why this exists. Schema-9 set arv_candles_rebuild_v9='1' intending to
    // trigger a full candle recompute, but auto_backfill_step() early-returns
    // when auto_backfill_next is 'done' or 'stalled' (left over from the v8
    // run):
    //
    //     if ($next === 'done' || $next === 'stalled') { return null; }
    //
    // This check runs BEFORE the rebuild flag is ever read, so the chain never
    // advanced past it. The rebuild flag was set but never consumed. Old ₹2
    // candles survived, fresh ingest wrote new-anchor minutes only → the
    // end-of-chart vertical spike remained live on arvcoin.com.
    //
    // The fix here is definitive:
    //   (a) Guard: units_rescaled_v8 MUST be '1' — never re-run the unit rescale.
    //   (b) Idempotency: candles_wiped_v10 must NOT already be '1'.
    //   (c) Force-set all four anchor settings to the $100-today anchor.
    //       Target: ARV ≈ $100 × fx_now ≈ $100 × 90 = ₹9,000.
    //       Math: BTC_launch_inr = 277.89 × 63.50 = 17,645.915
    //             BTC_now_inr ≈ ₹75,33,497
    //             arv_base_inr = 9000 × (17645.915 / 7533497) ≈ 21.08
    //   (d) DELETE FROM arv_candles — ALL rows, ALL timeframes. Candles carry no
    //       money (pure display/market data). This is the only way to guarantee
    //       that no mixed-anchor row survives from any prior partial rebuild.
    //   (e) Reset auto_backfill_next='1D', clear fails so the chain runs cleanly.
    //   (f) Clear the stale v9 flags so they do not confuse future logic.
    //   (g) Set candles_wiped_v10='1' as the idempotency guard.
    //
    // Does NOT touch: wallets, lots, ledger, fills, users, cost basis — only
    // settings + arv_candles.
    //
    // !!!  SAME BUG AS SCHEMA-9  !!!  Force-setting arv_base_inr (17.83 → 21.08)
    // again multiplied NAV — and value = units × NAV — for every existing
    // holding, with no matching unit rescale, compounding the phantom profit v9
    // introduced. Net effect of v9+v10 vs the last rescale at v8: value inflated
    // by 21.08/1.78 ≈ 11.84×. Repaired by schema-12. ANY future anchor change
    // MUST be paired with a unit rescale (schema-8/12) — do not change an anchor
    // here without one.
    $wipeFlag = 'candles_wiped_v10';
    $rescaledOk = setting_b('units_rescaled_v8', false);   // (a)
    if ($rescaledOk && !setting_b($wipeFlag, false)) {     // (b)
        // (c) Force-set all four canonical anchor settings.
        setting_set('arv_base_inr',    '21.08');
        setting_set('launch_at',       '2015-07-20 00:00:00');
        setting_set('base_btc_usd',    '277.89');
        setting_set('base_fx_usd_inr', '63.50');

        // (d) Wipe ALL arv_candles rows — guaranteed clean slate for the rebuild.
        //     Candles carry no money. Safe.
        $pdo->exec('DELETE FROM arv_candles');

        // (e) Reset the backfill chain to the start so the full history is rebuilt.
        setting_set('auto_backfill_next', '1D');
        setting_set('auto_backfill_fails', '0');
        setting_set('auto_backfill_fail_step', '');

        // (f) Clear stale v9 flags.
        setting_set('arv_candles_rebuild_v9', '');
        setting_set('anchor_recomputed_v9',   '');

        // (g) Idempotency guard.
        setting_set($wipeFlag, '1');

        $done[] = 'schema-10: wiped arv_candles, force-set anchor to 2015/₹21.08 (~$100 today), '
                . 'reset backfill to 1D (candles/settings only; no unit rescale, no wallet/lot/ledger writes)';
    } elseif (!$rescaledOk) {
        // Installation without v8 rescale — still force-set anchor and wipe.
        // units_rescaled_v8 is absent on fresh installs; arv_candles is empty on
        // those anyway, so the DELETE is a no-op and the anchor set is safe.
        if (!setting_b($wipeFlag, false)) {
            setting_set('arv_base_inr',    '21.08');
            setting_set('launch_at',       '2015-07-20 00:00:00');
            setting_set('base_btc_usd',    '277.89');
            setting_set('base_fx_usd_inr', '63.50');
            $pdo->exec('DELETE FROM arv_candles');
            setting_set('auto_backfill_next', '1D');
            setting_set('auto_backfill_fails', '0');
            setting_set('auto_backfill_fail_step', '');
            setting_set('arv_candles_rebuild_v9', '');
            setting_set($wipeFlag, '1');
            $done[] = 'schema-10 (fresh install): wiped arv_candles, set anchor to 2015/₹21.08';
        }
    }

    // ---------------------------------------------------------------------
    // Schema 11: derive the ARV chart from BTC's asset_candles.
    //
    // Why this exists. The ARV chart repeatedly broke because it read a SEPARATE
    // arv_candles series that depends on being backfilled/rolled-up/never-wiped,
    // and schema-10's wipe + re-queue left it nearly empty on the live install
    // (an empty arv_candles → an empty ARV chart) while the coin charts, which
    // read the reliably-backfilled asset_candles, stayed full.
    //
    // The fix (in code): market.php handle_candles() now DERIVES ARV candles from
    // BTC's asset_candles on the fly — ARV = arv_base_inr × (BTC_usd × fx) /
    // (base_btc_usd × base_fx_usd_inr), i.e. index_price() applied per candle — so
    // the ARV chart is dot-for-dot the BTC chart, INR-scaled, at every timeframe.
    //
    // For that BTC needs a FULL asset_candles history at every timeframe. It
    // previously did not: ingest writes only BTC's 1m rows, and BTC was excluded
    // from backfill_asset_tf()/rollup_assets()/auto_backfill_after(). Those now
    // include BTC (asset_keys()), but a live install whose backfill chain already
    // reached 'done' would never run the new BTC steps — so re-queue the chain
    // from the head. ARV frames already at/above their row-count floor are skipped
    // fast (no rebuild flag is set here), then the BTC asset frames build, then
    // ETH/SOL/XRP (also skipped fast if full), then 'done'.
    //
    // CANDLES / SCHEDULING / SETTINGS ONLY. Does NOT touch wallets, lots, the
    // append-only ledger, fills, users, or cost basis, and does NOT re-run any
    // unit rescale. Guarded by its own flag so it runs exactly once.
    $btcAssetFlag = 'btc_asset_candles_v11';
    if (!setting_b($btcAssetFlag, false)) {
        setting_set('auto_backfill_next', '1D');
        setting_set('auto_backfill_fails', '0');
        setting_set('auto_backfill_fail_step', '');
        setting_set($btcAssetFlag, '1');
        $done[] = 'schema-11: ARV chart now derives from BTC asset_candles; re-queued the '
                . 'backfill chain so BTC gets full asset_candles history at every timeframe '
                . '(candles/scheduling only; no wallet/lot/ledger/unit writes)';
    }

    // ---------------------------------------------------------------------
    // Schema 12: CORRECTIVE UNIT RESCALE for the anchor moves schema-9 and
    // schema-10 made without one. This is a MONEY-PATH repair and is written as
    // defensively as schema-8, which it mirrors EXACTLY.
    //
    // The disease. NAV = arv_base_inr × (BTC_now_inr / BTC_launch_inr). Schema-8
    // rescaled every holding's unit COUNT when it moved the anchor to 1.78, so
    // value = units × NAV and paise cost basis were preserved. Schema-9
    // (1.78 → 17.83) and schema-10 (17.83 → 21.08) then moved the anchor again
    // but did NOT rescale units. So today the anchor is 21.08 while the unit
    // counts are still at the 1.78 scale (last rescaled at v8). The current NAV
    // is therefore (21.08/1.78) ≈ 11.84× too high relative to the units, so
    // value = units × NAV is inflated ~11.84× while invested_paise (immutable,
    // real rupees) is unchanged → a phantom unrealised profit of ~11.84×. The
    // wallet_public() arithmetic (value − invested) is correct; the DATA is wrong.
    //
    // The cure (identical shape to schema-8):
    //   F = current_anchor / anchor_units_were_last_rescaled_at = 21.08 / 1.78.
    //   Because NAV = base × (market terms that cancel), F is EXACTLY the ratio
    //   of the two arv_base_inr values — no market data needed. Computed in SQL
    //   as a DECIMAL expression from the two string literals, never a PHP float.
    //   Divide qualifying unit counts by F, multiply lots.nav by F. Then
    //   units_new × NAV_now == units_old × NAV_at_1.78_scale: value and paise
    //   cost basis preserved, only the printed unit count and per-unit price move.
    //
    // CRITICAL GUARD — only OLD-anchor (1.78-era) holdings, never current-anchor
    // holdings. A lot bought at the 1.78 anchor has nav ≈ ₹1,000 (1.78 × the
    // ~561 BTC now/launch multiple). A lot bought at the current 21.08 anchor has
    // nav ≈ ₹11,800. These bands are an order of magnitude apart, so we rescale a
    // lot ONLY when nav < 5000 — safely between ₹1,000 and ₹10,000+. Rescaling a
    // lot already at the current anchor would BREAK it (divide a correct holding
    // by 11.84); the threshold prevents that. (Operator: before running on the
    // live DB, eyeball SELECT id,nav,acquired_at FROM lots ORDER BY nav to
    // confirm the two bands really are cleanly separated by 5000 for your data.)
    //
    // Wallets are RECOMPUTED FROM LOTS, never blindly divided, because a wallet
    // may hold a mix of old- and new-anchor lots. The true invariant (verified in
    // the code: sell orders escrow units wallet→locked but consume lots only at
    // FILL) is arv_units + arv_locked_units == Σ lots.units_remaining. So after
    // rescaling lots we set arv_locked_units = Σ the holder's OPEN SELL orders'
    // locked_units and arv_units = Σ lots.units_remaining − arv_locked_units.
    // That keeps both the wallet⇄lots invariant and the wallet⇄orders invariant
    // (wallets.arv_locked_units == Σ open sell orders.locked_units) intact.
    //
    // Open sell orders. locked_units live only on resting SELL orders (buys lock
    // rupees). Cancelling an order returns its locked_units to the wallet, so if
    // we rescale a holder's lots but leave a stale un-rescaled order, a later
    // cancel would return 11.84× too many units. We therefore rescale open sell
    // orders' locked_units by /F, but ONLY for holders whose held lots are
    // UNAMBIGUOUSLY old-anchor (they have an open lot with nav < 5000 and NO open
    // lot with nav >= 5000). Done BEFORE the lot rescale, while nav < 5000 still
    // identifies old lots. A holder with a genuinely MIXED book (both bands) is
    // left for manual live-DB review (see report) — an early-site rarity — and
    // the recompute clamps arv_units at 0 so no invariant is violated meanwhile.
    //
    // invested_paise / cost_paise / realised_pnl_paise are IMMUTABLE (real
    // rupees) — never touched, exactly like schema-8. One compensating
    // append-only ledger 'adjustment' (ref rescale_v12) is posted per holder
    // whose total units actually changed, for the exact unit delta computed in
    // SQL, so Σ wallets units == Σ ledger arv_delta_units stays balanced. Dust:
    // a lot flooring to 0 units gets cost_paise zeroed; a wallet flooring to 0
    // total units gets invested_paise zeroed — same as schema-8. Guarded by
    // units_rescaled_v12, wrapped in a transaction with rollback on error.
    //
    // Does NOT change any anchor setting (21.08 is correct — ~$100 today) and
    // does NOT touch arv-config.js.
    $rescaleV12Flag = 'units_rescaled_v12';
    if (!setting_b($rescaleV12Flag, false)) {
        // We can only compute F = 21.08/1.78 safely when the anchor is actually
        // at 21.08 AND v8 established the 1.78 unit scale. If an operator has
        // hand-tuned arv_base_inr to something else, F is unknown — record the
        // flag so we never try again, but leave every unit and setting alone.
        $lastRescaleAnchor = '1.78';   // anchor at which units were last rescaled (v8)
        $curAnchor         = '21.08';  // current canonical anchor (v10), unchanged here
        $onKnownAnchors =
            setting_b('units_rescaled_v8', false) &&
            (string)setting('arv_base_inr', '') === $curAnchor;

        if ($onKnownAnchors) {
            // F as a SQL DECIMAL from the two anchor literals bound as strings —
            // no PHP float ever touches a unit count. F = 21.08 / 1.78 ≈ 11.8427.
            $fExpr = '(CAST(? AS DECIMAL(30,10)) / CAST(? AS DECIMAL(30,10)))';
            $fArgs = [$curAnchor, $lastRescaleAnchor];

            // Reusable correlated sub-expressions, kept byte-identical between the
            // ledger INSERT and the wallet UPDATE so the two agree to the last
            // representable digit and the reconcile stays exactly balanced.
            //   sumLots  = Σ this holder's lots.units_remaining  (= total held)
            //   sumLock  = Σ this holder's OPEN SELL orders.locked_units (= locked)
            //   newAvail = GREATEST(sumLots − sumLock, 0)
            //   newTotal = newAvail + sumLock   (== sumLots unless clamped)
            $sumLots = 'COALESCE((SELECT SUM(l.units_remaining) FROM lots l WHERE l.user_id = w.user_id), 0)';
            $sumLock = "COALESCE((SELECT SUM(o.locked_units) FROM orders o
                                   WHERE o.user_id = w.user_id AND o.side = 'sell'
                                     AND o.status IN ('open','triggered','partial')), 0)";
            $newAvail  = "GREATEST({$sumLots} - {$sumLock}, 0)";
            $newTotal  = "({$newAvail} + {$sumLock})";
            $oldTotal  = '(w.arv_units + w.arv_locked_units)';

            $pdo->beginTransaction();
            try {
                // (1) Rescale open SELL orders by /F for holders whose held units
                // are unambiguously old-anchor. ALL unit-denominated fields move
                // together (units, filled_units, locked_units) so the order stays
                // internally consistent — the matching engine reads order.units for
                // its "fully filled" check ($filled >= $total in _match.php) and
                // consume_lots pulls the remaining locked units from the (rescaled)
                // lots, so a half-rescaled order would never fill out and would
                // return the wrong quantity on cancel. The rupee fields
                // (filled_paise, locked_paise) are NOT touched: a sell locks units,
                // not rupees, and any filled_paise is real historical proceeds.
                // MUST run before the lot rescale, while nav < 5000 still marks old
                // lots. side='sell' only (buys lock rupees, not units).
                $ord = $pdo->prepare(
                    "UPDATE orders o
                        SET o.units = o.units / {$fExpr},
                            o.filled_units = o.filled_units / {$fExpr},
                            o.locked_units = o.locked_units / {$fExpr}
                      WHERE o.side = 'sell'
                        AND o.status IN ('open','triggered','partial')
                        AND EXISTS (SELECT 1 FROM lots l
                                     WHERE l.user_id = o.user_id
                                       AND l.units_remaining > 0 AND l.nav < 5000)
                        AND NOT EXISTS (SELECT 1 FROM lots l2
                                         WHERE l2.user_id = o.user_id
                                           AND l2.units_remaining > 0 AND l2.nav >= 5000)"
                );
                $ord->execute(array_merge($fArgs, $fArgs, $fArgs));

                // (2) Rescale ONLY old-anchor lots: divide unit counts by F,
                // multiply per-lot nav by F. cost_paise is left exactly as it was.
                // The nav < 5000 guard leaves current-anchor lots (nav ≈ ₹11.8k)
                // untouched.
                $lot = $pdo->prepare(
                    "UPDATE lots
                        SET units = units / {$fExpr},
                            units_remaining = units_remaining / {$fExpr},
                            nav = nav * {$fExpr}
                      WHERE nav < 5000"
                );
                $lot->execute(array_merge($fArgs, $fArgs, $fArgs));

                // (3) BEFORE touching wallets, post one compensating 'adjustment'
                // per holder whose TOTAL units actually change, recording the exact
                // delta = newTotal − oldTotal computed in SQL against the DECIMAL
                // columns (no PHP float; the append-only INSERT is the sanctioned
                // way to correct the ledger). newTotal here is byte-identical to
                // what the wallet UPDATE in (4) writes, so Σ wallets units and
                // Σ ledger arv_delta_units stay equal to the last digit.
                $ledgerAdj = $pdo->prepare(
                    "INSERT INTO ledger (user_id, kind, inr_delta_paise, arv_delta_units, nav, ref, note, fy)
                     SELECT w.user_id, 'adjustment', 0,
                            {$newTotal} - {$oldTotal},
                            NULL, 'rescale_v12',
                            'Corrective rescale: schema-9/10 moved arv_base_inr (1.78→17.83→21.08) without rescaling unit counts; units divided by F = 21.08/1.78, lots.nav ×F. Holding value and paise cost basis unchanged.',
                            ''
                       FROM wallets w
                      WHERE {$newTotal} <> {$oldTotal}"
                );
                $ledgerAdj->execute();

                // (4) Recompute every wallet from its own lots + open sell orders.
                // arv_locked_units = Σ open sell orders.locked_units (already
                // rescaled in step 1 where applicable); arv_units = the rest of the
                // holder's lots. GREATEST(...,0) both satisfies chk_wallet_nonneg
                // and clamps the rare mixed-book edge (documented) without ever
                // breaking the reconcile, since (3) used the identical expression.
                $wal = $pdo->prepare(
                    "UPDATE wallets w
                        SET w.arv_locked_units = {$sumLock},
                            w.arv_units        = {$newAvail}"
                );
                $wal->execute();

                // (5) Dust coherence, identical to schema-8. Dividing a
                // DECIMAL(28,8) by F ≈ 11.84 floors sub-~1.2e-7 holdings to 0.
                // Cost basis in paise is deliberately untouched by the rescale, so
                // a floored holding would otherwise strand invested/cost > 0 against
                // 0 units (value = units×nav = 0, a phantom −100% position). The
                // residual is genuine dust; collapse it to a clean zero.
                //
                // Lots first: a lot with no remaining units carries no live cost
                // basis (consume_lots only reads units_remaining > 0).
                $pdo->prepare(
                    'UPDATE lots SET cost_paise = 0 WHERE units_remaining = 0 AND cost_paise <> 0'
                )->execute();

                // Wallets: a holder floored to zero total units drops the stranded
                // invested_paise. Realised P&L already booked stays as-is.
                $pdo->prepare(
                    'UPDATE wallets SET invested_paise = 0
                      WHERE (arv_units + arv_locked_units) = 0 AND invested_paise <> 0'
                )->execute();

                $pdo->commit();
                $done[] = 'schema-12: corrective unit rescale by F = 21.08/1.78 (≈11.84) for old-anchor '
                        . 'holdings (lots.nav < 5000) that schema-9/10 left un-rescaled; divided their '
                        . 'unit counts by F, multiplied lots.nav by F, rescaled matching open-sell '
                        . 'locked_units, recomputed wallets from lots, posted per-holder ledger '
                        . 'adjustments (rescale_v12), zeroed dust — value + paise cost basis preserved, '
                        . 'anchor unchanged';
            } catch (Throwable $e) {
                if ($pdo->inTransaction()) {
                    $pdo->rollBack();
                }
                throw $e;
            }
        } else {
            $done[] = 'schema-12: skipped unit rescale — anchor is not the canonical 21.08 (or v8 '
                    . 'never ran), so F = 21.08/1.78 is not known to apply; left units and settings untouched';
        }

        // Record the flag regardless, so the rescale can never run twice.
        setting_set($rescaleV12Flag, '1');
    }

    if ($done) {
        setting_set('schema_version', (string)ARV_SCHEMA_VERSION);
    }
    return $done;
}
