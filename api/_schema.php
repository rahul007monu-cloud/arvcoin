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
// 1W joined the chain.
const ARV_SCHEMA_VERSION = 7;

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
        // Launch is five years back so the chart carries a full cycle, including
        // the 2022 drawdown. Both figures are real observations for that date —
        // BTC/USD open from Coinbase, USD/INR from Frankfurter — and neither is
        // ever revised, because the whole index hangs off them.
        'arv_base_inr'          => '1.0',
        'launch_at'             => '2021-09-01 00:00:00',
        'base_btc_usd'          => '47110.33',
        'base_fx_usd_inr'       => '73.073',
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
        // one timeframe at a time: daily, then hourly, then minute, then 'done'.
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
        // Short enough that an unattended device does not stay trusted for weeks.
        // Cleared on sign-out, and there is a shared-computer opt-out on the form.
        'trust_hours'           => '24',

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

    if ($done) {
        setting_set('schema_version', (string)ARV_SCHEMA_VERSION);
    }
    return $done;
}
