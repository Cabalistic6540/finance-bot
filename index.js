import { createFinanceBot, loadConfig } from './bot.mjs';
import { createFirestoreStore } from './storage.mjs';

try {
  const config = loadConfig();
  let store = null;
  if (config.storageKind === 'firestore') {
    const { initializeApp, cert } = await import('firebase-admin/app');
    const { getFirestore } = await import('firebase-admin/firestore');
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    const firebase = initializeApp({ credential: cert(serviceAccount) });
    store = await createFirestoreStore(getFirestore(firebase));
  }
  const bot = await createFinanceBot(config, fetch, store);
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
