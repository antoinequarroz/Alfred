import { DAVClient, type DAVCalendar } from 'tsdav';
import type { SyncStatus } from '../shared/types.js';
import { tx } from './db.js';
import { DEFAULT_COLORS, eventIdForHref, type Store } from './store.js';

const MULTIGET_BATCH = 50;

export class ConflictError extends Error {}
export class RemoteError extends Error {}

export interface CaldavOptions {
  serverUrl: string;
  username: string;
  password: string;
}

function absolute(href: string, base: string): string {
  return new URL(href, base.endsWith('/') ? base : `${base}/`).href;
}

function normalizeColor(color: unknown, index: number): string {
  if (typeof color === 'string') {
    const m = /^#([0-9a-f]{6})/i.exec(color.trim());
    if (m) return `#${m[1].toLowerCase()}`;
  }
  return DEFAULT_COLORS[index % DEFAULT_COLORS.length];
}

function displayName(cal: DAVCalendar): string {
  const n = cal.displayName;
  if (typeof n === 'string' && n.trim()) return n.trim();
  return decodeURIComponent(new URL(cal.url).pathname.split('/').filter(Boolean).pop() ?? 'Calendrier');
}

export function calendarIdForUrl(url: string): string {
  return `caldav:${eventIdForHref(url)}`;
}

/**
 * Synchronisation CalDAV (iCloud ou tout serveur standard).
 *
 * Lecture : on compare les etags du serveur avec la base locale toutes les
 * quelques minutes (iCloud ne sait pas prévenir un serveur tiers).
 * Écriture : directe sur le serveur, puis mise à jour de la base.
 */
export class CaldavSync {
  private client: DAVClient | null = null;
  private running: Promise<void> | null = null;
  private status: SyncStatus = { configured: true, running: false, lastSuccessAt: null, lastError: null, lastErrorAt: null };

  constructor(private readonly store: Store, private readonly opts: CaldavOptions) {}

  getStatus(): SyncStatus {
    return { ...this.status, running: this.running !== null };
  }

  private async getClient(): Promise<DAVClient> {
    if (this.client) return this.client;
    const client = new DAVClient({
      serverUrl: this.opts.serverUrl,
      credentials: { username: this.opts.username, password: this.opts.password },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
    });
    await client.login();
    this.client = client;
    return client;
  }

  /** Lance une synchro complète (une seule à la fois). */
  sync(): Promise<void> {
    if (!this.running) {
      this.running = this.doSync()
        .then(() => {
          this.status.lastSuccessAt = new Date().toISOString();
          this.status.lastError = null;
        })
        .catch((err: Error) => {
          this.client = null; // reconnexion à la prochaine tentative
          this.status.lastError = err.message || String(err);
          this.status.lastErrorAt = new Date().toISOString();
          console.error('[alfred] synchro CalDAV en échec :', err);
        })
        .finally(() => {
          this.running = null;
        });
    }
    return this.running;
  }

  private async doSync(): Promise<void> {
    const client = await this.getClient();
    const remote = (await client.fetchCalendars()).filter(
      (c) => !c.components || c.components.length === 0 || c.components.includes('VEVENT'),
    );
    const seen = new Set<string>();
    remote.forEach((cal, index) => {
      const id = calendarIdForUrl(cal.url);
      seen.add(id);
      this.store.upsertCalendar({
        id,
        source: 'caldav',
        url: cal.url,
        name: displayName(cal),
        color: normalizeColor(cal.calendarColor, index),
        read_only: 0,
        sort: index,
      });
    });
    for (const cal of this.store.listCalendars()) {
      if (cal.source === 'caldav' && !seen.has(cal.id)) this.store.deleteCalendar(cal.id);
    }
    for (const cal of remote) {
      await this.syncCalendar(client, cal);
    }
  }

  private async syncCalendar(client: DAVClient, cal: DAVCalendar): Promise<void> {
    const id = calendarIdForUrl(cal.url);
    const stored = this.store.getCalendar(id);
    if (stored?.ctag && cal.ctag && stored.ctag === cal.ctag) return; // rien n'a changé

    const responses = await client.calendarQuery({
      url: cal.url,
      props: { 'd:getetag': {} },
      filters: { 'comp-filter': { _attributes: { name: 'VCALENDAR' }, 'comp-filter': { _attributes: { name: 'VEVENT' } } } },
      depth: '1',
    });
    const remoteEtags = new Map<string, string>();
    for (const r of responses) {
      if (!r.href || !r.ok) continue;
      const href = absolute(r.href, cal.url);
      if (href.replace(/\/$/, '') === cal.url.replace(/\/$/, '')) continue;
      remoteEtags.set(href, String(r.props?.getetag ?? ''));
    }

    const local = this.store.etagsForCalendar(id);
    const toFetch = [...remoteEtags].filter(([href, etag]) => !etag || local.get(href)?.etag !== etag).map(([href]) => href);
    const toDelete = [...local].filter(([href]) => !remoteEtags.has(href)).map(([, v]) => v.id);

    const fetched: { href: string; etag: string; ics: string }[] = [];
    for (let i = 0; i < toFetch.length; i += MULTIGET_BATCH) {
      const batch = toFetch.slice(i, i + MULTIGET_BATCH);
      const objects = await client.fetchCalendarObjects({ calendar: cal, objectUrls: batch, urlFilter: () => true });
      for (const o of objects) {
        if (typeof o.data === 'string' && o.data.includes('BEGIN:VCALENDAR')) {
          fetched.push({ href: absolute(o.url, cal.url), etag: o.etag ?? '', ics: o.data });
        }
      }
    }

    tx(this.store.db, () => {
      for (const f of fetched) {
        try {
          this.store.saveEvent({ calendarId: id, href: f.href, etag: f.etag, ics: f.ics });
        } catch (err) {
          console.warn(`[alfred] ressource ignorée ${f.href} : ${(err as Error).message}`);
        }
      }
      for (const eventId of toDelete) this.store.deleteEvent(eventId);
      this.store.setCalendarCtag(id, cal.ctag ?? null);
    });
  }

  // --- écriture ------------------------------------------------------------

  private async fetchOne(calendarUrl: string, href: string): Promise<{ etag: string; ics: string } | null> {
    const client = await this.getClient();
    const [obj] = await client.fetchCalendarObjects({ calendar: { url: calendarUrl }, objectUrls: [href], urlFilter: () => true });
    if (!obj || typeof obj.data !== 'string') return null;
    return { etag: obj.etag ?? '', ics: obj.data };
  }

  async create(calendarUrl: string, uid: string, ics: string): Promise<{ href: string; etag: string }> {
    const client = await this.getClient();
    const filename = `${uid.replace(/[^A-Za-z0-9._-]/g, '_')}.ics`;
    const res = await client.createCalendarObject({ calendar: { url: calendarUrl }, filename, iCalString: ics });
    if (!res.ok) throw new RemoteError(`Le serveur a refusé la création (${res.status})`);
    const href = absolute(filename, calendarUrl);
    let etag = res.headers.get('etag') ?? '';
    if (!etag) etag = (await this.fetchOne(calendarUrl, href))?.etag ?? '';
    return { href, etag };
  }

  async update(calendarUrl: string, href: string, ics: string, etag: string | null): Promise<string> {
    const client = await this.getClient();
    const res = await client.updateCalendarObject({ calendarObject: { url: href, data: ics, etag: etag ?? undefined } });
    if (res.status === 412) throw new ConflictError('Cet événement a été modifié ailleurs entre-temps');
    if (!res.ok) throw new RemoteError(`Le serveur a refusé la modification (${res.status})`);
    return res.headers.get('etag') ?? (await this.fetchOne(calendarUrl, href))?.etag ?? '';
  }

  async remove(href: string, etag: string | null): Promise<void> {
    const client = await this.getClient();
    const res = await client.deleteCalendarObject({ calendarObject: { url: href, etag: etag ?? undefined } });
    if (res.status === 412) throw new ConflictError('Cet événement a été modifié ailleurs entre-temps');
    if (!res.ok && res.status !== 404) throw new RemoteError(`Le serveur a refusé la suppression (${res.status})`);
  }

  /** Recharge une ressource depuis le serveur (après un conflit). */
  async refresh(eventId: string, calendarId: string, calendarUrl: string, href: string): Promise<void> {
    const obj = await this.fetchOne(calendarUrl, href);
    if (obj) this.store.saveEvent({ id: eventId, calendarId, href, etag: obj.etag, ics: obj.ics });
    else this.store.deleteEvent(eventId);
  }
}
