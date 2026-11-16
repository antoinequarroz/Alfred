// Envoi des e-mails de la prise de rendez-vous, contre un faux serveur SMTP local.
import { createServer, type AddressInfo, type Socket } from 'node:net';
import ICAL from 'ical.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildBookingIcs, clientCancellation, clientConfirmation, createDisabledMailer, createSmtpMailer, escapeHtml,
  formatWhen, headerSafe, ownerCancellation, ownerNotification, type BookingMailData, type MailContext,
} from '../server/booking/mail.js';
import { findPart, parseMime, startFakeSmtp, type FakeSmtp } from './helpers/smtp.js';

const ctx: MailContext = { publicName: 'Antoine Quarroz', timezone: 'Europe/Zurich', publicUrl: 'https://alfred.example.ch' };
const booking: BookingMailData = {
  id: 'b-123',
  typeName: 'Première consultation',
  location: 'Rue du Lac 1, 1950 Sion',
  start: '2026-11-17T08:00:00.000Z',
  end: '2026-11-17T08:30:00.000Z',
  name: 'Élodie Müller',
  email: 'elodie@example.org',
  phone: '+41 79 123 45 67',
  message: 'Bonjour,\nje viens pour la première fois.',
};
const cancelUrl = 'https://alfred.example.ch/rdv/annulation/abcDEF_-123';

let smtp: FakeSmtp | null = null;
afterEach(async () => {
  await smtp?.close();
  smtp = null;
});

function mailerFor(server: FakeSmtp, user = '') {
  return createSmtpMailer({
    host: '127.0.0.1', port: server.port, secure: false, requireTls: false, user, password: user ? 'secret-de-test' : '',
    from: { name: 'Antoine Quarroz', address: 'info@antoinequarroz.ch' }, notifyTo: 'info@antoinequarroz.ch',
  });
}

describe('e-mails de la prise de rendez-vous', () => {
  it('envoie la confirmation au client : texte, HTML, lien d’annulation et pièce jointe .ics', async () => {
    smtp = await startFakeSmtp();
    await mailerFor(smtp).send(clientConfirmation(booking, ctx, cancelUrl));
    expect(smtp.mails).toHaveLength(1);
    const mail = smtp.mails[0];
    expect(mail.from).toBe('info@antoinequarroz.ch');
    expect(mail.to).toEqual(['elodie@example.org']);

    const mime = parseMime(mail.raw);
    expect(mime.headers.from).toBe('Antoine Quarroz <info@antoinequarroz.ch>');
    expect(mime.headers.to).toContain('elodie@example.org');
    expect(mime.headers.to).toContain('Élodie Müller');
    expect(mime.headers.subject).toBe('Rendez-vous confirmé : Première consultation, mardi 17 novembre 2026, de 09:00 à 09:30');

    const text = findPart(mime, 'text/plain')!.body;
    expect(text).toContain('Bonjour Élodie Müller,');
    expect(text).toContain('Date : mardi 17 novembre 2026, de 09:00 à 09:30');
    expect(text).toContain('Lieu : Rue du Lac 1, 1950 Sion');
    expect(text).toContain(cancelUrl);
    // Le message libre du client n'est jamais renvoyé au client (pas de relais de contenu arbitraire).
    expect(text).not.toContain('première fois');

    const html = findPart(mime, 'text/html')!.body;
    expect(html).toContain(`<a href="${cancelUrl}">Annuler ce rendez-vous</a>`);
    expect(html).toContain('mardi 17 novembre 2026, de 09:00 à 09:30');

    const ics = findPart(mime, 'text/calendar')!;
    expect(ics.headers['content-type']).toMatch(/method=PUBLISH/i);
    expect(ics.headers['content-disposition']).toContain('rendez-vous.ics');
    const vcal = new ICAL.Component(ICAL.parse(ics.body) as unknown[]);
    expect(vcal.getFirstPropertyValue('method')).toBe('PUBLISH');
    const vevent = vcal.getFirstSubcomponent('vevent')!;
    const event = new ICAL.Event(vevent);
    expect(event.summary).toBe('Première consultation – Antoine Quarroz');
    expect(event.location).toBe('Rue du Lac 1, 1950 Sion');
    expect(event.uid).toBe('rdv-b-123@alfred.example.ch');
    // Une simple publication : ni organisateur ni participant, donc pas d'invitation.
    expect(vevent.hasProperty('attendee')).toBe(false);
    expect(vevent.hasProperty('organizer')).toBe(false);
    // Heure locale avec fuseau, et définition du fuseau jointe.
    expect(vevent.getFirstProperty('dtstart')!.getParameter('tzid')).toBe('Europe/Zurich');
    expect(ics.body).toContain('DTSTART;TZID=Europe/Zurich:20261117T090000');
    expect(vcal.getFirstSubcomponent('vtimezone')).not.toBeNull();
    for (const tz of vcal.getAllSubcomponents('vtimezone')) ICAL.TimezoneService.register(tz);
    const reparsed = new ICAL.Event(new ICAL.Component(ICAL.parse(ics.body) as unknown[]).getFirstSubcomponent('vevent')!);
    expect(reparsed.startDate.toJSDate().toISOString()).toBe(booking.start);
    expect(reparsed.endDate.toJSDate().toISOString()).toBe(booking.end);
  });

  it('s’identifie auprès du serveur quand un utilisateur est configuré', async () => {
    smtp = await startFakeSmtp();
    await mailerFor(smtp, 'info@antoinequarroz.ch').send(ownerNotification(booking, ctx, 'info@antoinequarroz.ch'));
    expect(smtp.logins).toEqual([['info@antoinequarroz.ch', 'secret-de-test']]);
    const mime = parseMime(smtp.mails[0].raw);
    expect(smtp.mails[0].to).toEqual(['info@antoinequarroz.ch']);
    expect(mime.headers.subject).toBe('Nouveau rendez-vous : Première consultation, Élodie Müller');
    expect(mime.headers['reply-to']).toContain('elodie@example.org');
    const text = findPart(mime, 'text/plain')!.body;
    expect(text).toContain('E-mail : elodie@example.org');
    expect(text).toContain('Téléphone : +41 79 123 45 67');
    expect(text).toContain('je viens pour la première fois.');
    expect(findPart(mime, 'text/html')!.body).toContain('Bonjour,<br>je viens pour la première fois.');
  });

  it('échappe tout contenu saisi dans le HTML', async () => {
    smtp = await startFakeSmtp();
    const evil: BookingMailData = {
      ...booking,
      name: '<script>alert(1)</script> & "Bob"',
      message: '<img src=x onerror=alert(1)>\n</td><a href="https://evil.example">clic</a>',
      phone: '<b>079</b>',
    };
    const mailer = mailerFor(smtp);
    await mailer.send(clientConfirmation(evil, ctx, cancelUrl));
    await mailer.send(ownerNotification(evil, ctx, 'info@antoinequarroz.ch'));
    await mailer.send(clientCancellation(evil, ctx, 'admin'));
    await mailer.send(ownerCancellation(evil, ctx, 'info@antoinequarroz.ch'));
    expect(smtp.mails).toHaveLength(4);
    for (const mail of smtp.mails) {
      const html = findPart(parseMime(mail.raw), 'text/html')!.body;
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('<img');
      expect(html).not.toContain('<b>079');
      expect(html).not.toContain('evil.example">');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Bob&quot;');
    }
    const owner = findPart(parseMime(smtp.mails[1].raw), 'text/html')!.body;
    expect(owner).toContain('&lt;img src=x onerror=alert(1)&gt;<br>&lt;/td&gt;&lt;a href=&quot;https://evil.example&quot;&gt;clic&lt;/a&gt;');
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('interdit les retours à la ligne dans les en-têtes', async () => {
    smtp = await startFakeSmtp();
    const evil: BookingMailData = {
      ...booking,
      name: 'Bob\r\nBcc: victime@example.net\r\nX-Injecte: oui',
      typeName: 'Consultation\r\nBcc: autre@example.net',
    };
    const mailer = mailerFor(smtp);
    await mailer.send(clientConfirmation(evil, ctx, cancelUrl));
    await mailer.send(ownerNotification(evil, ctx, 'info@antoinequarroz.ch'));
    expect(smtp.mails[0].to).toEqual(['elodie@example.org']);
    expect(smtp.mails[1].to).toEqual(['info@antoinequarroz.ch']);
    for (const mail of smtp.mails) {
      const head = mail.raw.slice(0, mail.raw.indexOf('\r\n\r\n'));
      expect(head).not.toMatch(/^bcc:/im);
      expect(head).not.toMatch(/^x-injecte:/im);
      expect(parseMime(mail.raw).headers.bcc).toBeUndefined();
    }
    expect(headerSafe('a\r\nb\u2028c\u0000d')).toBe('a b c d');
  });

  it('remonte l’erreur quand le serveur refuse le destinataire', async () => {
    smtp = await startFakeSmtp({ rejectRecipient: 'example.org' });
    await expect(mailerFor(smtp).send(clientConfirmation(booking, ctx, cancelUrl))).rejects.toThrow();
    expect(smtp.mails).toHaveLength(0);
  });

  it('abandonne un envoi qui dépasse la durée totale, même si le serveur répond au compte-gouttes', async () => {
    // Le serveur salue, puis égrène une réponse sans fin : les délais d'inactivité ne se déclenchent jamais.
    const timers = new Set<NodeJS.Timeout>();
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.write('220 lent ESMTP\r\n');
      socket.once('data', () => {
        const timer = setInterval(() => socket.write('250-ENCORE\r\n'), 20);
        timers.add(timer);
        socket.on('close', () => clearInterval(timer));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const mailer = createSmtpMailer({
        host: '127.0.0.1', port: (server.address() as AddressInfo).port, secure: false, requireTls: false, user: '', password: '',
        from: { name: 'Antoine Quarroz', address: 'info@antoinequarroz.ch' }, notifyTo: 'info@antoinequarroz.ch', totalTimeoutMs: 150,
      });
      const started = Date.now();
      await expect(mailer.send(clientConfirmation(booking, ctx, cancelUrl))).rejects.toThrow(/ne répond pas à temps/);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      for (const timer of timers) clearInterval(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('sans SMTP configuré, l’envoi est refusé proprement', async () => {
    const mailer = createDisabledMailer('Antoine <info@antoinequarroz.ch>', 'info@antoinequarroz.ch');
    expect(mailer.configured).toBe(false);
    await expect(mailer.send(clientConfirmation(booking, ctx, cancelUrl))).rejects.toThrow(/non configuré/);
  });

  it('annonce l’annulation au client, avec un ton différent selon qui annule', () => {
    const byClient = clientCancellation(booking, ctx, 'client');
    const byAdmin = clientCancellation(booking, ctx, 'admin');
    expect(byClient.subject).toBe('Rendez-vous annulé : Première consultation, mardi 17 novembre 2026, de 09:00 à 09:30');
    expect(byClient.text).toContain('a bien été annulé');
    expect(byAdmin.text).toContain('a dû être annulé');
    expect(byAdmin.text).toContain('https://alfred.example.ch/rdv');
    expect(byClient.attachments).toBeUndefined();
  });

  it('écrit les dates dans le fuseau configuré, été comme hiver', () => {
    expect(formatWhen('2026-07-14T07:00:00Z', '2026-07-14T08:00:00Z', 'Europe/Zurich')).toBe('mardi 14 juillet 2026, de 09:00 à 10:00');
    expect(formatWhen('2026-01-13T08:00:00Z', '2026-01-13T09:00:00Z', 'Europe/Zurich')).toBe('mardi 13 janvier 2026, de 09:00 à 10:00');
    const ics = buildBookingIcs({ ...booking, start: '2026-07-14T07:00:00.000Z', end: '2026-07-14T08:00:00.000Z' }, ctx);
    expect(ics).toContain('DTSTART;TZID=Europe/Zurich:20260714T090000');
    expect(ics).toContain('METHOD:PUBLISH');
  });
});
