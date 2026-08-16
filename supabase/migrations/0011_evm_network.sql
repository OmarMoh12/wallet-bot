-- =============================================================================
--  0011_evm_network
--
--  Adds `bsc` to the network enum.
--
--  This migration does nothing else, and that is deliberate. PostgreSQL allows
--  `ALTER TYPE ... ADD VALUE` inside a transaction, but the new value **cannot be used**
--  until that transaction commits. Since the migration runner wraps each file in its own
--  transaction, inserting BEP-20 asset rows here would fail with
--
--      unsafe use of new value "bsc" of enum type network_t
--
--  So the enum value lands here, and 0012 uses it.
-- =============================================================================

ALTER TYPE network_t ADD VALUE IF NOT EXISTS 'bsc';
