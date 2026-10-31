import { debank } from './debank.js';
import { zerion } from './zerion.js';

export const walletProviderList = [debank, zerion];

export const walletProviderMeta = walletProviderList.map((p) => ({
  id: p.id,
  name: p.name,
  description: p.description,
  requiresKey: p.requiresKey,
  addressHint: p.addressHint,
}));

export function getWalletProvider(id) {
  return walletProviderList.find((p) => p.id === String(id || '').toLowerCase()) || null;
}

export { CHAINS, canonicalChain, looksLikeEvm, looksLikeSolana } from './common.js';
