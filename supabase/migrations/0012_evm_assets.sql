-- =============================================================================
--  0012_evm_assets
--
--  BNB Smart Chain assets, and the index that makes EVM log scanning efficient.
--
--  Contract addresses are stored **lowercase**, which is the canonical form for an EVM
--  address. EIP-55 mixed case is a checksum for humans, not part of the address, and storing
--  the checksummed form would make `contract_address = $1` comparisons fail against a
--  perfectly valid lowercase input from a node.
-- =============================================================================

INSERT INTO assets (network, env, kind, symbol, name, decimals, contract_address, price_id, icon_key)
VALUES
  -- BNB Smart Chain mainnet (chain id 56)
  ('bsc', 'mainnet', 'native', 'BNB',  'BNB',                     18, NULL,                                         'binancecoin', 'bnb'),
  ('bsc', 'mainnet', 'token',  'USDT', 'Tether USD (BEP-20)',     18, '0x55d398326f99059ff775485246999027b3197955', 'tether',      'usdt'),
  ('bsc', 'mainnet', 'token',  'USDC', 'USD Coin (BEP-20)',       18, '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', 'usd-coin',    'usdc'),
  ('bsc', 'mainnet', 'token',  'BUSD', 'Binance USD (BEP-20)',    18, '0xe9e7cea3dedca5984780bafc599bd69add087d56', 'binance-usd', 'busd'),

  -- BNB Smart Chain testnet (chain id 97). These are faucet tokens, not real value.
  ('bsc', 'testnet', 'native', 'tBNB', 'BNB (testnet)',           18, NULL,                                         'binancecoin', 'bnb'),
  ('bsc', 'testnet', 'token',  'USDT', 'Test USDT (BEP-20)',      18, '0x337610d27c682e347c9cd60bd4b3b107c9d34ddd', 'tether',      'usdt')
ON CONFLICT (network, env, COALESCE(contract_address, 'native:' || symbol)) DO UPDATE
SET name       = EXCLUDED.name,
    decimals   = EXCLUDED.decimals,
    price_id   = EXCLUDED.price_id,
    icon_key   = EXCLUDED.icon_key,
    updated_at = now();

-- -----------------------------------------------------------------------------
--  Note on decimals
--
--  USDT on BSC has **18** decimals, unlike USDT on TRON and Ethereum which have 6.
--  Hard-coding 6 is one of the most common integration bugs on this chain and misstates
--  balances by a factor of 10^12. The value here comes from the deployed contract, and
--  `TokenAmount` carries decimals with every amount precisely so the two can never be
--  confused at a call site.
-- -----------------------------------------------------------------------------

-- EVM scanning resumes from a block height held in `wallets.scan_cursor`. This partial index
-- keeps the "which EVM wallets are due?" query cheap as the wallet count grows.
CREATE INDEX IF NOT EXISTS wallets_evm_scan_idx
  ON wallets (network, env, last_scanned_at NULLS FIRST)
  WHERE is_active AND deleted_at IS NULL;
