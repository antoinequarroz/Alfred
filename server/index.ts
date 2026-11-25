import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app.js';
import { BookingService } from './booking/service.js';
import { CaldavSync } from './caldav.js';
import { settings as compteSettings } from './compte.js';
import { allowPrivateHosts, config, connectionEnv, secretKeyEnv, videoEnv } from './config.js';
import { ConnectionsService } from './connections.js';
import { openDb } from './db.js';
import { PaymentsService } from './payments/service.js';
import { PeopleService } from './people.js';
import { SecretBox } from './secrets.js';
import { hashPassword } from './password.js';
import { CalendarService } from './service.js';
import { Store } from './store.js';
import { PushService } from './push/service.js';
import { VideoService } from './video/service.js';

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
const secrets = new SecretBox({ dataDir: config.dataDir, envKey: secretKeyEnv });
// Le client de synchro existe toujours : sans identifiants il reste inactif, et il peut en recevoir à chaud.
const caldav = new CaldavSync(store, null);
const connections = new ConnectionsService({
  store, secrets, caldav, env: connectionEnv, allowPrivateHosts, smtpRequireTls: config.mail.requireTls,
});
caldav.reconfigure(connections.caldavOptions());
const connectionsState = connections.state();
// Calendrier local seulement quand aucun compte n'est en place (un mot de passe à ressaisir ne crée pas de calendrier local).
if (!caldav.configured && !connectionsState.caldav.accountLocked) store.ensureLocalCalendar();

const service = new CalendarService(store, caldav, config.timezone);
const mailer = connections.mailer;
// La visio et la prise de rendez-vous se connaissent : une salle de rendez-vous suit sa réservation,
// et une réservation « En visio » reçoit le lien d'une salle.
let bookingRef: BookingService | null = null;
const video = new VideoService({
  db: store.db, server: videoEnv, publicUrl: config.publicUrl, timezone: config.timezone,
  hostName: () => bookingRef?.getSettings().publicName ?? config.mail.from.name,
  bookingLink: (id) => bookingRef?.videoLink(id) ?? null,
});
const payments = new PaymentsService({ db: store.db, secrets, pendingCount: () => bookingRef?.pendingPayments() ?? 0 });
const booking = new BookingService({
  video, payments,
  store, calendar: service, caldav, timezone: config.timezone, mailer, mailProblem: () => connections.smtpProblem(),
  publicUrl: config.publicUrl, defaultPublicName: config.mail.from.name,
});
bookingRef = booking;
// Notifications sur les appareils d'Antoine (iPhone, Mac) : nouveaux rendez-vous, rappels, invités en visio.
const push = new PushService({
  db: store.db, store, publicUrl: config.publicUrl, timezone: config.timezone,
  bookingVideoUrl: (id) => video.urlForBooking(id),
});
connections.mailContext = () => ({ publicName: booking.getSettings().publicName, timezone: config.timezone, publicUrl: config.publicUrl });
const people = new PeopleService({ db: store.db, store, booking, cairnUrl: config.cairnUrl });
// Compte Postmelo : actif seulement avec COMPTE_URL et COMPTE_CLIENT_SECRET. L'adresse de retour est celle d'Alfred.
const compte = compteSettings({ ...process.env, APP_URL: process.env.APP_URL?.trim() || config.publicUrl });
const app = createApp({
  store, service, caldav, passwordHash, booking, connections, video, push, people, compte, payments,
  secureCookies: config.production,
  sessionDays: config.sessionDays,
  embedOrigins: config.embedOrigins,
});

// App web compilée (dist/web), avec repli sur index.html pour le routage côté client.
const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
if (existsSync(join(webRoot, 'index.html'))) {
  const indexHtml = readFileSync(join(webRoot, 'index.html'), 'utf8');
  app.use('/assets/*', async (c, next) => {
    await next();
    if (c.res.status === 200) c.header('Cache-Control', 'public, max-age=31536000, immutable');
  });
  // La page, le service worker et le manifeste sont toujours revalidés : une mise à jour est visible tout de suite.
  app.use('/*', async (c, next) => {
    await next();
    if (!c.req.path.startsWith('/assets/') && !c.req.path.startsWith('/api/')) c.header('Cache-Control', 'no-cache');
  });
  app.use('/*', serveStatic({ root: webRoot }));
  app.get('/assets/*', (c) => c.notFound());
  app.get('*', (c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'Introuvable' }, 404) : c.html(indexHtml)));
}

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`[alfred] prêt sur http://${info.address}:${info.port} (fuseau ${config.timezone})`);
});

// La synchro régulière tourne toujours : elle ne fait rien tant qu'aucun identifiant n'est en place.
void caldav.sync();
push.start();
setInterval(() => void caldav.sync(), config.caldav.syncIntervalSeconds * 1000).unref();
// Rappels aux clients avant leurs rendez-vous : un passage par minute (rien ne part sans SMTP ni rappel réglé).
setTimeout(() => void booking.sendDueReminders(), 30_000).unref();
setInterval(() => void booking.sendDueReminders(), 60_000).unref();
// Paiements d'acompte en cours : vérifiés auprès de Stripe toutes les 30 s (le client a pu
// payer puis fermer la page sans revenir sur Alfred). Rien n'est appelé s'il n'y en a aucun.
void booking.sweepPayments();
setInterval(() => void booking.sweepPayments(), 30_000).unref();
// Visio : qui est encore dans les salles, qui est parti (historique des Personnes, ALFRED-300).
setInterval(() => void video.sweepParticipations().catch((err) => console.error('[alfred] visio : passage des participations :', err)), 60_000).unref();
const SOURCES = { app: 'réglés dans l’app', env: 'du fichier .env', default: 'par défaut', none: 'absents' } as const;
console.log(caldav.configured
  ? `[alfred] synchro CalDAV toutes les ${config.caldav.syncIntervalSeconds} s avec ${connectionsState.caldav.url.value} (identifiants ${SOURCES[connectionsState.caldav.password.source]})`
  : '[alfred] pas de CalDAV configuré : calendrier local uniquement');
console.log(mailer.configured
  ? `[alfred] e-mails de la prise de RDV via ${connectionsState.smtp.host.value}:${connectionsState.smtp.port.value}, expéditeur ${mailer.from} (identifiants ${SOURCES[connectionsState.smtp.password.source]})`
  : '[alfred] envoi d’e-mails non configuré : la prise de RDV fonctionne sans envoyer d’e-mails (réglable dans l’app)');
console.log(video.configured
  ? `[alfred] visio : serveur ${videoEnv.internalUrl}, adresse publique ${videoEnv.publicUrl}`
  : '[alfred] visio non configurée (LIVEKIT_API_KEY / LIVEKIT_API_SECRET absents)');
console.log(payments.configured
  ? `[alfred] paiement en ligne : Stripe (${payments.state().mode === 'live' ? 'mode réel' : 'mode test'}), ${payments.paymentMethods.join(' + ')}`
  : '[alfred] paiement en ligne non configuré (réglable dans l’app : Rendez-vous > Réglages)');
if (compte) console.log(`[alfred] connexion par le Compte Postmelo active (${compte.issuer}, retour ${compte.redirectUri})`);
else if (process.env.COMPTE_URL?.trim()) console.warn('[alfred] COMPTE_URL est réglé mais la connexion par le Compte Postmelo reste inactive : COMPTE_CLIENT_SECRET manque ou fait moins de 32 caractères');
for (const notice of connectionsState.notices) console.warn(`[alfred] ${notice}`);
// Un réglage de l'app passe avant le .env : le dire, pour qui modifie le .env et ne voit aucun effet.
if (connectionEnv.caldav.password && connectionsState.caldav.password.source === 'app') {
  console.warn('[alfred] les identifiants de calendrier du fichier .env sont ignorés : ceux enregistrés dans l’app (Réglages) passent avant');
}
if (connectionEnv.smtp.password && connectionsState.smtp.password.source === 'app') {
  console.warn('[alfred] le mot de passe SMTP du fichier .env est ignoré : celui enregistré dans l’app (Rendez-vous > Réglages) passe avant');
}
if (allowPrivateHosts) console.warn('[alfred] ALFRED_ALLOW_PRIVATE_HOSTS=1 : les serveurs internes sont acceptés dans les réglages (développement seulement)');

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    store.db.close();
    process.exit(0);
  });
}
