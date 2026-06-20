// The agent: holds a Casper testnet key + a WCSPR budget. It calls the rail,
// gets a 402, signs the EIP-712 payment authorization, replays, and saves the
// returned audio. Its budget is its hard cap — when WCSPR runs out, calls fail.
// Adapted from make-software/casper-x402 examples/client.

import { writeFileSync } from "node:fs";
import { config } from "dotenv";
import { x402Client, x402HTTPClient, wrapFetchWithPayment, type PaymentRequirements } from "@x402/fetch";
import { createClientCasperSigner } from "@make-software/casper-x402";
import { ExactCasperScheme } from "@make-software/casper-x402/exact/client";
import casperSdk from "casper-js-sdk";

const { KeyAlgorithm } = casperSdk;

config();

const casperPrivateKeyPath = process.env.CLIENT_PRIVATE_KEY_PATH;
const casperKeyAlgorithm = process.env.CLIENT_KEY_ALGO;
const baseURL = process.env.SERVER_URL || "http://localhost:4021";
const endpointPath = process.env.ENDPOINT_PATH || "/v1/speak";
const url = `${baseURL}${endpointPath}`;
const text =
  process.env.TEXT || "Hello. I am an autonomous agent, and I just paid for this sentence on Casper.";
const outFile = process.env.OUT_FILE || "out.mp3";

async function main(): Promise<void> {
  if (!casperPrivateKeyPath) {
    console.error("❌ CLIENT_PRIVATE_KEY_PATH environment variable is required");
    process.exit(1);
  }

  const networkPreferences = ["casper:"];
  const preferredNetworkSelector = (
    _x402Version: number,
    options: PaymentRequirements[],
  ): PaymentRequirements => {
    for (const preference of networkPreferences) {
      const match = options.find(opt => opt.network.startsWith(preference));
      if (match) return match;
    }
    return options[0];
  };

  const algorithm =
    casperKeyAlgorithm === "secp256k1" ? KeyAlgorithm.SECP256K1 : KeyAlgorithm.ED25519;
  const casperSigner = await createClientCasperSigner(casperPrivateKeyPath, algorithm);

  const client = new x402Client(preferredNetworkSelector).register(
    "casper:*",
    new ExactCasperScheme(casperSigner),
  );
  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  console.log(`🤖 Agent requesting TTS from ${url}`);
  console.log(`   "${text}"`);

  const response = await fetchWithPayment(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error(`❌ Request failed (${response.status}): ${body}`);
    process.exit(1);
  }

  const audio = Buffer.from(await response.arrayBuffer());
  writeFileSync(outFile, audio);
  console.log(`✅ Got ${audio.length} bytes of audio -> ${outFile}`);

  const paymentResponse = new x402HTTPClient(client).getPaymentSettleResponse(name =>
    response.headers.get(name),
  );
  if (paymentResponse) {
    console.log("💰 Payment settled on-chain:", paymentResponse);
  }
}

main().catch(error => {
  console.error(error?.response?.data?.error ?? error);
  process.exit(1);
});
