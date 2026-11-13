import test from 'node:test';
import assert from 'node:assert/strict';
import { assertMainnetStakeCap } from '../src/reputation.mjs';
import { parseBetCommand } from '../src/reply-bets.mjs';
import { submitEvidence, evidencePrompts, parseEvidenceCommand } from '../src/bet-evidence.mjs';
import { loadConfig } from '../src/config.mjs';

test('mainnet stake policy rejects dust before any database or chain work', () => {
  const config = { near: { real: true }, play: { maxStakeNear: '1', reputationTiers: null } };
  for (const value of ['0.000000000000000000000001', '0.01', '0.099999999999999999999999']) {
    assert.throws(() => assertMainnetStakeCap(config, value), { reason: 'minimum' });
  }
  for (const value of ['0.1', '0.100000000000000000000001', '1']) assertMainnetStakeCap(config, value);
  assertMainnetStakeCap({ ...config, near: { real: false } }, '0.01');
});

test('X mainnet stake parser refuses dust and accepts the exact minimum', () => {
  for (const value of ['0.01', '0.099999999999999999999999']) {
    assert.deepEqual(parseBetCommand(`bet ${value} yes`, { mainnet: true }), { kind: 'bet', side: 'yes', error: 'stake' });
  }
  assert.deepEqual(parseBetCommand('bet 0.1 no', { mainnet: true }), { kind: 'bet', side: 'no', stake: '0.1' });
});

test('disabled evidence returns 404 before touching a database or page', async () => {
  await assert.rejects(submitEvidence({}, { nearai: { rulings: false }, outlayer: { referee: '' } },
    { betId: 'unused', userId: '1', side: 'yes', url: 'https://example.org/result', via: 'page',
      fetchPage: () => assert.fail('must not fetch') }), { status: 404 });
});

test('unparseable evidence replies remain silent instead of entering the command queue', () => {
  for (const text of ['@statedbot yes here it is https://example.org/a', '@statedbot yes',
    '@statedbot no https://example.org/a https://example.org/b']) {
    assert.equal(parseEvidenceCommand(text, { outlayer: true }), null);
    assert.equal(parseBetCommand(text, { outlayer: true, rulings: true }), null);
  }
});

test('OutLayer X bets receive a deduplicated post-deadline Open evidence prompt without local rulings', async () => {
  const seen = [];
  const bet = { id: 'bet', event_id: 'original-command', resolve_at: new Date('2026-11-12T18:00:00Z'),
    outlayer_material: { evidence: { kind: 'open', window_seconds: 60 } } };
  const db = { tx: async fn => fn(db), many: async sql => {
    assert.match(sql, /outlayer_material/);
    assert.match(sql, /resolve_at\s*<=\s*clock_timestamp\(\)/);
    assert.match(sql, /not exists[\s\S]*bot_outbox/);
    return seen.length ? [] : [bet];
  } };
  const config = { baseUrl: 'https://stated.example', nearai: { rulings: false }, outlayer: { referee: 'jury.near' } };
  const say = async (row, tx) => { assert.equal(tx, db); seen.push(row); };
  assert.deepEqual(await evidencePrompts(db, config, { say }), { prompted: 1 });
  assert.equal(seen[0].key, 'evidence-prompt:bet');
  assert.equal(seen[0].inReplyTo, 'original-command');
  assert.match(seen[0].body, /https:\/\/stated.example\/bets\/bet/);
  assert.deepEqual(await evidencePrompts(db, config, { say }), { prompted: 0 });
});

test('registration daily sponsor limit defaults to five and rejects malformed configuration', () => {
  assert.equal(loadConfig({}).outlayer.registrationDailyLimit, 5);
  assert.equal(loadConfig({ STATED_OUTLAYER_REGISTRATION_DAILY_LIMIT: '0' }).outlayer.registrationDailyLimit, 0);
  for (const value of ['-1', '1.5', 'NaN', '9007199254740992']) {
    assert.throws(() => loadConfig({ STATED_OUTLAYER_REGISTRATION_DAILY_LIMIT: value }), /REGISTRATION_DAILY_LIMIT/);
  }
});
