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

/** Lecture seule si le serveur annonce des droits et qu'aucun ne permet d'écrire. */
function isReadOnly(cal: DAVCalendar): boolean {
  const set = cal.projectedProps?.currentUserPrivilegeSet as { privilege?: unknown } | undefined;
  if (!set?.privilege) return false;
  const list = Array.isArray(set.privilege) ? set.privilege : [set.privilege];
  const names = list.flatMap((p) => (p && typeof p === 'object' ? Object.keys(p as object) : []));
  if (names.length === 0) return false;
  return !names.some((n) => /^(write|writeContent|all|bind)$/i.test(n));
}

function resourceName(uid: string): string {
  return `${uid.replace(/[^A-Za-z0-9._-]/g, '_')}.ics`;
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
  /** Ressources écrites localement pendant une synchro : la synchro en cours ne doit pas les écraser. */
  private touched = new Set<string>();
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
    this.touched.clear();
    const remote = (
      await client.fetchCalendars({
        // Les propriétés par défaut de tsdav, plus les droits de l'utilisateur sur chaque calendrier.
        props: {
          'c:calendar-description': {},
          'c:calendar-timezone': {},
          'd:displayname': {},
          'ca:calendar-color': {},
          'cs:getctag': {},
          'd:resourcetype': {},
          'c:supported-calendar-component-set': {},
          'd:sync-token': {},
          'd:current-user-privilege-set': {},
        },
        projectedProps: { currentUserPrivilegeSet: true },
      })
    ).filter((c) => !c.components || c.components.length === 0 || c.components.includes('VEVENT'));
    // Une liste vide alors qu'on connaît déjà des calendriers est presque sûrement une réponse
    // incomplète du serveur : on ne supprime rien, la prochaine synchro réessaiera.
    if (remote.length === 0 && this.store.listCalendars().some((c) => c.source === 'caldav')) {
      throw new Error('Le serveur a renvoyé une liste de calendriers vide');
    }
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
        read_only: isReadOnly(cal) ? 1 : 0,
        sort: index,
      });
    });
    for (const cal of this.store.listCalendars()) {
      if (cal.source === 'caldav' && !seen.has(cal.id)) this.store.deleteCalendar(cal.id);
    }
    // Un calendrier en échec ne doit pas bloquer les autres.
    let firstError: unknown;
    for (const cal of remote) {
      try {
        await this.syncCalendar(client, cal);
      } catch (err) {
        firstError ??= err;
        console.warn(`[alfred] calendrier ${cal.url} non synchronisé : ${(err as Error).message}`);
      }
    }
    if (firstError) throw firstError;
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
    const toDelete = [...local].filter(([href]) => !remoteEtags.has(href)).map(([href, v]) => ({ href, id: v.id }));

    const fetched: { href: string; etag: string; ics: string }[] = [];
    let incomplete = false;
    const fetchBatch = async (batch: string[]): Promise<void> => {
      try {
        const objects = await client.fetchCalendarObjects({ calendar: cal, objectUrls: batch, urlFilter: () => true });
        for (const o of objects) {
          if (typeof o.data === 'string' && o.data.includes('BEGIN:VCALENDAR')) {
            fetched.push({ href: absolute(o.url, cal.url), etag: o.etag ?? '', ics: o.data });
          }
        }
      } catch (err) {
        // Une ressource supprimée entre la liste et la lecture fait échouer tout le lot :
        // on relit alors une par une, et celle qui manque sera traitée à la prochaine synchro.
        if (batch.length === 1) {
          incomplete = true;
          console.warn(`[alfred] ressource non lue ${batch[0]} : ${(err as Error).message}`);
          return;
        }
        for (const href of batch) await fetchBatch([href]);
      }
    };
    for (let i = 0; i < toFetch.length; i += MULTIGET_BATCH) {
      await fetchBatch(toFetch.slice(i, i + MULTIGET_BATCH));
    }

    tx(this.store.db, () => {
      for (const f of fetched) {
        if (this.touched.has(f.href)) {
          incomplete = true;
          continue;
        }
        try {
          this.store.saveEvent({ calendarId: id, href: f.href, etag: f.etag, ics: f.ics });
        } catch (err) {
          console.warn(`[alfred] ressource ignorée ${f.href} : ${(err as Error).message}`);
        }
      }
      for (const d of toDelete) {
        if (this.touched.has(d.href)) incomplete = true;
        else this.store.deleteEvent(d.id);
      }
      // Tant que tout n'a pas été lu, on ne mémorise pas le ctag : la prochaine synchro repassera.
      this.store.setCalendarCtag(id, incomplete ? null : (cal.ctag ?? null));
    });
  }

  // --- écriture ------------------------------------------------------------

  private async fetchOne(calendarUrl: string, href: string): Promise<{ etag: string; ics: string } | null> {
    const client = await this.getClient();
    try {
      const [obj] = await client.fetchCalendarObjects({ calendar: { url: calendarUrl }, objectUrls: [href], urlFilter: () => true });
      if (!obj || typeof obj.data !== 'string') return null;
      return { etag: obj.etag ?? '', ics: obj.data };
    } catch (err) {
      // tsdav lève une erreur quand la ressource n'existe plus.
      if (/\b404\b|incomplete response/i.test((err as Error).message ?? '')) return null;
      throw err;
    }
  }

  /** Adresse de la ressource qu'Alfred crée pour un UID donné : elle se déduit de l'UID. */
  hrefFor(calendarUrl: string, uid: string): string {
    return absolute(resourceName(uid), calendarUrl);
  }

  async create(calendarUrl: string, uid: string, ics: string): Promise<{ href: string; etag: string }> {
    const client = await this.getClient();
    const filename = resourceName(uid);
    const res = await client.createCalendarObject({ calendar: { url: calendarUrl }, filename, iCalString: ics });
    if (!res.ok) throw new RemoteError(`Le serveur a refusé la création (${res.status})`);
    const href = absolute(filename, calendarUrl);
    this.touched.add(href);
    let etag = res.headers.get('etag') ?? '';
    // Sans etag, la prochaine synchro relira simplement la ressource.
    if (!etag) etag = (await this.fetchOne(calendarUrl, href).catch(() => null))?.etag ?? '';
    return { href, etag };
  }

  async update(calendarUrl: string, href: string, ics: string, etag: string | null): Promise<string> {
    const client = await this.getClient();
    this.touched.add(href);
    const res = await client.updateCalendarObject({ calendarObject: { url: href, data: ics, etag: etag ?? undefined } });
    if (res.status === 412) throw new ConflictError('Cet événement a été modifié ailleurs entre-temps');
    if (!res.ok) throw new RemoteError(`Le serveur a refusé la modification (${res.status})`);
    return res.headers.get('etag') ?? (await this.fetchOne(calendarUrl, href).catch(() => null))?.etag ?? '';
  }

  async remove(href: string, etag: string | null): Promise<void> {
    const client = await this.getClient();
    this.touched.add(href);
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
