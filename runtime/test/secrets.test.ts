import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { dpapiStore, fileStore, keychainStore, preferredKeyStore, type KeyStore } from "../src/infrastructure/secret-key.js";
import { SecretsFile } from "../src/infrastructure/secrets-file.js";
import { FileStore } from "../src/infrastructure/store.js";

const KEY = "sk-ant-api03-THIS-MUST-NEVER-BE-ON-DISK";

async function dataDir() {
  return mkdtemp(path.join(os.tmpdir(), "saturn-secrets-"));
}

test("secrets.json holds only ciphertext, and a fresh start reads the key back", async () => {
  const dir = await dataDir();
  const store = new FileStore(dir);
  await store.load();
  await store.putSecret("model:anthropic", KEY);

  const raw = await readFile(path.join(dir, "secrets.json"), "utf8");
  assert.ok(!raw.includes(KEY) && !raw.includes("sk-ant"), "no plaintext key on disk");
  const envelope = JSON.parse(raw);
  assert.deepEqual([envelope.format, envelope.cipher, envelope.keyStore], ["saturn-secrets", "aes-256-gcm", "file"]);
  if (process.platform !== "win32") {
    assert.equal((await stat(path.join(dir, "secrets.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(dir, "secrets.key"))).mode & 0o777, 0o600);
  }

  const again = new FileStore(dir);
  await again.load();
  assert.equal(again.secret("model:anthropic"), KEY);
  assert.deepEqual(again.secretsProtection(), { encrypted: true, keyStore: "file", label: "key file in the data folder" });

  // A new IV on every write: the same secrets never produce the same file.
  await again.putSecret("model:anthropic", KEY);
  assert.notEqual(JSON.parse(await readFile(path.join(dir, "secrets.json"), "utf8")).iv, envelope.iv);
});

test("a plaintext secrets.json from an earlier version is encrypted on first load", async () => {
  const dir = await dataDir();
  await writeFile(path.join(dir, "secrets.json"), JSON.stringify({ "model:openai": KEY, "mcp:github": "ghp_token" }), { mode: 0o600 });
  const store = new FileStore(dir);
  await store.load();
  assert.equal(store.secret("model:openai"), KEY);
  assert.equal(store.secret("mcp:github"), "ghp_token");
  const raw = await readFile(path.join(dir, "secrets.json"), "utf8");
  assert.ok(!raw.includes(KEY) && !raw.includes("ghp_token"), "the plaintext is gone from disk as soon as it is loaded");
});

test("a file whose key is gone is kept aside, not overwritten, and Saturn starts fresh", async () => {
  const dir = await dataDir();
  const first = new FileStore(dir);
  await first.load();
  await first.putSecret("model:anthropic", KEY);
  const sealed = await readFile(path.join(dir, "secrets.json"), "utf8");
  await rm(path.join(dir, "secrets.key"));

  const store = new FileStore(dir);
  await store.load();
  assert.equal(store.secret("model:anthropic"), undefined);
  const kept = (await readdir(dir)).find((name) => name.startsWith("secrets.json.locked-"));
  assert.ok(kept, "the undecryptable file was copied aside");
  assert.equal(await readFile(path.join(dir, kept), "utf8"), sealed);

  await store.putSecret("model:openai", "sk-new");
  const fresh = new FileStore(dir);
  await fresh.load();
  assert.equal(fresh.secret("model:openai"), "sk-new");
});

test("tampered ciphertext is rejected rather than half-read", async () => {
  const dir = await dataDir();
  const store = new FileStore(dir);
  await store.load();
  await store.putSecret("model:anthropic", KEY);
  const file = path.join(dir, "secrets.json");
  const envelope = JSON.parse(await readFile(file, "utf8"));
  const data = Buffer.from(envelope.data, "base64");
  data[0] ^= 0xff;
  await writeFile(file, JSON.stringify({ ...envelope, data: data.toString("base64") }));

  const reopened = new FileStore(dir);
  await reopened.load();
  assert.equal(reopened.secret("model:anthropic"), undefined);
  assert.ok((await readdir(dir)).some((name) => name.startsWith("secrets.json.locked-")));
});

test("when the OS key store refuses, the key goes to a key file and secrets are still encrypted", async () => {
  const dir = await dataDir();
  const refusing: KeyStore = {
    name: "keychain",
    label: "macOS Keychain",
    get: async () => null,
    set: async () => {
      throw new Error("User interaction is not allowed.");
    },
    remove: async () => undefined,
  };
  const store = new FileStore(dir, new SecretsFile(dir, () => refusing));
  await store.load();
  await store.putSecret("model:anthropic", KEY);
  assert.equal(store.secretsProtection().keyStore, "file");
  const raw = await readFile(path.join(dir, "secrets.json"), "utf8");
  assert.equal(JSON.parse(raw).keyStore, "file");
  assert.ok(!raw.includes(KEY));

  const reopened = new FileStore(dir);
  await reopened.load();
  assert.equal(reopened.secret("model:anthropic"), KEY, "the envelope names the store its key is in");
});

test("the key store follows the platform unless SATURN_SECRET_STORE picks one", () => {
  assert.equal(preferredKeyStore("/tmp/a", {}, "darwin").name, "keychain");
  assert.equal(preferredKeyStore("/tmp/a", {}, "win32").name, "dpapi");
  assert.equal(preferredKeyStore("/tmp/a", {}, "linux").name, "libsecret");
  assert.equal(preferredKeyStore("/tmp/a", { SATURN_SECRET_STORE: "file" }, "darwin").name, "file");
});

test("the key file round-trips a key", async () => {
  const dir = await dataDir();
  const store = fileStore(dir);
  assert.equal(await store.get(), null);
  const key = Buffer.alloc(32, 7);
  await store.set(key);
  assert.deepEqual(await store.get(), key);
});

test("Windows DPAPI round-trips a key, and the saved blob is not the key", { skip: process.platform !== "win32" && "DPAPI is Windows only" }, async () => {
  const dir = await dataDir();
  const store = dpapiStore(dir);
  assert.equal(await store.get(), null);
  const key = Buffer.from("0123456789abcdef0123456789abcdef");
  await store.set(key);
  assert.deepEqual(await store.get(), key);
  assert.ok(!(await readFile(path.join(dir, "secrets.dpapi"), "utf8")).includes(key.toString("base64")));
});

// Writes a real Keychain item (removed again), so it only runs when asked: SATURN_TEST_KEYCHAIN=1 npm test.
test("the macOS Keychain round-trips a key", { skip: (process.platform !== "darwin" || process.env.SATURN_TEST_KEYCHAIN !== "1") && "set SATURN_TEST_KEYCHAIN=1 on macOS" }, async () => {
  const dir = await dataDir();
  const store = keychainStore(dir);
  try {
    assert.equal(await store.get(), null);
    const key = Buffer.alloc(32, 9);
    await store.set(key);
    assert.deepEqual(await store.get(), key);
  } finally {
    await store.remove();
  }
  assert.equal(await store.get(), null);
});
