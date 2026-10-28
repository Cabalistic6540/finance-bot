import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createHmac, createHash } from 'node:crypto';
import { createFinanceBot, loadConfig, verifySignature, isOwnerImage } from './bot.mjs';

test('configuration and raw signatures', () => {
  assert.throws(() => loadConfig({}), /Set LINE credentials/);
  const existingRenderConfig = loadConfig({
    CHANNEL_ACCESS_TOKEN: 'fixture-existing-line-token', CLAUDE_API_KEY: 'fixture-existing-claude-key',
    LINE_CHANNEL_SECRET: 'fixture-channel-secret', LINE_ALLOWED_USER_IDS: `U${'a'.repeat(32)}`,
    FINANCE_SYNC_TOKEN: 'fixture-sync-token-012345678901234567890',
    LEGACY_ANALYSIS_ENABLED: 'true', ANTHROPIC_MODEL: 'fixture-model',
  });
  assert.equal(existingRenderConfig.lineToken, 'fixture-existing-line-token');
  assert.equal(existingRenderConfig.anthropicKey, 'fixture-existing-claude-key');
  assert.equal(existingRenderConfig.legacyEnabled, true);
  assert.equal(loadConfig({
    CHANNEL_ACCESS_TOKEN: 'fixture-existing-line-token', LINE_CHANNEL_ACCESS_TOKEN: 'fixture-new-line-token',
    LINE_CHANNEL_SECRET: 'fixture-channel-secret', LINE_ALLOWED_USER_IDS: `U${'a'.repeat(32)}`,
    FINANCE_SYNC_TOKEN: 'fixture-sync-token-012345678901234567890',
    FIREBASE_SERVICE_ACCOUNT: 'deliberately-not-parsed',
  }).lineToken, 'fixture-new-line-token', 'New names take precedence and existing Firebase config is not activated');
  const raw = Buffer.from('{"ข้อความ":"ชำระแล้ว","events":[]}');
  const signature = createHmac('sha256', 'fixture_secret_123456').update(raw).digest('base64');
  assert.equal(verifySignature(raw, signature, 'fixture_secret_123456'), true);
  assert.equal(verifySignature(Buffer.concat([raw, Buffer.from(' ')]), signature, 'fixture_secret_123456'), false);
  assert.equal(isOwnerImage({ type: 'message', message: { type: 'image', id: '../bad' }, source: { type: 'user', userId: 'owner' } }, ['owner']), false);
});

test('signed receipt round trip, access restrictions, durability and deduplication', async () => {
  const tempParent = fileURLToPath(new URL('./test/.tmp/', import.meta.url));
  await fs.mkdir(tempParent, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(tempParent, 'receipt-'));
  assert.ok(path.resolve(dataDir).startsWith(path.resolve(tempParent) + path.sep));
  const owner = `U${'a'.repeat(32)}`;
  const config = { lineToken: 'fixture-token', lineSecret: 'fixture-secret-only', owners: [owner], syncToken: 'fixture-sync-token-012345678901234567890', dataDir, replyEnabled: false, legacyEnabled: false };
  const image = Buffer.from('fixture image payload');
  let lineRequests = 0;
  const bot = await createFinanceBot(config, async (url) => {
    assert.match(url, /^https:\/\/api-data\.line\.me\/v2\/bot\/message\/\d+\/content$/);
    lineRequests++;
    return new Response(image, { headers: { 'Content-Type': 'image/png' } });
  });
  bot.server.listen(0, '127.0.0.1');
  await once(bot.server, 'listening');
  const base = `http://127.0.0.1:${bot.server.address().port}`;
  const auth = { Authorization: `Bearer ${config.syncToken}` };
  const send = async (events, valid = true) => {
    const body = JSON.stringify({ events });
    return fetch(`${base}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-line-signature': valid ? createHmac('sha256', config.lineSecret).update(body).digest('base64') : 'invalid' }, body });
  };
  try {
    assert.equal((await fetch(`${base}/finance/receipts`)).status, 401);
    assert.equal((await fetch(`${base}/finance/receipts`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await send([])).status, 200, 'LINE verification event succeeds');
    const event = { webhookEventId: 'first', type: 'message', message: { type: 'image', id: '1234567' }, source: { type: 'user', userId: owner } };
    assert.equal((await send([event], false)).status, 401);
    assert.equal((await bot.list()).length, 0);
    await send([{ ...event, source: { type: 'user', userId: 'unapproved' } }]);
    await send([{ ...event, source: { type: 'group', userId: owner, groupId: 'group' } }]);
    assert.equal((await bot.list()).length, 0, 'Only the owner personal chat is accepted');
    assert.equal((await send([event])).status, 200);
    await bot.drain();
    const manifest = await (await fetch(`${base}/finance/receipts`, { headers: auth })).json();
    assert.equal(manifest.apiVersion, 1);
    assert.equal(manifest.items.length, 1);
    assert.equal(manifest.items[0].mimeType, 'image/png');
    assert.equal(manifest.items[0].profileKey, 'ct');
    const id = createHash('sha256').update(event.message.id).digest('hex');
    assert.equal(manifest.items[0].id, id);
    const content = await fetch(`${base}/finance/receipts/${id}/image`, { headers: auth });
    assert.equal(content.status, 200);
    assert.deepEqual(Buffer.from(await content.arrayBuffer()), image);
    await send([{ ...event, webhookEventId: 'redelivery-new-event-id' }]);
    await bot.drain();
    assert.equal((await bot.list()).length, 1);
    assert.equal(lineRequests, 1, 'Redelivery does not refetch or create another receipt');
    const restarted = await createFinanceBot(config, async () => { throw new Error('Already stored'); });
    assert.equal((await restarted.list()).length, 1, 'Saved records survive a new process using the same disk');
    const empty = await (await fetch(`${base}/finance/receipts?after=${encodeURIComponent(`${manifest.items[0].receivedAt}|${id}`)}`, { headers: auth })).json();
    assert.equal(empty.items.length, 0);
    assert.equal((await fetch(`${base}/finance/receipts/${id}/image`)).status, 401);
    assert.equal((await fetch(`${base}/data/events/${id}.json`)).status, 404);
    assert.equal((await fetch(`${base}/finance/receipts`, { method: 'POST', headers: auth })).status, 405);
    const command = (id, text) => ({ ...event, message: { type: 'text', id, text } });
    await send([command('2001', 'โปรไฟล์ขวัญ'), { ...event, message: { type: 'image', id: '2002' } }]);
    await bot.drain();
    const kwanReceipt = (await bot.list()).find((record) => record.messageId === '2002');
    assert.equal(kwanReceipt.profileKey, 'kwan'); assert.equal(kwanReceipt.status, 'ready');
    await send([command('2003', 'โปรไฟล์โตส'), command('2001', 'โปรไฟล์ขวัญ')]);
    await restarted.enqueue([{ ...event, message: { type: 'image', id: '2004' } }]);
    assert.equal((await restarted.list()).find((record) => record.messageId === '2004').profileKey, 'ct', 'A restarted bot retains the actual selected profile; old command redelivery cannot change it');
  } finally {
    bot.server.closeAllConnections();
    await new Promise((resolve) => bot.server.close(resolve));
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(tempParent) + path.sep));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
