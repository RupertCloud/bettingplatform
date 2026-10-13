import { Connection } from "@solana/web3.js";

const Web3 = require("web3");

export const solanaRPCurls = () => {
  return [
    // "https://api.mainnet-beta.solana.com",
    // "https://solana-api.projectserum.com",
    // "https://rpc.ankr.com/solana",
    process.env.SOLANA_RPC_URL as string,
  ];
};

export const getSolanaRPCurl = () => {
  // const rpcurls = solanaRPCurls();
  return process.env.SOLANA_RPC_URL as string;
};

export const getSolanaConnection = () => {
  const connection = new Connection(getSolanaRPCurl());
  return connection;
};

export const etherRPCurls = () => {
  return [
    "https://ethereum.publicnode.com",
    "https://rpc.ankr.com/eth",
    "https://eth-rpc.gateway.pokt.network",
  ];
};

export const getEtherRPCurl = () => {
  const rpcurls = etherRPCurls();
  return rpcurls[Math.floor(Math.random() * 3)];
};

export const binanceRPCurls = () => {
  return [
    process.env.BSC_RPC_URL as string,
    "https://binance.nodereal.io",
    "https://bsc-dataseed.binance.org",
    "https://bsc-dataseed2.defibit.io",
    "https://bsc-dataseed4.binance.org",
    // "https://bsc-testnet.public.blastapi.io",
    // "https://bsctestapi.terminet.io/rpc",
    // "https://data-seed-prebsc-1-s2.binance.org:8545",
    // "https://data-seed-prebsc-2-s2.binance.org:8545",
  ];
};

export const getBinanceRPCurl = () => {
  const rpcurls = binanceRPCurls();
  return rpcurls[Math.floor(Math.random() * 3)];
};
