import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { errorText, logger } from "./logger.js";
import { fileStore, keyStore, newKey, preferredKeyStore, type KeyStore, type KeyStoreName } from "./secret-key.js";

/** secrets.json on disk: the secrets as one AES-256-GCM ciphertext, and which store holds its key. */
type Envelope = {
  format: "saturn-secrets";
  version: 1;
  cipher: "aes-256-gcm";
  keyStore: KeyStoreName;
  iv: string;
  tag: string;
  data: string;
};

/** What the UI shows about how secrets are protected. */
export type SecretsProtection = { encrypted: boolean; keyStore: KeyStoreName | null; label: string };

const AAD = Buffer.from("saturn-secrets-v1");
const STORES: KeyStoreName[] = ["keychain", "dpapi", "libsecret", "file"];

function isEnvelope(value: unknown): value is Envelope {
  const item = value as Partial<Envelope> | null;
  return !!item && item.format === "saturn-secrets" && item.cipher === "aes-256-gcm" && STORES.includes(item.keyStore as KeyStoreName) && typeof item.data === "string";
}

export function encrypt(secrets: Map<string, string>, key: Buffer, store: KeyStoreName): Envelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const data = Buffer.concat([cipher.update(JSON.stringify(Object.fromEntries(secrets)), "utf8"), cipher.final()]);
  return { format: "saturn-secrets", version: 1, cipher: "aes-256-gcm", keyStore: store, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

export function decrypt(envelope: Envelope, key: Buffer): Map<string, string> {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const text = Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8");
  return new Map(Object.entries(JSON.parse(text) as Record<string, string>));
}

/**
 * The runtime's secrets (API keys, OAuth tokens), encrypted at rest. A random 256-bit key encrypts secrets.json with
 * AES-256-GCM; the key itself lives in the operating system's key store (Keychain, DPAPI, Secret Service), or in a
 * key file when there is none. A plaintext secrets.json from an earlier version is encrypted on first load.
 *
 * Nothing is ever lost silently: a file whose key cannot be found is copied aside before Saturn starts fresh.
 */
export class SecretsFile {
  private key: Buffer | null = null;
  private store: KeyStore;

  constructor(private readonly directory: string, private readonly preferred: () => KeyStore = () => preferredKeyStore(directory)) {
    this.store = preferred();
  }

  private get file(): string {
    return path.join(this.directory, "secrets.json");
  }

  protection(): SecretsProtection {
    return { encrypted: true, keyStore: this.store.name, label: this.store.label };
  }

  async load(): Promise<Map<string, string>> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") logger.error("store", `Could not read ${this.file}: ${errorText(error)}; starting with no secrets`);
      return new Map();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      await this.setAside("unreadable", `is not valid JSON (${errorText(error)})`);
      return new Map();
    }

    if (isEnvelope(parsed)) {
      this.store = keyStore(parsed.keyStore, this.directory);
      try {
        const key = await this.store.get();
        if (!key) throw new Error(`no key in the ${this.store.label}`);
        const secrets = decrypt(parsed, key);
        this.key = key;
        return secrets;
      } catch (error) {
        await this.setAside("locked", `could not be decrypted (${errorText(error)})`);
        this.store = this.preferred();
        return new Map();
      }
    }

    // An earlier version's plaintext file: encrypt it now, so the plaintext does not stay on disk.
    const secrets = new Map(Object.entries((parsed ?? {}) as Record<string, string>).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    await this.save(secrets);
    if (secrets.size) logger.info("store", `Encrypted ${secrets.size} saved ${secrets.size === 1 ? "secret" : "secrets"} in secrets.json; the key is kept in the ${this.store.label}`);
    return secrets;
  }

  async save(secrets: Map<string, string>): Promise<void> {
    const key = await this.ensureKey();
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(encrypt(secrets, key, this.store.name), null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.file);
  }

  /** The key for the next write: the loaded one, one already in the store, or a new one (the key file if the OS store refuses). */
  private async ensureKey(): Promise<Buffer> {
    if (this.key) return this.key;
    try {
      this.key = await this.store.get();
      if (!this.key) {
        const key = newKey();
        await this.store.set(key);
        this.key = key;
      }
    } catch (error) {
      if (this.store.name === "file") throw error;
      logger.warn("store", `Could not use the ${this.store.label} for the secrets key (${errorText(error)}); using a key file in the data folder instead`);
      this.store = fileStore(this.directory);
      this.key = (await this.store.get()) ?? newKey();
      await this.store.set(this.key);
    }
    return this.key;
  }

  private async setAside(reason: string, problem: string): Promise<void> {
    const backup = `${this.file}.${reason}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await copyFile(this.file, backup).catch(() => undefined);
    logger.error("store", `secrets.json ${problem}; starting with no saved keys. The file was kept as ${path.basename(backup)}, so nothing is lost.`);
  }
}
