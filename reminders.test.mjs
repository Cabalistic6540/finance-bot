import test from 'node:test';
import assert from 'node:assert/strict';
import { createReminderStore, createReminderSender, reminderClock, reminderMessage } from './reminders.mjs';

function memoryDb() {
  const documents = new Map(); let tail = Promise.resolve();
  return {
    collection: (collection) => ({ doc: (id) => `${collection}/${id}` }),
    runTransaction: (fn) => {
      const task = tail.then(() => fn({
        get: async (ref) => ({ exists: documents.has(ref), data: () => documents.get(ref) }),
        set: (ref, data) => documents.set(ref, structuredClone(data)),
      }));
      tail = task.catch(() => {}); return task;
    },
  };
}
const config = { owners: ['U' + '1'.repeat(32)], lineToken: 'fixture-token' };
const input = { date: '2026-10-28', creditorIds: ['first-choice-visa'] };
test('reminder clock, validation, dry run and time boundary do not send', async () => {
  assert.deepEqual(reminderClock(new Date('2026-10-28T13:00:00Z')), { date: '2026-10-28', hour: 20 });
  assert.deepEqual(reminderClock(new Date('2026-10-28T17:00:00Z')), { date: '2026-10-29', hour: 0 });
  assert.throws(() => reminderMessage(['unknown']), /Invalid/);
  assert.throws(() => reminderMessage(['umay', 'umay']), /Invalid/);
  let calls = 0;
  const sender = createReminderSender(config, createReminderStore(memoryDb()), async () => { calls++; }, () => new Date('2026-10-28T12:59:59Z'));
  assert.equal((await sender(input)).reason, 'before-20:00');
  const preview = await sender({ ...input, dryRun: true });
  assert.equal(preview.dryRun, true); assert.match(preview.text, /อย่าลืมส่งสลิป/);
  await assert.rejects(sender({ ...input, date: '2026-10-27' }), /today/);
  assert.equal(calls, 0);
});
test('one owner-only push per day survives concurrent triggers and restarts', async () => {
  const db = memoryDb(); let calls = 0;
  const fetcher = async (url, options) => {
    calls++; assert.equal(url, 'https://api.line.me/v2/bot/message/push');
    const body = JSON.parse(options.body);
    assert.equal(body.to, config.owners[0]); assert.equal(body.notificationDisabled, false);
    assert.match(options.headers['X-Line-Retry-Key'], /^[a-f0-9-]{36}$/);
    return new Response('{}', { status: 200 });
  };
  const clock = () => new Date('2026-10-28T13:00:00Z');
  const sender = createReminderSender(config, createReminderStore(db), fetcher, clock);
  const results = await Promise.all([sender(input), sender({ ...input, to: 'other-user' })]);
  assert.equal(results.filter((r) => r.sent).length, 1); assert.equal(calls, 1);
  const restarted = createReminderSender(config, createReminderStore(db), fetcher, clock);
  assert.equal((await restarted(input)).reason, 'already-handled'); assert.equal(calls, 1);
});
test('timeout retry keeps the same payload and retry key; accepted 409 stops retries', async () => {
  const db = memoryDb(); let now = new Date('2026-10-28T13:00:00Z'); const requests = [];
  const sender = createReminderSender(config, createReminderStore(db), async (_, options) => {
    requests.push(options);
    if (requests.length === 1) throw new Error('network timeout');
    return new Response('{}', { status: 409, headers: { 'x-line-accepted-request-id': 'fixture-request-id' } });
  }, () => now);
  await assert.rejects(sender(input), /temporarily unavailable/);
  assert.equal((await sender(input)).reason, 'already-handled');
  now = new Date('2026-10-28T13:00:31Z');
  assert.equal((await sender({ ...input, creditorIds: ['umay'] })).accepted, true);
  assert.equal(requests[0].body, requests[1].body);
  assert.equal(requests[0].headers['X-Line-Retry-Key'], requests[1].headers['X-Line-Retry-Key']);
  assert.equal((await sender(input)).reason, 'already-handled');
});
test('4xx is held for review rather than repeatedly pushing', async () => {
  const db = memoryDb(); let calls = 0;
  const sender = createReminderSender(config, createReminderStore(db), async () => { calls++; return new Response('{}', { status: 403 }); }, () => new Date('2026-10-28T13:00:00Z'));
  await assert.rejects(sender(input), /did not accept/);
  assert.equal((await sender(input)).reason, 'already-handled'); assert.equal(calls, 1);
});
