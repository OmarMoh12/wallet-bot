-- =============================================================================
--  0008_reference_data
--  Seed the asset registry, built-in categories and default app settings.
--  Idempotent: safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
--  Assets
--
--  Contract addresses below are the well-known production/testnet contracts. They are
--  reference data, not user input, and are re-verified by the address validator before any
--  transfer is built. Adding a network later means inserting rows here and shipping a
--  BlockchainProvider — nothing else in the schema changes.
-- -----------------------------------------------------------------------------

INSERT INTO assets (network, env, kind, symbol, name, decimals, contract_address, price_id, icon_key)
VALUES
  -- TRON mainnet
  ('tron', 'mainnet', 'native', 'TRX',  'TRON',            6, NULL,                                   'tron',              'trx'),
  ('tron', 'mainnet', 'token',  'USDT', 'Tether USD',      6, 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',   'tether',            'usdt'),
  ('tron', 'mainnet', 'token',  'USDC', 'USD Coin',        6, 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8',   'usd-coin',          'usdc'),
  -- TRON Shasta testnet. The Shasta USDT contract is a faucet token, not real Tether.
  ('tron', 'testnet', 'native', 'TRX',  'TRON (Shasta)',   6, NULL,                                   'tron',              'trx'),
  ('tron', 'testnet', 'token',  'USDT', 'Test USDT',       6, 'TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs',   'tether',            'usdt'),
  -- TON mainnet
  ('ton',  'mainnet', 'native', 'TON',  'Toncoin',         9, NULL,                                   'the-open-network',  'ton'),
  ('ton',  'mainnet', 'token',  'USDT', 'Tether USD',      6, 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs', 'tether', 'usdt'),
  -- TON testnet
  ('ton',  'testnet', 'native', 'TON',  'Toncoin (test)',  9, NULL,                                   'the-open-network',  'ton')
ON CONFLICT (network, env, COALESCE(contract_address, 'native:' || symbol)) DO UPDATE
SET name      = EXCLUDED.name,
    decimals  = EXCLUDED.decimals,
    price_id  = EXCLUDED.price_id,
    icon_key  = EXCLUDED.icon_key,
    updated_at = now();

-- -----------------------------------------------------------------------------
--  Built-in categories. `key` is a localisation key resolved in the UI, so these render
--  in Arabic or English without a translation table.
-- -----------------------------------------------------------------------------
INSERT INTO categories (key, kind, icon, color, is_system, sort_order)
VALUES
  ('category.work',      'income',  'briefcase', '#4C8DFF', true, 10),
  ('category.gifts',     'both',    'gift',      '#FF7AB6', true, 20),
  ('category.crypto',    'both',    'coins',     '#F2A33C', true, 30),
  ('category.savings',   'both',    'piggy',     '#3ECF8E', true, 40),
  ('category.food',      'expense', 'food',      '#FF8A5B', true, 50),
  ('category.transport', 'expense', 'car',       '#7C6CFF', true, 60),
  ('category.shopping',  'expense', 'bag',       '#FF5C7A', true, 70),
  ('category.bills',     'expense', 'receipt',   '#5AC8FA', true, 80),
  ('category.health',    'expense', 'heart',     '#FF6B6B', true, 90),
  ('category.other',     'both',    'dots',      '#8E8E93', true, 999)
ON CONFLICT (key) WHERE is_system DO UPDATE
SET kind = EXCLUDED.kind,
    icon = EXCLUDED.icon,
    color = EXCLUDED.color,
    sort_order = EXCLUDED.sort_order,
    updated_at = now();

-- -----------------------------------------------------------------------------
--  Default runtime settings.
--
--  `sending_enabled` here is ANDed with the SENDING_ENABLED environment variable — the
--  database can only ever turn sending OFF, never on. That asymmetry is intentional: a
--  database compromise must not be able to enable outbound transfers.
-- -----------------------------------------------------------------------------
INSERT INTO app_settings (key, value)
VALUES
  ('sending_enabled',            'false'::jsonb),
  ('scheduled_payments_enabled', 'true'::jsonb),
  ('chain_scanning_enabled',     'true'::jsonb),
  ('notifications_enabled',      'true'::jsonb),
  ('fx_auto_refresh_enabled',    'true'::jsonb),
  ('maintenance_mode',           'false'::jsonb)
ON CONFLICT (key) DO NOTHING;
