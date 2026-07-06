// Deploys our own CEP-18 x402 token (Cep18X402.wasm) to Casper testnet, then
// funds the agent account with a starting balance. Mirrors the reference
// deployer.cs. Run once after the deployer/treasury account is funded with CSPR.
//
//   npm run deploy-token
//
// On success it prints the token package hash and writes ASSET_PACKAGE into .env.

import { readFileSync, writeFileSync } from "node:fs";
import { config } from "dotenv";
import casperSdk from "casper-js-sdk";
import { extractPackageHash } from "../lib/casper.js";

const { PrivateKey, KeyAlgorithm, RpcClient, HttpHandler, SessionBuilder, ContractCallBuilder, Args, CLValue, Key, EntityIdentifier } = casperSdk;

config();

const env = (k: string, required = true): string => {
  const v = process.env[k];
  if (!v && required) {
    console.error(`❌ ${k} is required in .env`);
    process.exit(1);
  }
  return v || "";
};

const rpcUrl = env("RPCURL_CASPER_CASPER_TEST");
const caip2 = env("CAIP2_CHAIN_ID"); // casper:casper-test
const chainName = caip2.split(":")[1]; // casper-test (deploy header chain name)
const deployerPemPath = env("DEPLOYER_PRIVATE_KEY_PATH");
const deployerAlgo = env("DEPLOYER_KEY_ALGO", false) || "ed25519";
const tokenName = env("ASSET_NAME");
const tokenSymbol = env("ASSET_SYMBOL");
const initialSupply = env("TOKEN_INITIAL_SUPPLY");
const agentAccountHash = env("AGENT_ACCOUNT_HASH"); // account-hash-...
const agentFundAmount = env("AGENT_FUND_AMOUNT");

const PACKAGE_HASH_KEY = "X402_package_hash";
const DEPLOY_PAYMENT = 800_000_000_000; // 800 CSPR max gas for install
const TRANSFER_PAYMENT = 2_500_000_000; // 2.5 CSPR for the transfer

async function main() {
  const algo = deployerAlgo === "secp256k1" ? KeyAlgorithm.SECP256K1 : KeyAlgorithm.ED25519;
  const deployer = PrivateKey.fromPem(readFileSync(deployerPemPath, "utf8"), algo);
  const rpc = new RpcClient(new HttpHandler(rpcUrl));

  console.log(`Deployer public key: ${deployer.publicKey.toHex()}`);
  console.log(`Chain name (deploy): ${chainName}   chain_id (arg): ${caip2}`);

  // ---- 1. Install the token ------------------------------------------------
  const wasm = readFileSync("./assets/Cep18X402.wasm");
  const installArgs = Args.fromMap({
    name: CLValue.newCLString(tokenName),
    symbol: CLValue.newCLString(tokenSymbol),
    decimals: CLValue.newCLUint8(9),
    initial_supply: CLValue.newCLUInt256(initialSupply),
    chain_id: CLValue.newCLString(caip2),
    odra_cfg_is_upgradable: CLValue.newCLValueBool(true),
    odra_cfg_is_upgrade: CLValue.newCLValueBool(false),
    odra_cfg_allow_key_override: CLValue.newCLValueBool(true),
    odra_cfg_package_hash_key_name: CLValue.newCLString(PACKAGE_HASH_KEY),
  });

  const installTx = new SessionBuilder()
    .from(deployer.publicKey)
    .wasm(new Uint8Array(wasm))
    .installOrUpgrade()
    .runtimeArgs(installArgs)
    .chainName(chainName)
    .payment(DEPLOY_PAYMENT)
    .build();
  installTx.sign(deployer);

  console.log(`\n📦 Installing token...`);
  const installResult = await rpc.putTransaction(installTx);
  console.log(`   submitted: ${JSON.stringify(installResult).slice(0, 160)}`);
  await rpc.waitForTransaction(installTx, 120000);
  console.log("✅ install transaction processed");

  // ---- 2. Read the package hash from the deployer's named keys -------------
  let packageHash = "";
  try {
    const entity = (await rpc.getLatestEntity(
      EntityIdentifier.fromPublicKey(deployer.publicKey),
    )) as { rawJSON?: unknown };
    packageHash = extractPackageHash(entity?.rawJSON ?? entity);
  } catch (e) {
    console.warn("getLatestEntity failed:", e instanceof Error ? e.message : e);
  }
  if (!packageHash) {
    console.warn("⚠️  Could not auto-read package hash. Set ASSET_PACKAGE manually from the install tx on cspr.live.");
  } else {
    console.log(`\n🏷️  Token package hash: ${packageHash}`);
    updateEnv("ASSET_PACKAGE", packageHash);
    console.log(`   wrote ASSET_PACKAGE=${packageHash} to .env`);
  }

  // ---- 3. Fund the agent with starting token balance ----------------------
  console.log(`\n💸 Funding agent (${agentAccountHash}) with ${agentFundAmount} tokens...`);
  const transferArgs = Args.fromMap({
    amount: CLValue.newCLUInt256(agentFundAmount),
    recipient: CLValue.newCLKey(Key.newKey(agentAccountHash)),
  });
  const transferTx = new ContractCallBuilder()
    .from(deployer.publicKey)
    .byPackageName(PACKAGE_HASH_KEY)
    .entryPoint("transfer")
    .runtimeArgs(transferArgs)
    .chainName(chainName)
    .payment(TRANSFER_PAYMENT)
    .build();
  transferTx.sign(deployer);
  await rpc.putTransaction(transferTx);
  await rpc.waitForTransaction(transferTx, 120000);
  console.log("✅ agent funded\n");

  if (packageHash) {
    console.log("========================================================");
    console.log(`NEW ASSET_PACKAGE=${packageHash}`);
    console.log("Set this as ASSET_PACKAGE (in .env or Fly secrets) and redeploy.");
    console.log("========================================================");
  }
  console.log("Done. Next: npm run facilitator | npm run proxy | npm run agent");
}

// Minimal .env updater (replaces or appends a KEY=value line).
function updateEnv(key: string, value: string) {
  const path = ".env";
  let body = readFileSync(path, "utf8");
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  body = re.test(body) ? body.replace(re, line) : body + `\n${line}\n`;
  writeFileSync(path, body);
}

main().catch(err => {
  console.error("Deploy failed:", err);
  process.exit(1);
});
