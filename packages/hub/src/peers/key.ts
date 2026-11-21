// The network key (design multi-hub-m2 §2, §3.1): 32 random bytes every hub of a network holds and nothing else does.
// It is the pre-shared key of the hubs' TLS link (link.ts). Like the Wi-Fi passwords it lives only in secrets.json
// (`network_key`: the net id it belongs to and the key as hex), never in SQLite, an op result, a log line, an event or
// an error: nothing here returns it except to the link, and no message built here quotes it.
// It crosses from the registrar to a joining hub once, in the network_admit answer, sealed to an X25519 public key the
// joining hub made for that one call (seal / open below): ECDH with an ephemeral key of the registrar's, HKDF-SHA256
// over the shared secret, AES-256-GCM. A reader of the API call (a tunnel's far end, a proxy, a log of bodies) sees
// only the sealed blob.

import { createCipheriv, createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, type KeyObject, randomBytes } from 'node:crypto';

import { FrError, type SealedKey } from '@fractonica/protocol';

import { readSecrets, writeSecrets } from '../network.ts';

export const NETWORK_KEY_BYTES = 32;
const SECRET = 'network_key';
const ALG = 'x25519-hkdf-sha256-aes256gcm';
/** The DER prefix of a raw X25519 public key (RFC 8410): node:crypto takes it as SPKI, the wire carries its 32 bytes. */
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

/** The stored key of network `netId`; null when none is stored, or the stored one is another network's. */
export function readNetworkKey(netId: number | null): Buffer | null {
  if (netId === null) {
    return null;
  }
  const v = readSecrets()[SECRET] as { net_id?: unknown; key?: unknown } | undefined;
  if (!v || typeof v !== 'object' || v.net_id !== netId || typeof v.key !== 'string' || !/^[0-9a-f]{64}$/.test(v.key)) {
    return null;
  }
  return Buffer.from(v.key, 'hex');
}

/** Stores `key` as network `netId`'s (the other keys of secrets.json are kept). */
export function writeNetworkKey(netId: number, key: Buffer): void {
  if (key.length !== NETWORK_KEY_BYTES) {
    throw new FrError('INTERNAL', 'a network key is 32 bytes');
  }
  const secrets = readSecrets();
  secrets[SECRET] = { net_id: netId, key: key.toString('hex') };
  writeSecrets(secrets);
}

export function newNetworkKey(): Buffer {
  return randomBytes(NETWORK_KEY_BYTES);
}

/** The identity a hub names its key by in the TLS handshake: the net id, which is no secret (it is in every frame). */
export function pskIdentity(netId: number): string {
  return `fr-net-${netId}`;
}

/** A key pair for one admission: the public half goes to the registrar, the private half opens its answer. */
export interface AdmissionKeys {
  /** The raw public key, 32 bytes as base64: network_admit's `public_key`. */
  publicKey: string;
  privateKey: KeyObject;
}

export function admissionKeys(): AdmissionKeys {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length);
  return { publicKey: raw.toString('base64'), privateKey };
}

function publicFromRaw(b64: string): KeyObject {
  const raw = Buffer.from(b64, 'base64');
  if (raw.length !== 32) {
    throw new FrError('INVALID_ARGS', 'public_key is not a raw X25519 public key (32 bytes as base64)');
  }
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** What both ends bind the sealed key to: the network and the hub it is for. */
const aad = (netId: number, hub: string) => Buffer.from(`fr-network-key/1|${netId}|${hub}`);

function wrapKey(shared: Buffer, salt: Buffer, epk: Buffer, to: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, salt, Buffer.concat([Buffer.from('fr-network-key/1'), epk, to]), 32));
}

/** The registrar's half: `key` sealed to the joining hub's public key, for network `netId` and hub `hub`. */
export function sealKey(key: Buffer, toPublicKey: string, netId: number, hub: string): SealedKey {
  const to = publicFromRaw(toPublicKey);
  const mine = generateKeyPairSync('x25519');
  const epk = mine.publicKey.export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length);
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  let shared: Buffer;
  try {
    shared = diffieHellman({ privateKey: mine.privateKey, publicKey: to });
  } catch {
    // A point of small order: never a key a hub made.
    throw new FrError('INVALID_ARGS', 'public_key is not a usable X25519 public key');
  }
  const cipher = createCipheriv('aes-256-gcm', wrapKey(shared, salt, epk, Buffer.from(toPublicKey, 'base64')), nonce);
  cipher.setAAD(aad(netId, hub));
  const ct = Buffer.concat([cipher.update(key), cipher.final()]);
  return { alg: ALG, epk: epk.toString('base64'), salt: salt.toString('base64'), nonce: nonce.toString('base64'), ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

/**
 * The joining hub's half: the key out of the registrar's answer. Throws (never quoting the blob) when it was not
 * sealed to these keys for this network and hub, or is not a key.
 */
export function openSealed(sealed: SealedKey, keys: AdmissionKeys, netId: number, hub: string): Buffer {
  const bad = () => new FrError('HUB_VERSION_MISMATCH', "the registrar's answer does not open to a network key: it was not sealed for this hub and this call", { hint: 'both hubs must run the same version; join again' });
  if (sealed.alg !== ALG) {
    throw bad();
  }
  try {
    const epk = Buffer.from(sealed.epk, 'base64');
    const shared = diffieHellman({ privateKey: keys.privateKey, publicKey: createPublicKey({ key: Buffer.concat([SPKI_PREFIX, epk]), format: 'der', type: 'spki' }) });
    const decipher = createDecipheriv('aes-256-gcm', wrapKey(shared, Buffer.from(sealed.salt, 'base64'), epk, Buffer.from(keys.publicKey, 'base64')), Buffer.from(sealed.nonce, 'base64'));
    decipher.setAAD(aad(netId, hub));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    const key = Buffer.concat([decipher.update(Buffer.from(sealed.ct, 'base64')), decipher.final()]);
    if (key.length !== NETWORK_KEY_BYTES) {
      throw bad();
    }
    return key;
  } catch {
    throw bad();
  }
}
