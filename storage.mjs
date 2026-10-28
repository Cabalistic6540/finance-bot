import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const RECEIPT_COLLECTION = 'financeReceiptInbox_v1';
export const PROFILE_COLLECTION = 'financeReceiptProfiles_v1';
export const IMAGE_CHUNK_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const missing = () => Object.assign(new Error('Receipt not found'), { code: 'ENOENT' });
const profileOf = (value) => value === 'kwan' ? 'kwan' : 'ct';
export function profileCommand(text) {
  const normalized = String(text || '').trim().toLowerCase().replace(/\s+/g, '');
  if (['โปรไฟล์ขวัญ', 'kwan'].includes(normalized)) return 'kwan';
  if (['โปรไฟล์โตส', 'ctos', 'ct'].includes(normalized)) return 'ct';
  return null;
}
function newRecord(event, profileKey, change) {
  return { id: hash(event.message.id), messageId: event.message.id, profileKey,
    kind: change ? 'profile' : 'image', status: change ? 'complete' : 'pending',
    replyToken: change ? null : event.replyToken || null, attempts: 0, receivedAt: new Date().toISOString() };
}
function canClaim(record, now) {
  return record?.kind !== 'profile' && record?.status === 'pending' && (record.attempts || 0) < 20 &&
    (!record.nextAttempt || record.nextAttempt <= now) && (!record.leaseUntil || record.leaseUntil <= now);
}
function ownedLease(current, record) { return current?.status === 'pending' && current.leaseId === record.leaseId; }
function readyRecord(record, image, analysis, extra = {}) {
  return { ...record, ...extra, status: 'ready', size: image.length, sha256: hash(image), analysis,
    replyToken: null, leaseUntil: 0, leaseId: null, lastError: null };
}
export async function createFileStore(dataDir) {
  const eventDir = path.join(dataDir, 'events');
  const imageDir = path.join(dataDir, 'images');
  const profileDir = path.join(dataDir, 'profiles');
  for (const directory of [eventDir, imageDir, profileDir]) await fs.mkdir(directory, { recursive: true });
  const filename = (id) => path.join(eventDir, `${id}.json`);
  const read = async (id) => JSON.parse(await fs.readFile(filename(id), 'utf8'));
  const atomicJson = async (target, value) => {
    const temp = `${target}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await fs.rename(temp, target);
  };
  const write = (record) => atomicJson(filename(record.id), record);
  return {
    kind: 'file', read,
    async list() {
      const files = (await fs.readdir(eventDir)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
      return Promise.all(files.map((name) => read(name.slice(0, -5))));
    },
    async accept(event, change = null) {
      const id = hash(event.message.id);
      try { await read(id); return null; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const profileFile = path.join(profileDir, `${hash(event.source.userId)}.json`);
      let selected = 'ct';
      try { selected = profileOf(JSON.parse(await fs.readFile(profileFile, 'utf8')).profileKey); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (change) { selected = profileOf(change); await atomicJson(profileFile, { profileKey: selected }); }
      const record = newRecord(event, selected, change);
      await write(record);
      return record;
    },
    async claim(id) {
      const record = await read(id); const now = Date.now();
      if (!canClaim(record, now)) return null;
      const claimed = { ...record, leaseId: randomUUID(), leaseUntil: now + 120000 };
      await write(claimed); return claimed;
    },
    async complete(record, image, mimeType, analysis) {
      const current = await read(record.id);
      if (!ownedLease(current, record)) return false;
      const imageFile = `${record.id}.image`;
      await fs.writeFile(path.join(imageDir, imageFile), image, { mode: 0o600 });
      await write(readyRecord(record, image, analysis, { mimeType, imageFile })); return true;
    },
    async fail(record) {
      if (!ownedLease(await read(record.id), record)) return;
      await write({ ...record, leaseId: null, leaseUntil: 0, attempts: (record.attempts || 0) + 1,
        nextAttempt: Date.now() + 30000, lastError: 'Image retrieval failed' });
    },
    async image(record) {
      // Compatibility for receipts created by the first local-only package.
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[record.mimeType];
      const buffer = await fs.readFile(path.join(imageDir, record.imageFile || `${record.id}.${ext}`));
      if (record.sha256 && hash(buffer) !== record.sha256) throw new Error('Receipt integrity check failed');
      return buffer;
    },
    async close() {},
  };
}

// This adapter receives an Admin SDK Firestore instance. No client credentials or public bucket are used.
export async function createFirestoreStore(db, { startupTimeoutMs = 20000 } = {}) {
  const receipts = db.collection(RECEIPT_COLLECTION);
  const profiles = db.collection(PROFILE_COLLECTION);
  const records = new Map();
  let healthy = false; let stopped = false; let unsubscribe;
  let resolveInitial, rejectInitial;
  const initial = new Promise((resolve, reject) => { resolveInitial = resolve; rejectInitial = reject; });
  const timer = setTimeout(() => rejectInitial(new Error('Receipt storage startup timed out')), startupTimeoutMs);
  unsubscribe = receipts.onSnapshot((snapshot) => {
    if (stopped) return;
    records.clear();
    for (const doc of snapshot.docs) records.set(doc.id, doc.data());
    healthy = true; resolveInitial();
  }, () => { healthy = false; rejectInitial(new Error('Receipt storage unavailable')); });
  try { await initial; } catch (error) { stopped = true; unsubscribe(); throw error; } finally { clearTimeout(timer); }
  const available = () => { if (!healthy || stopped) throw new Error('Receipt storage unavailable'); };
  const read = async (id) => { available(); const doc = await receipts.doc(id).get(); if (!doc.exists) throw missing(); return doc.data(); };
  return {
    kind: 'firestore', read,
    async list() { available(); return [...records.values()]; },
    async accept(event, change = null) {
      available();
      const receiptRef = receipts.doc(hash(event.message.id));
      const profileRef = profiles.doc(hash(event.source.userId));
      const result = await db.runTransaction(async (transaction) => {
        const receipt = await transaction.get(receiptRef);
        if (receipt.exists) return null;
        const profile = await transaction.get(profileRef);
        const selected = profileOf(change || (profile.exists ? profile.data().profileKey : 'ct'));
        const record = newRecord(event, selected, change);
        if (change) transaction.set(profileRef, { profileKey: selected });
        transaction.create(receiptRef, record);
        return record;
      });
      if (result) records.set(result.id, result);
      return result;
    },
    async claim(id) {
      available(); const ref = receipts.doc(id);
      const result = await db.runTransaction(async (transaction) => {
        const doc = await transaction.get(ref); const current = doc.exists ? doc.data() : null; const now = Date.now();
        if (!canClaim(current, now)) return null;
        const claimed = { ...current, leaseId: randomUUID(), leaseUntil: now + 120000 };
        transaction.set(ref, claimed); return claimed;
      });
      if (result) records.set(result.id, result);
      return result;
    },
    async complete(record, image, mimeType, analysis) {
      available();
      if (!image.length || image.length > MAX_IMAGE_BYTES) throw new Error('Image size is invalid');
      // Each document is <=512 KiB; batches stay well below Firestore's 10 MiB request limit.
      // Content-addressed generations make retries idempotent without mixing different image bytes.
      const generation = hash(image);
      const chunks = [];
      for (let start = 0; start < image.length; start += IMAGE_CHUNK_BYTES) chunks.push(image.subarray(start, start + IMAGE_CHUNK_BYTES));
      const images = receipts.doc(record.id).collection('imageChunks');
      for (let start = 0; start < chunks.length; start += 8) {
        const batch = db.batch();
        chunks.slice(start, start + 8).forEach((bytes, offset) => batch.set(images.doc(`${generation}_${String(start + offset).padStart(3, '0')}`), { bytes }));
        await batch.commit();
      }
      const ready = readyRecord(record, image, analysis, { mimeType, imageGeneration: generation, imageChunkCount: chunks.length });
      const committed = await db.runTransaction(async (transaction) => {
        const ref = receipts.doc(record.id); const doc = await transaction.get(ref);
        if (!doc.exists || !ownedLease(doc.data(), record)) return false;
        transaction.set(ref, ready); return true;
      });
      if (committed) records.set(ready.id, ready);
      return committed;
    },
    async fail(record) {
      available();
      const result = await db.runTransaction(async (transaction) => {
        const ref = receipts.doc(record.id); const doc = await transaction.get(ref);
        if (!doc.exists || !ownedLease(doc.data(), record)) return null;
        const failed = { ...record, leaseId: null, leaseUntil: 0, attempts: (record.attempts || 0) + 1,
          nextAttempt: Date.now() + 30000, lastError: 'Image retrieval failed' };
        transaction.set(ref, failed); return failed;
      });
      if (result) records.set(result.id, result);
    },
    async image(record) {
      available();
      if (!Number.isInteger(record.imageChunkCount) || record.imageChunkCount < 1 || record.imageChunkCount > 30 ||
        !/^[a-f0-9]{64}$/.test(record.imageGeneration || '')) throw new Error('Invalid receipt image metadata');
      const chunks = receipts.doc(record.id).collection('imageChunks');
      const refs = Array.from({ length: record.imageChunkCount }, (_, i) => chunks.doc(`${record.imageGeneration}_${String(i).padStart(3, '0')}`));
      const documents = await db.getAll(...refs);
      if (documents.some((doc) => !doc.exists)) throw new Error('Receipt image is incomplete');
      const buffer = Buffer.concat(documents.map((doc) => Buffer.from(doc.data().bytes)));
      if (buffer.length !== record.size || hash(buffer) !== record.sha256) throw new Error('Receipt integrity check failed');
      return buffer;
    },
    async close() { stopped = true; healthy = false; unsubscribe(); },
  };
}
