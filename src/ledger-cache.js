/**
 * 交易所月度账本缓存：对账页每次打开都会为每个账户拉一次 fetchMonthlyLedger，
 * 串行网络请求会拖到十几秒。这里做 10 分钟 TTL 缓存 + 支持强制刷新。
 */

export function createLedgerCache({ ttlMs = 10 * 60_000, now = () => Date.now() } = {}) {
  const entries = new Map();

  function keyOf(account) {
    return `${account.exchange}:${account.id}`;
  }

  async function get(account, adapter, creds, { force = false } = {}) {
    const key = keyOf(account);
    const hit = entries.get(key);
    if (!force && hit && now() - hit.at < ttlMs) return hit.value;
    const value = await adapter.fetchMonthlyLedger({ creds, months: 6, force });
    entries.set(key, { at: now(), value });
    return value;
  }

  function invalidate(accountId) {
    for (const key of entries.keys()) {
      if (key.endsWith(`:${accountId}`)) entries.delete(key);
    }
  }

  function clear() {
    entries.clear();
  }

  return { get, invalidate, clear, size: () => entries.size };
}

/** 进程级单例；设置页改账户/凭据后由路由调用 invalidate。 */
export const monthlyLedgerCache = createLedgerCache();
