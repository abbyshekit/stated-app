// INTEGRATION: Meteor's direct SDK accepts wallet-selector actions, then converts
// them into NEAR actions. Keep all integer amounts as decimal strings.
export function walletTransaction(payload) {
  return { receiverId: payload.contract, actions: [{ type: 'FunctionCall', params: {
    methodName: payload.method, args: payload.args, gas: payload.gas, deposit: payload.depositYocto,
  } }] };
}
