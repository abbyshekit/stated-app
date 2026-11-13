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

test('the testnet Terms are unchanged and carry no real-NEAR section', () => {
  const plain = String(termsPage({ bot: 'statedforecast' }));
  assert.equal(String(termsPage({ bot: 'statedforecast', real: false })), plain);
  assert.doesNotMatch(text(plain), /Real NEAR|you can lose your stake|pilot is limited/);
  assert.match(plain, /<h2>Test NEAR only<\/h2>/);
});

test('on mainnet the Terms state the real-NEAR pilot instead of the test-NEAR section', () => {
  const page = String(termsPage({ bot: 'statedforecast', real: true }));
  const words = text(page);
  assert.match(page, /<h2>Real NEAR<\/h2>/);
  assert.match(words, /bets use real NEAR, which has monetary value/);
  assert.match(words, /The pilot is limited to people we allow/);
  assert.match(words, /Every stake is your own NEAR/);
  assert.match(words, /An escrow contract with no access keys holds both stakes, and a referee contract decides who wins/);
  assert.match(words, /refunds both stakes seven days after the bet’s deadline/);
  assert.match(words, /Stated takes no share of a pot\. The escrow contract keeps a small storage fee, in NEAR/);
  assert.doesNotMatch(page, /<h2>Test NEAR only<\/h2>/);
  assert.doesNotMatch(words, /every stake is test NEAR/);
  assert.match(words, /limited to CAD 100/, 'the rest of the Terms still applies');
});

test('open mainnet Terms disclose the configured stake limit and limited sponsored balances', () => {
  const words = text(termsPage({ bot: 'statedforecast', real: true, pilotXIds: ['*'], startNear: '1', sponsorLimit: 25, maxStakeNear: '0.5' }));
  assert.match(words, /Anyone with an X account can bet at their own risk, up to 0\.5 NEAR per bet/);
  assert.doesNotMatch(words, /pilot is limited|invite-only|Every stake is your own NEAR|every stake is your own NEAR|we do not lend or give you stakes|only enough NEAR/);
  assert.match(words, /Stated puts 1 NEAR into each new sponsored account, up to a lifetime limit of 25 recipients and one grant per X account/);
  assert.match(words, /That NEAR is yours to bet or withdraw/);
  assert.match(words, /Other new accounts receive 0\.05 NEAR for network fees/);
  assert.match(words, /The referee settles the escrow automatically through OutLayer/);
  assert.doesNotMatch(words, /A ruling then goes to Stated Court|each running in its own NEAR AI Cloud enclave/);
});

test('listed mainnet Terms keep access restrictions while disabled sponsorship promises no stake grant', () => {
  const words = text(termsPage({ bot: 'statedforecast', real: true, pilotXIds: ['123'], startNear: '1', sponsorLimit: 0, maxStakeNear: '1' }));
  assert.match(words, /The pilot is limited to people we allow/);
  assert.match(words, /Every stake is your own NEAR/);
  assert.doesNotMatch(words, /Anyone with an X account|yours to bet or withdraw|first 0 sponsored/);
});

test('the Privacy Policy names what is public, each cookie, each recipient and the choices', () => {
  const page = String(privacyPage({ bot: 'statedforecast', sessionDays: 30, textPolicy: 'public' }));
  const words = text(page);
  assert.match(page, /<h1>Privacy Policy<\/h1>/);
  assert.match(words, /a random visitor cookie that counts a visit to a public page once a day/);
  assert.match(words, /keeps you signed in \(30 days\)/);
  assert.match(words, /It is not given the bettors’ names or accounts/);
  assert.match(words, /Pages show a letter or a stored image; your browser does not load profile pictures from X/);
  assert.match(words, /Saves start private unless, with a public profile, you choose public for a save or set public as your default in settings/);
  assert.match(words, /Your profile starts private/);
  assert.match(words, /Remove a save from its page unless a bet relies on it; those saves stay to protect the stakes/);
  assert.match(words, /Before publication or after its creator takes it off public pages, its bettors can see its page, and signed-in people with its link can also see it while it is an open invitation/);
  assert.doesNotMatch(words, /Every save starts private|only to its two bettors|load it from X’s image server|Remove any save from its page/);
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

test('on mainnet the Terms and Privacy Policy never call stakes test NEAR', () => {
  const words = (page) => String(page).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const terms = words(termsPage({ bot: 'statedforecast', real: true }));
  assert.doesNotMatch(terms, /test NEAR|test service/);
  assert.match(terms, /Stated is a pilot service/);
  assert.match(terms, /every stake is your own NEAR/);
  const testnet = words(termsPage({ bot: 'statedforecast' }));
  assert.match(testnet, /Stated is a test service/);
  assert.match(testnet, /sell test NEAR from Stated/);
  const privacy = words(privacyPage({ bot: 'statedforecast', sessionDays: 30, real: true }));
  assert.match(privacy, /NEAR records every account, deposit, ruling and payout publicly/);
  assert.doesNotMatch(privacy, /NEAR testnet records/);
  assert.match(words(privacyPage({ bot: 'statedforecast', sessionDays: 30 })), /NEAR testnet records every account/);
});
