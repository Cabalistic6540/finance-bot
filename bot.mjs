import http from 'node:http';
import path from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { legacyAnalysis } from './legacy-analysis.mjs';
import { createFileStore, profileCommand } from './storage.mjs';

const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const ID = /^[a-f0-9]{64}$/;
export function verifySignature(rawBody, signature, secret) {
  if (!secret || typeof signature !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const actual = Buffer.from(signature, 'base64');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function authorize(token, expected) {
  if (typeof token !== 'string' || !expected) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(`Bearer ${expected}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function isOwnerImage(event, owners) {
  return event?.type === 'message' && event.message?.type === 'image' &&
    /^\d{1,40}$/.test(event.message.id) && event.source?.type === 'user' && owners.includes(event.source.userId);
}
export function loadConfig(env = process.env) {
  const config = {
    lineToken: env.LINE_CHANNEL_ACCESS_TOKEN || env.CHANNEL_ACCESS_TOKEN || '', lineSecret: env.LINE_CHANNEL_SECRET || '',
    owners: (env.LINE_ALLOWED_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
    syncToken: env.FINANCE_SYNC_TOKEN || '', dataDir: path.resolve(env.DATA_DIR || './data'),
    replyEnabled: env.LINE_REPLY_ENABLED === 'true', legacyEnabled: env.LEGACY_ANALYSIS_ENABLED === 'true',
    anthropicKey: env.ANTHROPIC_API_KEY || env.CLAUDE_API_KEY || '', anthropicModel: env.ANTHROPIC_MODEL || '',
    storageKind: env.FINANCE_STORAGE || 'file',
  };
  if (!config.lineToken || config.lineSecret.length < 16 || config.syncToken.length < 32 ||
      !config.owners.length || config.owners.some((id) => !/^U[a-f0-9]{32}$/.test(id))) throw new Error('Set LINE credentials, owner IDs, and a FINANCE_SYNC_TOKEN of at least 32 characters.');
  if (config.legacyEnabled && (!config.anthropicKey || !config.anthropicModel)) throw new Error('Legacy analysis requires its API key and model.');
  if (!['file', 'firestore'].includes(config.storageKind)) throw new Error('FINANCE_STORAGE must be file or firestore.');
  if (config.storageKind === 'firestore' && !env.FIREBASE_SERVICE_ACCOUNT) throw new Error('Firestore requires the existing FIREBASE_SERVICE_ACCOUNT.');
  if (env.RENDER === 'true' && config.storageKind !== 'firestore') throw new Error('Render must use FINANCE_STORAGE=firestore to preserve receipts.');
  return config;
}
export async function createFinanceBot(config, fetcher = fetch, providedStore = null) {
  if (config.storageKind === 'firestore' && !providedStore) throw new Error('Firestore store must be initialized before starting the bot.');
  const store = providedStore || await createFileStore(config.dataDir);
  const read = (id) => store.read(id);
  const list = () => store.list();
  let drainPromise = null;
  const reply = async (record, text) => {
    if (!config.replyEnabled || !record.replyToken) return;
    const response = await fetcher('https://api.line.me/v2/bot/message/reply', {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.lineToken}` },
      body: JSON.stringify({ replyToken: record.replyToken, messages: [{ type: 'text', text }] }),
    });
    if (!response.ok) throw new Error('Reply failed');
  };
  const processRecord = async (record) => {
    try {
      const response = await fetcher(`https://api-data.line.me/v2/bot/message/${record.messageId}/content`, {
        signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${config.lineToken}` },
      });
      if (!response.ok) throw new Error('Content unavailable');
      const mimeType = response.headers.get('content-type')?.split(';')[0];
      const ext = TYPES[mimeType];
      if (!ext) throw new Error('Unsupported image');
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 15 * 1024 * 1024) throw new Error('Image too large');
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      if (!buffer.length) throw new Error('Empty image');
      let analysis = null;
      // Optional original capability. Failure never prevents receipt synchronization.
      if (config.legacyEnabled) {
        try { analysis = await legacyAnalysis(buffer, mimeType, config, fetcher); }
        catch { analysis = null; }
      }
      if (!await store.complete(record, buffer, mimeType, analysis)) return;
      try {
        const suffix = analysis ? `\nหนี้: ${analysis.debtName}\nยอดหนี้: ${analysis.balance ?? 'ยังไม่ทราบ'}\nขั้นต่ำ: ${analysis.minPay ?? 'ยังไม่ทราบ'}` : '';
        await reply(record, `รับรูปสำหรับโปรไฟล์${record.profileKey === 'kwan' ? 'ขวัญ' : 'โตส'}แล้วครับ เปิดแอพเพื่อตรวจข้อมูลและยืนยันก่อนบันทึกการจ่าย${suffix}`);
      } catch { /* A failed chat reply does not replay or discard the financial receipt. */ }
    } catch {
      await store.fail(record);
    }
  };
  const drain = () => {
    if (drainPromise) return drainPromise;
    drainPromise = (async () => {
      for (const record of await list()) {
        if (record.status === 'pending' && (record.attempts || 0) < 20 && (!record.nextAttempt || record.nextAttempt <= Date.now())) {
          const claimed = await store.claim(record.id);
          if (claimed) await processRecord(claimed);
        }
      }
    })().finally(() => { drainPromise = null; });
    return drainPromise;
  };
  // Serialize insertions as LINE can deliver the same event concurrently.
  let inserts = Promise.resolve();
  const enqueue = (events) => {
    const task = inserts.then(async () => {
      for (const event of events) {
        const ownerText = event?.type === 'message' && event.message?.type === 'text' &&
          /^\d{1,40}$/.test(event.message.id) && event.source?.type === 'user' && config.owners.includes(event.source.userId);
        const change = ownerText ? profileCommand(event.message.text) : null;
        if (!isOwnerImage(event, config.owners) && !change) continue;
        // Profile changes and images are atomically deduplicated by the LINE message ID.
        const record = await store.accept(event, change);
        if (record && change) {
          try { await reply({ replyToken: event.replyToken }, `เลือกโปรไฟล์${change === 'kwan' ? 'ขวัญ' : 'โตส'}แล้วครับ รูปถัดไปจะเก็บไว้ในโปรไฟล์นี้ และยังรอยืนยันก่อนบันทึกการจ่าย`); }
          catch { /* The durable selection remains valid even when the reply expires. */ }
        }
      }
    });
    inserts = task.catch(() => {});
    return task;
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    try {
      const url = new URL(req.url, 'http://local');
      if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('Finance Bot running!'); return; }
      if (req.method === 'GET' && url.pathname === '/health') { await list(); json(200, { ok: true, syncApiVersion: 1, storage: store.kind }); return; }
      if (url.pathname.startsWith('/finance/')) {
        if (!authorize(req.headers.authorization, config.syncToken)) { json(401, { error: 'Unauthorized' }); return; }
        if (req.method !== 'GET') { json(405, { error: 'Method not allowed' }); return; }
        if (url.pathname === '/finance/receipts') {
          const after = url.searchParams.get('after') || '';
          const all = await list();
          const records = all.filter((r) => r.status === 'ready').sort((a, b) => `${a.receivedAt}|${a.id}`.localeCompare(`${b.receivedAt}|${b.id}`)).filter((r) => `${r.receivedAt}|${r.id}` > after);
          const selected = records.slice(0, 100);
          const items = selected.map((r) => ({ id: r.id, receivedAt: r.receivedAt, mimeType: r.mimeType, profileKey: r.profileKey || 'ct' }));
          const last = selected.at(-1);
          json(200, { apiVersion: 1, items, pendingCount: all.filter((r) => r.status === 'pending' && r.attempts < 20).length, failedCount: all.filter((r) => r.status === 'pending' && r.attempts >= 20).length, nextCursor: records.length > 100 && last ? `${last.receivedAt}|${last.id}` : null });
          return;
        }
        const match = url.pathname.match(/^\/finance\/receipts\/([a-f0-9]{64})\/image$/);
        if (match && ID.test(match[1])) {
          const record = await read(match[1]);
          const ext = TYPES[record.mimeType];
          if (record.status !== 'ready' || !ext) { json(404, { error: 'Not ready' }); return; }
          const image = await store.image(record);
          res.writeHead(200, { 'Content-Type': record.mimeType });
          res.end(image);
          return;
        }
        json(404, { error: 'Not found' }); return;
      }
      if (url.pathname !== '/webhook' || req.method !== 'POST') { json(404, { error: 'Not found' }); return; }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) { json(413, { error: 'Too large' }); return; }
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks);
      if (!verifySignature(raw, req.headers['x-line-signature'], config.lineSecret)) { json(401, { error: 'Invalid signature' }); return; }
      const data = JSON.parse(raw.toString('utf8'));
      if (!Array.isArray(data.events) || data.events.length > 100) { json(400, { error: 'Invalid events' }); return; }
      // Persist the queue before acknowledging, so transient processing failures can retry.
      await enqueue(data.events);
      json(200, { ok: true });
      drain().catch(() => {});
    } catch (error) { if (!res.headersSent) json(error instanceof SyntaxError ? 400 : error.code === 'ENOENT' ? 404 : 500, { error: 'Request could not be processed' }); else res.end(); }
  });
  return { server, drain, list, enqueue, close: () => store.close() };
}
