import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createFirestoreStore, IMAGE_CHUNK_BYTES, RECEIPT_COLLECTION, PROFILE_COLLECTION } from './storage.mjs';

// An explicitly local Firestore contract double: no credentials, network, or live project are used.
function memoryFirestore() {
  const documents = new Map(); const watchers = new Map();
  let transactions = Promise.resolve(); let batches = 0; let failBatch = -1;
  const clone = (data) => data == null ? data : structuredClone(data);
  const snapshot = (ref) => ({ id: ref.id, exists: documents.has(ref.path), data: () => clone(documents.get(ref.path)) });
  const collectionSnapshot = (prefix) => ({ docs: [...documents.keys()].filter((key) => key.startsWith(`${prefix}/`) && !key.slice(prefix.length + 1).includes('/')).map((key) => snapshot(reference(key))) });
  const notify = () => { for (const [prefix, callbacks] of watchers) for (const callback of callbacks) callback(collectionSnapshot(prefix)); };
  const reference = (key) => ({ path: key, id: key.split('/').at(-1), get: async () => snapshot(reference(key)), collection: (name) => collection(`${key}/${name}`) });
  const collection = (prefix) => ({
    doc: (id) => reference(`${prefix}/${id}`),
    onSnapshot(callback, error) {
      const callbacks = watchers.get(prefix) || new Set(); callbacks.add(callback); watchers.set(prefix, callbacks);
      queueMicrotask(() => callback(collectionSnapshot(prefix)));
      return () => callbacks.delete(callback);
    },
  });
  const commit = (writes) => {
    for (const [kind, ref, data] of writes) {
      if (kind === 'create' && documents.has(ref.path)) throw new Error('Already exists');
      const encodedBytes = Object.entries(data).reduce((sum, [key, value]) => sum + Buffer.byteLength(key) +
        ((Buffer.isBuffer(value) || value instanceof Uint8Array) ? value.byteLength : Buffer.byteLength(JSON.stringify(value))), 0);
      assert.ok(encodedBytes < 1024 * 1024, 'Each document fits the Firestore limit');
    }
    for (const [, ref, data] of writes) documents.set(ref.path, clone(data));
    notify();
  };
  return {
    collection, getAll: async (...refs) => refs.map(snapshot), documents,
    runTransaction(callback) {
      const result = transactions.then(async () => {
        const writes = [];
        const answer = await callback({
          async get(ref) { assert.equal(writes.length, 0, 'Firestore reads precede writes'); return snapshot(ref); },
          create: (ref, data) => writes.push(['create', ref, data]), set: (ref, data) => writes.push(['set', ref, data]),
        });
        commit(writes); return answer;
      });
      transactions = result.catch(() => {}); return result;
    },
    batch() {
      const writes = [];
      return { set: (ref, data) => writes.push(['set', ref, data]), async commit() {
        batches++; if (batches === failBatch) throw new Error('Simulated connection loss');
        assert.ok(writes.length <= 8); commit(writes);
      } };
    },
    failNextBatch(offset = 1) { failBatch = batches + offset; },
    allowBatches() { failBatch = -1; },
  };
}
const owner = `U${'a'.repeat(32)}`;
const event = (id, text = null) => ({ type: 'message', message: text == null ? { id, type: 'image' } : { id, type: 'text', text }, source: { type: 'user', userId: owner }, replyToken: 'fixture-reply' });
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('Firestore persists profile selection, deduplicates across workers, and restores image bytes after restart', async () => {
  const db = memoryFirestore(); let store = await createFirestoreStore(db); const second = await createFirestoreStore(db);
  try {
    await store.accept(event('100', 'โปรไฟล์ขวัญ'), 'kwan');
    const inserted = await Promise.all([store.accept(event('101')), second.accept(event('101'))]);
    assert.equal(inserted.filter(Boolean).length, 1, 'Only one process creates the receipt');
    const receipt = inserted.find(Boolean);
    assert.equal(receipt.profileKey, 'kwan');
    const claims = await Promise.all([store.claim(receipt.id), second.claim(receipt.id)]);
    assert.equal(claims.filter(Boolean).length, 1, 'Only one process downloads and analyzes the image');
    const claimed = claims.find(Boolean); const bytes = Buffer.alloc(IMAGE_CHUNK_BYTES * 2 + 123, 0xab);
    assert.equal(await store.complete(claimed, bytes, 'image/png', null), true);
    await store.accept(event('102', 'โปรไฟล์โตส'), 'ct');
    assert.equal(await second.accept(event('100', 'โปรไฟล์ขวัญ'), 'kwan'), null, 'Redelivered old commands do not change the current profile');
    await store.close(); store = await createFirestoreStore(db);
    assert.equal((await store.accept(event('103'))).profileKey, 'ct', 'Selection survives a restarted bot');
    const saved = await store.read(receipt.id);
    assert.equal(saved.profileKey, 'kwan'); assert.equal(saved.status, 'ready'); assert.equal(saved.imageChunkCount, 3);
    assert.deepEqual(await store.image(saved), bytes);
    assert.equal(saved.sha256, digest(bytes));
    assert.equal(await second.complete(claimed, bytes, 'image/png', null), false, 'An old lease cannot publish twice');
    assert.ok([...db.documents.keys()].every((key) => key.startsWith(`${RECEIPT_COLLECTION}/`) || key.startsWith(`${PROFILE_COLLECTION}/`)), 'No writes touch the existing debts collection');
    const chunk = `${RECEIPT_COLLECTION}/${receipt.id}/imageChunks/${saved.imageGeneration}_000`;
    db.documents.set(chunk, { bytes: Buffer.from('tampered') });
    await assert.rejects(store.image(saved), /integrity/);
  } finally { await store.close(); await second.close(); }
});

test('An interrupted multi-batch image is never ready; retry publishes only a complete verified generation', async () => {
  const db = memoryFirestore(); const store = await createFirestoreStore(db);
  try {
    const receipt = await store.accept(event('201')); const claimed = await store.claim(receipt.id);
    const bytes = Buffer.alloc(IMAGE_CHUNK_BYTES * 9 + 37, 0x5c);
    db.failNextBatch(2);
    await assert.rejects(store.complete(claimed, bytes, 'image/jpeg', null), /connection loss/);
    assert.equal((await store.read(receipt.id)).status, 'pending');
    assert.equal((await store.list()).filter((record) => record.status === 'ready').length, 0);
    await store.fail(claimed);
    const retryRecord = await store.read(receipt.id); assert.equal(retryRecord.attempts, 1);
    // Advance this fixture's retry time without waiting in a test.
    db.documents.set(`${RECEIPT_COLLECTION}/${receipt.id}`, { ...retryRecord, nextAttempt: 0 });
    db.allowBatches(); const retry = await store.claim(receipt.id);
    assert.equal(await store.complete(retry, bytes, 'image/jpeg', null), true);
    const ready = await store.read(receipt.id); assert.deepEqual(await store.image(ready), bytes);
    assert.equal([...db.documents.keys()].filter((key) => key.includes('/imageChunks/')).length, 10, 'Retry reuses content-addressed chunks');
    await assert.rejects(store.complete(retry, Buffer.alloc(0), 'image/jpeg', null), /size/);
  } finally { await store.close(); }
});

test('Firestore watch failure fails closed at startup', async () => {
  let unsubscribed = false;
  const db = { collection: () => ({ onSnapshot(next, error) { queueMicrotask(() => error(new Error('fixture permission denied'))); return () => { unsubscribed = true; }; } }) };
  await assert.rejects(createFirestoreStore(db), /storage unavailable/); assert.equal(unsubscribed, true);
});
