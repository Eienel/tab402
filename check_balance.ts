import { config } from "dotenv";
import casperSdk from "casper-js-sdk";

const { RpcClient, HttpHandler, PublicKey } = casperSdk;

const rpcUrl = "https://node.testnet.casper.network/rpc";
const rpc = new RpcClient(new HttpHandler(rpcUrl));

const pubKey = PublicKey.fromHex("01e336825955f452e85c0eb4e9f0d27f675743d0e8946449efdcd123edab7eda5e");
try {
  const balance = await rpc.getBalance(pubKey);
  console.log(`Balance: ${balance} motes (${parseInt(balance) / 1e9} CSPR)`);
} catch(e) {
  console.log("Account not found or error:", e.message);
}
