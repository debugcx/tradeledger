import { okx } from './okx.js';
import { binance } from './binance.js';
import { bybit } from './bybit.js';
import { bitget } from './bitget.js';
import { gate } from './gate.js';
import { hyperliquid } from './hyperliquid.js';

export const exchangeList = [okx, binance, bybit, bitget, gate, hyperliquid];

export const exchangeMeta = exchangeList.map((x) => ({
  id: x.id,
  name: x.name,
  fields: x.fields,
  tips: x.tips,
}));

export function getExchange(id) {
  return exchangeList.find((x) => x.id === String(id || '').toLowerCase()) || null;
}
