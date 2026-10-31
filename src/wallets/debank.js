/**
 * DeBank Cloud API：一次返回 EVM 多链钱包代币与 DeFi 协议仓位。
 *
 *   GET /v1/user/token_list?id=<address>&is_all=true
 *   GET /v1/user/all_complex_protocol_list?id=<address>
 *   Header: AccessKey: <key>
 *
 * 覆盖 Aave、Uniswap、Lido、Pendle、Curve 等协议的存款 / 借款 / LP / 质押，
 * 是本项目推荐的钱包索引服务。
 */

import { requestJson } from '../http-client.js';
import { makePosition, keepPosition, chainAllowed, canonicalChain, looksLikeEvm, num, text } from './common.js';

const DEFAULT_BASE = 'https://pro-openapi.debank.com';

function arrayOf(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

function tokenPositions(tokens, chains) {
  const out = [];
  for (const t of tokens) {
    const chain = canonicalChain(t.chain);
    if (!chainAllowed(chain, chains)) continue;
    const amount = num(t.amount);
    const rawPrice = t.price === null || t.price === undefined ? null : num(t.price);
    const price = rawPrice !== null && rawPrice > 0 ? rawPrice : null;
    const p = makePosition({
      bucket: 'wallet',
      asset: t.symbol || t.name || t.id,
      amount,
      price,
      value: price === null ? null : amount * price,
      chain,
      protocol: '',
      product: t.name || '',
      source: 'debank:/v1/user/token_list',
      sourceRef: t.id || '',
    });
    if (keepPosition(p)) out.push(p);
  }
  return out;
}

function bucketOf(types, item, hasBorrow) {
  const tag = types.join(' ').toLowerCase();
  const name = String(item.name || '').toLowerCase();
  if (/liquid|pool|farm|lp/.test(tag) || /pool|farm|lp/.test(name)) return 'defi_lp';
  if (/stake|lock|restake|vest|validator/.test(tag) || /stake|lock|restake/.test(name)) return 'defi_staking';
  if (/lend|borrow|credit/.test(tag) || hasBorrow) return 'defi_supply';
  return 'defi_supply';
}

function pushTokenList(out, list, { bucket, protocol, product, chain, source, sourceRef, sign = 1 }) {
  for (const t of Array.isArray(list) ? list : []) {
    const amount = num(t.amount);
    const rawPrice = t.price === null || t.price === undefined ? null : num(t.price);
    const price = rawPrice !== null && rawPrice > 0 ? rawPrice : null;
    const p = makePosition({
      bucket,
      asset: t.symbol || t.name || t.id,
      amount: amount * sign,
      price,
      value: price === null ? null : amount * price * sign,
      chain,
      protocol,
      product,
      source,
      sourceRef,
    });
    if (keepPosition(p)) out.push(p);
  }
}

/** 纯函数：便于用固定响应做单元测试 */
export function mapDebank({ tokens = [], protocols = [], chains = [] } = {}) {
  const out = tokenPositions(arrayOf(tokens), chains);
  for (const protocol of arrayOf(protocols)) {
    const chain = canonicalChain(protocol.chain);
    if (!chainAllowed(chain, chains)) continue;
    const protocolName = text(protocol.name) || text(protocol.id);
    const items = Array.isArray(protocol.portfolio_item_list) ? protocol.portfolio_item_list : [];
    for (const item of items) {
      const detail = item.detail || {};
      const stats = item.stats || {};
      const types = [].concat(item.detail_types || [], item.detail_type || []).map((x) => String(x));
      const supplies = detail.supply_token_list || detail.supply_tokens || [];
      const borrows = detail.borrow_token_list || detail.borrow_tokens || [];
      const rewards = detail.reward_token_list || detail.reward_tokens || [];
      const source = 'debank:/v1/user/all_complex_protocol_list';
      const sourceRef = String(protocol.id || item.pool?.id || '');
      const product = String(item.name || '');
      const bucket = bucketOf(types, item, borrows.length > 0);

      pushTokenList(out, supplies, { bucket, protocol: protocolName, product, chain, source, sourceRef });
      pushTokenList(out, borrows, {
        bucket: 'defi_debt', protocol: protocolName, product, chain, source, sourceRef, sign: -1,
      });
      pushTokenList(out, rewards, {
        bucket: 'defi_reward', protocol: protocolName, product, chain, source, sourceRef,
      });

      // 协议没有给出 token 明细时，用 stats 兜底，至少把仓位金额记录进来
      const hasTokens = supplies.length || borrows.length || rewards.length;
      if (!hasTokens) {
        const assetValue = num(stats.asset_usd_value);
        const debtValue = num(stats.debt_usd_value);
        if (Math.abs(assetValue) > 0) {
          const p = makePosition({
            bucket, asset: protocolName || 'POSITION', amount: 1, value: assetValue,
            chain, protocol: protocolName, product, source, sourceRef,
          });
          if (keepPosition(p)) out.push(p);
        }
        if (Math.abs(debtValue) > 0) {
          const p = makePosition({
            bucket: 'defi_debt', asset: protocolName || 'DEBT', amount: -1, value: -Math.abs(debtValue),
            chain, protocol: protocolName, product, source, sourceRef,
          });
          if (keepPosition(p)) out.push(p);
        }
      }
    }
  }
  return out;
}

export const debank = {
  id: 'debank',
  name: 'DeBank Cloud',
  description: 'EVM 多链代币 + DeFi 协议仓位（Aave / Uniswap / Lido / Pendle 等），覆盖最好，按量收费',
  requiresKey: true,
  supportsAddress: looksLikeEvm,
  addressHint: '0x 开头的 EVM 地址（同一个地址会扫描所有 EVM 链）',

  async fetchPositions({ address, apiKey, baseUrl = '', chains = [] } = {}) {
    if (!apiKey) throw new Error('未配置 DeBank AccessKey');
    if (!looksLikeEvm(address)) throw new Error('DeBank 只支持 0x 开头的 EVM 地址');
    const base = String(baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    const headers = { AccessKey: apiKey, accept: 'application/json' };
    const id = encodeURIComponent(address.trim());
    const errors = [];
    let tokens = [];
    let protocols = [];

    const [tokenRes, protocolRes] = await Promise.allSettled([
      requestJson(`${base}/v1/user/token_list?id=${id}&is_all=true`, { method: 'GET', headers, timeout: 20_000, retries: 0 }),
      requestJson(`${base}/v1/user/all_complex_protocol_list?id=${id}`, { method: 'GET', headers, timeout: 20_000, retries: 0 }),
    ]);
    if (tokenRes.status === 'fulfilled') {
      if (tokenRes.value.status >= 400) errors.push(`代币列表 HTTP ${tokenRes.value.status}`);
      else tokens = arrayOf(tokenRes.value.json);
    } else {
      errors.push(`代币列表：${tokenRes.reason?.message || tokenRes.reason}`);
    }
    if (protocolRes.status === 'fulfilled') {
      if (protocolRes.value.status >= 400) errors.push(`协议仓位 HTTP ${protocolRes.value.status}`);
      else protocols = arrayOf(protocolRes.value.json);
    } else {
      errors.push(`协议仓位：${protocolRes.reason?.message || protocolRes.reason}`);
    }
    if (errors.length && !tokens.length && !protocols.length) {
      throw new Error(`DeBank 同步失败：${errors.join('；')}`);
    }

    // is_verified=false 的钱包代币多为空投垃圾币；协议仓位不受影响
    const skipped = tokens.filter((t) => t.is_verified === false);
    const verifiedTokens = tokens.filter((t) => t.is_verified !== false);
    const notes = skipped.length
      ? [`已跳过 ${skipped.length} 个未验证钱包代币：${skipped.slice(0, 3).map((t) => {
        const contract = String(t.id || '').slice(0, 8);
        return contract ? `${t.symbol || t.name}(${contract}…)` : (t.symbol || t.name);
      }).join(' / ')}`]
      : [];
    return { positions: mapDebank({ tokens: verifiedTokens, protocols, chains }), errors, notes };
  },
};
