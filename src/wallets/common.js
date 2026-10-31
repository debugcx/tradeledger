/** 钱包索引器公共工具：链名归一化、数量解析、仓位构造。 */

export const CHAINS = [
  { id: 'ethereum', label: 'Ethereum' },
  { id: 'arbitrum', label: 'Arbitrum' },
  { id: 'optimism', label: 'Optimism' },
  { id: 'base', label: 'Base' },
  { id: 'polygon', label: 'Polygon' },
  { id: 'bsc', label: 'BNB Chain' },
  { id: 'opbnb', label: 'opBNB' },
  { id: 'avalanche', label: 'Avalanche' },
  { id: 'robinhood', label: 'Robinhood' },
  { id: 'okbchain', label: 'OKB Chain' },
  { id: 'linea', label: 'Linea' },
  { id: 'scroll', label: 'Scroll' },
  { id: 'zksync-era', label: 'zkSync Era' },
  { id: 'polygon-zkevm', label: 'Polygon zkEVM' },
  { id: 'blast', label: 'Blast' },
  { id: 'mantle', label: 'Mantle' },
  { id: 'unichain', label: 'Unichain' },
  { id: 'sonic', label: 'Sonic' },
  { id: 'berachain', label: 'Berachain' },
  { id: 'celo', label: 'Celo' },
  { id: 'fantom', label: 'Fantom' },
  { id: 'gnosis', label: 'Gnosis' },
  { id: 'hyperevm', label: 'HyperEVM' },
  { id: 'world', label: 'World' },
  { id: 'zora', label: 'Zora' },
  { id: 'mode', label: 'Mode' },
  { id: 'manta-pacific', label: 'Manta Pacific' },
  { id: 'solana', label: 'Solana' },
  { id: 'bitcoin', label: 'Bitcoin' },
];

const CHAIN_ALIASES = new Map();
for (const [canonical, aliases] of Object.entries({
  ethereum: ['eth', 'ethereum', 'mainnet', 'ethereum-mainnet', '1'],
  arbitrum: ['arb', 'arbitrum', 'arbitrum-one', 'arbitrum-mainnet', '42161'],
  optimism: ['op', 'optimism', 'optimism-mainnet', '10'],
  base: ['base', 'base-mainnet', '8453'],
  polygon: ['matic', 'polygon', 'polygon-pos', 'polygon-mainnet', '137'],
  bsc: ['bsc', 'bnb', 'binance-smart-chain', 'binance', '56'],
  opbnb: ['opbnb', 'op-bnb', '204'],
  avalanche: ['avax', 'avalanche', 'avalanche-c-chain', '43114'],
  robinhood: ['robinhood', 'rbin', 'robin'],
  okbchain: ['okbchain', 'okbc', 'okexchain', 'okt'],
  linea: ['linea', '59144'],
  scroll: ['scroll', '534352'],
  'zksync-era': ['zksync', 'zksync-era', 'zksync era', '324'],
  'polygon-zkevm': ['polygon-zkevm', 'polygon zk evm', '1101'],
  blast: ['blast', '81457'],
  mantle: ['mantle', '5000'],
  unichain: ['unichain', '130'],
  sonic: ['sonic', '146'],
  berachain: ['berachain', 'bera', '80094'],
  celo: ['celo', '42220'],
  fantom: ['ftm', 'fantom', '250'],
  gnosis: ['gnosis', 'xdai', '100'],
  hyperevm: ['hyperevm', 'hyperliquid', '999'],
  world: ['world', 'worldchain', '480'],
  zora: ['zora', '7777777'],
  mode: ['mode', '34443'],
  'manta-pacific': ['manta', 'manta-pacific', '169'],
  solana: ['sol', 'solana', 'mainnet-beta'],
  bitcoin: ['btc', 'bitcoin'],
})) {
  for (const alias of aliases) CHAIN_ALIASES.set(alias, canonical);
}

export function canonicalChain(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (!key) return '';
  return CHAIN_ALIASES.get(key) || key;
}

export function chainAllowed(chain, filters) {
  const list = Array.isArray(filters) ? filters : [];
  if (!list.length) return true;
  const target = canonicalChain(chain);
  return list.map(canonicalChain).includes(target);
}

export const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function text(v) {
  if (v && typeof v === 'object') return String(v.name || v.id || '');
  return String(v || '');
}

export function makePosition({
  bucket, asset, amount, price = null, value = null,
  chain = '', protocol = '', product = '', source, sourceRef = '',
}) {
  const qty = num(amount);
  const rawPrice = price === null || price === undefined || price === '' ? null : num(price);
  const p = rawPrice !== null && rawPrice > 0 ? rawPrice : null;
  const v = value === null || value === undefined || value === '' ? null : num(value);
  const usd = v === null && p !== null ? qty * p : v;
  return {
    bucket,
    asset: String(asset || '').trim().toUpperCase(),
    amount: qty,
    price_usd: p,
    value_usd: usd === null ? null : usd,
    chain: canonicalChain(chain),
    protocol: String(protocol || '').trim(),
    product: String(product || '').trim(),
    source,
    source_ref: String(sourceRef || '').trim(),
    fetched_at: new Date().toISOString(),
  };
}

/**
 * 过滤灰尘仓位；没有价格的仓位保留，方便用户看到“未估值”。
 * 阈值取 1e-6 而不是 0.01：钱包里的 <0.01 小额真实资产也要能看到。
 */
export function keepPosition(p, minUsd = 1e-6) {
  if (!p.asset || !Number.isFinite(p.amount) || p.amount === 0) return false;
  if (p.value_usd === null) return true;
  return Math.abs(p.value_usd) >= minUsd;
}

export function looksLikeEvm(address) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(address || '').trim());
}

export function looksLikeSolana(address) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(address || '').trim());
}
