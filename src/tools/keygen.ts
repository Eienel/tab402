// Generate a Casper testnet keypair and print everything you need to wire it
// into .env. Usage:  npm run keygen -- [ed25519|secp256k1] [outfile.pem]

import { writeFileSync } from "node:fs";
import casperSdk from "casper-js-sdk";

const algoArg = (process.argv[2] || "ed25519").toLowerCase();
const outFile = process.argv[3] || `key-${algoArg}.pem`;

const algorithm =
  algoArg === "secp256k1" ? casperSdk.KeyAlgorithm.SECP256K1 : casperSdk.KeyAlgorithm.ED25519;

const pk = casperSdk.PrivateKey.generate(algorithm);
const pub = pk.publicKey;

const pem = pk.toPem();
writeFileSync(outFile, pem);

const publicKeyHex = pub.toHex();
const accountHashPrefixed = pub.accountHash().toPrefixedString(); // account-hash-<64hex>
const accountHashHex = accountHashPrefixed.replace(/^account-hash-/, "");
const payToKey = `00${accountHashHex}`; // Key::Account serialization used by PAYEE_ADDRESS

console.log("\n🔑 Generated Casper keypair");
console.log("──────────────────────────────────────────────────────────");
console.log(`algorithm        : ${algoArg}`);
console.log(`PEM written to   : ${outFile}   (keep secret; it is gitignored)`);
console.log(`public key (hex) : ${publicKeyHex}`);
console.log(`account hash     : ${accountHashPrefixed}`);
console.log("──────────────────────────────────────────────────────────");
console.log("Wire it into .env:");
console.log(`  • As the AGENT key:        CLIENT_PRIVATE_KEY_PATH=./${outFile}  CLIENT_KEY_ALGO=${algoArg}`);
console.log(`  • As the OPERATOR payee:   PAYEE_ADDRESS=${payToKey}`);
console.log(`  • As the FACILITATOR key:  SECRET_KEY_PEM_CASPER_CASPER_TEST + SECRET_KEY_ALGO_CASPER_CASPER_TEST=${algoArg}`);
console.log("\nFund this account:");
console.log(`  • Testnet CSPR faucet uses the public key: ${publicKeyHex}`);
console.log("    (facilitator needs CSPR for gas; agent needs WCSPR to spend)\n");
