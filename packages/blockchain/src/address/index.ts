import type { Network } from '@wallet/shared';
import type { AddressValidation } from '../types.js';
import { validateTronAddress } from './tron.js';
import { validateTonAddress } from './ton.js';
import { validateEvmAddress } from './evm.js';

export * from './base58.js';
export * from './tron.js';
export * from './ton.js';
export * from './evm.js';

/**
 * Validate an address against a specific network.
 *
 * Always network-scoped: "is this a valid address" is not a meaningful question on its own,
 * and answering it generically is how a TON address ends up in a TRON transfer. Every call
 * site passes the network it intends to use.
 */
export function validateAddress(network: Network, address: string): AddressValidation {
  switch (network) {
    case 'tron':
      return validateTronAddress(address);
    case 'ton':
      return validateTonAddress(address);
    case 'bsc': {
      // Every EVM chain shares one address format, so the validator cannot know which chain
      // it was called for. Re-tag the result with the network the caller asked about.
      const result = validateEvmAddress(address);
      return result.valid ? { ...result, network } : result;
    }
    default: {
      // Compile error if a Network variant is added without an address validator.
      const exhaustive: never = network;
      void exhaustive;
      return { valid: false, reason: 'network' };
    }
  }
}

/**
 * Which networks would accept this address?
 *
 * Used only for the "this looks like a different network" warning on the send screen. It is
 * advisory: the authoritative check is always `validateAddress(intendedNetwork, address)`.
 */
export function detectNetworks(address: string): Network[] {
  const matches: Network[] = [];
  if (validateTronAddress(address).valid) matches.push('tron');
  if (validateTonAddress(address).valid) matches.push('ton');
  // An EVM address is valid on every EVM chain, so this reports the family rather than a
  // specific chain — enough for the "that looks like a different network" warning.
  if (validateEvmAddress(address).valid) matches.push('bsc');
  return matches;
}

export function canonicalAddress(network: Network, address: string): string | null {
  const result = validateAddress(network, address);
  return result.valid ? result.canonical : null;
}

export function displayAddress(network: Network, address: string): string {
  const result = validateAddress(network, address);
  return result.valid ? result.display : address;
}
