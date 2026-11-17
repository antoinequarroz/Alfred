import { useEffect, useRef, useState } from 'react';
import type { CalendarInfo, EditScope, RepeatRule } from '../../shared/types';
import { videoApi } from './api';
import { addDays, combine, dateKey, parseDateKey, timeKey } from './dates';
import { ExternalIcon, VideoIcon } from './icons';
import { draftError, REPEAT_LABELS, type Draft } from './model';

interface Props {
  initial: Draft;
  calendars: CalendarInfo[];
  busy: boolean;
  onSave: (draft: Draft, scope: EditScope) => void;
  onDelete: (draft: Draft, scope: EditScope) => void;
  onClose: () => void;
}

export function EventDialog({ initial, calendars, busy, onSave, onDelete, onClose }: Props) {
  const [d, setD] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState<'save' | 'delete' | null>(null);
  const [videoBusy, setVideoBusy] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const editing = d.occ !== null;
  const recurring = d.occ?.recurring ?? false;
  const locked = editing && (calendars.find((c) => c.id === initial.calendarId)?.readOnly ?? false);
  const writable = calendars.filter((c) => !c.readOnly || c.id === initial.calendarId);

  useEffect(() => {
    if (!editing) titleRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') (ask ? setAsk(null) : onClose());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ask, onClose]);

  const set = (patch: Partial<Draft>) => {
    setError(null);
    setD((prev) => ({ ...prev, ...patch }));
  };

  /** Quand le début bouge, la fin suit pour garder la même durée. */
  const setStart = (startDate: string, startTime: string) => {
    if (!startDate || !startTime) return set({ startDate, startTime });
    if (d.allDay) {
      const span = Math.round((parseDateKey(d.endDate).getTime() - parseDateKey(d.startDate).getTime()) / 86_400_000);
      return set({ startDate, endDate: dateKey(addDays(parseDateKey(startDate), Number.isFinite(span) ? Math.max(0, span) : 0)) });
    }
    const duration = combine(d.endDate, d.endTime).getTime() - combine(d.startDate, d.startTime).getTime();
    const end = new Date(combine(startDate, startTime).getTime() + (Number.isFinite(duration) ? Math.max(0, duration) : 3_600_000));
    set({ startDate, startTime, endDate: dateKey(end), endTime: timeKey(end) });
  };

  // Lien d'une salle Alfred déjà présent dans le lieu ou les notes.
  const videoLink = /https?:\/\/[^\s]+\/v\/[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}/.exec(`${d.location}\n${d.description}`)?.[0] ?? null;

  /** Crée une salle de visio pour cet événement ; son lien devient le lieu (ou s'ajoute aux notes). */
  const addVideo = async () => {
    const err = draftError(d);
    if (err) return setError(err);
    setVideoBusy(true);
    try {
      const start = d.allDay ? combine(d.startDate, '00:00') : combine(d.startDate, d.startTime);
      const end = d.allDay ? addDays(combine(d.endDate, '00:00'), 1) : combine(d.endDate, d.endTime);
      const room = await videoApi.createRoom({ title: d.title.trim() || 'Visio', start: start.toISOString(), end: end.toISOString() });
      if (!d.location.trim()) set({ location: room.url });
      else set({ description: d.description.trim() ? `${d.description.trim()}\nVisio : ${room.url}` : `Visio : ${room.url}` });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'La visio n’a pas pu être créée');
    } finally {
      setVideoBusy(false);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (locked) return;
    const err = draftError(d);
    if (err) return setError(err);
    if (recurring) setAsk('save');
    else onSave(d, 'all');
  };

  const repeatOptions: RepeatRule[] = ['none', 'daily', 'weekly', 'monthly', 'yearly'];
  if (initial.repeat === 'custom') repeatOptions.push('custom');

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog" onSubmit={submit} aria-label={editing ? 'Modifier l’événement' : 'Nouvel événement'}>
        {ask ? (
          <div className="ask">
            <h2>{ask === 'save' ? 'Modifier un événement récurrent' : 'Supprimer un événement récurrent'}</h2>
            <p>Cet événement se répète. Que veux-tu {ask === 'save' ? 'modifier' : 'supprimer'} ?</p>
            <button type="button" className="btn wide" disabled={busy} onClick={() => (ask === 'save' ? onSave(d, 'this') : onDelete(d, 'this'))}>
              Seulement cet événement
            </button>
            <button type="button" className={`btn wide${ask === 'delete' ? ' danger' : ''}`} disabled={busy} onClick={() => (ask === 'save' ? onSave(d, 'all') : onDelete(d, 'all'))}>
              Tous les événements de la série
            </button>
            <button type="button" className="btn wide ghost" onClick={() => setAsk(null)}>Annuler</button>
          </div>
        ) : (
          <>
            <input
              ref={titleRef}
              className="title-input"
              placeholder="Titre"
              value={d.title}
              onChange={(e) => set({ title: e.target.value })}
              maxLength={300}
            />

            <label className="check">
              <input type="checkbox" checked={d.allDay} onChange={(e) => set({ allDay: e.target.checked })} />
              Toute la journée
            </label>

            <div className="row">
              <span className="label">Début</span>
              <input type="date" required value={d.startDate} onChange={(e) => setStart(e.target.value, d.startTime)} />
              {!d.allDay && <input type="time" required step={300} value={d.startTime} onChange={(e) => setStart(d.startDate, e.target.value)} />}
            </div>
            <div className="row">
              <span className="label">Fin</span>
              <input type="date" required value={d.endDate} min={d.startDate} onChange={(e) => set({ endDate: e.target.value })} />
              {!d.allDay && <input type="time" required step={300} value={d.endTime} onChange={(e) => set({ endTime: e.target.value })} />}
            </div>

            <div className="row">
              <span className="label">Répéter</span>
              <select value={d.repeat} onChange={(e) => set({ repeat: e.target.value as RepeatRule })}>
                {repeatOptions.map((r) => (
                  <option key={r} value={r}>{REPEAT_LABELS[r]}</option>
                ))}
              </select>
            </div>

            <div className="row">
              <span className="label">Calendrier</span>
              <select value={d.calendarId} onChange={(e) => set({ calendarId: e.target.value })}>
                {writable.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>

            <div className="row">
              <span className="label">Lieu</span>
              <input type="text" value={d.location} onChange={(e) => set({ location: e.target.value })} placeholder="Adresse ou lien" maxLength={500} />
            </div>

            <div className="row">
              <span className="label">Visio</span>
              {videoLink ? (
                <a className="btn" href={videoLink} target="_blank" rel="noopener"><ExternalIcon />Rejoindre la visio</a>
              ) : (
                <button type="button" className="btn" disabled={videoBusy || locked} onClick={() => void addVideo()}><VideoIcon />{videoBusy ? 'Création…' : 'Ajouter une visio Alfred'}</button>
              )}
            </div>

            <textarea rows={3} placeholder="Notes" value={d.description} onChange={(e) => set({ description: e.target.value })} />

            {error && <p className="form-error" role="alert">{error}</p>}
            {locked && <p className="muted">Ce calendrier est en lecture seule : l’événement ne peut pas être modifié ici.</p>}

            <div className="actions">
              {editing && !locked && (
                <button type="button" className="btn danger ghost" disabled={busy} onClick={() => (recurring ? setAsk('delete') : onDelete(d, 'all'))}>
                  Supprimer
                </button>
              )}
              <span className="spacer" />
              <button type="button" className="btn ghost" onClick={onClose}>{locked ? 'Fermer' : 'Annuler'}</button>
              {!locked && <button type="submit" className="btn primary" disabled={busy}>{editing ? 'Enregistrer' : 'Créer'}</button>}
            </div>
          </>
        )}
      </form>
    </div>
  );
}

/** Choix de portée après un déplacement à la souris d'un événement récurrent. */
export function ScopeDialog({ onChoose, onCancel }: { onChoose: (scope: EditScope) => void; onCancel: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog ask">
        <h2>Déplacer un événement récurrent</h2>
        <p>Cet événement se répète. Que veux-tu déplacer ?</p>
        <button className="btn wide" onClick={() => onChoose('this')}>Seulement cet événement</button>
        <button className="btn wide" onClick={() => onChoose('all')}>Tous les événements de la série</button>
        <button className="btn wide ghost" onClick={onCancel}>Annuler</button>
      </div>
    </div>
  );
}
