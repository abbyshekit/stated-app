// INTEGRATION: Which NEAR network this server is on. One process serves one
// network: loadConfig sets it from STATED_NEAR_NETWORK, and everything that
// names an account, a unit, an RPC endpoint or an explorer link reads it here.
// Testnet is the default. Mainnet moves real NEAR, so config.mjs refuses to
// turn it on without an explicit acknowledgement.
const NETWORKS = {
  testnet: {
    id: 'testnet', suffix: 'testnet', name: 'NEAR testnet', unit: 'test NEAR', real: false,
    // rpc.testnet.near.org is deprecated: on 10 November 2026 it answered a live run with HTTP 429
    // and "THIS ENDPOINT IS DEPRECATED ... Switch to https://fastnear.com". FastNEAR is the primary;
    // a second endpoint is tried when one is busy or down. STATED_NEAR_RPC replaces the list.
    rpc: ['https://test.rpc.fastnear.com', 'https://rpc.testnet.fastnear.com'],
    explorer: 'https://testnet.nearblocks.io',
    // https://github.com/near/near-contract-helper#create-account-works-only-on-test-networks
    faucet: 'https://helper.testnet.near.org/account',
    wrap: 'wrap.testnet',
  },
  mainnet: {
    id: 'mainnet', suffix: 'near', name: 'NEAR', unit: 'NEAR', real: true,
    // Public endpoints listed on https://docs.near.org/api/rpc/providers (read 10 November 2026).
    rpc: ['https://free.rpc.fastnear.com', 'https://near.drpc.org'],
    explorer: 'https://nearblocks.io',
    faucet: null,
    wrap: 'wrap.near',
  },
};

let current = NETWORKS.testnet;

export const network = () => current;
export function useNetwork(id) {
  if (!Object.hasOwn(NETWORKS, id)) throw new Error(`Unknown NEAR network: ${id}`);
  current = NETWORKS[id];
  return current;
}

/** What a stake is counted in: "test NEAR" on testnet, "NEAR" on mainnet. */
export const unit = () => current.unit;
/** The network as a person would name it. */
export const networkName = () => current.name;

/** Mainnet deposits are limited to the configured pilot participants. */
export function inPilot(config, xUserId) {
  if (!config.near?.real) return true;
  const list = config.play?.pilotXIds || [];
  return list.includes('*') || list.includes(String(xUserId));
}

const NAMED = { testnet: /^(?:[a-z0-9]+(?:[-_][a-z0-9]+)*\.)+testnet$/, mainnet: /^(?:[a-z0-9]+(?:[-_][a-z0-9]+)*\.)+near$/ };
const IMPLICIT = /^[0-9a-f]{64}$/;
const sized = (value) => typeof value === 'string' && value.length >= 2 && value.length <= 64;

/** A named account on this server's network: alice.testnet, or alice.near on mainnet. */
export const isNamedAccount = (value) => sized(value) && NAMED[current.id].test(value);
/** A named account on this network, or a 64-character implicit account. */
export const isAccount = (value) => sized(value) && (NAMED[current.id].test(value) || IMPLICIT.test(value));
export const accountPattern = () => `(${NAMED[current.id].source})|(${IMPLICIT.source})`;

export const accountLink = (accountId) => `${current.explorer}/address/${accountId}`;
export const transactionLink = (hash) => `${current.explorer}/txns/${hash}`;
