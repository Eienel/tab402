// Shared Casper helpers for the dashboard: generate an agent keypair and fund
// it with X402 tokens from the treasury (the deployer holds the supply).

import { readFileSync } from "node:fs";
import casperSdk from "casper-js-sdk";

const { PrivateKey, KeyAlgorithm, RpcClient, HttpHandler, ContractCallBuilder, Args, CLValue, Key } =
  casperSdk;

const rpcUrl = process.env.RPCURL_CASPER_CASPER_TEST || "https://node.testnet.casper.network/rpc";
const chainName = (process.env.CAIP2_CHAIN_ID || "casper:casper-test").split(":")[1];
const deployerPemPath = process.env.DEPLOYER_PRIVATE_KEY_PATH || "./facilitator.pem";
const deployerAlgo = (process.env.DEPLOYER_KEY_ALGO || "ed25519").toLowerCase();
const PACKAGE_HASH_KEY = "X402_package_hash";

function rpc() {
  return new RpcClient(new HttpHandler(rpcUrl));
}

function deployerKey() {
  const algo = deployerAlgo === "secp256k1" ? KeyAlgorithm.SECP256K1 : KeyAlgorithm.ED25519;
  return PrivateKey.fromPem(readFileSync(deployerPemPath, "utf8"), algo);
}

export interface AgentKey {
  publicKeyHex: string;
  accountHash: string; // bare hex
  payTo: string; // "00" + accountHash (Key::Account)
  pem: string;
  algo: string;
}

export function newAgentKeypair(): AgentKey {
  const pk = PrivateKey.generate(KeyAlgorithm.ED25519);
  const accountHash = pk.publicKey.accountHash().toPrefixedString().replace(/^account-hash-/, "");
  return {
    publicKeyHex: pk.publicKey.toHex(),
    accountHash,
    payTo: `00${accountHash}`,
    pem: pk.toPem(),
    algo: "ed25519",
  };
}

// Transfer X402 tokens from the treasury to a recipient account hash.
export async function fundAccount(accountHash: string, amount: string): Promise<string> {
  const dep = deployerKey();
  const client = rpc();
  const bare = accountHash.replace(/^(00|account-hash-)/, "");
  const args = Args.fromMap({
    amount: CLValue.newCLUInt256(amount),
    recipient: CLValue.newCLKey(Key.newKey(`account-hash-${bare}`)),
  });
  const tx = new ContractCallBuilder()
    .from(dep.publicKey)
    .byPackageName(PACKAGE_HASH_KEY)
    .entryPoint("transfer")
    .runtimeArgs(args)
    .chainName(chainName)
    .payment(2_500_000_000)
    .build();
  tx.sign(dep);
  const res = (await client.putTransaction(tx)) as { transactionHash?: { toHex?: () => string } };
  await client.waitForTransaction(tx, 120000);
  return res?.transactionHash?.toHex?.() ?? "submitted";
}
