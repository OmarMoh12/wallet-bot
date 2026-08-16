#!/usr/bin/env node
/**
 * Demo data seeder.
 *
 *   node dist/cli/seed.js --telegram-id 123456789
 *
 * Creates one user with wallets, cash accounts, a few months of transactions, expected
 * income, a scheduled payment and a goal — enough that every screen in the Mini App has
 * something real to render on a fresh install.
 *
 * Refuses to run against a production database. Seed data in a live financial system would
 * be indistinguishable from real records once it is in the ledger.
 */
import { createDatabase, withSystem, type Sql } from '../client.js';

const DEMO_TRON_ADDRESS = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const DEMO_TON_ADDRESS = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

/** Deterministic pseudo-random so repeated seeds look the same. */
function pseudo(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

async function seed(sql: Sql, telegramId: bigint): Promise<void> {
  const random = pseudo(20260816);

  await withSystem(sql, async (tx) => {
    /* ------------------------------------------------------------- user -- */
    const users = await tx<Array<{ id: string }>>`
      INSERT INTO users (telegram_id, first_name, username, is_admin, language_code)
      VALUES (${telegramId.toString()}, ${'Demo'}, ${'demo_user'}, true, ${'en'})
      ON CONFLICT (telegram_id) DO UPDATE SET first_name = EXCLUDED.first_name
      RETURNING id
    `;
    const userId = users[0]?.id as string;

    await tx`
      INSERT INTO user_settings (user_id, locale, primary_fiat, reporting_fiat, timezone)
      VALUES (${userId}, 'en', 'ILS', 'USD', 'Asia/Jerusalem')
      ON CONFLICT (user_id) DO NOTHING
    `;
    await tx`
      INSERT INTO notification_preferences (user_id) VALUES (${userId})
      ON CONFLICT (user_id) DO NOTHING
    `;

    console.log(`  user ${userId} (telegram ${telegramId})`);

    /* ----------------------------------------------------- cash accounts -- */
    const accounts = await tx<Array<{ id: string; currency: string }>>`
      INSERT INTO cash_accounts (user_id, name, currency, is_default)
      VALUES
        (${userId}, ${'Cash (₪)'}, 'ILS', true),
        (${userId}, ${'Cash ($)'}, 'USD', false)
      ON CONFLICT DO NOTHING
      RETURNING id, currency
    `;
    const ilsAccount = accounts.find((account) => account.currency === 'ILS')?.id;
    const usdAccount = accounts.find((account) => account.currency === 'USD')?.id;
    if (!ilsAccount || !usdAccount) {
      console.log('  cash accounts already exist; skipping the rest of the seed');
      return;
    }

    /* ---------------------------------------------------------- wallets -- */
    const env = process.env.CHAIN_ENV === 'mainnet' ? 'mainnet' : 'testnet';

    const wallets = await tx<Array<{ id: string; network: string }>>`
      INSERT INTO wallets (user_id, name, network, env, address, address_canonical, type)
      VALUES
        (${userId}, ${'Personal TRON Wallet'}, 'tron', ${env}, ${DEMO_TRON_ADDRESS}, ${DEMO_TRON_ADDRESS}, 'watch_only'),
        (${userId}, ${'Personal TON Wallet'}, 'ton', ${env}, ${DEMO_TON_ADDRESS}, ${'0:b113a994b5024a16719f691392' + '28eb75959b'.padEnd(38, '0')}, 'watch_only')
      ON CONFLICT DO NOTHING
      RETURNING id, network
    `;
    console.log(`  ${wallets.length} wallet(s)`);

    /* --------------------------------------------------------- balances -- */
    const assets = await tx<
      Array<{ id: string; symbol: string; decimals: number; network: string }>
    >`
      SELECT id, symbol, decimals, network FROM assets WHERE env = ${env}
    `;

    for (const wallet of wallets) {
      const walletAssets = assets.filter((asset) => asset.network === wallet.network);
      for (const asset of walletAssets) {
        const unit = 10n ** BigInt(asset.decimals);
        const amount =
          asset.symbol === 'USDT'
            ? 125n * unit + 500_000n
            : asset.symbol === 'TON'
              ? (472n * unit) / 100n
              : 350n * unit;

        await tx`
          INSERT INTO wallet_balances (wallet_id, asset_id, raw_amount, source)
          VALUES (${wallet.id}, ${asset.id}, ${amount.toString()}, ${'seed'})
          ON CONFLICT (wallet_id, asset_id) DO UPDATE SET raw_amount = EXCLUDED.raw_amount
        `;
      }
    }

    /* ------------------------------------------------------- categories -- */
    const categories = await tx<Array<{ id: string; key: string | null }>>`
      SELECT id, key FROM categories WHERE is_system
    `;
    const categoryFor = (key: string): string | null =>
      categories.find((category) => category.key === key)?.id ?? null;

    /* ----------------------------------------------------- transactions -- */
    const samples: Array<[string, string, number, 'in' | 'out', string]> = [
      ['Payment for project', 'category.work', 450000, 'in', 'ILS'],
      ['Dinner', 'category.food', -12000, 'out', 'ILS'],
      ['Bus pass', 'category.transport', -21500, 'out', 'ILS'],
      ['Consulting invoice', 'category.work', 120000, 'in', 'USD'],
      ['Groceries', 'category.food', -34250, 'out', 'ILS'],
      ['Phone bill', 'category.bills', -8900, 'out', 'ILS'],
      ['Headphones', 'category.shopping', -49900, 'out', 'ILS'],
      ['Freelance top-up', 'category.work', 180000, 'in', 'ILS'],
      ['Coffee', 'category.food', -1800, 'out', 'ILS'],
      ['Electricity', 'category.bills', -27400, 'out', 'ILS'],
      ['Birthday gift', 'category.gifts', -15000, 'out', 'ILS'],
      ['Refund', 'category.other', 6500, 'in', 'ILS'],
    ];

    let inserted = 0;
    for (const [
      index,
      [title, categoryKey, amountMinor, direction, currency],
    ] of samples.entries()) {
      const daysAgo = Math.floor(random() * 75) + index;
      const account = currency === 'ILS' ? ilsAccount : usdAccount;
      // A stable rate for the seed, so demo totals are reproducible.
      const usdMinor = currency === 'USD' ? amountMinor : Math.round(amountMinor / 3.7);
      const ilsMinor = currency === 'ILS' ? amountMinor : Math.round(amountMinor * 3.7);

      await tx`
        INSERT INTO transactions (
          user_id, kind, type, direction, status, source, title, category_id, occurred_at,
          cash_account_id, fiat_currency, fiat_amount_minor,
          value_usd_minor, value_ils_minor, usd_ils_rate, valued_at, idempotency_key
        ) VALUES (
          ${userId}, 'cash', ${direction === 'in' ? 'income' : 'expense'}, ${direction},
          'confirmed', 'manual', ${title}, ${categoryFor(categoryKey)},
          now() - make_interval(days => ${daysAgo}),
          ${account}, ${currency}, ${amountMinor},
          ${usdMinor}, ${ilsMinor}, ${'3.7'}, now(), ${`seed-tx-${index}`}
        )
        ON CONFLICT DO NOTHING
      `;
      inserted += 1;
    }
    console.log(`  ${inserted} cash transaction(s)`);

    /* --------------------------------------------------- expected income -- */
    await tx`
      INSERT INTO expected_income (user_id, name, reason, amount_minor, currency, expected_date, category_id)
      VALUES
        (${userId}, ${'Client Payment'}, ${'Website project'}, ${30000}, 'USD',
         (current_date + 9), ${categoryFor('category.work')}),
        (${userId}, ${'Retainer'}, ${'Monthly retainer'}, ${120000}, 'ILS',
         (current_date - 3), ${categoryFor('category.work')})
      ON CONFLICT DO NOTHING
    `;

    /* --------------------------------------------------------- schedule -- */
    const tronWallet = wallets.find((wallet) => wallet.network === 'tron');
    const usdt = assets.find((asset) => asset.symbol === 'USDT' && asset.network === 'tron');
    if (tronWallet && usdt) {
      await tx`
        INSERT INTO scheduled_payments (
          user_id, wallet_id, asset_id, title, to_address, to_address_canonical,
          raw_amount, scheduled_at, idempotency_key
        ) VALUES (
          ${userId}, ${tronWallet.id}, ${usdt.id}, ${'Monthly transfer'},
          ${'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8'}, ${'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8'},
          ${(25n * 10n ** 6n).toString()}, now() + interval '4 days', ${'seed-schedule-1'}
        )
        ON CONFLICT DO NOTHING
      `;
    }

    /* ------------------------------------------------------------ goals -- */
    await tx`
      INSERT INTO financial_goals (user_id, name, target_minor, current_minor, currency, icon, color)
      VALUES
        (${userId}, ${'New PC'}, ${150000}, ${80000}, 'USD', ${'target'}, ${'#4C8DFF'}),
        (${userId}, ${'Emergency fund'}, ${1000000}, ${240000}, 'ILS', ${'piggy'}, ${'#3ECF8E'})
      ON CONFLICT DO NOTHING
    `;

    /* ----------------------------------------------------- exchange rate -- */
    await tx`
      INSERT INTO exchange_rates (base, quote, rate, source, is_manual)
      VALUES ('USD', 'ILS', ${'3.7000000000'}, ${'seed'}, false)
    `;

    console.log('  expected income, scheduled payment, goals and a seed FX rate');
  });
}

async function main(): Promise<void> {
  const appEnv = process.env.APP_ENV ?? 'development';
  if (appEnv === 'production' || appEnv === 'staging') {
    console.error(
      `Refusing to seed demo data with APP_ENV=${appEnv}. ` +
        'Seed rows are indistinguishable from real records once they are in the ledger.',
    );
    process.exit(1);
  }

  const telegramIdRaw = arg('telegram-id') ?? process.env.TELEGRAM_ADMIN_IDS?.split(',')[0]?.trim();
  if (!telegramIdRaw || !/^\d{5,19}$/.test(telegramIdRaw)) {
    console.error(
      'A Telegram user id is required so the demo data belongs to your account.\n' +
        '  node dist/cli/seed.js --telegram-id 123456789\n' +
        'Find yours by messaging @userinfobot on Telegram.',
    );
    process.exit(1);
  }

  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  const sql = createDatabase({
    url,
    ssl: process.env.DATABASE_SSL === 'true',
    maxConnections: 2,
    statementTimeoutMs: 30_000,
    idleTimeoutSeconds: 5,
    connectTimeoutSeconds: 10,
    applicationName: 'wallet-seed',
  });

  try {
    console.log('Seeding demo data…');
    await seed(sql, BigInt(telegramIdRaw));
    console.log('Done. Open the Mini App to see it.');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
