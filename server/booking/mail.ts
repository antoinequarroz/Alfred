import { isIP } from 'node:net';
import ICAL from 'ical.js';
import type { Transporter } from 'nodemailer';
import { DiagnosedError, describeSmtpError, logLine } from '../diagnostics.js';
import { resolveGuarded } from '../netguard.js';
import { timeInZone, vtimezoneComponent } from '../timezone.js';

// ---------------------------------------------------------------------------
// Envoi

export interface MailAddress {
  name: string;
  address: string;
}

export interface MailAttachment {
  filename: string;
  content: string;
  contentType: string;
}

export interface MailMessage {
  to: MailAddress | string;
  subject: string;
  text: string;
  html: string;
  replyTo?: MailAddress | string;
  attachments?: MailAttachment[];
}

export interface Mailer {
  /** Faux : aucun envoi possible (SMTP non configuré). */
  readonly configured: boolean;
  /** Expéditeur, en clair (pour l'admin). */
  readonly from: string;
  /** Adresse qui reçoit les avis de nouveau rendez-vous et d'annulation. */
  readonly notifyTo: string;
  send(message: MailMessage): Promise<void>;
}

export interface SmtpOptions {
  host: string;
  port: number;
  /** TLS implicite (port 465). */
  secure: boolean;
  /** STARTTLS obligatoire quand secure est faux. */
  requireTls: boolean;
  /** Durée totale maximale d'un envoi, en ms (45 s par défaut). */
  totalTimeoutMs?: number;
  user: string;
  password: string;
  from: MailAddress;
  notifyTo: string;
  /**
   * Hôte saisi dans l'app : il est résolu et vérifié à chaque envoi (pas d'adresse interne,
   * sauf allowInternal), et la connexion se fait vers l'adresse vérifiée. Absent pour un hôte
   * venu du fichier .env, qui est de confiance.
   */
  guard?: { allowInternal: boolean };
}

/** Retire tout caractère de contrôle : rien de saisi ne doit pouvoir couper un en-tête. */
export function headerSafe(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
}

function safeAddress(a: MailAddress | string): MailAddress | string {
  if (typeof a === 'string') return headerSafe(a);
  return { name: headerSafe(a.name), address: headerSafe(a.address) };
}

function formatAddress(a: MailAddress): string {
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

/**
 * Expéditeur SMTP (nodemailer). La connexion n'est ouverte qu'au premier envoi.
 * Un échec est levé sous forme de diagnostic en français (DiagnosedError) : le texte de
 * nodemailer, qui peut reprendre la réponse du serveur ou un identifiant, ne sort pas d'ici.
 */
export function createSmtpMailer(opts: SmtpOptions): Mailer {
  let transport: Transporter | null = null;
  const from = safeAddress(opts.from) as MailAddress;
  const connect = async (): Promise<Transporter> => {
    // Chargé au premier envoi seulement : sans SMTP configuré, nodemailer ne pèse rien en mémoire.
    const { default: nodemailer } = await import('nodemailer');
    const create = (host: string, servername?: string) => nodemailer.createTransport({
      host,
      port: opts.port,
      secure: opts.secure,
      requireTLS: !opts.secure && opts.requireTls,
      auth: opts.user ? { user: opts.user, pass: opts.password } : undefined,
      // Connexion vers une adresse vérifiée : le certificat reste contrôlé pour le nom saisi.
      tls: servername ? { servername } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    if (!opts.guard) return (transport ??= create(opts.host));
    const address = await resolveGuarded(opts.host, opts.guard.allowInternal);
    return create(address, isIP(opts.host.replace(/^\[(.*)\]$/, '$1')) ? undefined : opts.host);
  };
  return {
    configured: true,
    from: formatAddress(from),
    notifyTo: headerSafe(opts.notifyTo),
    async send(message) {
      let sending: Promise<unknown> | undefined;
      let timer: NodeJS.Timeout | undefined;
      try {
        const smtp = await connect();
        sending = smtp.sendMail({
          from,
          to: safeAddress(message.to),
          replyTo: message.replyTo ? safeAddress(message.replyTo) : undefined,
          subject: headerSafe(message.subject),
          text: message.text,
          html: message.html,
          attachments: message.attachments?.map((a) => ({ filename: headerSafe(a.filename), content: a.content, contentType: a.contentType })),
        });
        // Les délais de nodemailer sont des délais d'inactivité : un serveur qui répond au
        // compte-gouttes pourrait retenir l'envoi indéfiniment. On borne donc la durée totale.
        await Promise.race([
          sending,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new DiagnosedError({ code: 'timeout', message: 'Délai dépassé : le serveur d’envoi ne répond pas à temps.' })),
              opts.totalTimeoutMs ?? 45_000,
            );
          }),
        ]);
      } catch (err) {
        // Envoi abandonné : son éventuel échec tardif ne doit pas rester sans gestionnaire.
        sending?.catch(() => undefined);
        const diagnostic = describeSmtpError(err);
        console.error(`[alfred] envoi SMTP en échec : ${logLine(diagnostic, err)}`);
        throw new DiagnosedError(diagnostic);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Sans SMTP : tout fonctionne sauf l'envoi. */
export function createDisabledMailer(from = '', notifyTo = ''): Mailer {
  return {
    configured: false,
    from,
    notifyTo,
    async send() {
      throw new Error('Envoi d’e-mails non configuré');
    },
  };
}

/** Expéditeur dont la configuration peut changer à chaud : chaque appel passe par l'expéditeur du moment. */
export function createDynamicMailer(current: () => Mailer): Mailer {
  return {
    get configured() { return current().configured; },
    get from() { return current().from; },
    get notifyTo() { return current().notifyTo; },
    send: (message) => current().send(message),
  };
}

// ---------------------------------------------------------------------------
// Contenu

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

/** « mardi 17 novembre 2026, de 09:00 à 09:30 » dans le fuseau donné. */
export function formatWhen(startIso: string, endIso: string, timezone: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  // Assemblé à la main : la ponctuation d'Intl varie selon les versions d'ICU.
  const parts: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('fr-CH', { timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).formatToParts(start)) {
    parts[part.type] = part.value;
  }
  const day = `${parts.weekday} ${parts.day === '1' ? '1er' : parts.day} ${parts.month} ${parts.year}`;
  const time = new Intl.DateTimeFormat('fr-CH', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return `${day}, de ${time.format(start)} à ${time.format(end)}`;
}

export interface BookingMailData {
  id: string;
  typeName: string;
  /** Lieu ou mode en clair. */
  location: string;
  start: string;
  end: string;
  name: string;
  email: string;
  phone: string;
  message: string;
  /** Lien de la visio Alfred, pour un rendez-vous « En visio ». */
  videoUrl?: string | null;
  /** Version de l'événement joint (SEQUENCE) : augmente à chaque déplacement, pour que l'agenda du client le mette à jour. */
  sequence?: number;
  /** Acompte payé en ligne, en clair (« CHF 50.00 »). */
  deposit?: string;
  /** Ce qu'il est devenu : encaissé, remboursé, remboursement en échec. */
  depositStatus?: 'paid' | 'refunded' | 'refund_failed';
}

export interface MailContext {
  /** Nom public d'Antoine (signature, titre de l'événement du client). */
  publicName: string;
  timezone: string;
  /** Adresse publique d'Alfred, sans barre finale. */
  publicUrl: string;
  /** Vrai : le client peut déplacer lui-même son rendez-vous (le lien des e-mails le propose). */
  allowReschedule?: boolean;
}

/**
 * Domaine des UID iCalendar des rendez-vous. Il ne doit JAMAIS changer, même si l'adresse d'Alfred
 * change (passage à alfred.postmelo.ch en novembre 2026) : le calendrier du client reconnaît un
 * rendez-vous à son UID, et un nouvel UID ferait un doublon au lieu d'une mise à jour.
 */
export const BOOKING_UID_DOMAIN = 'alfred.antoinequarroz.ch';

export function bookingIcsUid(bookingId: string): string {
  return `rdv-${bookingId}@${BOOKING_UID_DOMAIN}`;
}

/**
 * Pièce jointe iCalendar pour le client : simple publication (METHOD:PUBLISH),
 * pas une invitation. Ni organisateur ni participant, donc aucune réponse attendue.
 */
export function buildBookingIcs(b: BookingMailData, ctx: MailContext): string {
  const vcal = new ICAL.Component(['vcalendar', [], []]);
  vcal.updatePropertyWithValue('prodid', '-//Alfred//Rendez-vous//FR');
  vcal.updatePropertyWithValue('version', '2.0');
  vcal.updatePropertyWithValue('calscale', 'GREGORIAN');
  vcal.updatePropertyWithValue('method', 'PUBLISH');
  const tz = vtimezoneComponent(ctx.timezone);
  if (tz) vcal.addSubcomponent(tz);
  const vevent = new ICAL.Component('vevent');
  vevent.updatePropertyWithValue('uid', bookingIcsUid(b.id));
  vevent.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true));
  const setTime = (name: string, iso: string) => {
    const time = timeInZone(new Date(iso), ctx.timezone);
    const prop = new ICAL.Property(name, vevent);
    prop.setValue(time);
    const tzid = time.zone?.tzid;
    if (tzid && tzid !== 'UTC' && tzid !== 'floating') prop.setParameter('tzid', tzid);
    vevent.addProperty(prop);
  };
  setTime('dtstart', b.start);
  setTime('dtend', b.end);
  vevent.updatePropertyWithValue('summary', ctx.publicName ? `${b.typeName} – ${ctx.publicName}` : b.typeName);
  // Visio : le lien sert de lieu (cliquable dans Apple Calendar et Google Agenda) et d'URL de l'événement.
  if (b.videoUrl) {
    vevent.updatePropertyWithValue('location', b.videoUrl);
    vevent.updatePropertyWithValue('url', b.videoUrl);
    vevent.updatePropertyWithValue('description', `Rejoindre la visio : ${b.videoUrl}`);
  } else if (b.location) vevent.updatePropertyWithValue('location', b.location);
  vevent.updatePropertyWithValue('status', 'CONFIRMED');
  if (b.sequence) vevent.updatePropertyWithValue('sequence', b.sequence);
  vcal.addSubcomponent(vevent);
  return vcal.toString();
}

const STYLE = {
  body: 'margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1c2024;',
  card: 'max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e3e5e8;border-radius:10px;padding:28px;',
  h1: 'margin:0 0 16px;font-size:20px;line-height:1.3;',
  p: 'margin:0 0 14px;font-size:15px;line-height:1.5;',
  table: 'border-collapse:collapse;margin:0 0 18px;font-size:15px;line-height:1.5;',
  th: 'text-align:left;vertical-align:top;padding:4px 16px 4px 0;color:#60646c;font-weight:normal;white-space:nowrap;',
  td: 'vertical-align:top;padding:4px 0;',
  small: 'margin:18px 0 0;font-size:13px;line-height:1.5;color:#60646c;',
  button: 'display:inline-block;padding:11px 20px;border-radius:8px;background:#2f5bff;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;',
};

const VIDEO_HINT = 'Le lien s’ouvre dans votre navigateur, sans compte ni installation : autorisez simplement la caméra et le micro.';

function layout(title: string, inner: string): string {
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="${STYLE.body}"><div style="${STYLE.card}">
<h1 style="${STYLE.h1}">${escapeHtml(title)}</h1>
${inner}
</div></body></html>`;
}

function rowsHtml(rows: [string, string][]): string {
  const body = rows
    .filter(([, value]) => value)
    .map(([label, value]) => `<tr><th style="${STYLE.th}">${escapeHtml(label)}</th><td style="${STYLE.td}">${escapeHtml(value).replace(/\n/g, '<br>')}</td></tr>`)
    .join('\n');
  return `<table role="presentation" style="${STYLE.table}">\n${body}\n</table>`;
}

function rowsText(rows: [string, string][]): string {
  return rows.filter(([, value]) => value).map(([label, value]) => `${label} : ${value}`).join('\n');
}

function p(html: string): string {
  return `<p style="${STYLE.p}">${html}</p>`;
}

function summaryRows(b: BookingMailData, ctx: MailContext): [string, string][] {
  return [
    ['Rendez-vous', b.typeName],
    ['Date', formatWhen(b.start, b.end, ctx.timezone)],
    ['Lieu', b.location],
    ['Visio', b.videoUrl ?? ''],
    ['Acompte', depositLine(b)],
  ];
}

function depositLine(b: BookingMailData): string {
  if (!b.deposit) return '';
  if (b.depositStatus === 'refunded') return `${b.deposit}, remboursé`;
  if (b.depositStatus === 'refund_failed') return `${b.deposit}, remboursement en cours`;
  return `${b.deposit}, payé en ligne`;
}

/** Phrase sur l'acompte dans l'avis d'annulation au client, ou rien. */
function refundSentence(b: BookingMailData): string {
  if (!b.deposit) return '';
  if (b.depositStatus === 'refunded') return `Votre acompte de ${b.deposit} vous est remboursé. Selon votre banque, il apparaît sur votre compte d’ici 5 à 10 jours.`;
  if (b.depositStatus === 'refund_failed') return `Le remboursement de votre acompte de ${b.deposit} est en cours de traitement.`;
  return `L’acompte de ${b.deposit} n’est pas remboursé.`;
}

function clientRows(b: BookingMailData): [string, string][] {
  return [
    ['Nom', b.name],
    ['E-mail', b.email],
    ['Téléphone', b.phone],
    ['Message', b.message],
  ];
}

/** Lien de gestion du rendez-vous (déplacer ou annuler). Les anciens liens /rdv/annulation/<jeton> restent valables. */
export function cancelUrlFor(publicUrl: string, token: string): string {
  return `${publicUrl}/rdv/gerer/${token}`;
}

/** Phrase et libellé du lien de gestion, selon que le client peut déplacer lui-même son rendez-vous. */
function manageWording(ctx: MailContext): { text: string; link: string } {
  return ctx.allowReschedule
    ? { text: 'Un empêchement ? Vous pouvez déplacer ou annuler ce rendez-vous ici :', link: 'Déplacer ou annuler ce rendez-vous' }
    : { text: 'Un empêchement ? Vous pouvez annuler ce rendez-vous ici :', link: 'Annuler ce rendez-vous' };
}

function videoBlock(b: BookingMailData): { text: string[]; html: string[] } {
  if (!b.videoUrl) return { text: [], html: [] };
  return {
    text: ['Pour rejoindre la visio, à l’heure du rendez-vous :', b.videoUrl, VIDEO_HINT, ''],
    html: [p(`<a href="${escapeHtml(b.videoUrl)}" style="${STYLE.button}">Rejoindre la visio</a>`), `<p style="${STYLE.small}">${escapeHtml(VIDEO_HINT)}</p>`],
  };
}

function icsAttachment(b: BookingMailData, ctx: MailContext): MailAttachment {
  return { filename: 'rendez-vous.ics', content: buildBookingIcs(b, ctx), contentType: 'text/calendar; charset=utf-8; method=PUBLISH' };
}

/** Confirmation au client, avec le lien d'annulation et l'événement en pièce jointe. */
export function clientConfirmation(b: BookingMailData, ctx: MailContext, cancelUrl: string): MailMessage {
  const title = 'Votre rendez-vous est confirmé';
  const rows = summaryRows(b, ctx);
  const signature = ctx.publicName || 'Alfred';
  const text = [
    `Bonjour ${b.name},`,
    '',
    'Votre rendez-vous est confirmé.',
    '',
    rowsText(rows),
    '',
    ...videoBlock(b).text,
    manageWording(ctx).text,
    cancelUrl,
    '',
    'Le rendez-vous est joint à ce message : ouvrez la pièce jointe pour l’ajouter à votre agenda.',
    '',
    signature,
  ].join('\n');
  const html = layout(title, [
    p(`Bonjour ${escapeHtml(b.name)},`),
    p('Votre rendez-vous est confirmé.'),
    rowsHtml(rows),
    ...videoBlock(b).html,
    p(`Un empêchement ? <a href="${escapeHtml(cancelUrl)}">${escapeHtml(manageWording(ctx).link)}</a>.`),
    `<p style="${STYLE.small}">Le rendez-vous est joint à ce message : ouvrez la pièce jointe pour l’ajouter à votre agenda.</p>`,
    `<p style="${STYLE.small}">${escapeHtml(signature)}</p>`,
  ].join('\n'));
  return {
    to: { name: b.name, address: b.email },
    subject: `Rendez-vous confirmé : ${b.typeName}, ${formatWhen(b.start, b.end, ctx.timezone)}`,
    text,
    html,
    attachments: [icsAttachment(b, ctx)],
  };
}

/** Heure locale « 15:30 ». */
function timeOf(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('fr-CH', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

/** Jour local AAAA-MM-JJ. */
function dayOf(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

/** « aujourd'hui à 15:30 », « demain à 09:00 », ou la date complète. */
export function whenFromNow(startIso: string, nowMs: number, timezone: string): string {
  const startMs = Date.parse(startIso);
  const time = timeOf(startIso, timezone);
  const today = dayOf(nowMs, timezone);
  const day = dayOf(startMs, timezone);
  if (day === today) return `aujourd’hui à ${time}`;
  // Le lendemain local : midi du jour courant + 24 h tombe toujours le jour suivant, changement d'heure compris.
  const tomorrow = dayOf(Date.parse(`${today}T12:00:00Z`) + 86_400_000, timezone);
  if (day === tomorrow) return `demain à ${time}`;
  return formatWhen(startIso, new Date(startMs + 1).toISOString(), timezone).replace(/, de .*$/, ` à ${time}`);
}

/**
 * Rappel au client avant le rendez-vous, avec le lien de la visio et le lien de gestion.
 * moved : l'horaire a changé depuis le dernier e-mail du client (déplacé dans l'agenda d'Antoine).
 */
export function clientReminder(
  b: BookingMailData, ctx: MailContext, manageUrl: string, opts: { nowMs: number; moved?: boolean; canChange?: boolean },
): MailMessage {
  const rows = summaryRows(b, ctx);
  const signature = ctx.publicName || 'Alfred';
  const when = whenFromNow(b.start, opts.nowMs, ctx.timezone);
  const soon = Date.parse(b.start) - opts.nowMs <= 90 * 60_000;
  const title = soon ? 'Votre rendez-vous commence bientôt' : 'Rappel de votre rendez-vous';
  const intro = `Petit rappel : votre rendez-vous a lieu ${when}.`;
  const movedLine = 'Attention : l’horaire a changé depuis notre dernier message. L’horaire ci-dessous est le bon.';
  const video = videoBlock(b);
  // Trop tard pour changer en ligne : pas de lien qui mènerait à un refus.
  const late = opts.canChange === false;
  const wording = late
    ? { text: 'Un empêchement ? Répondez simplement à cet e-mail.', link: '' }
    : manageWording(ctx);
  const text = [
    `Bonjour ${b.name},`,
    '',
    intro,
    ...(opts.moved ? ['', movedLine] : []),
    '',
    rowsText(rows),
    '',
    ...video.text,
    wording.text,
    ...(late ? [] : [manageUrl]),
    '',
    signature,
  ].join('\n');
  const html = layout(title, [
    p(`Bonjour ${escapeHtml(b.name)},`),
    p(escapeHtml(intro)),
    ...(opts.moved ? [p(`<strong>${escapeHtml(movedLine)}</strong>`)] : []),
    rowsHtml(rows),
    ...video.html,
    p(late ? escapeHtml(wording.text) : `Un empêchement ? <a href="${escapeHtml(manageUrl)}">${escapeHtml(wording.link)}</a>.`),
    `<p style="${STYLE.small}">${escapeHtml(signature)}</p>`,
  ].join('\n'));
  return {
    to: { name: b.name, address: b.email },
    subject: `Rappel : ${b.typeName}, ${when}`,
    text,
    html,
    // L'horaire a changé : l'événement joint met à jour l'agenda du client.
    attachments: opts.moved ? [icsAttachment(b, ctx)] : undefined,
  };
}

/** Le client a déplacé son rendez-vous : nouvel horaire, ancien horaire pour mémoire, événement à jour joint. */
export function clientRescheduled(b: BookingMailData, ctx: MailContext, manageUrl: string, previous: { start: string; end: string }): MailMessage {
  const title = 'Votre rendez-vous est déplacé';
  const rows: [string, string][] = [...summaryRows(b, ctx), ['Ancien horaire', formatWhen(previous.start, previous.end, ctx.timezone)]];
  const signature = ctx.publicName || 'Alfred';
  const video = videoBlock(b);
  const wording = manageWording(ctx);
  const text = [
    `Bonjour ${b.name},`,
    '',
    'Votre rendez-vous a bien été déplacé. Voici le nouvel horaire :',
    '',
    rowsText(rows),
    '',
    ...video.text,
    wording.text,
    manageUrl,
    '',
    'Le rendez-vous à jour est joint à ce message : ouvrez la pièce jointe pour mettre votre agenda à jour.',
    '',
    signature,
  ].join('\n');
  const html = layout(title, [
    p(`Bonjour ${escapeHtml(b.name)},`),
    p('Votre rendez-vous a bien été déplacé. Voici le nouvel horaire :'),
    rowsHtml(rows),
    ...video.html,
    p(`Un autre empêchement ? <a href="${escapeHtml(manageUrl)}">${escapeHtml(wording.link)}</a>.`),
    `<p style="${STYLE.small}">Le rendez-vous à jour est joint à ce message : ouvrez la pièce jointe pour mettre votre agenda à jour.</p>`,
    `<p style="${STYLE.small}">${escapeHtml(signature)}</p>`,
  ].join('\n'));
  return {
    to: { name: b.name, address: b.email },
    subject: `Rendez-vous déplacé : ${b.typeName}, ${formatWhen(b.start, b.end, ctx.timezone)}`,
    text,
    html,
    attachments: [icsAttachment(b, ctx)],
  };
}

/** Avis à Antoine : un client a déplacé son rendez-vous. */
export function ownerRescheduled(b: BookingMailData, ctx: MailContext, notifyTo: string, previous: { start: string; end: string }): MailMessage {
  const title = 'Rendez-vous déplacé par le client';
  const rows: [string, string][] = [
    ...summaryRows(b, ctx),
    ['Ancien horaire', formatWhen(previous.start, previous.end, ctx.timezone)],
    ...clientRows(b),
  ];
  return {
    to: notifyTo,
    replyTo: { name: b.name, address: b.email },
    subject: `Rendez-vous déplacé : ${b.typeName}, ${b.name}`,
    text: [`${title}. L’événement a été déplacé dans le calendrier.`, '', rowsText(rows)].join('\n'),
    html: layout(title, [p('L’événement a été déplacé dans le calendrier.'), rowsHtml(rows)].join('\n')),
  };
}

/** Avis à Antoine : nouveau rendez-vous. */
export function ownerNotification(b: BookingMailData, ctx: MailContext, notifyTo: string): MailMessage {
  const title = 'Nouveau rendez-vous';
  const rows = [...summaryRows(b, ctx), ...clientRows(b)];
  return {
    to: notifyTo,
    replyTo: { name: b.name, address: b.email },
    subject: `Nouveau rendez-vous : ${b.typeName}, ${b.name}`,
    text: [`${title}, pris depuis la page de réservation.`, '', rowsText(rows), '', `Agenda : ${ctx.publicUrl}`].join('\n'),
    html: layout(title, [
      p('Pris depuis la page de réservation. L’événement est dans le calendrier.'),
      rowsHtml(rows),
      `<p style="${STYLE.small}"><a href="${escapeHtml(ctx.publicUrl)}">Ouvrir Alfred</a></p>`,
    ].join('\n')),
  };
}

/** Annulation, côté client. by : qui a annulé. */
export function clientCancellation(b: BookingMailData, ctx: MailContext, by: 'client' | 'admin'): MailMessage {
  const title = 'Votre rendez-vous est annulé';
  const rows = summaryRows(b, ctx);
  const intro = by === 'client'
    ? 'Votre rendez-vous a bien été annulé.'
    : 'Votre rendez-vous a dû être annulé. Veuillez nous en excuser.';
  const again = `Pour reprendre rendez-vous : ${ctx.publicUrl}/rdv`;
  const signature = ctx.publicName || 'Alfred';
  const refund = refundSentence(b);
  return {
    to: { name: b.name, address: b.email },
    subject: `Rendez-vous annulé : ${b.typeName}, ${formatWhen(b.start, b.end, ctx.timezone)}`,
    text: [`Bonjour ${b.name},`, '', intro, ...(refund ? ['', refund] : []), '', rowsText(rows), '', again, '', signature].join('\n'),
    html: layout(title, [
      p(`Bonjour ${escapeHtml(b.name)},`),
      p(escapeHtml(intro)),
      ...(refund ? [p(escapeHtml(refund))] : []),
      rowsHtml(rows),
      p(`<a href="${escapeHtml(`${ctx.publicUrl}/rdv`)}">Reprendre rendez-vous</a>`),
      `<p style="${STYLE.small}">${escapeHtml(signature)}</p>`,
    ].join('\n')),
  };
}

/** Avis à Antoine : un client a annulé. */
export function ownerCancellation(b: BookingMailData, ctx: MailContext, notifyTo: string): MailMessage {
  const title = 'Rendez-vous annulé par le client';
  const rows = [...summaryRows(b, ctx), ...clientRows(b)];
  return {
    to: notifyTo,
    replyTo: { name: b.name, address: b.email },
    subject: `Rendez-vous annulé : ${b.typeName}, ${b.name}`,
    text: [`${title}. L’événement a été retiré du calendrier.`, '', rowsText(rows)].join('\n'),
    html: layout(title, [p('L’événement a été retiré du calendrier.'), rowsHtml(rows)].join('\n')),
  };
}

/** Message d'essai, envoyé depuis l'admin pour vérifier la configuration SMTP. */
export function testMessage(ctx: MailContext, notifyTo: string): MailMessage {
  const title = 'Essai d’envoi depuis Alfred';
  const line = 'Si ce message est arrivé, l’envoi des e-mails de la prise de rendez-vous fonctionne.';
  return { to: notifyTo, subject: title, text: `${line}\n\n${ctx.publicUrl}`, html: layout(title, p(escapeHtml(line))) };
}
