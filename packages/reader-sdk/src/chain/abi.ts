/** Just the fragments the SDK touches. Full ABI lives in the contracts package. */
export const attentionStreamAbi = [
  {
    type: "function",
    name: "openSession",
    stateMutability: "nonpayable",
    inputs: [
      { name: "articleId", type: "uint64" },
      { name: "budget", type: "uint96" },
      { name: "ratePerSec", type: "uint64" },
      { name: "signer", type: "address" },
    ],
    outputs: [{ name: "id", type: "bytes32" }],
  },
  {
    // Phase 1 of two-phase closure: records the accrual cutoff, no refund.
    type: "function",
    name: "closeSession",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [],
  },
  {
    // Phase 2: permissionless after `closeInitiatedAt + challengeWindow`.
    type: "function",
    name: "finalizeSession",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "challengeWindow",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    type: "function",
    name: "closeInitiatedAt",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    type: "function",
    name: "token",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "event",
    name: "SessionOpened",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "articleId", type: "uint256", indexed: true },
      { name: "reader", type: "address", indexed: true },
      { name: "author", type: "address", indexed: false },
      { name: "signer", type: "address", indexed: false },
      { name: "budget", type: "uint96", indexed: false },
      { name: "ratePerSec", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SessionClosing",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "articleId", type: "uint256", indexed: true },
      { name: "initiatedAt", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SessionClosed",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "articleId", type: "uint256", indexed: true },
      { name: "totalPaid", type: "uint96", indexed: false },
      { name: "refunded", type: "uint96", indexed: false },
      { name: "duration", type: "uint64", indexed: false },
    ],
  },
] as const;

export const erc20Abi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;
