// Resolves per-network signing material for the facilitator from env vars.
// Adapted from make-software/casper-x402 examples/facilitator/config.ts.

import type { Network } from "@x402/core/types";

export type KeyAlgorithm = "ed25519" | "secp256k1";

export const DefaultAlgorithm: KeyAlgorithm = "ed25519";

/** Resolved per-network signing material. */
export interface NetworkKey {
  /** PEM-encoded private-key content (newlines normalized). */
  pem: string;
  /** Algorithm used to parse the PEM. */
  algorithm: KeyAlgorithm;
  /** JSON-RPC endpoint for the Casper node on this network. */
  rpcUrl: string;
}

export interface Env {
  logLevel: string;
  port: number;
  /** CAIP-2 network IDs this facilitator will accept. */
  networks: Network[];
  /** Gas budget (motes) for each settlement transaction. */
  transactionPaymentMotes: number;
  /** Resolved signing material, keyed by raw CAIP-2 network id. */
  keys: Record<string, NetworkKey>;
}

function envVar(key: string): string | undefined {
  return process.env[key];
}

/**
 * Convert a CAIP-2 network id to the env-var suffix used for per-network
 * overrides: "casper:casper-test" -> "CASPER_CASPER_TEST".
 */
export function networkEnvSuffix(network: string): string {
  return network.toUpperCase().replace(/[:\-]/g, "_");
}

/** Normalize a PEM string: support escaped "\n" and strip carriage returns. */
export function normalizePEM(pem: string): string {
  return pem.replace(/\\n/g, "\n").replace(/\r/g, "");
}

export function parseEnv(): Env {
  const logLevel = process.env.LOG_LEVEL || "info";

  const portRaw = process.env.PORT || "4022";
  const port = parseInt(portRaw, 10);
  if (Number.isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT must be a valid port number, got ${portRaw}`);
  }

  const networksRaw = process.env.CASPER_NETWORKS || "casper:casper-test";
  const networks = networksRaw
    .split(",")
    .map(n => n.trim())
    .filter(n => n.length > 0) as Network[];

  if (networks.length === 0) {
    throw new Error("CASPER_NETWORKS must list at least one network (comma-separated CAIP-2 ids)");
  }

  const transactionPaymentMotesRaw = process.env.TRANSACTION_PAYMENT_MOTES || "7000000000";
  const transactionPaymentMotes = parseInt(transactionPaymentMotesRaw, 10);
  if (Number.isNaN(transactionPaymentMotes) || transactionPaymentMotes <= 0) {
    throw new Error(
      `TRANSACTION_PAYMENT_MOTES must be a positive integer, got ${transactionPaymentMotesRaw}`,
    );
  }

  const keys: Record<string, NetworkKey> = {};
  const missing: string[] = [];

  for (const net of networks) {
    const suffix = networkEnvSuffix(net);

    const pemRaw = envVar(`SECRET_KEY_PEM_${suffix}`);
    const rpcUrl = envVar(`RPCURL_${suffix}`);

    if (!pemRaw || !rpcUrl) {
      missing.push(net);
      continue;
    }

    const algoRaw = (envVar(`SECRET_KEY_ALGO_${suffix}`) || DefaultAlgorithm).toLowerCase();
    if (algoRaw !== "ed25519" && algoRaw !== "secp256k1") {
      throw new Error(`SECRET_KEY_ALGO_${suffix} must be 'ed25519' or 'secp256k1', got '${algoRaw}'`);
    }

    keys[net] = {
      pem: normalizePEM(pemRaw),
      algorithm: algoRaw as KeyAlgorithm,
      rpcUrl,
    };
  }

  if (missing.length > 0) {
    throw new Error(
      `Incomplete configurations for networks ${missing.join(", ")}: set SECRET_KEY_PEM_<NET> and RPCURL_<NET> for each network (e.g. CASPER_CASPER_TEST for casper:casper-test).`,
    );
  }

  return { logLevel, port, networks, transactionPaymentMotes, keys };
}
