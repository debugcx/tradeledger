/**
 * Zerion API：EVM + Solana 钱包代币与 DeFi 仓位。
 *
 *   GET /v1/wallets/{address}/positions/?currency=usd
 *   Authorization: Basic base64(<apiKey>:)
 *
 * 返回的 position_type 映射到统一资产桶：
 * wallet → 钱包代币；deposit/investment → DeFi 存款；
 * loan/borrow → 负债；staked → 质押；reward → 奖励。
 */

import { requestJson } from '../http-client.js';
import { makePosition, keepPosition, chainAllowed, canonicalChain, looksLikeEvm, looksLikeSolana, num, text } from './common.js';

const DEFAULT_BASE = 'https://api.zerion.io';

function pickQuantity(attrs) {
  const q = attrs.quantity;
  if (q === null || q === undefined) return num(attrs.amount);
  if (typeof q === 'object') return num(q.float ?? q.numeric ?? q.value);
  return num(q);
}

// Zerion 把 Uniswap/Pancake 这类 LP 也标成 deposit，需要根据 dApp 或 NFT 凭证识别
const DEX_RE = /uniswap|pancake|curve|sushi|balancer|aerodrome|velodrome|trader.?joe|raydium|orca|meteora|1inch|dodo|kyber|maverick|thena|quickswap/i;

function bucketOfPosition(type, attrs, row) {
  const t = String(type || '').toLowerCase();
  if (t === 'wallet' || t === 'asset' || t === 'token') return 'wallet';
  if (t.includes('loan') || t.includes('borrow') || t.includes('debt')) return 'defi_debt';
  if (t.includes('stake') || t.includes('lock')) return 'defi_staking';
  if (t.includes('reward') || t.includes('claim')) return 'defi_reward';
  const dapp = String(
    attrs.application_metadata?.name
    || row?.relationships?.dapp?.data?.id
    || attrs.protocol?.name
    || attrs.protocol
    || '',
  );
  if (t.includes('pool') || t.includes('lp')
    || attrs.receipt?.nft_info
    || /pool|lp|farm|liquidity/i.test(String(attrs.name || ''))
    || DEX_RE.test(dapp)) return 'defi_lp';
  return 'defi_supply';
}

/** 纯函数：便于用固定响应做单元测试 */
export function mapZerion(rows = [], chains = []) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const attrs = row?.attributes || row || {};
    // Zerion 的链在 JSON:API relationships 里，不在 attributes.chain；老响应可能仍有 attributes.chain
    const chain = canonicalChain(
      row?.relationships?.chain?.data?.id
      || attrs.chain?.id || attrs.chain || attrs.network
      || attrs.receipt?.nft_info?.chain_id
      || attrs.parent?.chain_id || attrs.parent?.chain,
    );
    if (!chainAllowed(chain, chains)) continue;
    const amount = pickQuantity(attrs);
    const type = attrs.position_type || attrs.positionType || attrs.type || 'wallet';
    const bucket = bucketOfPosition(type, attrs, row);
    const sign = bucket === 'defi_debt' ? -1 : 1;
    const rawPrice = attrs.price === null || attrs.price === undefined ? null : num(attrs.price);
    const price = rawPrice !== null && rawPrice > 0 ? rawPrice : null;
    const rawValue = attrs.value === null || attrs.value === undefined ? null : num(attrs.value);
    const computed = price === null ? null : amount * price;
    const value = rawValue === null || rawValue === 0 ? (computed === 0 ? null : computed) : rawValue;
    const protocol = text(attrs.application_metadata)
      || text(row?.relationships?.dapp?.data?.id)
      || text(attrs.protocol)
      || text(attrs.dapp)
      || '';
    const symbol = attrs.fungible_info?.symbol
      || attrs.fungible_info?.name
      || attrs.symbol
      || attrs.name
      || 'POSITION';
    const p = makePosition({
      bucket,
      asset: symbol,
      amount: amount * sign,
      price,
      value: value === null ? null : Math.abs(value) * sign,
      chain,
      protocol,
      product: bucket === 'wallet' ? '' : String(attrs.name || ''),
      source: 'zerion:/v1/wallets/positions',
      sourceRef: String(row?.id || attrs.id || ''),
    });
    // Zerion 的 fungible_info.flags.verified=false 基本是空投垃圾币（常见于同名假币）
    p.unverified = attrs.fungible_info?.flags?.verified === false;
    if (keepPosition(p)) out.push(p);
  }
  return out;
}

/** 未验证的钱包代币不进入资产统计；DeFi 仓位即使代币未验证也保留，避免漏掉真实仓位 */
export function splitUnverifiedWalletPositions(positions = []) {
  const kept = [];
  const skipped = [];
  for (const p of positions) {
    if (p.unverified && p.bucket === 'wallet') skipped.push(p);
    else kept.push(p);
  }
  return { kept, skipped };
}

export const zerion = {
  id: 'zerion',
  name: 'Zerion',
  description: 'EVM + Solana 代币与 DeFi 仓位，有免费额度，覆盖比 DeBank 略窄',
  requiresKey: true,
  supportsAddress: (address) => looksLikeEvm(address) || looksLikeSolana(address),
  addressHint: '0x 开头的 EVM 地址，或 Solana base58 地址',

  async fetchPositions({ address, apiKey, baseUrl = '', chains = [] } = {}) {
    if (!apiKey) throw new Error('未配置 Zerion API Key');
    if (!looksLikeEvm(address) && !looksLikeSolana(address)) {
      throw new Error('地址格式无法识别（需要 EVM 0x 地址或 Solana base58 地址）');
    }
    const base = String(baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    const auth = `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;
    const headers = { Authorization: auth, accept: 'application/json' };
    // 默认 only_simple 只返回钱包代币；no_filter 才包含 Aave/Uniswap/Pancake 等 DeFi 仓位
    let url = `${base}/v1/wallets/${encodeURIComponent(address.trim())}/positions/?currency=usd&page[size]=100&filter[positions]=no_filter&filter[trash]=only_non_trash`;
    const rows = [];
    const errors = [];

    for (let page = 0; page < 10 && url; page++) {
      let res;
      try {
        res = await requestJson(url, { method: 'GET', headers, timeout: 20_000, retries: 0 });
      } catch (err) {
        throw new Error(`Zerion 请求失败：${err?.message || err}`);
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error('Zerion API Key 无效或权限不足');
      }
      if (res.status >= 400) {
        errors.push(`Zerion HTTP ${res.status}`);
        break;
      }
      const data = res.json || {};
      rows.push(...(Array.isArray(data.data) ? data.data : []));
      const next = data.links?.next;
      url = next ? (String(next).startsWith('http') ? String(next) : `${base}${next}`) : '';
    }

    const mapped = mapZerion(rows, chains);
    const { kept, skipped } = splitUnverifiedWalletPositions(mapped);
    const notes = skipped.length
      ? [`已跳过 ${skipped.length} 个未验证钱包代币：${skipped.slice(0, 3).map((p) => {
        const contract = String(p.source_ref || '').slice(0, 8);
        return contract ? `${p.asset}(${contract}…)` : p.asset;
      }).join(' / ')}`]
      : [];
    return { positions: kept, errors, notes };
  },
};
