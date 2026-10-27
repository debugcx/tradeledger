/**
 * CSV 解析、列映射、数值/时间归一化（纯函数，零依赖）
 *
 * 设计目标：交易所导出的格式千差万别，但只要表头能对上，
 * 就能通过「自动映射 + 人工改映射」把数据导进来。
 */

import { matchFills, fingerprintTrade } from './fills.js';

export const FIELD_DEFS = [
  {
    key: 'symbol', label: '币种', required: true,
    aliases: ['symbol', 'pair', 'tradingpair', 'currencypair', 'contract', 'instrument', 'instrumentid', 'instid', 'instfamily', 'market', 'coin', 'underlying', '币种', '交易对', '合约', '合约名称', '标的'],
  },
  {
    key: 'side', label: '方向',
    aliases: ['side', 'direction', 'positionside', 'posside', 'tradeside', '开平方向', '持仓方向', '买卖方向', '方向', '买卖'],
  },
  {
    key: 'order_type', label: '订单类型',
    aliases: ['ordertype', 'ordtype', 'type', '订单类型', '委托类型', '类型'],
  },
  {
    key: 'size', label: '数量',
    aliases: ['size', 'qty', 'quantity', 'filledqty', 'filledquantity', 'execqty', 'executedqty', 'executed', 'basevolume', 'vol', 'volume', 'amount', 'openmaxpos', 'closetotalpos', 'closesize', 'total', 'sz', '数量', '成交量', '成交数量', '委托数量', '持仓量'],
  },
  {
    key: 'notional', label: '名义价值',
    aliases: ['notional', 'notionalvalue', 'turnover', 'value', 'amountusdt', 'quotqty', 'quotevolume', 'cumentryvalue', 'cumexitvalue', '成交额', '名义价值', '名义金额', '成交金额', '交易额'],
  },
  {
    key: 'open_time', label: '开仓时间',
    aliases: ['opentime', 'entrytime', 'createtime', 'createdtime', 'ctime', 'opendate', '开仓时间', '建仓时间', '创建时间', '下单时间'],
  },
  {
    key: 'close_time', label: '平仓时间', required: true,
    aliases: ['closetime', 'closedtime', 'exittime', 'updatetime', 'updatedtime', 'utime', 'time', 'timestamp', 'ts', 'filltime', '成交时间', '平仓时间', '更新时间', '结束时间', '时间'],
  },
  {
    key: 'pnl', label: '净盈亏',
    aliases: ['pnl', 'realizedpnl', 'closedpnl', 'realizedprofit', 'closedprofit', 'netprofit', 'grossprofit', 'profit', 'totalpnl', '盈亏', '已实现盈亏', '平仓盈亏', '净盈亏', '实现盈亏', '收益', '利润'],
  },
  {
    key: 'fee', label: '手续费',
    aliases: ['fee', 'fees', 'commission', 'commissionfee', 'tradingfee', 'feeamount', 'execfee', 'totalfee', '手续费', '交易手续费', '费用'],
  },
  {
    key: 'funding', label: '资金费',
    aliases: ['funding', 'fundingfee', 'fundingcost', 'fundingpayment', 'totalfunding', '资金费', '资金费用', '资金费率'],
  },
  {
    key: 'entry_price', label: '开仓价',
    aliases: ['entryprice', 'openprice', 'openavgprice', 'avgprice', 'averageprice', 'avgentryprice', 'entry', 'open', '开仓价', '开仓均价', '建仓价', '买入价', '开仓价格'],
  },
  {
    key: 'exit_price', label: '平仓价',
    aliases: ['exitprice', 'closeprice', 'closeavgprice', 'avgcloseprice', 'avgexitprice', 'close', 'exit', 'fillpx', 'fillprice', 'avgfillprice', 'execprice', 'px', 'price', '成交价', '平仓价', '平仓均价', '卖出价', '成交均价', '平仓价格'],
  },
  {
    key: 'external_id', label: '外部 ID',
    aliases: ['id', 'orderid', 'tradeid', 'execid', 'executionid', 'ordid', 'tid', 'billid', 'positionid', '订单号', '订单id', '成交id', '交易id'],
  },
  {
    key: 'tags', label: '标签',
    aliases: ['tags', 'tag', '标签'],
  },
  {
    key: 'note', label: '备注',
    aliases: ['note', 'notes', 'remark', 'remarks', 'comment', 'memo', '备注', '说明', '注释'],
  },
];

export const EMPTY_MAPPING = Object.fromEntries(FIELD_DEFS.map((f) => [f.key, '']));

/** 表头归一化：小写、去空白与常见标点，保留中文 */
export function normalizeHeader(header) {
  return String(header ?? '')
    .toLowerCase()
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s_\-./\\:*"'`~!@#$%^&+=|<>[\]{}，。；：、]/g, '');
}

function countOutsideQuotes(line, delimiter) {
  let count = 0, inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') i++;
      else inQuotes = !inQuotes;
    } else if (ch === delimiter && !inQuotes) count++;
  }
  return count;
}

export function detectDelimiter(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim()).slice(0, 5);
  const candidates = [',', ';', '\t', '|'];
  let best = ',', bestScore = -1;
  for (const d of candidates) {
    const score = lines.reduce((acc, line) => acc + countOutsideQuotes(line, d), 0);
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return bestScore > 0 ? best : ',';
}

/** 把 CSV 文本切成二维数组（不含表头判断） */
export function parseCsvRows(text, delimiter) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const delim = delimiter || detectDelimiter(src);
  const raw = [];
  let row = [], cell = '', inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      raw.push(row);
      row = [];
      cell = '';
    } else if (ch === '\r') {
      // 跳过；\r\n 由 \n 收尾
    } else {
      cell += ch;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    raw.push(row);
  }
  return {
    delimiter: delim,
    rows: raw.filter((r) => r.some((c) => String(c).trim() !== '')),
  };
}

/** 解析 CSV → { headers, rows, delimiter }；第一行当表头（兼容旧调用） */
export function parseCsv(text, delimiter) {
  const { rows, delimiter: delim } = parseCsvRows(text, delimiter);
  if (!rows.length) return { headers: [], rows: [], delimiter: delim };
  const headers = rows[0].map((h) => String(h).trim());
  return { headers, rows: rows.slice(1), delimiter: delim };
}

/** 所有可能出现在表头里的字段名，用来给“找表头”打分 */
const HEADER_HINTS = (() => {
  const set = new Set();
  for (const f of FIELD_DEFS) for (const a of f.aliases) set.add(normalizeHeader(a));
  for (const extra of [
    'orderid', 'tradeid', 'execid', 'fillprice', 'fillsize', 'realizedprofit', 'closedpnl',
    'fundingfee', 'ordtype', 'instrumentid', 'feecoin', 'feeccy', 'basevolume', 'quotevolume',
    'avgprice', 'markprice', 'leverage', 'margin', 'positionid', 'posside', 'direction',
    'execqty', 'execprice', 'currencypair', 'contract', 'size', 'closesize', 'startposition',
    'crossed', 'oid', 'tid', 'coin', 'dir', 'px', 'sz',
  ]) set.add(normalizeHeader(extra));
  return set;
})();

/** 在前 15 行里找最像表头的一行（交易所导出常有标题/账户信息等前置行） */
export function findHeaderRow(rows) {
  let best = 0;
  let bestScore = -1;
  const limit = Math.min(rows.length, 15);
  for (let i = 0; i < limit; i++) {
    const row = rows[i] || [];
    let matches = 0;
    let nonEmpty = 0;
    for (const cell of row) {
      const n = normalizeHeader(cell);
      if (!n) continue;
      nonEmpty++;
      if (HEADER_HINTS.has(n)) matches++;
    }
    const score = matches * 10 + Math.min(nonEmpty, 20);
    if (matches >= 2 && score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  return best;
}

/** 智能解析：跳过前置说明行、定位表头 */
export function parseCsvSmart(text, delimiter) {
  const { rows, delimiter: delim } = parseCsvRows(text, delimiter);
  if (!rows.length) return { headers: [], rows: [], delimiter: delim, headerIndex: 0, skippedRows: 0 };
  const headerIndex = findHeaderRow(rows);
  const headers = rows[headerIndex].map((h) => String(h).trim());
  return {
    headers,
    rows: rows.slice(headerIndex + 1),
    delimiter: delim,
    headerIndex,
    skippedRows: headerIndex,
  };
}

/* ---------------- 交易所格式预设 ---------------- */

export const CSV_PRESETS = [
  { id: 'okx', label: 'OKX', signatures: ['instrumentid', 'fillsize', 'fillprice', 'realizedpnl', 'posside', 'utime'] },
  { id: 'binance', label: 'Binance', signatures: ['realizedprofit', 'commissionasset', 'quotqty', 'executedqty', 'executed', 'orderid'] },
  { id: 'bybit', label: 'Bybit', signatures: ['closedpnl', 'avgentryprice', 'avgexitprice', 'execprice', 'execqty', 'createdtime', 'updatedtime'] },
  { id: 'bitget', label: 'Bitget', signatures: ['positionid', 'openavgprice', 'closeavgprice', 'opentotalpos', 'closetotalpos', 'netprofit', 'basevolume'] },
  { id: 'gate', label: 'Gate.io', signatures: ['contract', 'closesize', 'createtime', 'orderid'] },
  { id: 'hyperliquid', label: 'Hyperliquid', signatures: ['coin', 'dir', 'px', 'sz', 'closedpnl', 'startposition'] },
];

export function detectPreset(headers) {
  const set = new Set(headers.map(normalizeHeader).filter(Boolean));
  let best = { id: 'generic', label: '通用（自动识别）', score: 0 };
  for (const preset of CSV_PRESETS) {
    let score = 0;
    for (const sig of preset.signatures) {
      if (set.has(normalizeHeader(sig))) score++;
    }
    if (score > best.score) best = { id: preset.id, label: preset.label, score };
  }
  return best;
}

/** 自动判断是「已平仓交易」还是「逐笔成交」 */
export function detectMode(headers, mapping) {
  const has = (key) => mapping[key] !== '' && mapping[key] !== undefined;
  if (has('entry_price') && has('exit_price')) return 'roundtrip';
  if (has('exit_price') && has('size') && !has('entry_price')) {
    // 有方向列，或者没有盈亏列（只有成交价/数量）→ 逐笔成交
    if (has('side') || !has('pnl')) return 'fills';
  }
  return 'roundtrip';
}

/** 逐笔成交的买卖方向（区别于 round trip 的 long/short） */
export function normalizeFillSide(raw) {
  const s = String(raw || '').toLowerCase().replace(/\s+/g, '');
  if (!s) return '';
  if (s.includes('开多') || s.includes('openlong') || s.includes('平空') || s.includes('closeshort')) return 'buy';
  if (s.includes('开空') || s.includes('openshort') || s.includes('平多') || s.includes('closelong')) return 'sell';
  if (s.includes('买') || s.includes('buy') || s === 'b') return 'buy';
  if (s.includes('卖') || s.includes('sell') || s === 's') return 'sell';
  return '';
}

/** 自动列映射：返回 { fieldKey: headerIndex|'' } */
export function autoMap(headers) {
  const used = new Set();
  const mapping = { ...EMPTY_MAPPING };
  for (const field of FIELD_DEFS) {
    let bestIndex = -1;
    let bestScore = 0;
    headers.forEach((header, index) => {
      if (used.has(index)) return;
      const nh = normalizeHeader(header);
      if (!nh) return;
      let score = 0;
      for (const alias of field.aliases) {
        const na = normalizeHeader(alias);
        if (nh === na) score = Math.max(score, 100);
        else if ((nh.startsWith(na) || na.startsWith(nh)) && Math.min(nh.length, na.length) >= 4) score = Math.max(score, 70);
        else if (nh.includes(na)) score = Math.max(score, 40);
      }
      if (score > bestScore) { bestScore = score; bestIndex = index; }
    });
    if (bestIndex >= 0 && bestScore >= 40) {
      mapping[field.key] = bestIndex;
      used.add(bestIndex);
    }
  }
  return mapping;
}

export function mappingFromForm(body = {}) {
  const mapping = { ...EMPTY_MAPPING };
  for (const field of FIELD_DEFS) {
    const raw = body[`map_${field.key}`];
    if (raw === undefined || raw === '') { mapping[field.key] = ''; continue; }
    const index = Number(raw);
    mapping[field.key] = Number.isInteger(index) && index >= 0 ? index : '';
  }
  return mapping;
}

export function validateMapping(mapping, headers, mode = 'roundtrip') {
  if (!headers.length) return ['CSV 没有表头'];
  if (mapping.symbol === '' || mapping.symbol === undefined) return ['请选择「币种」对应的列'];
  const hasTime = (mapping.close_time !== '' && mapping.close_time !== undefined)
    || (mapping.open_time !== '' && mapping.open_time !== undefined);
  if (!hasTime) return ['请选择「平仓时间」或「开仓时间」对应的列'];
  if (mode === 'fills') {
    if (mapping.exit_price === '' || mapping.exit_price === undefined) return ['逐笔成交模式需要映射「成交价」列'];
    if (mapping.size === '' || mapping.size === undefined) return ['逐笔成交模式需要映射「数量」列'];
    return [];
  }
  const hasPnl = mapping.pnl !== '' && mapping.pnl !== undefined;
  const hasPricePnl = mapping.entry_price !== '' && mapping.exit_price !== '' && mapping.size !== '';
  if (!hasPnl && !hasPricePnl) {
    return ['缺少盈亏列：请映射「净盈亏」，或同时映射「开仓价 / 平仓价 / 数量」'];
  }
  return [];
}

/**
 * 逐笔成交模式：符号/买卖方向/成交价/数量/时间 → FIFO 配对成 round trip。
 * 适用于现货成交、合约 fills、以及只导出了成交明细的 CSV。
 */
export function buildTradesFromFills(headers, rows, mapping, opts = {}) {
  const tzOffset = Number(opts.tzOffset || 0);
  const costPositive = opts.costPositive !== false;
  const market = opts.market === 'spot' ? 'spot' : 'futures';
  const fills = [];
  const errors = [];

  rows.forEach((row, index) => {
    const line = index + 2 + (Number(opts.lineOffset) || 0);
    try {
      const pick = (key) => {
        const i = mapping[key];
        return i === '' || i === undefined || i === null ? '' : (row[i] ?? '');
      };
      const symbol = normalizeCsvSymbol(pick('symbol'));
      if (!symbol) throw new Error('币种为空');
      const time = parseTimeValue(pick('close_time') || pick('open_time'), tzOffset);
      if (!time) throw new Error(`成交时间无法解析：${String(pick('close_time') || pick('open_time')).slice(0, 40)}`);
      const rawSize = parseNumber(pick('size'));
      // 有些 fills 导出没有 side，用带符号的数量判断买卖
      const side = normalizeFillSide(pick('side')) || (rawSize < 0 ? 'sell' : 'buy');
      const price = parseNumber(pick('exit_price'));
      const qty = Math.abs(rawSize);
      if (!price || !qty) throw new Error('成交价或数量为空');
      let fee = parseNumber(pick('fee'));
      if (costPositive && fee !== 0) fee = -Math.abs(fee);
      fills.push({
        id: String(pick('external_id') || `${line}`),
        symbol,
        side,
        price,
        qty,
        fee,
        time: Date.parse(time),
        orderType: normalizeOrderType(pick('order_type')),
      });
    } catch (err) {
      errors.push({ line, message: err.message || String(err) });
    }
  });

  const trades = matchFills(fills, 'csv', { longOnly: market === 'spot' })
    .map((t) => ({ ...t, source: 'csv', market }));
  return { trades, errors };
}

/** 把「字段 → 列下标」映射转换成「字段 → 表头名」，用于保存模板 */
export function templateFromMapping(headers, mapping) {
  const out = {};
  for (const field of FIELD_DEFS) {
    const index = mapping[field.key];
    if (index !== '' && index !== undefined && headers[index]) out[field.key] = headers[index];
  }
  return out;
}

/** 把「字段 → 表头名」模板套用到当前 CSV 的表头 */
export function mappingFromTemplate(headers, template) {
  const mapping = { ...EMPTY_MAPPING };
  if (!template || typeof template !== 'object') return mapping;
  for (const field of FIELD_DEFS) {
    const name = template[field.key];
    if (!name) continue;
    const index = headers.findIndex((h) => String(h) === String(name));
    if (index >= 0) mapping[field.key] = index;
  }
  return mapping;
}

/** 金额解析：支持千分位、货币符号、百分号、括号负数、小数逗号 */
export function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  let s = String(value ?? '').trim();
  if (!s) return 0;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  s = s.replace(/[^\d.,+\-eE]/g, '');
  if (!s) return 0;
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');
  if (hasDot && hasComma) {
    s = s.replace(/,/g, '');
  } else if (hasComma && !hasDot) {
    const parts = s.split(',');
    s = parts.length === 2 && parts[1].length !== 3 ? `${parts[0]}.${parts[1]}` : s.replace(/,/g, '');
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return negative ? -n : n;
}

/**
 * 时间解析 → UTC ISO；无法解析返回 null。
 * tzOffsetHours 仅用于「字符串里没有时区」的情况。
 */
export function parseTimeValue(value, tzOffsetHours = 0) {
  const raw = String(value ?? '').trim().replace(/^["']|["']$/g, '');
  if (!raw) return null;

  if (/^\d{10}$/.test(raw)) return new Date(Number(raw) * 1000).toISOString();
  if (/^\d{13}$/.test(raw)) return new Date(Number(raw)).toISOString();
  if (/^\d{16,19}$/.test(raw)) return new Date(Math.floor(Number(raw) / 1000)).toISOString();

  // 自带时区：直接交给 Date
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    const d = new Date(raw.replace(/\s+/, 'T'));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  const s = raw.replace(/\//g, '-').replace(/\s+/g, ' ').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?)?$/);
  let year, month, day, hour = 0, minute = 0, second = 0, ms = 0;
  if (m) {
    [, year, month, day, hour = 0, minute = 0, second = 0, ms = 0] = m;
  } else {
    m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (!m) return null;
    const a = Number(m[1]);
    const b = Number(m[2]);
    year = m[3];
    // 第一段 > 12 时按 日/月/年，否则按 月/日/年
    month = a > 12 ? b : a;
    day = a > 12 ? a : b;
    hour = Number(m[4] || 0);
    minute = Number(m[5] || 0);
    second = Number(m[6] || 0);
  }

  const utc = Date.UTC(
    Number(year), Number(month) - 1, Number(day),
    Number(hour), Number(minute), Number(second), Number(String(ms).padEnd(3, '0')),
  );
  const shifted = utc - Number(tzOffsetHours || 0) * 3600_000;
  const d = new Date(shifted);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function normalizeSide(raw) {
  const s = String(raw ?? '').toLowerCase().replace(/\s+/g, '');
  if (!s) return '';
  if (s.includes('多') || s.includes('long') || s.includes('buy') || s === 'b') return 'long';
  if (s.includes('空') || s.includes('short') || s.includes('sell') || s === 's') return 'short';
  if (s.includes('买')) return 'long';
  if (s.includes('卖')) return 'short';
  return '';
}

export function normalizeOrderType(raw) {
  const s = String(raw ?? '').toLowerCase().replace(/\s+/g, '');
  if (!s) return 'other';
  if (s.includes('market') || s.includes('市价')) return 'market';
  if (s.includes('limit') || s.includes('限价')) return 'limit';
  return 'other';
}

/** 交易所合约名归一：BTC-USDT-SWAP / BTC_USDT / BTCUSDT → BTC/USDT */
export function normalizeCsvSymbol(raw) {
  let s = String(raw || '').trim().toUpperCase();
  if (!s) return '';
  s = s.replace(/-OFF\d{6,8}-\d+$/i, '').replace(/-OFF.*$/i, '').replace(/-SWAP$/i, '');

  // 已经有分隔符时只取前两段，保留币种本身可能带连字符的情况
  if (s.includes('/')) {
    const parts = s.split('/').filter(Boolean);
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : s;
  }
  if (s.includes('_')) {
    const parts = s.split('_').filter(Boolean);
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : s;
  }
  if (s.includes('-')) {
    const parts = s.split('-').filter(Boolean);
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : s;
  }
  for (const q of ['USDT', 'USDC', 'USD']) {
    if (s.endsWith(q) && s.length > q.length) return `${s.slice(0, -q.length)}/${q}`;
  }
  return s;
}

/** 识别 UTF-8 / UTF-16 BOM 并解码（交易所导出常见 UTF-16LE） */
export function decodeCsvBuffer(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
    const swapped = new Uint8Array(bytes.length - 2);
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      swapped[i - 2] = bytes[i + 1];
      swapped[i - 1] = bytes[i];
    }
    return new TextDecoder('utf-16le').decode(swapped);
  }
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  return new TextDecoder('utf-8').decode(bytes);
}

function splitTags(raw) {
  return [...new Set(String(raw || '')
    .split(/[,;，；|]/)
    .map((x) => x.trim().slice(0, 30))
    .filter(Boolean))].slice(0, 20);
}

/**
 * 把原始行构建成交易对象。
 * @returns {{ trades: object[], errors: {line:number,message:string}[] }}
 */
export function buildTrades(headers, rows, mapping, opts = {}) {
  const tzOffset = Number(opts.tzOffset || 0);
  const costPositive = opts.costPositive !== false;
  const defaultSide = opts.defaultSide === 'short' ? 'short' : 'long';
  const market = opts.market === 'spot' ? 'spot' : 'futures';
  const trades = [];
  const errors = [];

  rows.forEach((row, index) => {
    const line = index + 2 + (Number(opts.lineOffset) || 0); // 表头占第 1 行
    try {
      const pick = (key) => {
        const i = mapping[key];
        return i === '' || i === undefined || i === null ? '' : (row[i] ?? '');
      };

      const symbol = normalizeCsvSymbol(pick('symbol'));
      if (!symbol) throw new Error('币种为空');

      const closeTime = parseTimeValue(pick('close_time') || pick('open_time'), tzOffset);
      if (!closeTime) throw new Error(`平仓时间无法解析：${String(pick('close_time') || pick('open_time')).slice(0, 40)}`);
      const openTime = parseTimeValue(pick('open_time'), tzOffset) || closeTime;
      if (new Date(openTime).getTime() > new Date(closeTime).getTime()) throw new Error('开仓时间晚于平仓时间');

      const side = normalizeSide(pick('side')) || defaultSide;
      const entry = parseNumber(pick('entry_price'));
      const exit = parseNumber(pick('exit_price'));
      const size = parseNumber(pick('size'));

      let fee = parseNumber(pick('fee'));
      let funding = parseNumber(pick('funding'));
      if (costPositive) {
        fee = fee === 0 ? 0 : -Math.abs(fee);
        funding = funding === 0 ? 0 : -Math.abs(funding);
      }

      let pnl;
      if (String(pick('pnl')).trim() === '') {
        if (!entry || !exit || !size) throw new Error('缺少盈亏，且开仓价 / 平仓价 / 数量不完整');
        // 缺净盈亏时先算价差毛盈亏，再叠加手续费与资金费
        pnl = (exit - entry) * size * (side === 'short' ? -1 : 1) + fee + funding;
      } else {
        pnl = parseNumber(pick('pnl'));
      }

      const notional = parseNumber(pick('notional')) || Math.abs(entry * size);

      const rawId = String(pick('external_id')).trim();
      const trade = {
        symbol: symbol.slice(0, 40),
        side,
        order_type: normalizeOrderType(pick('order_type')),
        size,
        notional,
        entry_price: entry,
        exit_price: exit,
        open_time: openTime,
        close_time: closeTime,
        pnl,
        fee,
        funding,
        source: 'csv',
        market,
        note: String(pick('note')).trim().slice(0, 2000) || null,
        tags: splitTags(pick('tags')),
      };
      trade.external_id = rawId
        ? `csvid:${rawId}`.slice(0, 200)
        : `csv:${fingerprintTrade(trade)}`;
      trades.push(trade);
    } catch (err) {
      errors.push({ line, message: err.message || String(err) });
    }
  });

  return { trades, errors };
}
