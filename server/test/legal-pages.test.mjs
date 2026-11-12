import test from 'node:test';
import assert from 'node:assert/strict';
import { privacyPage, termsPage, LEGAL_EFFECTIVE } from '../src/legal-pages.mjs';

const text = (page) => String(page).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('the Terms describe a test-NEAR service with its jury, Court and limits', () => {
  const page = String(termsPage({ bot: 'statedforecast' }));
  const words = text(page);
  assert.match(page, /<h1>Terms of Service<\/h1>/);
  assert.match(words, new RegExp(`Effective ${LEGAL_EFFECTIVE}`));
  assert.match(words, /every stake is test NEAR\. Test NEAR has no monetary value/);
  assert.match(words, /all three agree, each with at least 80% confidence/);
  assert.match(words, /after three undecided juries both stakes go back/);
  assert.match(words, /Its council can vote the ruling down within ten minutes/);
  assert.match(words, /seven days after the bet’s result time/);
  assert.match(words, /limited to CAD 100/);
  assert.match(words, /takes no share of any pot\. The escrow contract keeps a small storage fee/);
  assert.doesNotMatch(words, /charges nothing/);
  assert.match(words, /do not apply to fraud, gross negligence or wilful misconduct/);
  assert.match(page, /href="https:\/\/github\.com\/abbyshekit\/stated-app\/issues"/);
  assert.match(page, /href="\/privacy"/);
  assert.doesNotMatch(words, /play money|live on mainnet|audit|independent/i);
});

test('the Privacy Policy names what is public, each cookie, each recipient and the choices', () => {
  const page = String(privacyPage({ bot: 'statedforecast', sessionDays: 30, textPolicy: 'public' }));
  const words = text(page);
  assert.match(page, /<h1>Privacy Policy<\/h1>/);
  assert.match(words, /a random visitor cookie that counts a visit to a public page once a day/);
  assert.match(words, /keeps you signed in \(30 days\)/);
  assert.match(words, /It is not given the bettors’ names or accounts/);
  assert.match(words, /load it from X’s image server/);
  assert.match(words, /stored encrypted with AES-256-GCM/);
  assert.match(words, /not written to the database/);
  assert.match(words, /Stated keeps the link and the terms, not the words/);
  assert.match(words, /your profile page lists, under your X handle, the published bets you took part in/);
  assert.match(page, /href="\/me\/export\.json"/);
  assert.match(page, /href="\/terms"/);
  assert.doesNotMatch(words, /operator named in the bot|play money|audit/i);
  const all = text(privacyPage({ bot: 'statedforecast', sessionDays: 7, textPolicy: 'all' }));
  assert.match(all, /store the words of every saved post too/);
  assert.match(all, /keeps you signed in \(7 days\)/);
});

test('both pages escape the bot handle', () => {
  assert.doesNotMatch(String(termsPage({ bot: '<x>' })), /<x>/);
  assert.doesNotMatch(String(privacyPage({ bot: '<x>', sessionDays: 30 })), /<x>/);
});
