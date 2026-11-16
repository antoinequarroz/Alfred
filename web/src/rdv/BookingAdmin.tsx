import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type {
  Booking, BookingAdminState, BookingHoursRange, BookingMode, BookingSettings, BookingStep, BookingType, BookingTypeInput, CalendarInfo,
} from '../../../shared/types';
import { ApiError, bookingApi } from '../api';
import { AlertIcon, CheckIcon, Chevron, CloseIcon, CopyIcon, ExternalIcon, MenuIcon, PlusIcon } from '../icons';
import { hoursProblems, WEEKDAYS } from './hours';
import { SmtpCard, smtpDraftDirty, useConnections, type SmtpDraft } from '../settings/ConnectionCards';
import { Card, Fld } from './ui';
import { dateTimeShortIn, dayKeyIn, dayLabel, durationLabel, timeIn } from './tz';
import './rdv.css';

type Tab = 'bookings' | 'types' | 'hours' | 'settings';
const TABS: [Tab, string][] = [['bookings', 'Réservations'], ['types', 'Types'], ['hours', 'Horaires'], ['settings', 'Réglages']];
const MODES: Record<BookingMode, string> = { cabinet: 'Au cabinet', telephone: 'Par téléphone', visio: 'En visio', autre: 'Autre (texte libre)' };

const message = (err: unknown) => (err instanceof Error ? err.message : 'Une erreur est survenue');

/** Lieu tel que le client le verra (même règle que le serveur). */
function modeLabel(t: Pick<BookingType, 'mode' | 'location'>): string {
  if (t.mode === 'cabinet') return t.location || 'Au cabinet';
  if (t.mode === 'telephone') return t.location ? `Par téléphone (${t.location})` : 'Par téléphone';
  if (t.mode === 'visio') return t.location ? `En visio (${t.location})` : 'En visio';
  return t.location;
}

// --- petits composants ---------------------------------------------------------

function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" disabled={disabled} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Fenêtre modale : le focus y entre à l'ouverture, la tabulation y reste (l'app derrière le
 * voile ne doit pas pouvoir être actionnée au clavier), Échap la ferme, et le focus revient
 * à l'élément qui l'a ouverte.
 */
function Modal({ title, onClose, children, small }: { title: string; onClose: () => void; children: React.ReactNode; small?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = () => [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((el) => el.getClientRects().length > 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return close.current();
      if (e.key !== 'Tab') return;
      const list = focusables();
      const active = document.activeElement;
      if (list.length === 0) e.preventDefault();
      else if (!ref.current?.contains(active)) {
        e.preventDefault();
        list[0].focus();
      } else if (e.shiftKey && active === list[0]) {
        e.preventDefault();
        list[list.length - 1].focus();
      } else if (!e.shiftKey && active === list[list.length - 1]) {
        e.preventDefault();
        list[0].focus();
      }
    };
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input:not([type=hidden]), select, textarea, button')?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className={`dialog bk-dialog${small ? ' ask' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className="bk-dialog-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}

// --- types ---------------------------------------------------------------------

interface TypeDraft {
  name: string; durationMin: string; mode: BookingMode; location: string; description: string;
  bufferBeforeMin: string; bufferAfterMin: string; minNoticeHours: string; horizonDays: string; slug: string; active: boolean;
}

function toDraft(t: BookingType | null): TypeDraft {
  return {
    name: t?.name ?? '', durationMin: String(t?.durationMin ?? 30), mode: t?.mode ?? 'cabinet', location: t?.location ?? '',
    description: t?.description ?? '', bufferBeforeMin: String(t?.bufferBeforeMin ?? 0), bufferAfterMin: String(t?.bufferAfterMin ?? 0),
    minNoticeHours: String(t?.minNoticeHours ?? 12), horizonDays: String(t?.horizonDays ?? 60), slug: t?.slug ?? '', active: t?.active ?? true,
  };
}

function TypeDialog({ type, onSaved, onDeleted, onClose }: { type: BookingType | null; onSaved: () => void; onDeleted: () => void; onClose: () => void }) {
  const [d, setD] = useState(() => toDraft(type));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = (patch: Partial<TypeDraft>) => setD((prev) => ({ ...prev, ...patch }));
  const num = (v: string) => (v.trim() === '' ? Number.NaN : Number(v));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setFailure(null);
    const input: BookingTypeInput = {
      name: d.name.trim(), durationMin: num(d.durationMin), mode: d.mode, location: d.location.trim(), description: d.description.trim(),
      bufferBeforeMin: num(d.bufferBeforeMin), bufferAfterMin: num(d.bufferAfterMin), minNoticeHours: num(d.minNoticeHours),
      horizonDays: num(d.horizonDays), active: d.active,
    };
    if (type && d.slug.trim() !== type.slug) input.slug = d.slug.trim();
    try {
      if (type) await bookingApi.updateType(type.id, input);
      else await bookingApi.createType(input);
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.fields) setErrors(err.fields);
      else if (err instanceof ApiError && err.code === 'slug_taken') setErrors({ slug: err.message });
      else setFailure(message(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!type) return;
    setBusy(true);
    try {
      await bookingApi.deleteType(type.id);
      onDeleted();
    } catch (err) {
      setFailure(message(err));
      setBusy(false);
    }
  };

  const locationLabel = d.mode === 'cabinet' ? 'Adresse du cabinet' : d.mode === 'telephone' ? 'Précision (facultatif)' : d.mode === 'visio' ? 'Lien ou précision (facultatif)' : 'Lieu affiché au client';

  return (
    <Modal title={type ? 'Modifier le type de rendez-vous' : 'Nouveau type de rendez-vous'} onClose={onClose}>
      <form className="bk-form" onSubmit={(e) => void submit(e)} noValidate>
        <div className="bk-grid">
          <Fld label="Nom" error={errors.name} className="span-2">
            {(id) => <input id={id} type="text" value={d.name} maxLength={100} placeholder="Consultation" onChange={(e) => set({ name: e.target.value })} />}
          </Fld>
          <Fld label="Durée (min)" error={errors.durationMin}>
            {(id) => <input id={id} type="number" inputMode="numeric" min={5} max={480} step={5} value={d.durationMin} onChange={(e) => set({ durationMin: e.target.value })} />}
          </Fld>
          <Fld label="Mode" error={errors.mode}>
            {(id) => (
              <select id={id} value={d.mode} onChange={(e) => set({ mode: e.target.value as BookingMode })}>
                {(Object.keys(MODES) as BookingMode[]).map((m) => <option key={m} value={m}>{MODES[m]}</option>)}
              </select>
            )}
          </Fld>
          <Fld label={locationLabel} error={errors.location} className="span-2" hint={d.mode === 'visio' ? 'Chaque rendez-vous reçoit automatiquement un lien de visio Alfred, envoyé au client dans l’e-mail de confirmation (si la visio est activée dans Réglages).' : undefined}>
            {(id) => <input id={id} type="text" value={d.location} maxLength={300} onChange={(e) => set({ location: e.target.value })} />}
          </Fld>
          <Fld label="Description (affichée au client)" error={errors.description} className="span-2">
            {(id) => <textarea id={id} rows={2} value={d.description} maxLength={2000} onChange={(e) => set({ description: e.target.value })} />}
          </Fld>
          <Fld label="Tampon avant (min)" error={errors.bufferBeforeMin}>
            {(id) => <input id={id} type="number" inputMode="numeric" min={0} max={240} step={5} value={d.bufferBeforeMin} onChange={(e) => set({ bufferBeforeMin: e.target.value })} />}
          </Fld>
          <Fld label="Tampon après (min)" error={errors.bufferAfterMin}>
            {(id) => <input id={id} type="number" inputMode="numeric" min={0} max={240} step={5} value={d.bufferAfterMin} onChange={(e) => set({ bufferAfterMin: e.target.value })} />}
          </Fld>
          <Fld label="Préavis minimal (heures)" error={errors.minNoticeHours}>
            {(id) => <input id={id} type="number" inputMode="numeric" min={0} max={720} value={d.minNoticeHours} onChange={(e) => set({ minNoticeHours: e.target.value })} />}
          </Fld>
          <Fld label="Réservable jusqu’à (jours)" error={errors.horizonDays}>
            {(id) => <input id={id} type="number" inputMode="numeric" min={1} max={365} value={d.horizonDays} onChange={(e) => set({ horizonDays: e.target.value })} />}
          </Fld>
          {type && (
            <Fld label="Identifiant du lien" error={errors.slug} hint={`Lien direct : /rdv/${d.slug || '…'}. Le changer casse les liens déjà partagés.`} className="span-2">
              {(id) => <input id={id} type="text" value={d.slug} maxLength={50} spellCheck={false} autoCapitalize="none" onChange={(e) => set({ slug: e.target.value })} />}
            </Fld>
          )}
        </div>
        <label className="check">
          <input type="checkbox" checked={d.active} onChange={(e) => set({ active: e.target.checked })} />
          Proposé sur la page publique
        </label>
        {failure && <p className="form-error" role="alert">{failure}</p>}
        {confirmDelete ? (
          <div className="actions">
            <span className="bk-confirm-text">Supprimer ce type ? Ses réservations sont conservées.</span>
            <span className="spacer" />
            <button type="button" className="btn ghost" onClick={() => setConfirmDelete(false)}>Non</button>
            <button type="button" className="btn danger" disabled={busy} onClick={() => void remove()}>Supprimer</button>
          </div>
        ) : (
          <div className="actions">
            {type && <button type="button" className="btn ghost danger" onClick={() => setConfirmDelete(true)}>Supprimer</button>}
            <span className="spacer" />
            <button type="button" className="btn ghost" onClick={onClose}>Annuler</button>
            <button className="btn primary" disabled={busy}>{type ? 'Enregistrer' : 'Créer'}</button>
          </div>
        )}
      </form>
    </Modal>
  );
}

function TypesTab({ types, reload, notify }: { types: BookingType[]; reload: () => Promise<void>; notify: (msg: string) => void }) {
  const [editing, setEditing] = useState<BookingType | 'new' | null>(null);
  const [local, setLocal] = useState(types);
  useEffect(() => setLocal(types), [types]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      notify(message(err));
    }
    await reload();
  };
  const move = (index: number, delta: number) => {
    const next = [...local];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item);
    setLocal(next);
    void act(() => bookingApi.reorderTypes(next.map((t) => t.id)));
  };
  const toggle = (t: BookingType, active: boolean) => {
    setLocal((list) => list.map((x) => (x.id === t.id ? { ...x, active } : x)));
    void act(() => bookingApi.updateType(t.id, { active }));
  };

  return (
    <>
      <Card
        title="Types de rendez-vous"
        sub="Ce que tes clients peuvent réserver : durée, lieu, délais."
        action={<button className="btn primary" onClick={() => setEditing('new')}><PlusIcon />Nouveau type</button>}
      >
        {local.length === 0 ? (
          <p className="bk-empty">Aucun type pour l’instant. Crée le premier, par exemple « Consultation, 30 min ».</p>
        ) : (
          <ul className="bk-list">
            {local.map((t, i) => (
              <li key={t.id} className={`bk-type${t.active ? '' : ' off'}`}>
                <div className="bk-order">
                  <button className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Monter ${t.name}`}><span className="rot-up"><Chevron dir="left" /></span></button>
                  <button className="icon-btn" disabled={i === local.length - 1} onClick={() => move(i, 1)} aria-label={`Descendre ${t.name}`}><span className="rot-down"><Chevron dir="left" /></span></button>
                </div>
                <div className="bk-type-body">
                  <p className="bk-type-name">{t.name}{!t.active && <span className="tag">Masqué</span>}</p>
                  <p className="bk-meta">
                    {durationLabel(t.durationMin)} · {modeLabel(t) || 'Lieu à préciser'}
                    {(t.bufferBeforeMin > 0 || t.bufferAfterMin > 0) && ` · tampons ${t.bufferBeforeMin}/${t.bufferAfterMin} min`}
                    {` · préavis ${t.minNoticeHours} h · jusqu’à ${t.horizonDays} j`}
                  </p>
                  <p className="bk-meta mono">/rdv/{t.slug}</p>
                </div>
                <Switch checked={t.active} onChange={(v) => toggle(t, v)} label={`Proposer « ${t.name} » sur la page publique`} />
                <button className="btn" onClick={() => setEditing(t)}>Modifier</button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {editing && (
        <TypeDialog
          type={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void reload(); }}
          onDeleted={() => { setEditing(null); void reload(); }}
        />
      )}
    </>
  );
}

// --- horaires et calendriers ---------------------------------------------------

const toTime = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** Lit « 9 », « 9h30 », « 09:30 », « 0930 », « 24:00 » ; null si ce n'est pas une heure. */
function parseTime(value: string, isEnd: boolean): number | null {
  const m = /^(\d{1,2})(?:\s*[:h.]?\s*(\d{2}))?\s*h?$/i.exec(value.trim());
  if (!m) return null;
  const min = Number(m[1]) * 60 + Number(m[2] ?? 0);
  if (Number(m[2] ?? 0) > 59 || min > 1440) return null;
  // Une fin à 00:00 signifie minuit le soir même ; un début à 24:00 n'existe pas.
  if (isEnd) return min === 0 ? 1440 : min;
  return min === 1440 ? null : min;
}

/**
 * Champ d'heure en texte, toujours sur 24 heures (le champ « time » du navigateur suit
 * la langue du système et peut passer en AM/PM). La valeur est validée en quittant le champ.
 */
function TimeField({ value, isEnd, label, invalid, onChange }: { value: number; isEnd: boolean; label: string; invalid?: boolean; onChange: (min: number) => void }) {
  const [text, setText] = useState(() => toTime(value));
  useEffect(() => setText(toTime(value)), [value]);
  const commit = () => {
    const min = parseTime(text, isEnd);
    if (min === null) setText(toTime(value));
    else {
      setText(toTime(min));
      if (min !== value) onChange(min);
    }
  };
  return (
    <input
      type="text"
      inputMode="numeric"
      autoComplete="off"
      maxLength={5}
      placeholder={isEnd ? '12:00' : '09:00'}
      aria-label={label}
      aria-invalid={invalid || undefined}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
    />
  );
}

const sortHours = (list: BookingHoursRange[]) => [...list].sort((a, b) => a.weekday - b.weekday || a.startMin - b.startMin);
const sameHours = (a: BookingHoursRange[], b: BookingHoursRange[]) => JSON.stringify(sortHours(a)) === JSON.stringify(sortHours(b));

/**
 * Horaires hebdomadaires. Le brouillon vit dans l'écran parent : il survit au changement
 * d'onglet et au rafraîchissement automatique (draft null : rien en cours de saisie).
 */
function HoursCard({ hours, draft, setDraft, onSaved, notify }: {
  hours: BookingHoursRange[]; draft: BookingHoursRange[] | null; setDraft: React.Dispatch<React.SetStateAction<BookingHoursRange[] | null>>;
  onSaved: (h: BookingHoursRange[]) => void; notify: (msg: string) => void;
}) {
  // L'ordre de saisie est conservé pendant l'édition (pas de tri qui ferait sauter les lignes).
  const list = draft ?? hours;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = draft !== null && !sameHours(draft, hours);
  // Contrôle avant l'envoi : la plage fautive est marquée et le message nomme le jour.
  const problems = useMemo(() => hoursProblems(list), [list]);
  const problemAt = new Map(problems.map((p) => [p.index, p.message]));
  const edit = (fn: (current: BookingHoursRange[]) => BookingHoursRange[]) => {
    setError(null);
    setDraft((prev) => fn(prev ?? hours));
  };

  const update = (range: BookingHoursRange, patch: Partial<BookingHoursRange>) => edit((current) => current.map((r) => (r === range ? { ...r, ...patch } : r)));
  const add = (weekday: number) => edit((current) => {
    const day = current.filter((r) => r.weekday === weekday);
    const last = day.reduce((max, r) => Math.max(max, r.endMin), 0);
    const startMin = day.length === 0 ? 540 : Math.min(last + 60, 1380);
    return [...current, { weekday, startMin, endMin: Math.min(startMin + (day.length === 0 ? 180 : 120), 1440) }];
  });
  const remove = (range: BookingHoursRange) => edit((current) => current.filter((r) => r !== range));

  const save = async () => {
    if (problems.length > 0) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await bookingApi.saveHours(sortHours(list)));
      setDraft(null);
      notify('Horaires enregistrés');
    } catch (err) {
      setError(err instanceof ApiError && err.fields?.hours ? err.fields.hours : message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Horaires hebdomadaires" sub="Les créneaux ne sont proposés qu’à l’intérieur de ces plages, hors de tes événements.">
      <ul className="bk-hours">
        {WEEKDAYS.map((name, i) => {
          const weekday = i + 1;
          const ranges = list.filter((r) => r.weekday === weekday);
          return (
            <li key={weekday} className={ranges.length === 0 ? 'closed' : ''}>
              <span className="bk-dayname">{name}</span>
              <div className="bk-ranges">
                {ranges.length === 0 && <span className="bk-closed">Fermé</span>}
                {ranges.map((r, j) => {
                  const invalid = problemAt.has(list.indexOf(r));
                  return (
                    <span key={j} className={`bk-range${invalid ? ' invalid' : ''}`}>
                      <TimeField value={r.startMin} isEnd={false} invalid={invalid} label={`${name}, début de la plage ${j + 1}`} onChange={(startMin) => update(r, { startMin })} />
                      <span aria-hidden="true">–</span>
                      <TimeField value={r.endMin} isEnd invalid={invalid} label={`${name}, fin de la plage ${j + 1}`} onChange={(endMin) => update(r, { endMin })} />
                      <button type="button" className="icon-btn" onClick={() => remove(r)} aria-label={`Supprimer la plage ${j + 1} du ${name.toLowerCase()}`}><CloseIcon /></button>
                    </span>
                  );
                })}
              </div>
              <button type="button" className="icon-btn bk-add" onClick={() => add(weekday)} aria-label={`Ajouter une plage le ${name.toLowerCase()}`} title="Ajouter une plage"><PlusIcon /></button>
            </li>
          );
        })}
      </ul>
      {problems.length > 0 && (
        <p className="form-error" role="alert">
          {problems[0].message}{problems.length > 1 ? ` (et ${problems.length - 1} autre${problems.length > 2 ? 's' : ''} plage${problems.length > 2 ? 's' : ''} à corriger)` : ''}.
        </p>
      )}
      {error && problems.length === 0 && <p className="form-error" role="alert">{error}</p>}
      {dirty && (
        <div className="bk-savebar">
          <span>Modifications non enregistrées</span>
          <button className="btn ghost" onClick={() => { setDraft(null); setError(null); }}>Annuler</button>
          <button className="btn primary" disabled={busy || problems.length > 0} onClick={() => void save()}>Enregistrer les horaires</button>
        </div>
      )}
    </Card>
  );
}

function BlockingCard({ calendars, allDayBlocks, onChange, onAllDay }: {
  calendars: CalendarInfo[]; allDayBlocks: boolean; onChange: (c: CalendarInfo, blocks: boolean) => void; onAllDay: (blocks: boolean) => void;
}) {
  return (
    <Card title="Calendriers qui bloquent les créneaux" sub="Un événement d’un calendrier coché rend le créneau indisponible, même si le calendrier est masqué. Les événements marqués « disponible » ne bloquent pas.">
      {calendars.length === 0 ? <p className="bk-empty">Aucun calendrier pour l’instant.</p> : (
        <div className="bk-cals">
          {calendars.map((c) => (
            <label key={c.id} className="cal-item" style={{ '--c': c.color } as React.CSSProperties}>
              <input type="checkbox" checked={c.blocksBooking} onChange={(e) => onChange(c, e.target.checked)} />
              <span className="swatch" />
              <span className="cal-name">{c.name}</span>
            </label>
          ))}
        </div>
      )}
      <div className="bk-option">
        <label className="check">
          <input type="checkbox" checked={allDayBlocks} onChange={(e) => onAllDay(e.target.checked)} />
          Une journée entière bloque toujours toute la journée
        </label>
        <p className="bk-hint">
          Apple Calendar marque « disponible » les journées entières qu’il crée, congés compris. Case cochée, elles bloquent quand même.
          Décoche-la si tes journées entières sont surtout des rappels, ou décoche plus haut le calendrier qui les porte (anniversaires, jours fériés).
        </p>
      </div>
    </Card>
  );
}

// --- réglages ------------------------------------------------------------------

/** Réglages de la page publique. Comme pour les horaires, le brouillon vit dans l'écran parent. */
function SettingsCard({ state, calendars, draft, setDraft, onSaved, notify }: {
  state: BookingAdminState; calendars: CalendarInfo[]; draft: BookingSettings | null; setDraft: (d: BookingSettings | null) => void;
  onSaved: (s: BookingAdminState) => void; notify: (msg: string) => void;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const s = state.settings;
  const d = draft ?? s;
  const setD = setDraft;
  const dirty = d.publicName !== s.publicName || d.welcomeText !== s.welcomeText || d.calendarId !== s.calendarId || d.slotStepMin !== s.slotStepMin;
  const writable = calendars.filter((c) => !c.readOnly);
  const effective = calendars.find((c) => c.id === state.effectiveCalendarId);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      onSaved(await bookingApi.saveSettings({ publicName: d.publicName.trim(), welcomeText: d.welcomeText, calendarId: d.calendarId, slotStepMin: d.slotStepMin }));
      setDraft(null);
      notify('Réglages enregistrés');
    } catch (err) {
      if (err instanceof ApiError && err.fields) setErrors(err.fields);
      else notify(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Page publique" sub="Ce que voient tes clients, et où atterrissent les rendez-vous.">
      <form className="bk-form" onSubmit={(e) => void save(e)}>
        <div className="bk-grid">
          <Fld label="Nom affiché" error={errors.publicName} className="span-2">
            {(id) => <input id={id} type="text" maxLength={100} value={d.publicName} onChange={(e) => setD({ ...d, publicName: e.target.value })} />}
          </Fld>
          <Fld label="Texte d’accueil" error={errors.welcomeText} hint="Affiché en haut de la page, sous le titre. Texte simple." className="span-2">
            {(id) => <textarea id={id} rows={3} maxLength={2000} value={d.welcomeText} onChange={(e) => setD({ ...d, welcomeText: e.target.value })} />}
          </Fld>
          <Fld label="Calendrier des rendez-vous" error={errors.calendarId} hint={d.calendarId === null && effective ? `Actuellement : ${effective.name}.` : undefined}>
            {(id) => (
              <select id={id} value={d.calendarId ?? ''} onChange={(e) => setD({ ...d, calendarId: e.target.value || null })}>
                <option value="">Automatique (premier calendrier modifiable)</option>
                {writable.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
          </Fld>
          <div className="fld">
            <span className="fld-label" id="bk-step-label">Pas des créneaux</span>
            <div className="seg bk-seg" role="radiogroup" aria-labelledby="bk-step-label">
              {([15, 30, 60] as BookingStep[]).map((step) => (
                <button key={step} type="button" role="radio" aria-checked={d.slotStepMin === step} className={d.slotStepMin === step ? 'active' : ''} onClick={() => setD({ ...d, slotStepMin: step })}>
                  {step} min
                </button>
              ))}
            </div>
            {errors.slotStepMin && <p className="fld-err" role="alert">{errors.slotStepMin}</p>}
          </div>
        </div>
        <div className="bk-savebar static">
          {dirty && <span>Modifications non enregistrées</span>}
          {dirty && <button type="button" className="btn ghost" onClick={() => { setDraft(null); setErrors({}); }}>Annuler</button>}
          <button className="btn primary" disabled={busy || !dirty}>Enregistrer</button>
        </div>
      </form>
    </Card>
  );
}

// --- réservations --------------------------------------------------------------

function BookingRow({ b, timezone, mailConfigured, onCancel, onResend }: {
  b: Booking; timezone: string; mailConfigured: boolean; onCancel: (b: Booking) => void; onResend: (b: Booking) => void;
}) {
  const confirmed = b.status === 'confirmed';
  const upcoming = confirmed && new Date(b.end).getTime() > Date.now();
  return (
    <li className={`bk-booking${confirmed ? '' : ' cancelled'}`}>
      <div className="bk-when">
        <span className="bk-when-day">{dayLabel(dayKeyIn(timezone, new Date(b.start)))}</span>
        <span className="bk-when-time">{timeIn(timezone, b.start)} – {timeIn(timezone, b.end)}</span>
      </div>
      <div className="bk-who">
        <p className="bk-who-name">{b.name} <span className="bk-meta">· {b.typeName}</span></p>
        <p className="bk-meta bk-contacts">
          <a href={`mailto:${b.email}`}>{b.email}</a>
          {b.phone && <a href={`tel:${b.phone.replace(/[^\d+]/g, '')}`}>{b.phone}</a>}
          {b.location && <span>{b.location}</span>}
          {b.videoUrl && <a href={b.videoUrl} target="_blank" rel="noopener">Rejoindre la visio</a>}
        </p>
        {b.message && <p className="bk-message">{b.message}</p>}
        <div className="bk-flags">
          {!confirmed && (
            <span className="tag">
              Annulée {b.cancelledBy === 'client' ? 'par le client' : 'par toi'}{b.cancelledAt ? ` le ${dateTimeShortIn(timezone, b.cancelledAt)}` : ''}
            </span>
          )}
          {b.eventState === 'missing' && (
            <span className="tag danger" title="L’événement n’est plus dans le calendrier. Le créneau reste pris : annule la réservation pour prévenir le client et le libérer.">
              <AlertIcon />Événement supprimé du calendrier
            </span>
          )}
          {b.eventState === 'moved' && b.notifiedStart && (
            <span className="tag warn" title="L’événement a été déplacé dans le calendrier : la réservation suit le nouvel horaire. Le client n’est pas prévenu automatiquement.">
              <AlertIcon />Déplacé : le client a reçu l’horaire du {dateTimeShortIn(timezone, b.notifiedStart)}
            </span>
          )}
          {b.mailError && <span className="tag warn"><AlertIcon />{b.mailError}</span>}
        </div>
        {b.eventState === 'missing' && <p className="bk-hint">Le créneau reste pris. Annule la réservation pour prévenir le client et libérer le créneau.</p>}
        {b.eventState === 'moved' && (
          <p className="bk-hint">
            {mailConfigured ? '« Renvoyer l’e-mail » lui annonce le nouvel horaire.' : 'Pense à lui annoncer le nouvel horaire toi-même.'}
          </p>
        )}
      </div>
      {upcoming && (
        <div className="bk-row-actions">
          {mailConfigured && <button className="btn ghost small" onClick={() => onResend(b)}>Renvoyer l’e-mail</button>}
          <button className="btn small danger" onClick={() => onCancel(b)}>Annuler</button>
        </div>
      )}
    </li>
  );
}

function CancelDialog({ b, timezone, mailConfigured, onDone, onClose }: { b: Booking; timezone: string; mailConfigured: boolean; onDone: () => void; onClose: () => void }) {
  const [notifyClient, setNotifyClient] = useState(mailConfigured);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const confirm = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await bookingApi.cancelBooking(b.id, notifyClient);
      onDone();
    } catch (err) {
      setFailure(message(err));
      setBusy(false);
    }
  };
  return (
    <Modal title="Annuler ce rendez-vous ?" onClose={onClose} small>
      <p className="bk-dialog-text">
        {b.typeName} avec <strong>{b.name}</strong>, {dateTimeShortIn(timezone, b.start)}. L’événement est retiré de ton calendrier et le créneau redevient libre.
      </p>
      <label className="check">
        <input type="checkbox" checked={notifyClient} disabled={!mailConfigured} onChange={(e) => setNotifyClient(e.target.checked)} />
        Prévenir le client par e-mail
      </label>
      {!mailConfigured && <p className="bk-hint">L’envoi d’e-mails n’est pas configuré : pense à prévenir {b.name} toi-même.</p>}
      {failure && <p className="form-error" role="alert">{failure}</p>}
      <div className="actions">
        <span className="spacer" />
        <button type="button" className="btn ghost" onClick={onClose}>Garder</button>
        <button type="button" className="btn danger" disabled={busy} onClick={() => void confirm()}>Annuler le rendez-vous</button>
      </div>
    </Modal>
  );
}

// --- écran ---------------------------------------------------------------------

/** Lien direct vers le formulaire d'envoi des e-mails ; l'adresse revient ensuite à celle de l'onglet. */
const MAIL_HASH = '#rendez-vous/reglages/e-mails';

export function BookingAdmin({ onMenu, onCalendarChanged }: { onMenu: () => void; onCalendarChanged: () => void }) {
  const [tab, setTab] = useState<Tab>(() => (location.hash.startsWith('#rendez-vous/reglages') ? 'settings' : 'bookings'));
  const connections = useConnections();
  /**
   * Demande, consommée une fois, d'amener le focus sur le formulaire d'envoi des e-mails :
   * posée par le bandeau « Configurer l'envoi » ou par un lien #rendez-vous/reglages/e-mails,
   * jamais par la simple ouverture de l'onglet ni par un rechargement.
   */
  const [mailFocus, setMailFocus] = useState(() => (location.hash === MAIL_HASH ? 1 : 0));
  const [smtpDraft, setSmtpDraft] = useState<SmtpDraft | null>(null);
  const [state, setState] = useState<BookingAdminState | null>(null);
  const [types, setTypes] = useState<BookingType[]>([]);
  const [hours, setHours] = useState<BookingHoursRange[]>([]);
  // Saisies en cours : gardées ici pour survivre au changement d'onglet et au rafraîchissement
  // automatique, qui ne remplace que les valeurs du serveur.
  const [hoursDraft, setHoursDraft] = useState<BookingHoursRange[] | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<BookingSettings | null>(null);
  const [calendars, setCalendars] = useState<CalendarInfo[]>([]);
  const [upcoming, setUpcoming] = useState<Booking[]>([]);
  const [past, setPast] = useState<Booking[]>([]);
  const [scope, setScope] = useState<'upcoming' | 'past'>('upcoming');
  const [cancelling, setCancelling] = useState<Booking | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const notify = useCallback((msg: string) => setToast(msg), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const reload = useCallback(async () => {
    try {
      const [s, t, h, c, up, pa] = await Promise.all([
        bookingApi.state(), bookingApi.types(), bookingApi.hours(), bookingApi.calendars(), bookingApi.bookings('upcoming'), bookingApi.bookings('past'),
      ]);
      setState(s);
      setTypes(t);
      setHours(h);
      setCalendars(c);
      setUpcoming(up);
      setPast(pa);
      setLoadError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      setLoadError(message(err));
    }
  }, []);
  useEffect(() => void reload(), [reload]);

  // Les réservations arrivent de l'extérieur : rafraîchissement régulier et au retour sur l'app.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') void reload();
    };
    const t = setInterval(refresh, 60_000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [reload]);

  const lastMailError = useMemo(
    () => [...upcoming, ...past].filter((b) => b.mailError).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null,
    [upcoming, past],
  );

  const setEnabled = async (enabled: boolean) => {
    setState((s) => (s ? { ...s, settings: { ...s.settings, enabled } } : s));
    try {
      setState(await bookingApi.saveSettings({ enabled }));
    } catch (err) {
      notify(message(err));
      void reload();
    }
  };

  const setAllDayBlocks = async (allDayBlocks: boolean) => {
    setState((s) => (s ? { ...s, settings: { ...s.settings, allDayBlocks } } : s));
    try {
      setState(await bookingApi.saveSettings({ allDayBlocks }));
    } catch (err) {
      notify(message(err));
      void reload();
    }
  };

  const copyLink = async () => {
    if (!state) return;
    try {
      await navigator.clipboard.writeText(state.publicPageUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      notify('Copie impossible : sélectionne le lien à la main.');
    }
  };

  const setBlocks = async (c: CalendarInfo, blocksBooking: boolean) => {
    setCalendars((list) => list.map((x) => (x.id === c.id ? { ...x, blocksBooking } : x)));
    try {
      await bookingApi.setCalendarBlocks(c.id, blocksBooking);
      onCalendarChanged();
    } catch (err) {
      notify(message(err));
    }
    void reload();
  };

  const resend = async (b: Booking) => {
    try {
      const res = await bookingApi.resendConfirmation(b.id);
      notify(res.mailError
        ? `E-mail non envoyé : ${res.mailError}. Le lien d’annulation que le client a déjà reste valable.`
        : `Confirmation renvoyée à ${b.email} (nouveau lien d’annulation).`);
    } catch (err) {
      notify(message(err));
    }
    void reload();
  };

  // L'adresse suit l'onglet Réglages : un rechargement ou un lien y ramène.
  useEffect(() => {
    const hash = tab === 'settings' ? '#rendez-vous/reglages' : '#rendez-vous';
    if (location.hash.startsWith('#rendez-vous') && location.hash !== hash) history.replaceState(null, '', location.pathname + location.search + hash);
  }, [tab]);

  const openMailSettings = () => {
    setTab('settings');
    setMailFocus((n) => n + 1);
  };
  const clearMailFocus = useCallback(() => setMailFocus(0), []);
  const mailWarning = (w: string) => /^(L’envoi d’e-mails n’est pas configuré|Le dernier essai d’envoi d’e-mails a échoué)/.test(w);
  const smtpDirty = connections.state !== null && smtpDraftDirty(connections.state.smtp, smtpDraft);

  const hoursDirty = hoursDraft !== null && !sameHours(hoursDraft, hours);
  const settingsDirty = settingsDraft !== null && state !== null && (['publicName', 'welcomeText', 'calendarId', 'slotStepMin'] as const).some((k) => settingsDraft[k] !== state.settings[k]);
  const list = scope === 'upcoming' ? upcoming : past;
  const attention = upcoming.filter((b) => b.eventState === 'missing' || b.eventState === 'moved').length;

  return (
    <main className="main bk-main">
      <header className="toolbar">
        <button className="icon-btn menu-btn" onClick={onMenu} aria-label="Menu"><MenuIcon /></button>
        <h1>Rendez-vous</h1>
      </header>
      <div className="bk-scroll">
        <div className="bk">
          {loadError && !state && (
            <div className="bk-card"><p className="form-error" role="alert">{loadError}</p><button className="btn" onClick={() => void reload()}>Réessayer</button></div>
          )}
          {state && (
            <>
              <section className={`bk-card bk-hero${state.settings.enabled ? ' on' : ''}`}>
                <div className="bk-hero-main">
                  <Switch checked={state.settings.enabled} onChange={(v) => void setEnabled(v)} label="Ouvrir la prise de rendez-vous" />
                  <div>
                    <h2>{state.settings.enabled ? 'La prise de rendez-vous est ouverte' : 'La prise de rendez-vous est fermée'}</h2>
                    <p>{state.settings.enabled ? 'Tes clients peuvent réserver un créneau libre depuis la page publique.' : 'La page publique n’accepte aucune réservation tant que tu ne l’ouvres pas.'}</p>
                  </div>
                </div>
                <div className="bk-link">
                  <span className="bk-link-label">Lien public</span>
                  <code className="bk-url">{state.publicPageUrl}</code>
                  <button className="btn" onClick={() => void copyLink()}>{copied ? <CheckIcon /> : <CopyIcon />}{copied ? 'Copié' : 'Copier'}</button>
                  <a className="btn" href="/rdv" target="_blank" rel="noopener"><ExternalIcon />Ouvrir</a>
                </div>
                {state.warnings.filter((w) => !/^La prise de rendez-vous est fermée/.test(w)).length > 0 && (
                  <ul className="bk-warnings">
                    {state.warnings.filter((w) => !/^La prise de rendez-vous est fermée/.test(w)).map((w) => (
                      <li key={w}>
                        <AlertIcon />
                        {mailWarning(w) ? (
                          <span>
                            {w.startsWith('L’envoi') ? 'L’envoi d’e-mails n’est pas configuré : les réservations fonctionnent, mais aucun e-mail ne part.' : w}
                            <button type="button" className="cx-link" onClick={openMailSettings}>{w.startsWith('L’envoi') ? 'Configurer l’envoi' : 'Corriger l’envoi'}</button>
                          </span>
                        ) : <span>{w}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <div className="seg bk-tabs" role="tablist" aria-label="Rubriques">
                {TABS.map(([key, label]) => (
                  <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
                    {label}
                    {key === 'bookings' && upcoming.length > 0 && <span className={`bk-count${attention > 0 ? ' alert' : ''}`}>{upcoming.length}</span>}
                    {((key === 'hours' && hoursDirty) || (key === 'settings' && (settingsDirty || smtpDirty))) && (
                      <span className="bk-unsaved" title="Modifications non enregistrées"><span className="sr-only">(modifications non enregistrées)</span></span>
                    )}
                  </button>
                ))}
              </div>

              {tab === 'bookings' && (
                <Card
                  title={scope === 'upcoming' ? 'Réservations à venir' : 'Réservations passées ou annulées'}
                  sub={scope === 'upcoming' ? 'Chaque réservation crée un événement dans ton calendrier.' : undefined}
                  action={(
                    <div className="seg small bk-scope" role="radiogroup" aria-label="Période">
                      <button role="radio" aria-checked={scope === 'upcoming'} className={scope === 'upcoming' ? 'active' : ''} onClick={() => setScope('upcoming')}>À venir</button>
                      <button role="radio" aria-checked={scope === 'past'} className={scope === 'past' ? 'active' : ''} onClick={() => setScope('past')}>Passées</button>
                    </div>
                  )}
                >
                  {list.length === 0 ? (
                    <p className="bk-empty">{scope === 'upcoming' ? 'Aucune réservation à venir.' : 'Rien pour l’instant.'}</p>
                  ) : (
                    <ul className="bk-list">
                      {list.map((b) => (
                        <BookingRow key={b.id} b={b} timezone={state.timezone} mailConfigured={state.mail.configured} onCancel={setCancelling} onResend={(x) => void resend(x)} />
                      ))}
                    </ul>
                  )}
                </Card>
              )}
              {tab === 'types' && <TypesTab types={types} reload={reload} notify={notify} />}
              {tab === 'hours' && (
                <>
                  <HoursCard hours={hours} draft={hoursDraft} setDraft={setHoursDraft} onSaved={(h) => { setHours(h); void reload(); }} notify={notify} />
                  <BlockingCard calendars={calendars} allDayBlocks={state.settings.allDayBlocks} onChange={(c, v) => void setBlocks(c, v)} onAllDay={(v) => void setAllDayBlocks(v)} />
                </>
              )}
              {tab === 'settings' && (
                <>
                  <SettingsCard state={state} calendars={calendars} draft={settingsDraft} setDraft={setSettingsDraft} onSaved={setState} notify={notify} />
                  {connections.state ? (
                    <SmtpCard
                      id="bk-mail" state={connections.state} notify={notify} autoFocus={mailFocus} onFocused={clearMailFocus}
                      draft={smtpDraft} setDraft={setSmtpDraft}
                      onState={(next) => { connections.set(next); void reload(); }}
                    >
                      {state.mail.configured && (
                        <div>
                          <dt>Envois sur 24 h</dt>
                          <dd className={state.mail.sentLast24h >= state.mail.dailyLimit ? 'bk-err-text' : undefined}>
                            {state.mail.sentLast24h} sur {state.mail.dailyLimit} au plus{state.mail.sentLast24h >= state.mail.dailyLimit ? ' : plafond atteint, plus rien ne part' : ''}
                          </dd>
                        </div>
                      )}
                      <div>
                        <dt>Dernière erreur</dt>
                        <dd>
                          {lastMailError
                            ? <span className="bk-err-text">{lastMailError.mailError} <span className="bk-meta">(réservation de {lastMailError.name}, {dateTimeShortIn(state.timezone, lastMailError.start)})</span></span>
                            : 'Aucune'}
                        </dd>
                      </div>
                    </SmtpCard>
                  ) : connections.error ? (
                    <div className="bk-card"><p className="form-error" role="alert">{connections.error}</p><button className="btn" onClick={() => void connections.reload()}>Réessayer</button></div>
                  ) : null}
                </>
              )}
            </>
          )}
        </div>
      </div>
      {cancelling && state && (
        <CancelDialog
          b={cancelling}
          timezone={state.timezone}
          mailConfigured={state.mail.configured}
          onClose={() => setCancelling(null)}
          onDone={() => { setCancelling(null); notify('Rendez-vous annulé'); onCalendarChanged(); void reload(); }}
        />
      )}
      {toast && <div className="toast" role="status" onClick={() => setToast(null)}>{toast}</div>}
    </main>
  );
}
