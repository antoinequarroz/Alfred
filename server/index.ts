import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app.js';
import { CaldavSync } from './caldav.js';
import { caldavConfigured, config } from './config.js';
import { openDb } from './db.js';
import { hashPassword } from './password.js';
import { CalendarService } from './service.js';
import { Store } from './store.js';

let passwordHash = config.passwordHash;
if (!passwordHash) {
  if (config.production) {
    console.error('ALFRED_PASSWORD_HASH manquant. Génère-le avec : npm run hash-password');
    process.exit(1);
  }
  passwordHash = await hashPassword('alfred');
  console.warn('[alfred] mode dev : mot de passe « alfred »');
}

const store = new Store(openDb(config.dataDir));
const caldav = caldavConfigured
  ? new CaldavSync(store, { serverUrl: config.caldav.url, username: config.caldav.username, password: config.caldav.password })
  : null;
if (!caldav) store.ensureLocalCalendar();

const service = new CalendarService(store, caldav, config.timezone);
const app = createApp({
  store, service, caldav, passwordHash,
  secureCookies: config.production,
  sessionDays: config.sessionDays,
});

// App web compilée (dist/web), avec repli sur index.html pour le routage côté client.
const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
if (existsSync(join(webRoot, 'index.html'))) {
  const indexHtml = readFileSync(join(webRoot, 'index.html'), 'utf8');
  app.use('/assets/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
  });
  app.use('/*', serveStatic({ root: webRoot }));
  app.get('*', (c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'Introuvable' }, 404) : c.html(indexHtml)));
}

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`[alfred] prêt sur http://${info.address}:${info.port} (fuseau ${config.timezone})`);
});

if (caldav) {
  const run = () => void caldav.sync();
  run();
  setInterval(run, config.caldav.syncIntervalSeconds * 1000).unref();
  console.log(`[alfred] synchro CalDAV toutes les ${config.caldav.syncIntervalSeconds} s avec ${config.caldav.url}`);
} else {
  console.log('[alfred] pas de CalDAV configuré : calendrier local uniquement');
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    store.db.close();
    process.exit(0);
  });
}
