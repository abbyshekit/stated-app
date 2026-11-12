import { isNamedAccount, useNetwork } from './near-network.mjs';
import { parseReputationTiers } from './reputation.mjs';
import { validateDstackVerifierUrl } from './dstack-verifier.mjs';

// A test stack's fake NEAR AI answers on a loopback or reserved .test host and has no GPU.
function testNearAi(url) {
  try {
    const { hostname } = new URL(url);
    return ['localhost', '127.0.0.1', '[::1]'].includes(hostname) || hostname.endsWith('.test');
  } catch { return false; }
}

// Enclave rulings decide a Result with no human step, so they run only when asked
// for in so many words (STATED_ENCLAVE_RULINGS=1) and a key is set. A ruling is
// decisive only when every listed model gives the same answer at this confidence.
function nearaiConfig(env, list) {
  const apiKey = env.NEARAI_API_KEY || '';
  const model = env.NEARAI_MODEL || 'Qwen/Qwen3.8-27B';
  const models = list(env.NEARAI_RULING_MODELS);
  const confidence = Number(env.NEARAI_RULING_MIN_CONFIDENCE ?? 0.8);
  const dstackVerifierUrl = env.STATED_DSTACK_VERIFIER_URL
    ? validateDstackVerifierUrl(env.STATED_DSTACK_VERIFIER_URL) : '';
  if (dstackVerifierUrl.startsWith('http:') && env.STATED_FETCH_ALLOW_LOOPBACK !== '1') {
    throw new Error('STATED_DSTACK_VERIFIER_URL requires https (loopback http is for tests only).');
  }
  // Production policy: a ruling needs the signing model's GPU evidence and the dstack boot check.
  // Only test stacks, whose fake NEAR AI has no GPU, run rulings without them (STATED_REQUIRE_GPU_EVIDENCE=0),
  // and the switch is refused against any other NEAR AI host.
  const rulings = Boolean(apiKey) && env.STATED_ENCLAVE_RULINGS === '1';
  const baseUrl = String(env.NEARAI_BASE_URL || 'https://cloud-api.near.ai/v1').replace(/\/$/, '');
  if (rulings && env.STATED_REQUIRE_GPU_EVIDENCE === '0' && !testNearAi(baseUrl)) {
    throw new Error('STATED_REQUIRE_GPU_EVIDENCE=0 is only for test stacks with a fake NEAR AI on a loopback or .test host; rulings against NEAR AI Cloud need GPU evidence and the dstack check.');
  }
  if (rulings && env.STATED_REQUIRE_GPU_EVIDENCE !== '0' && !dstackVerifierUrl) {
    throw new Error('STATED_ENCLAVE_RULINGS=1 needs STATED_DSTACK_VERIFIER_URL: a ruling is checked against the published dstack image.');
  }
  return {
    apiKey,
    dstackVerifierUrl,
    // A model call counts only with the signing model's own NVIDIA GPU evidence, verified by NRAS.
    // Off only for test stacks whose fake NEAR AI has no GPU (STATED_REQUIRE_GPU_EVIDENCE=0).
    requireGpu: env.STATED_REQUIRE_GPU_EVIDENCE !== '0',
    baseUrl,
    model,
    rulings,
    rulingModels: models.length ? models : [model],
    rulingMinConfidence: Number.isFinite(confidence) && confidence > 0 && confidence <= 1 ? confidence : 0.8,
  };
}

export function loadConfig(env = process.env) {
  const port = Number(env.PORT || 8080);
  // One process serves one NEAR network; loading a configuration selects it.
  const near = useNetwork(env.STATED_NEAR_NETWORK === 'mainnet' ? 'mainnet' : 'testnet');
  const mainnet = near.id === 'mainnet';
  const baseUrl = String(env.STATED_BASE_URL || `http://localhost:${port}`).replace(/\/$/, '');
  const list = (value) => String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
  // A typo must fail closed, rather than silently choose the direct-key path.
  const courtAccount = (name) => {
    const value = env[name] || '';
    if (value && (!/^(?=.{2,64}$)[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*$/.test(value)
      || (near.id === 'testnet' ? !value.endsWith('.testnet') : value.endsWith('.testnet')))) {
      throw new Error(`${name} must be an account on ${near.id}.`);
    }
    return value;
  };
  const court = { dao: courtAccount('STATED_COURT_DAO'), relay: courtAccount('STATED_COURT_RELAY') };
  if (court.relay && !court.dao) throw new Error('STATED_COURT_RELAY requires STATED_COURT_DAO.');
  return {
    port,
    baseUrl,
    databaseUrl: env.DATABASE_URL || '',
    nearai: nearaiConfig(env, list),
    demoBetId: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(env.STATED_DEMO_BET_ID || '') ? env.STATED_DEMO_BET_ID.toLowerCase() : null,
    sessionDays: Number(env.STATED_SESSION_DAYS || 30),
    tokenKey: env.STATED_TOKEN_KEY || '',
    adminXIds: list(env.STATED_ADMIN_X_IDS),
    excludeXIds: list(env.STATED_METRICS_EXCLUDE_X_IDS),
    secureCookies: baseUrl.startsWith('https://'),
    nearContract: env.STATED_NEAR_CONTRACT || '',
    // Testnet unless STATED_NEAR_NETWORK=mainnet. Mainnet moves real NEAR, so it also
    // needs STATED_MAINNET=real-funds; see assertNetworkConfig.
    near: { network: near.id, real: near.real, acknowledged: env.STATED_MAINNET === 'real-funds' },
    // Bets in the replies: accounts named after X handles, signed by this server
    // until claimed. Needs a version 2 escrow contract. The treasury creates the
    // accounts; its key comes from the environment, or on testnet only
    // (STATED_PLAY_AUTOPROVISION=1, for demos) from the faucet at first use.
    // The relay, when set, is the only jury member and enforces the correction
    // window on chain. Its operator remains the play referee account.
    court,
    play: {
      enabled: env.STATED_PLAY === '1' && Boolean(env.STATED_NEAR_CONTRACT),
      treasury: env.STATED_PLAY_TREASURY || '',
      treasuryKey: env.STATED_PLAY_TREASURY_KEY || '',
      autoProvision: env.STATED_PLAY_AUTOPROVISION === '1' && !mainnet,
      defaultStakeNear: env.STATED_PLAY_DEFAULT_STAKE || '0.1',
      reputationTiers: parseReputationTiers(env.STATED_REPUTATION_TIERS),
      // What a new account starts with. On testnet, enough for one full-size Bet. On mainnet
      // it is the operator's own NEAR, so it covers network fees only: a stake is the person's money.
      startNear: env.STATED_PLAY_START_NEAR || (mainnet ? '0.05' : '1.6'),
      // On mainnet the treasury never pays for a stake.
      fundsStakes: !mainnet,
      // Who may bet with real NEAR: X user ids, or * for anyone. Empty on mainnet means nobody.
      pilotXIds: list(env.STATED_PILOT_X_IDS),
      // Ceilings for a public bot. New accounts each cost the treasury; each reply is a paid post.
      newAccountsPerHour: Number(env.STATED_PLAY_NEW_ACCOUNTS_PER_HOUR || (mainnet ? 10 : 30)),
      repliesPerDay: Number(env.STATED_PLAY_REPLIES_PER_DAY || 150),
      // A recorded Result waits this long before the referee acts on it, so a slip can be corrected first.
      settleDelaySeconds: Number(env.STATED_PLAY_SETTLE_DELAY_SECONDS ?? 600),
      // After the deadline the two bettors have this long to offer evidence before the enclave jury rules.
      evidenceWindowSeconds: Number(env.STATED_EVIDENCE_WINDOW_SECONDS ?? 86400),
    },
    // A Bet's page can say what its stake would cost from another chain, as a dry-run quote from NEAR Intents.
    // On mainnet, STATED_INTENTS_DEPOSITS=1 also lets a person pay NEAR into their account from another
    // chain: a real quote with a deposit address. NEAR Intents has no testnet, so this is mainnet only.
    intents: { enabled: env.STATED_INTENTS_QUOTES === '1', deposits: mainnet && env.STATED_INTENTS_DEPOSITS === '1' },
    x: {
      apiBase: String(env.X_API_BASE || 'https://api.x.com').replace(/\/$/, ''),
      authorizeUrl: env.X_AUTHORIZE_URL || 'https://x.com/i/oauth2/authorize',
      clientId: env.X_CLIENT_ID || '',
      clientSecret: env.X_CLIENT_SECRET || '',
      redirectUri: env.X_REDIRECT_URI || `${baseUrl}/callback`,
      dmEnabled: env.STATED_DM_ENABLED === '1',
      repliesEnabled: env.STATED_REPLIES === '1',
      replyLinks: env.STATED_REPLY_LINKS === '1',
      // 'public-only': X post text is stored only while a public save shows it.
      // 'all': the earlier behaviour, text stored for every save.
      textPolicy: env.STATED_X_TEXT_POLICY === 'all' ? 'all' : 'public-only',
      oembedBase: String(env.X_OEMBED_BASE || 'https://publish.x.com').replace(/\/$/, ''),
      botUserId: env.X_BOT_USER_ID || '',
      repliesPerTaggerPerHour: Number(env.STATED_REPLIES_PER_TAGGER_PER_HOUR || 10),
      privateCheckDays: Number(env.STATED_PRIVATE_CHECK_DAYS ?? 7),
      complianceBearer: env.X_COMPLIANCE_BEARER || '',
      mentionsStart: env.STATED_MENTIONS_START === 'all' ? 'all' : 'now',
    },
    // A hosted deployment (Railway sets RAILWAY_ENVIRONMENT; anywhere else set
    // STATED_HOSTED=1) refuses to start on a configuration that would break
    // sign-in or cookies. See assertHostedConfig.
    hosted: env.STATED_HOSTED === '1' || Boolean(env.RAILWAY_ENVIRONMENT),
    worker: {
      // Mention polling and the X source checks spend money, so the worker
      // runs only when asked to. The NEAR refresher is separate and free.
      enabled: env.STATED_WORKER === '1',
      pollMs: Number(env.STATED_POLL_MS || 60000),
    },
    fetch: {
      allowLoopback: env.STATED_FETCH_ALLOW_LOOPBACK === '1',
      timeoutMs: Number(env.STATED_FETCH_TIMEOUT_MS || 8000),
      maxBytes: Number(env.STATED_FETCH_MAX_BYTES || 2_000_000),
    },
  };
}

// What a public deployment cannot run without. Each failure names the setting
// to fix; the process exits before it listens, so a bad deploy never serves.
export function assertHostedConfig(config) {
  if (!config.hosted) return;
  const problems = [];
  let origin = null;
  try { origin = new URL(config.baseUrl); } catch { /* reported below */ }
  const local = (host) => ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(host) || host.endsWith('.localhost');
  if (!origin || origin.protocol !== 'https:' || local(origin.hostname)) {
    problems.push('STATED_BASE_URL must be the public https origin (links, cookies and form checks are built from it)');
  }
  let callback = null;
  try { callback = new URL(config.x.redirectUri); } catch { /* reported below */ }
  if (!callback || !origin || callback.origin !== origin.origin || callback.pathname !== '/callback') {
    problems.push('X_REDIRECT_URI must be STATED_BASE_URL/callback, exactly as registered on the X app');
  }
  if (Buffer.byteLength(config.tokenKey) < 32) {
    problems.push('STATED_TOKEN_KEY must be at least 32 bytes (openssl rand -base64 32) and must not change between deploys');
  }
  if (/@(localhost|127\.0\.0\.1)[:/]/.test(config.databaseUrl)) {
    problems.push('DATABASE_URL points at this machine; use the hosted database');
  }
  if (problems.length) throw new Error(`Hosted configuration refused:\n- ${problems.join('\n- ')}`);
}

// Mainnet moves real NEAR. The process refuses to start on a mainnet
// configuration that was not asked for in so many words, or that would leave
// people's keys under a weak seal or their accounts without an owner.
export function assertNetworkConfig(config) {
  if (!config.near?.real) return;
  const problems = [];
  if (!config.near.acknowledged) problems.push('STATED_MAINNET must be set to real-funds: on mainnet every stake is real NEAR');
  if (config.nearContract && !isNamedAccount(config.nearContract)) problems.push('STATED_NEAR_CONTRACT must be a .near account on mainnet');
  if (config.play?.enabled) {
    if (Buffer.byteLength(config.tokenKey) < 32) problems.push('STATED_TOKEN_KEY must be at least 32 bytes: it seals the keys of accounts that hold real NEAR');
    if (!config.play.treasury || !config.play.treasuryKey) problems.push('STATED_PLAY_TREASURY and STATED_PLAY_TREASURY_KEY must name a funded .near account: there is no faucet on mainnet');
    else if (!isNamedAccount(config.play.treasury)) problems.push('STATED_PLAY_TREASURY must be a .near account on mainnet');
  }
  if (problems.length) throw new Error(`Mainnet configuration refused:\n- ${problems.join('\n- ')}`);
}

export function requireConfig(config, keys) {
  const missing = keys.filter((key) => {
    const value = key.split('.').reduce((obj, part) => obj?.[part], config);
    return value === '' || value == null;
  });
  if (missing.length) {
    throw new Error(`Missing configuration: ${missing.join(', ')}`);
  }
}
