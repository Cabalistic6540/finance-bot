import { createFinanceBot, loadConfig } from './bot.mjs';
import { createFirestoreStore } from './storage.mjs';
import { createReminderStore, createReminderSender } from './reminders.mjs';

try {
  const config = loadConfig();
  let store = null;
  let reminders = null;
  if (config.storageKind === 'firestore') {
    const { initializeApp, cert } = await import('firebase-admin/app');
    const { getFirestore } = await import('firebase-admin/firestore');
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    const firebase = initializeApp({ credential: cert(serviceAccount) });
    const db = getFirestore(firebase);
    store = await createFirestoreStore(db);
    reminders = createReminderSender(config, createReminderStore(db));
  }
  const bot = await createFinanceBot(config, fetch, store, reminders);
  const port = Number(process.env.PORT || 3000);
  bot.server.listen(port, '0.0.0.0', () => console.log(`Finance Bot listening on port ${port}`));
  const timer = setInterval(() => bot.drain().catch(() => {}), 10000);
  bot.drain().catch(() => {});
  const stop = () => { clearInterval(timer); bot.server.close(async () => { await bot.close(); process.exit(0); }); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
} catch (error) {
  console.error('Finance Bot could not start. Check credentials, storage access, and required settings.');
  process.exitCode = 1;
}
