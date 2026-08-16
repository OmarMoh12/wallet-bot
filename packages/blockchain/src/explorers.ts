import type { Network, NetworkEnv } from '@wallet/shared';

/**
 * Block-explorer URL registry.
 *
 * Every explorer link in the app is built here. Nothing string-concatenates an explorer URL
 * at a call site, because a fabricated or subtly wrong link on a financial record is worse
 * than no link at all — it looks authoritative while pointing at nothing.
 *
 * The `{hash}` / `{address}` placeholders are substituted with URL-encoded values.
 */

export interface ExplorerConfig {
  name: string;
  baseUrl: string;
  transactionPath: string;
  addressPath: string;
  tokenPath?: string;
}

type ExplorerKey = `${Network}:${NetworkEnv}`;

export const EXPLORERS: Readonly<Record<ExplorerKey, ExplorerConfig>> = Object.freeze({
  'tron:mainnet': {
    name: 'TronScan',
    baseUrl: 'https://tronscan.org',
    transactionPath: '/#/transaction/{hash}',
    addressPath: '/#/address/{address}',
    tokenPath: '/#/token20/{address}',
  },
  'tron:testnet': {
    // Shasta is the TRON testnet this project targets; see .env.example.
    name: 'Shasta TronScan',
    baseUrl: 'https://shasta.tronscan.org',
    transactionPath: '/#/transaction/{hash}',
    addressPath: '/#/address/{address}',
    tokenPath: '/#/token20/{address}',
  },
  'ton:mainnet': {
    name: 'Tonviewer',
    baseUrl: 'https://tonviewer.com',
    transactionPath: '/transaction/{hash}',
    addressPath: '/{address}',
  },
  'ton:testnet': {
    name: 'Tonviewer (testnet)',
    baseUrl: 'https://testnet.tonviewer.com',
    transactionPath: '/transaction/{hash}',
    addressPath: '/{address}',
  },
  'bsc:mainnet': {
    name: 'BscScan',
    baseUrl: 'https://bscscan.com',
    transactionPath: '/tx/{hash}',
    addressPath: '/address/{address}',
    tokenPath: '/token/{address}',
  },
  'bsc:testnet': {
    name: 'BscScan (testnet)',
    baseUrl: 'https://testnet.bscscan.com',
    transactionPath: '/tx/{hash}',
    addressPath: '/address/{address}',
    tokenPath: '/token/{address}',
  },
});

function explorerFor(network: Network, env: NetworkEnv): ExplorerConfig | null {
  return EXPLORERS[`${network}:${env}` as ExplorerKey] ?? null;
}

function build(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = values[key];
    return value === undefined ? match : encodeURIComponent(value);
  });
}

export function explorerName(network: Network, env: NetworkEnv): string | null {
  return explorerFor(network, env)?.name ?? null;
}

export function transactionUrl(network: Network, env: NetworkEnv, txHash: string): string | null {
  const explorer = explorerFor(network, env);
  if (!explorer || !txHash) return null;
  return explorer.baseUrl + build(explorer.transactionPath, { hash: txHash });
}

export function addressUrl(network: Network, env: NetworkEnv, address: string): string | null {
  const explorer = explorerFor(network, env);
  if (!explorer || !address) return null;
  return explorer.baseUrl + build(explorer.addressPath, { address });
}

export function tokenUrl(
  network: Network,
  env: NetworkEnv,
  contractAddress: string,
): string | null {
  const explorer = explorerFor(network, env);
  if (!explorer?.tokenPath || !contractAddress) return null;
  return explorer.baseUrl + build(explorer.tokenPath, { address: contractAddress });
}

/** Human-readable network label for the UI (e.g. the "correct network" warning). */
const NETWORK_LABELS: Readonly<Record<Network, string>> = Object.freeze({
  tron: 'TRON (TRC20)',
  ton: 'TON',
  bsc: 'BNB Smart Chain (BEP-20)',
});

export function networkLabel(network: Network, env: NetworkEnv): string {
  const base = NETWORK_LABELS[network] ?? network.toUpperCase();
  return env === 'testnet' ? `${base} — testnet` : base;
}
