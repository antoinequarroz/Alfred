import { useCallback, useEffect, useState } from 'react';
import type { Booking, PersonCall, PersonDetail, PersonEvent, PersonSummary } from '../../../shared/types';
import { peopleApi } from '../api';
import { ArrowLeftIcon, CheckIcon, CopyIcon, MenuIcon } from '../icons';
import { Card } from '../rdv/ui';
import { dayKeyIn, dayLabel, durationLabel, timeIn } from '../rdv/tz';
import { LinksPanel } from './Links';
import '../rdv/rdv.css';
import './people.css';

// Rubrique « Personnes » : l'annuaire des clients (une fiche par e-mail), l'historique de leurs
// rendez-vous et les notes Cairn qui leur sont liées. #personnes : la liste ; #personnes/<id> : une fiche.

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Zurich';

const personIdFromHash = (): string | null => {
  const m = /^#personnes\/(.+)$/.exec(location.hash);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
};

const shortDate = (iso: string) => dayLabel(dayKeyIn(TZ, new Date(iso)), new Date(iso).getFullYear() !== new Date().getFullYear());

function initials(p: Pick<PersonSummary, 'name' | 'email'>): string {
  const words = (p.name || p.email).replace(/[^\p{L}\p{N} ]+/gu, ' ').trim().split(/\s+/);
  return (words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] ?? '?').slice(0, 2)).toUpperCase();
}

export function PeopleScreen({ onMenu }: { onMenu: () => void }) {
  const [personId, setPersonId] = useState<string | null>(personIdFromHash);
  useEffect(() => {
    const onHash = () => setPersonId(personIdFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const open = (id: string | null) => {
    history.pushState(null, '', `${location.pathname}${location.search}#personnes${id ? `/${encodeURIComponent(id)}` : ''}`);
    setPersonId(id);
  };

  return (
    <main className="main bk-main">
      <header className="toolbar">
        <button className="icon-btn menu-btn" onClick={onMenu} aria-label="Menu"><MenuIcon /></button>
        {personId && <button className="icon-btn" onClick={() => open(null)} aria-label="Retour à la liste"><ArrowLeftIcon /></button>}
        <h1>Personnes</h1>
      </header>
      <div className="bk-scroll">
        <div className="bk">
          {personId ? <PersonView key={personId} id={personId} onBack={() => open(null)} /> : <PeopleList onOpen={open} />}
        </div>
      </div>
    </main>
  );
}

function PeopleList({ onOpen }: { onOpen: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<PersonSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      peopleApi.list(query).then((list) => alive && (setPeople(list), setError(null)), (err) => alive && setError(err instanceof Error ? err.message : 'Liste indisponible'));
    }, query ? 200 : 0);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query]);

  return (
    <Card
      title="Tes clients"
      sub="Chaque personne qui réserve a sa fiche, retrouvée par son e-mail. Tu y vois ses rendez-vous et les notes Cairn liées."
    >
      <input className="pp-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Chercher un nom, un e-mail, un téléphone" aria-label="Chercher une personne" />
      {error && <p className="form-error" role="alert">{error}</p>}
      {people && people.length === 0 && (
        <p className="bk-empty">{query ? 'Personne ne correspond.' : 'Aucune fiche pour l’instant : elles se créent toutes seules à chaque réservation.'}</p>
      )}
      {people && people.length > 0 && (
        <ul className="bk-list pp-list">
          {people.map((p) => (
            <li key={p.id}>
              <button type="button" className="pp-row" onClick={() => onOpen(p.id)}>
                <span className="pp-avatar" aria-hidden="true">{initials(p)}</span>
                <span className="pp-row-main">
                  <span className="pp-name">{p.name || p.email}</span>
                  <span className="bk-meta">{p.email}{p.phone ? ` · ${p.phone}` : ''}</span>
                </span>
                <span className="pp-row-side">
                  {p.nextAt ? <span className="tag accent">Prochain : {shortDate(p.nextAt)}</span> : p.lastAt ? <span className="bk-meta">Dernier : {shortDate(p.lastAt)}</span> : null}
                  <span className="bk-meta">{p.bookingCount} RDV</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function BookingLine({ b }: { b: Booking }) {
  const cancelled = b.status === 'cancelled';
  return (
    <li className={`pp-booking${cancelled ? ' cancelled' : ''}`}>
      <span className="pp-when">
        <span className="bk-when-day">{dayLabel(dayKeyIn(TZ, new Date(b.start)), true)}</span>
        <span className="bk-when-time">{timeIn(TZ, b.start)} – {timeIn(TZ, b.end)}</span>
      </span>
      <span className="pp-what">
        <span>{b.typeName}{b.location ? <span className="bk-meta"> · {b.location}</span> : null}</span>
        {cancelled && <span className="tag">Annulé {b.cancelledBy === 'client' ? 'par le client' : 'par toi'}</span>}
        {b.message && <span className="bk-message">{b.message}</span>}
      </span>
      {b.videoUrl && !cancelled && <a className="btn small" href={b.videoUrl} target="_blank" rel="noopener">Visio</a>}
    </li>
  );
}

const PARTSTAT: Record<string, string> = {
  ACCEPTED: 'Accepté', DECLINED: 'Refusé', TENTATIVE: 'Peut-être', 'NEEDS-ACTION': 'Sans réponse', DELEGATED: 'Délégué',
};

function CallLine({ c }: { c: PersonCall }) {
  const minutes = c.leftAt ? Math.max(1, Math.round((Date.parse(c.leftAt) - Date.parse(c.joinedAt)) / 60_000)) : null;
  return (
    <li className="pp-booking">
      <span className="pp-when">
        <span className="bk-when-day">{dayLabel(dayKeyIn(TZ, new Date(c.joinedAt)), true)}</span>
        <span className="bk-when-time">{timeIn(TZ, c.joinedAt)}{c.leftAt ? ` – ${timeIn(TZ, c.leftAt)}` : ''}</span>
      </span>
      <span className="pp-what">
        <span>{c.title}{c.name ? <span className="bk-meta"> · nom affiché : {c.name}</span> : null}</span>
        {minutes === null ? <span className="tag">En cours</span> : <span className="bk-meta">{durationLabel(minutes)}</span>}
      </span>
    </li>
  );
}

function EventLine({ e }: { e: PersonEvent }) {
  const answer = PARTSTAT[e.partstat];
  return (
    <li className="pp-booking">
      <span className="pp-when">
        <span className="bk-when-day">{dayLabel(dayKeyIn(TZ, new Date(e.start)), true)}</span>
        <span className="bk-when-time">{timeIn(TZ, e.start)} – {timeIn(TZ, e.end)}</span>
      </span>
      <span className="pp-what">
        <span>{e.title}{e.recurring ? <span className="bk-meta"> · se répète</span> : null}</span>
        {answer && <span className="tag">{answer}</span>}
      </span>
    </li>
  );
}

function PersonView({ id, onBack }: { id: string; onBack: () => void }) {
  const [person, setPerson] = useState<PersonDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      setPerson(await peopleApi.get(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fiche indisponible');
    }
  }, [id]);
  useEffect(() => void load(), [load]);

  const copyAddress = async () => {
    if (!person) return;
    try {
      await navigator.clipboard.writeText(person.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* presse-papiers refusé : l'adresse reste lisible à l'écran */
    }
  };

  if (error) {
    return (
      <div className="bk-card">
        <p className="form-error" role="alert">{error}</p>
        <button className="btn" onClick={onBack}>Retour à la liste</button>
      </div>
    );
  }
  if (!person) return <div className="bk-card"><p className="bk-empty">Chargement…</p></div>;

  return (
    <>
      <section className="bk-card pp-hero">
        <span className="pp-avatar large" aria-hidden="true">{initials(person)}</span>
        <div className="pp-hero-main">
          <h2>{person.name || person.email}</h2>
          <p className="bk-meta bk-contacts">
            <a href={`mailto:${person.email}`}>{person.email}</a>
            {person.phone && <a href={`tel:${person.phone.replace(/[^\d+]/g, '')}`}>{person.phone}</a>}
            <span>Client depuis le {shortDate(person.createdAt)}</span>
          </p>
          <div className="pp-address">
            <code title="Adresse stable de la fiche dans la suite Media">{person.address}</code>
            <button type="button" className="btn ghost small" onClick={() => void copyAddress()}>{copied ? <CheckIcon /> : <CopyIcon />}{copied ? 'Copiée' : 'Copier l’adresse'}</button>
          </div>
        </div>
      </section>

      <Card title="Notes et liens" sub="Les notes Cairn sur cette personne. Ouvre la note dans Cairn, copie son lien et colle-le ici.">
        <LinksPanel source={{ from: person.address }} initial={person.links} />
      </Card>

      <Card title="À venir" sub={person.upcoming.length ? undefined : 'Aucun rendez-vous prévu.'}>
        {person.upcoming.length > 0 && <ul className="bk-list">{person.upcoming.map((b) => <BookingLine key={b.id} b={b} />)}</ul>}
      </Card>

      <Card title="Historique" sub={person.past.length ? `${person.past.length} rendez-vous passé${person.past.length > 1 ? 's' : ''} ou annulé${person.past.length > 1 ? 's' : ''}` : 'Pas encore d’historique.'}>
        {person.past.length > 0 && <ul className="bk-list">{person.past.map((b) => <BookingLine key={b.id} b={b} />)}</ul>}
      </Card>

      {person.calls.length > 0 && (
        <Card title="Visios" sub={`${person.calls.length} passage${person.calls.length > 1 ? 's' : ''} dans la salle de ses rendez-vous`}>
          <ul className="bk-list">{person.calls.map((c) => <CallLine key={c.id} c={c} />)}</ul>
        </Card>
      )}

      {person.events.length > 0 && (
        <Card title="Invitations" sub="Événements de ton agenda où son e-mail figure parmi les invités">
          <ul className="bk-list">{person.events.map((e) => <EventLine key={e.eventId} e={e} />)}</ul>
        </Card>
      )}
    </>
  );
}
