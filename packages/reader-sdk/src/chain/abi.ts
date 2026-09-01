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
    type: "function",
    name: "closeSession",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "bytes32" },
      { name: "cumulativeAmount", type: "uint96" },
      { name: "sig", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "readerReclaim",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [],
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
