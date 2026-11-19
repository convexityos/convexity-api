/**
 * Zero-dependency am/1 Agent Mandate verifier, spend tracker, and fail-closed
 * Convexity MCP tool guard (Node 22+ / Node 24 LTS with node:crypto).
 *
 * Wire-compatible with convexityos/agent-mandate (am/1) and vitna-code's
 * vitna-policy::mandate + vitna-mcp::MandatedToolBridge.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { readFileSync } from "node:fs";

export const MANDATE_TYP = "application/agent-mandate+jwt";
export const PROTOCOL_VERSION = "am/1";
export const DEFAULT_SKEW_SECONDS = 60;

export type Effect = "irreversible" | "write" | "read";

export interface Money {
  cur: string;
  amt: string;
}

export interface StepUpCaveat {
  over: Money;
}

export interface MandateCaveats {
  currency?: string;
  max_total?: Money;
  max_per_txn?: Money;
  aud?: string[];
  resources?: string[];
  purpose?: string[];
  task?: string;
  effect?: Effect;
  depth?: number;
  delegable?: boolean;
  step_up?: StepUpCaveat;
}

export interface MandateClaims {
  v: string;
  typ: "mandate";
  jti: string;
  iss: string;
  sub: string;
  par: string | null;
  iat: number;
  nbf: number;
  exp: number;
  cnf: { jkt: string };
  ledger: string;
  cav: MandateCaveats;
}

export interface ToolPriceSpec {
  server: string;
  tool: string;
  scope?: string;
  resource_uri: string;
  amount: Money;
  effect: Effect;
  purpose?: string;
}

export interface ToolPricingCatalogFile {
  schema_version: string;
  description?: string;
  tools: ToolPriceSpec[];
}

export interface MandateActionRequest {
  resource: string;
  amount: Money;
  effect?: Effect;
  purpose?: string;
  taskId?: string;
}

export interface VerifiedMandateChain {
  chainHash: string;
  rootJti: string;
  path: string[];
  ledger: string;
  effective: MandateCaveats;
  nodeBudgets: Array<{ jti: string; maxTotal?: Money }>;
}

export interface MandateSpendRecord {
  spend_id: string;
  chain_hash: string;
  path: string[];
  resource: string;
  amount: Money;
  effect: Effect;
  refunded: boolean;
  timestamp: number;
}

/** Matches VitnaRunReceiptV1.mandate_provenance in convexityos/vitna-code. */
export interface MandateProvenanceRecord {
  chain_hash: string;
  root_jti: string;
  path: string[];
  ledger: string;
  currency: string;
  total_spent: string;
  spend_digests: string[];
}

export class MandateError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`mandate_refused:${code}: ${message}`);
    this.name = "MandateError";
    this.code = code;
  }
}

// ---- Key encoding (Ed25519 did:key + RFC 7638 JWK thumbprint) ---------------

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX = new Map<string, number>([...BASE58_ALPHABET].map((c, i) => [c, i]));

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function base58Encode(bytes: Uint8Array): string {
  let leadingZeros = 0;
  for (const b of bytes) {
    if (b === 0) leadingZeros += 1;
    else break;
  }
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = "1".repeat(leadingZeros);
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    out += BASE58_ALPHABET[digits[i]];
  }
  return out;
}

function base58Decode(input: string): Uint8Array {
  let leadingZeros = 0;
  for (const ch of input) {
    if (ch === "1") leadingZeros += 1;
    else break;
  }
  const bytes: number[] = [];
  for (const ch of input) {
    const val = BASE58_INDEX.get(ch);
    if (val === undefined) throw new MandateError("malformed_did", `invalid base58 character '${ch}'`);
    let carry = val;
    for (let i = 0; i < bytes.length; i += 1) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(leadingZeros + bytes.length);
  for (let i = 0; i < bytes.length; i += 1) {
    out[leadingZeros + i] = bytes[bytes.length - 1 - i];
  }
  return out;
}

export interface AgentKeyPair {
  did: string;
  jkt: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  rawPublicKey: Uint8Array;
}

export function keyPairFromSeed(seed32: Uint8Array): AgentKeyPair {
  if (seed32.length !== 32) throw new Error("Ed25519 seed must be 32 bytes");
  const pkcs8 = Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed32)]);
  const privateKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  return keyPairFromObjects(privateKey, publicKey);
}

export function generateAgentKeyPair(): AgentKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return keyPairFromObjects(privateKey, publicKey);
}

function keyPairFromObjects(privateKey: KeyObject, publicKey: KeyObject): AgentKeyPair {
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const rawPublicKey = new Uint8Array(spki.subarray(spki.length - 32));
  const did = didKeyFromRawPublicKey(rawPublicKey);
  const jkt = jwkThumbprintFromRawPublicKey(rawPublicKey);
  return { did, jkt, privateKey, publicKey, rawPublicKey };
}

export function didKeyFromRawPublicKey(raw32: Uint8Array): string {
  const prefixed = new Uint8Array(34);
  prefixed[0] = 0xed;
  prefixed[1] = 0x01;
  prefixed.set(raw32, 2);
  return `did:key:z${base58Encode(prefixed)}`;
}

export function rawPublicKeyFromDidKey(did: string): Uint8Array {
  if (!did.startsWith("did:key:z")) {
    throw new MandateError("malformed_did", `unsupported did format: ${did}`);
  }
  const decoded = base58Decode(did.slice("did:key:z".length));
  if (decoded.length !== 34 || decoded[0] !== 0xed || decoded[1] !== 0x01) {
    throw new MandateError("malformed_did", `did:key is not Ed25519 multicodec: ${did}`);
  }
  return decoded.subarray(2);
}

export function publicKeyObjectFromDidKey(did: string): KeyObject {
  const raw = rawPublicKeyFromDidKey(did);
  const spki = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw)]);
  return createPublicKey({ key: spki, format: "der", type: "spki" });
}

export function jwkThumbprintFromRawPublicKey(raw32: Uint8Array): string {
  const x = Buffer.from(raw32).toString("base64url");
  const canonical = `{"crv":"Ed25519","kty":"OKP","x":"${x}"}`;
  return createHash("sha256").update(canonical).digest().toString("base64url");
}

// ---- Exact 9-decimal Money arithmetic ---------------------------------------

const SCALE_DIGITS = 9;
const SCALE_FACTOR = 1_000_000_000n;

export function moneyToScaled(money: Money): bigint {
  if (!/^[A-Z0-9]{2,12}$/.test(money.cur)) {
    throw new MandateError("invalid_money", `invalid currency '${money.cur}'`);
  }
  const match = /^([0-9]+)(?:\.([0-9]+))?$/.exec(money.amt);
  if (!match) {
    throw new MandateError("invalid_money", `invalid decimal amount '${money.amt}'`);
  }
  const whole = BigInt(match[1]);
  const fracRaw = match[2] ?? "";
  if (fracRaw.length > SCALE_DIGITS) {
    throw new MandateError("invalid_money", `amount '${money.amt}' exceeds 9 decimal places`);
  }
  const fracPadded = fracRaw.padEnd(SCALE_DIGITS, "0");
  return whole * SCALE_FACTOR + BigInt(fracPadded);
}

export function moneyFromScaled(scaled: bigint, cur: string): Money {
  const whole = scaled / SCALE_FACTOR;
  const frac = (scaled % SCALE_FACTOR).toString().padStart(SCALE_DIGITS, "0").replace(/0+$/, "");
  return { cur, amt: frac.length === 0 ? whole.toString() : `${whole}.${frac}` };
}

// ---- Pattern matching & effect lattice --------------------------------------

function effectRank(effect: Effect): number {
  switch (effect) {
    case "irreversible":
      return 0;
    case "write":
      return 1;
    case "read":
      return 2;
  }
}

function hostOfUri(uri: string): string | null {
  try {
    return new URL(uri).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function hostPatternMatches(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase();
  const h = host.toLowerCase();
  if (p.startsWith("*.")) {
    const suffix = p.slice(1); // ".example.com"
    return h.endsWith(suffix) && h.length > suffix.length;
  }
  return p === h;
}

function hostPatternNarrows(parent: string, child: string): boolean {
  const p = parent.toLowerCase();
  const c = child.toLowerCase();
  if (p === c) return true;
  if (p.startsWith("*.")) {
    const suffix = p.slice(1);
    if (c.startsWith("*.")) return c.slice(1).endsWith(suffix);
    return c.endsWith(suffix) && c.length > suffix.length;
  }
  return false;
}

function uriPatternMatches(pattern: string, uri: string): boolean {
  if (pattern.endsWith("*")) {
    return uri.startsWith(pattern.slice(0, -1));
  }
  return pattern === uri;
}

function uriPatternNarrows(parent: string, child: string): boolean {
  if (parent === child) return true;
  if (parent.endsWith("*")) {
    const pPrefix = parent.slice(0, -1);
    const cPrefix = child.endsWith("*") ? child.slice(0, -1) : child;
    return cPrefix.startsWith(pPrefix);
  }
  return false;
}

// ---- JWS Signing & Chain Verification ---------------------------------------

export function signMandateJws(claims: MandateClaims, signer: AgentKeyPair): string {
  const header = { alg: "EdDSA", typ: MANDATE_TYP, kid: signer.did };
  const hB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
  const pB64 = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signingInput = `${hB64}.${pB64}`;
  const sig = cryptoSign(null, Buffer.from(signingInput, "ascii"), signer.privateKey);
  return `${signingInput}.${sig.toString("base64url")}`;
}

const KNOWN_CLAIMS = new Set([
  "v",
  "typ",
  "jti",
  "iss",
  "sub",
  "par",
  "iat",
  "nbf",
  "exp",
  "cnf",
  "ledger",
  "cav",
  "st",
]);

const KNOWN_CAVEATS = new Set([
  "currency",
  "max_total",
  "max_per_txn",
  "aud",
  "resources",
  "purpose",
  "task",
  "effect",
  "depth",
  "delegable",
  "step_up",
  "rate",
  "settle",
  "quote",
]);

function parseAndVerifySingle(token: string): MandateClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new MandateError("malformed_jws", "expected 3 compact JWS segments");
  const [hB64, pB64, sB64] = parts;
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(hB64, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(pB64, "base64url").toString("utf8"));
  } catch {
    throw new MandateError("malformed_jws", "invalid JSON in JWS header or payload");
  }
  if (header.alg !== "EdDSA" || header.typ !== MANDATE_TYP) {
    throw new MandateError("invalid_header", `expected EdDSA + ${MANDATE_TYP}`);
  }
  for (const key of Object.keys(payload)) {
    if (!KNOWN_CLAIMS.has(key)) {
      throw new MandateError("unknown_claim", `unregistered claim '${key}' rejected fail-closed`);
    }
  }
  const claims = payload as unknown as MandateClaims;
  if (claims.v !== PROTOCOL_VERSION || claims.typ !== "mandate") {
    throw new MandateError("invalid_claims", "unsupported mandate version or typ");
  }
  if (claims.cav && typeof claims.cav === "object") {
    for (const key of Object.keys(claims.cav)) {
      if (!KNOWN_CAVEATS.has(key)) {
        throw new MandateError("unknown_caveat", `unregistered caveat '${key}' rejected fail-closed`);
      }
    }
  }
  const pubKey = publicKeyObjectFromDidKey(claims.iss);
  const sig = Buffer.from(sB64, "base64url");
  const ok = cryptoVerify(null, Buffer.from(`${hB64}.${pB64}`, "ascii"), pubKey, sig);
  if (!ok) {
    throw new MandateError("invalid_signature", `Ed25519 verification failed for ${claims.jti}`);
  }
  return claims;
}

function attenuateCaveats(effective: MandateCaveats, child: MandateCaveats): MandateCaveats {
  const next: MandateCaveats = { ...effective };

  if (child.currency !== undefined) {
    if (effective.currency !== undefined && effective.currency !== child.currency) {
      throw new MandateError("attenuation_violation", "child changed currency");
    }
    next.currency = child.currency;
  }

  if (child.max_total !== undefined) {
    const cScaled = moneyToScaled(child.max_total);
    if (effective.max_total !== undefined) {
      if (effective.max_total.cur !== child.max_total.cur) {
        throw new MandateError("currency_mismatch", "max_total currency mismatch");
      }
      if (cScaled > moneyToScaled(effective.max_total)) {
        throw new MandateError("attenuation_violation", "child max_total exceeds parent");
      }
    }
    next.max_total = child.max_total;
  }

  if (child.max_per_txn !== undefined) {
    const cScaled = moneyToScaled(child.max_per_txn);
    if (effective.max_per_txn !== undefined) {
      if (effective.max_per_txn.cur !== child.max_per_txn.cur) {
        throw new MandateError("currency_mismatch", "max_per_txn currency mismatch");
      }
      if (cScaled > moneyToScaled(effective.max_per_txn)) {
        throw new MandateError("attenuation_violation", "child max_per_txn exceeds parent");
      }
    }
    next.max_per_txn = child.max_per_txn;
  }

  if (child.aud !== undefined) {
    if (effective.aud !== undefined) {
      for (const cPat of child.aud) {
        if (!effective.aud.some((pPat) => hostPatternNarrows(pPat, cPat))) {
          throw new MandateError("attenuation_violation", `aud '${cPat}' widens parent allowlist`);
        }
      }
    }
    next.aud = [...child.aud];
  }

  if (child.resources !== undefined) {
    if (effective.resources !== undefined) {
      for (const cPat of child.resources) {
        if (!effective.resources.some((pPat) => uriPatternNarrows(pPat, cPat))) {
          throw new MandateError("attenuation_violation", `resource '${cPat}' widens parent grant`);
        }
      }
    }
    next.resources = [...child.resources];
  }

  if (child.purpose !== undefined) {
    if (effective.purpose !== undefined) {
      const parentSet = new Set(effective.purpose);
      for (const p of child.purpose) {
        if (!parentSet.has(p)) {
          throw new MandateError("attenuation_violation", `purpose '${p}' outside parent grant`);
        }
      }
    }
    next.purpose = [...child.purpose];
  }

  if (child.task !== undefined) {
    if (effective.task !== undefined && effective.task !== child.task) {
      throw new MandateError("attenuation_violation", "child cannot change pinned task");
    }
    next.task = child.task;
  }

  if (child.effect !== undefined) {
    if (effective.effect !== undefined && effectRank(child.effect) < effectRank(effective.effect)) {
      throw new MandateError(
        "attenuation_violation",
        `child effect '${child.effect}' widens parent '${effective.effect}'`,
      );
    }
    next.effect = child.effect;
  }

  if (child.depth !== undefined) {
    if (effective.depth !== undefined && child.depth >= effective.depth) {
      throw new MandateError("attenuation_violation", "child depth must strictly decrease");
    }
    next.depth = child.depth;
  } else if (effective.depth !== undefined) {
    next.depth = effective.depth - 1;
  }

  if (child.delegable !== undefined) {
    if (effective.delegable === false && child.delegable === true) {
      throw new MandateError("attenuation_violation", "child cannot re-enable delegation");
    }
    next.delegable = child.delegable;
  }

  if (child.step_up !== undefined) {
    if (effective.step_up !== undefined) {
      if (effective.step_up.over.cur !== child.step_up.over.cur) {
        throw new MandateError("currency_mismatch", "step_up currency mismatch");
      }
      if (moneyToScaled(child.step_up.over) > moneyToScaled(effective.step_up.over)) {
        throw new MandateError("attenuation_violation", "child step_up threshold exceeds parent");
      }
    }
    next.step_up = child.step_up;
  }

  return next;
}

export interface VerifyMandateOptions {
  trustedRootIssuers: Set<string>;
  ledger: string;
  now?: number;
  skewSeconds?: number;
  request?: MandateActionRequest;
  stepUpApproved?: boolean;
}

export function verifyMandateChain(tokens: string[], opts: VerifyMandateOptions): VerifiedMandateChain {
  if (tokens.length === 0) throw new MandateError("empty_chain", "mandate chain is empty");
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const skew = opts.skewSeconds ?? DEFAULT_SKEW_SECONDS;

  const claimsList = tokens.map(parseAndVerifySingle);
  const root = claimsList[0];
  if (root.par !== null) {
    throw new MandateError("invalid_root", "root mandate must have par: null");
  }
  if (!opts.trustedRootIssuers.has(root.iss)) {
    throw new MandateError("untrusted_issuer", `root issuer ${root.iss} is not trusted`);
  }

  let effective: MandateCaveats = { ...root.cav };
  const path: string[] = [];
  const nodeBudgets: Array<{ jti: string; maxTotal?: Money }> = [];

  for (let i = 0; i < claimsList.length; i += 1) {
    const cur = claimsList[i];
    if (cur.ledger !== opts.ledger) {
      throw new MandateError("ledger_mismatch", `mandate ${cur.jti} ledger mismatch`);
    }
    if (now + skew < cur.nbf) {
      throw new MandateError("not_yet_valid", `mandate ${cur.jti} is not yet valid`);
    }
    if (now - skew > cur.exp) {
      throw new MandateError("expired", `mandate ${cur.jti} expired`);
    }
    const subRaw = rawPublicKeyFromDidKey(cur.sub);
    const expectedJkt = jwkThumbprintFromRawPublicKey(subRaw);
    if (cur.cnf?.jkt !== expectedJkt) {
      throw new MandateError("cnf_mismatch", `mandate ${cur.jti} cnf.jkt does not match sub`);
    }
    if (i > 0) {
      const parent = claimsList[i - 1];
      if (cur.par !== parent.jti) {
        throw new MandateError("broken_chain", `mandate ${cur.jti} par does not match ${parent.jti}`);
      }
      if (cur.iss !== parent.sub) {
        throw new MandateError("broken_chain", `mandate ${cur.jti} iss does not match parent sub`);
      }
      if (effective.delegable === false) {
        throw new MandateError("delegation_forbidden", "parent mandate forbids delegation");
      }
      if (effective.depth !== undefined && effective.depth === 0) {
        throw new MandateError("depth_exceeded", "delegation depth exhausted");
      }
      if (cur.exp > parent.exp) {
        throw new MandateError("attenuation_violation", "child exp exceeds parent exp");
      }
      effective = attenuateCaveats(effective, cur.cav);
    }
    path.push(cur.jti);
    nodeBudgets.push({ jti: cur.jti, maxTotal: cur.cav.max_total });
  }

  if (opts.request) {
    const req = opts.request;
    const reqScaled = moneyToScaled(req.amount);

    if (effective.currency !== undefined && req.amount.cur !== effective.currency) {
      throw new MandateError("currency_mismatch", `request ${req.amount.cur} != ${effective.currency}`);
    }
    if (effective.max_per_txn !== undefined) {
      if (req.amount.cur !== effective.max_per_txn.cur) {
        throw new MandateError("currency_mismatch", "max_per_txn currency mismatch");
      }
      if (reqScaled > moneyToScaled(effective.max_per_txn)) {
        throw new MandateError(
          "amount_exceeds_cap",
          `${req.amount.amt} ${req.amount.cur} exceeds max_per_txn ${effective.max_per_txn.amt}`,
        );
      }
    }
    if (effective.max_total !== undefined) {
      if (req.amount.cur !== effective.max_total.cur) {
        throw new MandateError("currency_mismatch", "max_total currency mismatch");
      }
      if (reqScaled > moneyToScaled(effective.max_total)) {
        throw new MandateError("budget_exhausted", "single request exceeds effective max_total");
      }
    }
    if (effective.aud !== undefined) {
      const host = hostOfUri(req.resource);
      if (!host || !effective.aud.some((pat) => hostPatternMatches(pat, host))) {
        throw new MandateError("audience_mismatch", `host ${host ?? "<invalid>"} outside aud allowlist`);
      }
    }
    if (effective.resources !== undefined) {
      if (!effective.resources.some((pat) => uriPatternMatches(pat, req.resource))) {
        throw new MandateError("resource_not_covered", `resource ${req.resource} outside grant`);
      }
    }
    if (effective.purpose !== undefined) {
      if (!req.purpose || !effective.purpose.includes(req.purpose)) {
        throw new MandateError(
          "purpose_not_covered",
          `purpose '${req.purpose ?? "<none>"}' outside [${effective.purpose.join(", ")}]`,
        );
      }
    }
    if (effective.task !== undefined && req.taskId !== effective.task) {
      throw new MandateError("purpose_not_covered", `taskId does not match pinned task ${effective.task}`);
    }
    if (effective.effect !== undefined) {
      const actual: Effect = req.effect ?? "irreversible";
      if (effectRank(actual) < effectRank(effective.effect)) {
        throw new MandateError(
          "effect_not_permitted",
          `effect '${actual}' exceeds permitted '${effective.effect}'`,
        );
      }
    }
    if (effective.step_up !== undefined) {
      if (req.amount.cur !== effective.step_up.over.cur) {
        throw new MandateError("currency_mismatch", "step_up currency mismatch");
      }
      if (reqScaled > moneyToScaled(effective.step_up.over) && !opts.stepUpApproved) {
        throw new MandateError(
          "step_up_required",
          `${req.amount.amt} ${req.amount.cur} exceeds step_up ${effective.step_up.over.amt}`,
        );
      }
    }
  }

  const chainHash = `sha256:${createHash("sha256").update(tokens.join(".")).digest("hex")}`;
  return {
    chainHash,
    rootJti: root.jti,
    path,
    ledger: root.ledger,
    effective,
    nodeBudgets,
  };
}

// ---- Per-Ancestor Spend Tracker & Pricing Catalog ---------------------------

export class MandateSpendTracker {
  private nextId = 1;
  private readonly nodeSpent = new Map<string, { cur: string; scaled: bigint }>();
  private readonly records = new Map<string, MandateSpendRecord>();

  reserve(
    verified: VerifiedMandateChain,
    resource: string,
    amount: Money,
    effect: Effect,
    timestamp = Math.floor(Date.now() / 1000),
  ): MandateSpendRecord {
    const debit = moneyToScaled(amount);

    // Phase 1: check every ancestor cap before mutating any counter.
    for (const node of verified.nodeBudgets) {
      const existing = this.nodeSpent.get(node.jti);
      if (existing && existing.cur !== amount.cur) {
        throw new MandateError("currency_mismatch", `node ${node.jti} tracks ${existing.cur}`);
      }
      if (node.maxTotal) {
        if (node.maxTotal.cur !== amount.cur) {
          throw new MandateError("currency_mismatch", `node ${node.jti} cap currency mismatch`);
        }
        const already = existing?.scaled ?? 0n;
        const cap = moneyToScaled(node.maxTotal);
        if (already + debit > cap) {
          throw new MandateError("budget_exhausted", `mandate ${node.jti} budget exhausted`);
        }
      }
    }

    // Phase 2: debit every ancestor along the verified path.
    for (const node of verified.nodeBudgets) {
      const existing = this.nodeSpent.get(node.jti);
      this.nodeSpent.set(node.jti, {
        cur: amount.cur,
        scaled: (existing?.scaled ?? 0n) + debit,
      });
    }

    const spendId = `spn_${String(this.nextId++).padStart(6, "0")}`;
    const record: MandateSpendRecord = {
      spend_id: spendId,
      chain_hash: verified.chainHash,
      path: [...verified.path],
      resource,
      amount: { ...amount },
      effect,
      refunded: false,
      timestamp,
    };
    this.records.set(spendId, record);
    return record;
  }

  /** Refunds ONLY Effect::read failures; write and irreversible stay debited. */
  refundIfReversible(spendId: string): boolean {
    const rec = this.records.get(spendId);
    if (!rec || rec.refunded || rec.effect !== "read") return false;
    rec.refunded = true;
    const debit = moneyToScaled(rec.amount);
    for (const jti of rec.path) {
      const entry = this.nodeSpent.get(jti);
      if (entry && entry.cur === rec.amount.cur) {
        entry.scaled = entry.scaled > debit ? entry.scaled - debit : 0n;
      }
    }
    return true;
  }

  spentOn(jti: string): Money | undefined {
    const entry = this.nodeSpent.get(jti);
    return entry ? moneyFromScaled(entry.scaled, entry.cur) : undefined;
  }

  provenanceFor(verified: VerifiedMandateChain, currency: string): MandateProvenanceRecord {
    let totalScaled = 0n;
    const digests: string[] = [];
    for (const rec of this.records.values()) {
      if (rec.chain_hash === verified.chainHash && !rec.refunded && rec.amount.cur === currency) {
        totalScaled += moneyToScaled(rec.amount);
        digests.push(`sha256:${createHash("sha256").update(JSON.stringify(rec)).digest("hex")}`);
      }
    }
    const total = moneyFromScaled(totalScaled, currency);
    return {
      chain_hash: verified.chainHash,
      root_jti: verified.rootJti,
      path: [...verified.path],
      ledger: verified.ledger,
      currency: total.cur,
      total_spent: total.amt,
      spend_digests: digests,
    };
  }
}

export class ToolPricingCatalog {
  private readonly byKey = new Map<string, ToolPriceSpec>();

  static fromFile(filePath: string | URL): ToolPricingCatalog {
    const raw = readFileSync(filePath, "utf8");
    return ToolPricingCatalog.fromJson(JSON.parse(raw) as ToolPricingCatalogFile);
  }

  static fromJson(doc: ToolPricingCatalogFile): ToolPricingCatalog {
    if (doc.schema_version !== "am-mcp-pricing-v1") {
      throw new Error(`Unsupported pricing catalog schema_version: ${doc.schema_version}`);
    }
    const catalog = new ToolPricingCatalog();
    for (const entry of doc.tools) {
      catalog.set(entry);
    }
    return catalog;
  }

  set(spec: ToolPriceSpec): void {
    this.byKey.set(`${spec.server}\0${spec.tool}`, spec);
  }

  get(server: string, tool: string): ToolPriceSpec | undefined {
    return this.byKey.get(`${server}\0${tool}`);
  }

  list(): ToolPriceSpec[] {
    return [...this.byKey.values()];
  }
}

// ---- Fail-Closed Convexity MCP Client ---------------------------------------

export interface McpToolCallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export type McpTransport = (toolName: string, args: Record<string, unknown>) => Promise<McpToolCallResult>;

export function createHttpConvexityMcpTransport(
  apiKey: string,
  endpoint = "https://convexityos.com/api/v1/mcp",
): McpTransport {
  let reqId = 1;
  return async (toolName, args) => {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: reqId++,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
    });
    if (!resp.ok) {
      throw new Error(`Convexity MCP HTTP ${resp.status}: ${await resp.text()}`);
    }
    const rpc = (await resp.json()) as {
      result?: McpToolCallResult;
      error?: { code: number; message: string };
    };
    if (rpc.error) {
      throw new Error(`Convexity MCP RPC ${rpc.error.code}: ${rpc.error.message}`);
    }
    if (!rpc.result) {
      throw new Error("Convexity MCP returned empty JSON-RPC result");
    }
    return rpc.result;
  };
}

export interface MandatedMcpClientOptions {
  serverName?: string;
  tokens: string[];
  trustedRootIssuers: Set<string>;
  ledger: string;
  pricing: ToolPricingCatalog;
  tracker: MandateSpendTracker;
  transport: McpTransport;
  taskId?: string;
  stepUpApproved?: boolean;
  clock?: () => number;
}

export class MandatedConvexityMcpClient {
  private readonly serverName: string;
  private readonly opts: MandatedMcpClientOptions;

  constructor(opts: MandatedMcpClientOptions) {
    this.serverName = opts.serverName ?? "convexity";
    this.opts = opts;
  }

  async callTool(toolName: string, args: Record<string, unknown> = {}): Promise<McpToolCallResult> {
    const spec = this.opts.pricing.get(this.serverName, toolName);
    if (!spec) {
      throw new MandateError(
        "unpriced_tool",
        `tool '${this.serverName}:${toolName}' has no pricing entry in catalog`,
      );
    }
    const now = this.opts.clock ? this.opts.clock() : Math.floor(Date.now() / 1000);
    const verified = verifyMandateChain(this.opts.tokens, {
      trustedRootIssuers: this.opts.trustedRootIssuers,
      ledger: this.opts.ledger,
      now,
      request: {
        resource: spec.resource_uri,
        amount: spec.amount,
        effect: spec.effect,
        purpose: spec.purpose,
        taskId: this.opts.taskId,
      },
      stepUpApproved: this.opts.stepUpApproved,
    });

    const spend = this.opts.tracker.reserve(verified, spec.resource_uri, spec.amount, spec.effect, now);
    try {
      const result = await this.opts.transport(toolName, args);
      if (result.isError) {
        this.opts.tracker.refundIfReversible(spend.spend_id);
      }
      return result;
    } catch (err) {
      this.opts.tracker.refundIfReversible(spend.spend_id);
      throw err;
    }
  }

  provenance(currency = "USD"): MandateProvenanceRecord {
    const now = this.opts.clock ? this.opts.clock() : Math.floor(Date.now() / 1000);
    const verified = verifyMandateChain(this.opts.tokens, {
      trustedRootIssuers: this.opts.trustedRootIssuers,
      ledger: this.opts.ledger,
      now,
    });
    return this.opts.tracker.provenanceFor(verified, currency);
  }
}
