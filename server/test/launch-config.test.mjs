import test from 'node:test';
import assert from 'node:assert/strict';
import { botOwnershipLine, loadConfig } from '../src/config.mjs';
import { fundingNeed, fundingPanel, fundingStatus } from '../src/funding-view.mjs';
import { yocto } from '../src/play.mjs';
import { betCommandText } from '../src/bet-start.mjs';
import { parseBetCommand } from '../src/reply-bets.mjs';

test('mainnet defaults to 1 NEAR per bet, 25 sponsors and fee-only starting funds', () => {
  const config = loadConfig({ STATED_NEAR_NETWORK: 'mainnet' });
  assert.equal(config.play.maxStakeNear, '1');
  assert.equal(config.play.sponsorLimit, 25);
  assert.equal(config.play.startNear, '0.05');
  assert.equal(config.play.fundsStakes, false);
});

test('mainnet rejects invalid caps, sponsor counts and starting amounts at configuration boundary', () => {
  for (const value of ['0', '-1', '2', 'NaN', 'Infinity', '1e-1', '0.0000000000000000000000001']) {
    assert.throws(() => loadConfig({ STATED_NEAR_NETWORK: 'mainnet', STATED_MAX_STAKE_NEAR: value }), /STATED_MAX_STAKE_NEAR/);
  }
  for (const value of ['-1', 'NaN', '1.2', '9007199254740992', '']) {
    assert.throws(() => loadConfig({ STATED_NEAR_NETWORK: 'mainnet', STATED_SPONSOR_LIMIT: value }), /STATED_SPONSOR_LIMIT/);
  }
  for (const value of ['-1', '0', 'Infinity', '1e8']) {
    assert.throws(() => loadConfig({ STATED_NEAR_NETWORK: 'mainnet', STATED_PLAY_START_NEAR: value }), /STATED_PLAY_START_NEAR/);
  }
  const custom = loadConfig({ STATED_NEAR_NETWORK: 'mainnet', STATED_MAX_STAKE_NEAR: '0.125', STATED_SPONSOR_LIMIT: '0', STATED_PLAY_START_NEAR: '0.8' });
  assert.equal(custom.play.maxStakeNear, '0.125');
  assert.equal(custom.play.sponsorLimit, 0);
  assert.equal(custom.play.startNear, '0.8');
});

test('testnet starting funds and faucet defaults stay unchanged', () => {
  const config = loadConfig({ STATED_PLAY_AUTOPROVISION: '1', STATED_MAX_STAKE_NEAR: 'invalid', STATED_SPONSOR_LIMIT: 'invalid' });
  assert.equal(config.near.network, 'testnet');
  assert.equal(config.play.startNear, '1.6');
  assert.equal(config.play.fundsStakes, true);
  assert.equal(config.play.autoProvision, true);
});

test('startup names the bot network and all three switches for both launch services', () => {
  for (const [network, enabled] of [['mainnet', '1'], ['testnet', '0']]) {
    const config = loadConfig({ STATED_NEAR_NETWORK: network, STATED_NEAR_CONTRACT: network === 'mainnet' ? 'escrow.statedforecast.near' : 'escrow.testnet',
      STATED_WORKER: enabled, STATED_PLAY: enabled, STATED_REPLIES: enabled });
    assert.match(botOwnershipLine(config), new RegExp(`X bot ownership: ${network} ${enabled === '1' ? 'owns mention polling' : 'does not poll mentions'}`));
    assert.ok(botOwnershipLine(config).includes(`STATED_WORKER=${enabled}, STATED_PLAY=${enabled}, STATED_REPLIES=${enabled}`));
  }
});

test('funding amounts are bounded integers and preserve exact yocto values', () => {
  for (const value of ['-1', '1.2', '1e24', '00', '9'.repeat(100), yocto('1.010000000000000000000001')]) assert.equal(fundingNeed(value), '0');
  assert.equal(fundingNeed(yocto('1.01')), yocto('1.01'));
  assert.equal(fundingNeed('1'), '1');
});

test('a generated mainnet X command round trips supported precision above the minimum', () => {
  for (const stake of ['0.1250001', '0.100000000000000000000001']) {
    const parsed = parseBetCommand(betCommandText('statedforecast', stake, 'yes'), { mainnet: true });
    assert.equal(parsed.stake, stake);
    assert.equal(parsed.error, undefined);
    assert.equal(parseBetCommand(betCommandText('statedforecast', stake, 'yes'), { mainnet: false }).error, 'stake', 'testnet precision remains unchanged');
  }
  for (const stake of ['0.000000000000000000000001', '0.099999999999999999999999']) {
    assert.equal(parseBetCommand(betCommandText('statedforecast', stake, 'yes'), { mainnet: true }).error, 'stake',
      'a generated command cannot bypass the 0.1 NEAR mainnet minimum');
  }
});

test('funding view carries the actual account, exact balance, stake and gas shortfall', async () => {
  const config = loadConfig({ STATED_NEAR_NETWORK: 'mainnet' });
  const account = { account_id: 'alice.play.statedforecast.near', granted_yocto: yocto('0.05') };
  const chain = { balance: async () => yocto('0.05'), callFunds: async () => ({ balance: BigInt(yocto('0.05')), reserve: BigInt(yocto('0.1')) }) };
  const status = await fundingStatus(config, chain, account, yocto('0.2'));
  assert.equal(status.balanceNear, '0.05');
  assert.equal(status.neededNear, '0.2');
  assert.equal(status.missingNear, '0.25');
  const page = String(fundingPanel(status));
  assert.match(page, /id="funding-account">alice\.play\.statedforecast\.near/);
  assert.match(page, /data-copy="funding-account"/);
  assert.match(page, /Needed for this bet: <b>0\.2 NEAR<\/b>, plus network fees/);
  assert.match(page, /Send NEAR to this account from any exchange or wallet; it shows up here within a minute/);
  assert.match(page, /data-refresh-balance/);
});
