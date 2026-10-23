/**
 * 加密与签名工具。
 *
 * - 交易所凭据用 AES-256-GCM 加密后落库；
 * - 主密钥优先取 TRADELEDGER_MASTER_KEY（64 位十六进制，或任意口令经 SHA-256 派生）；
 * - 未配置时在数据库同目录生成 data/master.key（仅本机可读）。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

let cachedKey = null;

export function getMasterKey() {
  if (cachedKey) return cachedKey;

  const fromEnv = process.env.TRADELEDGER_MASTER_KEY;
  if (fromEnv) {
    cachedKey = /^[0-9a-f]{64}$/i.test(fromEnv)
      ? Buffer.from(fromEnv, 'hex')
      : crypto.createHash('sha256').update(fromEnv).digest();
    return cachedKey;
  }

  if (config.dbFile === ':memory:') {
    cachedKey = crypto.randomBytes(32);
    return cachedKey;
  }

  const keyFile = path.join(path.dirname(config.dbFile), 'master.key');
  try {
    const hex = fs.readFileSync(keyFile, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) {
      cachedKey = Buffer.from(hex, 'hex');
      return cachedKey;
    }
  } catch { /* 首次运行，下面生成 */ }

  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 });
  cachedKey = key;
  return key;
}

export function resetMasterKeyCache() {
  cachedKey = null;
}

export function encryptSecret(plain) {
  if (plain === undefined || plain === null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getMasterKey(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${data.toString('base64url')}`;
}

export function decryptSecret(payload) {
  if (!payload) return '';
  const [version, ivB64, tagB64, dataB64] = String(payload).split(':');
  if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) throw new Error('凭据格式损坏，请重新填写 API Key');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getMasterKey(), Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
}

export function hintKey(key) {
  const s = String(key || '');
  return s.length <= 4 ? '****' : s.slice(-4);
}

/* ---------------- 签名 ---------------- */

export const hmacHex = (secret, text) => crypto.createHmac('sha256', secret).update(text).digest('hex');
export const hmacBase64 = (secret, text) => crypto.createHmac('sha256', secret).update(text).digest('base64');
export const hmacHex512 = (secret, text) => crypto.createHmac('sha512', secret).update(text).digest('hex');
export const sha512Hex = (text) => crypto.createHash('sha512').update(text).digest('hex');
export const sha256Hex = (text) => crypto.createHash('sha256').update(text).digest('hex');
