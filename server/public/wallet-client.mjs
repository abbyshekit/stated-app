// INTEGRATION: Bundle with @meteorwallet/sdk 3.24.1 and @near-js/transactions 2.2.5; serve on the wallet review page.
import { MeteorWallet, setEnvConfig } from '@meteorwallet/sdk';
import { InMemoryKeyStore } from '@near-js/keystores';
import { walletTransaction } from './wallet-transaction.mjs';

setEnvConfig({ wallet_base_url: 'https://wallet.meteorwallet.app' });
// The page says which NEAR network its request is for (data-near-network on the form). One wallet
// connection is made per network, on first use; anything but mainnet is testnet.
const wallets = new Map();
function walletFor(networkId) {
  if (!wallets.has(networkId)) {
    wallets.set(networkId, new MeteorWallet({ networkId, keyStore: new InMemoryKeyStore(),
      nodeUrl: new URL('/near/block', window.location.origin).href,
      forceTargetPlatformConfig: { executionTarget: 'v1_web' } }));
  }
  return wallets.get(networkId);
}

const methods = new Set(['create_bet', 'accept_bet', 'cancel_bet', 'expire_bet', 'propose_outcome', 'confirm_outcome', 'dispute_outcome', 'finalize_unanswered', 'referee_resolve', 'refund_unresolved', 'withdraw']);
const namedAccount = { testnet: /^(?:[a-z0-9]+(?:[-_][a-z0-9]+)*\.)+testnet$/, mainnet: /^(?:[a-z0-9]+(?:[-_][a-z0-9]+)*\.)+near$/ };
const implicitAccount = /^[0-9a-f]{64}$/;
const hashPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const failure = 'Wallet approval was not verified. Check the transaction before trying again.';

function validAccount(networkId, value, contract = false) {
  return typeof value === 'string' && value.length >= 2 && value.length <= 64
    && (namedAccount[networkId].test(value) || (!contract && implicitAccount.test(value)));
}

function readPayload(form, networkId) {
  const raw = form.elements.namedItem('walletPayload')?.value;
  if (typeof raw !== 'string' || raw.length > 16384) throw new Error('Invalid request');
  const payload = JSON.parse(raw);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || !validAccount(networkId, payload.accountId) || !validAccount(networkId, payload.contract, true)
    || !methods.has(payload.method) || !payload.args || typeof payload.args !== 'object' || Array.isArray(payload.args)
    || JSON.stringify(payload.args).length > 10240
    || typeof payload.depositYocto !== 'string' || !/^(0|[1-9][0-9]{0,38})$/.test(payload.depositYocto)
    || BigInt(payload.depositYocto) > 1010000000000000000000000n
    || payload.gas !== '100000000000000'
    || typeof payload.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.requestId)
    || form.elements.namedItem('requestId')?.value !== payload.requestId) throw new Error('Invalid request');
  return payload;
}

for (const form of document.querySelectorAll('form[data-stated-wallet]')) {
  const connect = form.querySelector('[data-connect-wallet]');
  const sign = form.querySelector('[data-sign-wallet]');
  const status = form.querySelector('[data-wallet-status]');
  const hashInput = form.elements.namedItem('transactionHash');
  if (!connect || !sign || !status || !hashInput) continue;
  const networkId = form.dataset.nearNetwork === 'mainnet' ? 'mainnet' : 'testnet';
  let account;
  let payload;

  const busy = (value) => { connect.disabled = value; sign.disabled = value; };
  const submitHash = (hash) => {
    if (typeof hash !== 'string' || !hashPattern.test(hash)) return false;
    hashInput.value = hash;
    form.requestSubmit();
    return true;
  };

  connect.addEventListener('click', async () => {
    account = undefined;
    sign.hidden = true;
    busy(true);
    try {
      payload = readPayload(form, networkId);
      const connected = await walletFor(networkId).requestSignIn({});
      if (!connected.success || connected.payload?.accountId !== payload.accountId) {
        status.textContent = `Connect the ${networkId} wallet ${payload.accountId} and try again.`;
        return;
      }
      // Public account descriptor only. No function-call key is requested or
      // stored, and the SDK opens Meteor for every transaction approval.
      account = { identifier: { blockchain: 'near', network: networkId, accountId: connected.payload.accountId },
        publicKeys: [], connection: { executionTarget: 'v1_web' } };
      connect.hidden = true;
      sign.hidden = false;
      status.textContent = 'Wallet connected. Review the request and sign.';
    } catch {
      status.textContent = failure;
    } finally {
      busy(false);
    }
  });

  sign.addEventListener('click', async () => {
    if (!account || !payload) return;
    busy(true);
    try {
      const current = readPayload(form, networkId);
      if (JSON.stringify(current) !== JSON.stringify(payload)) throw new Error('Request changed');
      const outcomes = await walletFor(networkId).requestSignTransactions({
          account,
          transactions: [walletTransaction(payload)],
      });
      if (!submitHash(outcomes?.[0]?.transaction?.hash)) throw new Error('Missing transaction hash');
      status.textContent = 'Checking the transaction.';
      return;
    } catch (error) {
      if (submitHash(error?.transactionHash)) return;
      account = undefined;
      connect.hidden = false;
      sign.hidden = true;
      status.textContent = failure;
    } finally {
      busy(false);
    }
  });
}
