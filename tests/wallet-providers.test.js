import test from 'node:test';
import assert from 'node:assert/strict';
import { mapDebank } from '../src/wallets/debank.js';
import { mapZerion, splitUnverifiedWalletPositions } from '../src/wallets/zerion.js';
import { canonicalChain, looksLikeEvm, looksLikeSolana } from '../src/wallets/common.js';
import { debank } from '../src/wallets/debank.js';
import { zerion } from '../src/wallets/zerion.js';

const EVM = '0x1111111111111111111111111111111111111111';
const SOL = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

test('DeBank：钱包代币 + Aave 存款/借款 + LP + 质押 + 奖励', () => {
  const tokens = [
    { id: 'eth', chain: 'eth', symbol: 'ETH', name: 'Ethereum', amount: 0.5, price: 3000 },
    { id: 'usdc', chain: 'arb', symbol: 'USDC', name: 'USD Coin', amount: 100, price: 1 },
    { id: 'dust', chain: 'eth', symbol: 'DUST', amount: 0.000001, price: 0 },
  ];
  const protocols = [
    {
      id: 'aave3', name: 'Aave V3', chain: 'eth',
      portfolio_item_list: [{
        name: 'Lending', detail_types: ['lending'],
        detail: {
          supply_token_list: [{ id: 'usdc', symbol: 'USDC', amount: 1000, price: 1 }],
          borrow_token_list: [{ id: 'usdt', symbol: 'USDT', amount: 200, price: 1 }],
          reward_token_list: [{ id: 'arb', symbol: 'ARB', amount: 5, price: 1.2 }],
        },
        stats: { asset_usd_value: 1000, debt_usd_value: 200 },
      }],
    },
    {
      id: 'uniswap3', name: 'Uniswap V3', chain: 'arb',
      portfolio_item_list: [{
        name: 'Liquidity Pool', detail_types: ['liquiditypool'],
        detail: {
          supply_token_list: [{ id: 'weth', symbol: 'WETH', amount: 0.2, price: 3000 }],
        },
        stats: { asset_usd_value: 600, debt_usd_value: 0 },
      }],
    },
    {
      id: 'lido', name: 'Lido', chain: 'eth',
      portfolio_item_list: [{
        name: 'Staking', detail_types: ['staked'],
        detail: { supply_token_list: [{ id: 'steth', symbol: 'STETH', amount: 1, price: 3000 }] },
        stats: { asset_usd_value: 3000, debt_usd_value: 0 },
      }],
    },
  ];

  const positions = mapDebank({ tokens, protocols, chains: [] });
  const find = (bucket, asset) => positions.find((p) => p.bucket === bucket && p.asset === asset);
  assert.ok(find('wallet', 'ETH'));
  assert.ok(find('wallet', 'USDC'));
  // 没有价格的代币保留数量、标记未估值，而不是直接丢掉
  assert.equal(find('wallet', 'DUST').value_usd, null);

  const supply = find('defi_supply', 'USDC');
  assert.equal(supply.value_usd, 1000);
  const debt = find('defi_debt', 'USDT');
  assert.equal(debt.amount, -200);
  assert.equal(debt.value_usd, -200);
  assert.equal(debt.protocol, 'Aave V3');
  const reward = find('defi_reward', 'ARB');
  assert.equal(reward.value_usd, 6);
  assert.ok(find('defi_lp', 'WETH'));
  assert.ok(find('defi_staking', 'STETH'));
});

test('DeBank：链过滤生效，非法/空明细用 stats 兜底', () => {
  const positions = mapDebank({
    tokens: [{ id: 'a', chain: 'eth', symbol: 'ETH', amount: 1, price: 3000 }],
    protocols: [{
      id: 'x', name: 'Some Protocol', chain: 'arb',
      portfolio_item_list: [{
        name: 'Vault', detail_types: ['yield'],
        detail: {},
        stats: { asset_usd_value: 500, debt_usd_value: 0 },
      }],
    }],
    chains: ['arbitrum'],
  });
  assert.equal(positions.length, 1);
  assert.equal(positions[0].bucket, 'defi_supply');
  assert.equal(positions[0].asset, 'SOME PROTOCOL');
  assert.equal(positions[0].value_usd, 500);
  assert.equal(positions[0].chain, 'arbitrum');
});

test('Zerion：钱包 / 存款 / 借款 / 质押 / 奖励映射与符号', () => {
  const rows = [
    { id: 'p1', attributes: { symbol: 'ETH', name: 'Ethereum', quantity: { float: 1 }, price: 3000, value: 3000, chain: { id: 'ethereum' }, position_type: 'wallet' } },
    { id: 'p2', attributes: { symbol: 'USDC', name: 'Aave deposit', quantity: { float: 1000 }, price: 1, value: 1000, chain: { id: 'arbitrum' }, position_type: 'deposit', protocol: 'Aave' } },
    { id: 'p3', attributes: { symbol: 'USDT', name: 'Aave borrow', quantity: { float: 200 }, price: 1, value: 200, chain: { id: 'arbitrum' }, position_type: 'loan', protocol: 'Aave' } },
    { id: 'p4', attributes: { symbol: 'STETH', name: 'Lido staked', quantity: { float: 1 }, price: 3000, value: 3000, chain: { id: 'ethereum' }, position_type: 'staked', protocol: 'Lido' } },
    { id: 'p5', attributes: { symbol: 'ARB', name: 'Reward', quantity: { float: 5 }, price: 1.2, value: 6, chain: { id: 'arbitrum' }, position_type: 'reward', protocol: 'Aave' } },
    { id: 'p6', attributes: { symbol: 'SOL', name: 'Solana', quantity: { float: 2 }, price: 150, value: 300, chain: 'solana', position_type: 'wallet' } },
  ];
  const positions = mapZerion(rows, []);
  assert.equal(positions.find((p) => p.asset === 'ETH').bucket, 'wallet');
  assert.equal(positions.find((p) => p.asset === 'USDC').bucket, 'defi_supply');
  assert.equal(positions.find((p) => p.asset === 'USDT').value_usd, -200);
  assert.equal(positions.find((p) => p.asset === 'STETH').bucket, 'defi_staking');
  assert.equal(positions.find((p) => p.asset === 'ARB').bucket, 'defi_reward');
  assert.equal(positions.find((p) => p.asset === 'SOL').chain, 'solana');

  const onlyEvm = mapZerion(rows, ['ethereum']);
  assert.ok(onlyEvm.every((p) => p.chain === 'ethereum'));
});

test('Zerion：relationships 里的链、fungible_info 里的币种、LP 识别', () => {
  const rows = [
    {
      id: 'base-robinhood-asset-asset',
      attributes: {
        position_type: 'wallet', name: 'Asset', quantity: { float: 0.002 }, value: 4.7, price: 2243,
        fungible_info: { symbol: 'ETH', name: 'Ethereum' },
      },
      relationships: { chain: { data: { id: 'robinhood' } } },
    },
    {
      id: '0x000-binance-smart-chain-aster/wbnb-pool-deposit',
      attributes: {
        position_type: 'deposit', name: 'ASTER/WBNB Pool 0.25% #7730058',
        quantity: { float: 8.5 }, value: 5.9, price: 0.69,
        fungible_info: { symbol: 'ASTER', name: 'Aster' },
        application_metadata: { name: 'PancakeSwap V3' },
      },
      relationships: {
        chain: { data: { id: 'binance-smart-chain' } },
        dapp: { data: { id: 'pancake-swap-v3' } },
      },
    },
    {
      id: '0x000-arbitrum-lending-deposit',
      attributes: {
        position_type: 'deposit', name: 'Lending', quantity: { float: 100 }, value: 100, price: 1,
        fungible_info: { symbol: 'USDC', name: 'USD Coin' },
      },
      relationships: {
        chain: { data: { id: 'arbitrum' } },
        dapp: { data: { id: 'aave-v3' } },
      },
    },
  ];
  const positions = mapZerion(rows, []);
  const eth = positions.find((p) => p.asset === 'ETH');
  assert.equal(eth.chain, 'robinhood');
  assert.equal(eth.bucket, 'wallet');
  const lp = positions.find((p) => p.asset === 'ASTER');
  assert.equal(lp.bucket, 'defi_lp');
  assert.equal(lp.chain, 'bsc');
  assert.equal(lp.protocol, 'PancakeSwap V3');
  const supply = positions.find((p) => p.asset === 'USDC');
  assert.equal(supply.bucket, 'defi_supply');
  assert.equal(supply.protocol, 'aave-v3');
});

test('Zerion：未验证的钱包同名假币不会进入资产统计，真实小额保留', () => {
  const rows = [
    {
      id: '0x5fc536-robinhood-asset-asset',
      attributes: {
        position_type: 'wallet', name: 'Asset', quantity: { float: 0.000029 }, value: 0.000029, price: 1,
        fungible_info: { symbol: 'USDG', name: 'Global Dollar', flags: { verified: true } },
      },
      relationships: { chain: { data: { id: 'robinhood' } } },
    },
    {
      id: '0xd4efe1-robinhood-asset-asset',
      attributes: {
        position_type: 'wallet', name: 'Asset', quantity: { float: 100 }, value: null, price: 0,
        fungible_info: { symbol: 'USDG', name: 'U.S Digital Global Dollar', flags: { verified: false } },
      },
      relationships: { chain: { data: { id: 'robinhood' } } },
    },
  ];
  const mapped = mapZerion(rows, []);
  assert.equal(mapped.length, 2);
  const real = mapped.find((p) => p.source_ref.startsWith('0x5fc536'));
  const fake = mapped.find((p) => p.source_ref.startsWith('0xd4efe1'));
  assert.equal(real.amount, 0.000029);
  assert.equal(real.value_usd, 0.000029);
  assert.equal(real.unverified, false);
  assert.equal(fake.unverified, true);
  assert.equal(fake.value_usd, null);

  const { kept, skipped } = splitUnverifiedWalletPositions(mapped);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].amount, 0.000029);
  assert.equal(skipped.length, 1);
});

test('链名归一化与地址识别', () => {
  assert.equal(canonicalChain('eth'), 'ethereum');
  assert.equal(canonicalChain('42161'), 'arbitrum');
  assert.equal(canonicalChain('binance-smart-chain'), 'bsc');
  assert.equal(canonicalChain('SOLANA'), 'solana');
  assert.ok(looksLikeEvm(EVM));
  assert.ok(!looksLikeEvm(SOL));
  assert.ok(looksLikeSolana(SOL));
  assert.ok(debank.supportsAddress(EVM));
  assert.ok(!debank.supportsAddress(SOL));
  assert.ok(zerion.supportsAddress(EVM));
  assert.ok(zerion.supportsAddress(SOL));
});
