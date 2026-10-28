import { createHash, randomUUID } from 'node:crypto';
import { salaryPeriodForDate } from './payday-calendar.mjs';

export const REMINDER_COLLECTION = 'financeReminderDeliveries_v1';
const names = {
  'car-refinance': 'ค่ารีไฟแนนซ์รถ',
  'first-choice-visa': 'First Choice Visa', 'first-choice-mastercard': 'บัตรเครดิต Platinum Mastercard',
  promise: 'Promise', umay: 'UMAY+', 'line-bk': 'LINE BK', shopee: 'Shopee Pay', tiktok: 'TikTok PayLater',
  'student-loan': 'กยศ.', wangjai: 'สินเชื่อวางใจ', insurance: 'ค่าประกัน',
};
export function reminderClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const part = (type) => parts.find((p) => p.type === type).value;
  return { date: `${part('year')}-${part('month')}-${part('day')}`, hour: Number(part('hour')) };
}
export function reminderMessage(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > Object.keys(names).length || ids.some((id) => !Object.hasOwn(names, id)) || new Set(ids).size !== ids.length) throw new Error('Invalid reminder creditors');
  return `วันนี้เงินเดือนออกครับ\nรายการในรอบเงินเดือนนี้: ${ids.map((id) => names[id]).join(', ')}\nอย่าลืมส่งสลิปหลังชำระเงินนะครับ\nถ้าส่งสลิปให้บอทแล้ว ข้ามข้อความนี้ได้เลยครับ`;
}
export function createReminderStore(db) {
  const collection = db.collection(REMINDER_COLLECTION);
  return {
    async claim(key, text, date, now) {
      const ref = collection.doc(key);
      return db.runTransaction(async (tx) => {
        const doc = await tx.get(ref); const old = doc.exists ? doc.data() : {};
        if (['accepted', 'blocked'].includes(old.status) || old.leaseUntil > now || old.nextAttempt > now) return null;
        const record = { date, text: old.text || text, retryKey: old.retryKey || randomUUID(), leaseId: randomUUID(),
          status: 'sending', leaseUntil: now + 120000, attempts: (old.attempts || 0) + 1 };
        tx.set(ref, record); return record;
      });
    },
    async finish(key, leaseId, status, now) {
      const ref = collection.doc(key);
      await db.runTransaction(async (tx) => {
        const doc = await tx.get(ref); if (!doc.exists || doc.data().leaseId !== leaseId) return;
        tx.set(ref, { ...doc.data(), status, leaseUntil: 0, nextAttempt: status === 'retry' ? now + 30000 : 0, updatedAt: now });
      });
    },
  };
}
export function createReminderSender(config, store, fetcher = fetch, clock = () => new Date()) {
  return async (input) => {
    const now = clock(); const current = reminderClock(now);
    const text = reminderMessage(input.creditorIds);
    if (input.date !== current.date) throw new Error('Reminder date must be today in Bangkok');
    const isSalaryDay = !!salaryPeriodForDate(current.date);
    if (input.dryRun === true) return { ok: true, dryRun: true, eligible: isSalaryDay && current.hour >= 20, date: current.date, text };
    if (!isSalaryDay) return { ok: true, sent: false, reason: 'not-salary-day', date: current.date };
    if (current.hour < 20) return { ok: true, sent: false, reason: 'before-20:00', date: current.date };
    const recipient = config.owners[0];
    const key = createHash('sha256').update(`${recipient}|${current.date}`).digest('hex');
    const record = await store.claim(key, text, current.date, now.getTime());
    if (!record) return { ok: true, sent: false, reason: 'already-handled', date: current.date };
    let response;
    try {
      response = await fetcher('https://api.line.me/v2/bot/message/push', {
        method: 'POST', signal: AbortSignal.timeout(20000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.lineToken}`, 'X-Line-Retry-Key': record.retryKey },
        body: JSON.stringify({ to: recipient, messages: [{ type: 'text', text: record.text }], notificationDisabled: false }),
      });
    } catch {
      await store.finish(key, record.leaseId, 'retry', now.getTime());
      throw new Error('LINE reminder temporarily unavailable');
    }
    const accepted = response.ok || (response.status === 409 && !!response.headers.get('x-line-accepted-request-id'));
    await store.finish(key, record.leaseId, accepted ? 'accepted' : response.status >= 500 ? 'retry' : 'blocked', now.getTime());
    if (!accepted) throw new Error('LINE did not accept reminder');
    return { ok: true, sent: true, accepted: true, date: current.date };
  };
}
