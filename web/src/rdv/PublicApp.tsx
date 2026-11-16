import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { BookingConfirmation, BookingMode, BookingRequest, PublicBooking, PublicBookingInfo, PublicBookingType, PublicSlots } from '../../../shared/types';
import { ApiError, requestJson } from '../http';
import { AlertIcon, ArrowLeftIcon, CalendarIcon, CheckIcon, Chevron, ClockIcon, PhoneIcon, PinIcon, UserIcon, VideoIcon } from '../icons';
import { MoonIcon, SunIcon, useTheme } from '../theme';
import {
  addDaysKey, addMonths, dayKeyIn, dayLabel, dayLongIn, dayNumber, durationLabel, firstDayOf, hourIn, lastDayOf,
  monthLabel, monthOf, monthWeeks, timeIn, timezoneLabel,
} from './tz';
import './rdv.css';

// La page publique n'appelle que /api/public/booking/* : rien de privé, pas de session.
const BASE = '/api/public/booking';
const publicApi = {
  info: () => requestJson<PublicBookingInfo>('GET', BASE),
  slots: (slug: string, from: string, to: string) =>
    requestJson<PublicSlots>('GET', `${BASE}/types/${encodeURIComponent(slug)}/slots?from=${from}&to=${to}`),
  book: (body: BookingRequest) => requestJson<BookingConfirmation>('POST', `${BASE}/book`, body),
  getByToken: (token: string) => requestJson<PublicBooking>('GET', `${BASE}/cancel/${token || '-'}`),
  cancel: (token: string) => requestJson<PublicBooking>('POST', `${BASE}/cancel/${token || '-'}`),
};

/** Message d'erreur pour le client (vouvoiement), d'après le code de l'API. */
function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'network') return 'Connexion impossible. Vérifiez votre réseau, puis réessayez.';
    if (err.code === 'rate_limited') return 'Trop de demandes en peu de temps. Patientez quelques minutes, puis réessayez.';
    if (err.code === 'calendar_unavailable' || err.code === 'busy') return 'Le service est momentanément indisponible. Rien n’a été enregistré : réessayez dans un instant.';
    if (err.code === 'rejected') return 'Votre demande n’a pas pu être envoyée. Rechargez la page, puis réessayez.';
    if (err.status >= 500) return 'Une erreur est survenue. Réessayez dans un instant.';
    return err.message;
  }
  return 'Une erreur est survenue. Réessayez dans un instant.';
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? 'A') + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
}

function ModeIcon({ mode }: { mode: BookingMode }) {
  if (mode === 'telephone') return <PhoneIcon />;
  if (mode === 'visio') return <VideoIcon />;
  return <PinIcon />;
}

// --- cadre commun ---------------------------------------------------------------

function Shell({ name, children }: { name: string; children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <div className="rdv">
      <div className="rdv-page">
        <header className="rdv-top">
          <span className="rdv-avatar" aria-hidden="true">{initials(name || 'Alfred')}</span>
          <div className="rdv-id">
            <p className="rdv-name">{name || 'Rendez-vous'}</p>
            <p className="rdv-kicker">Prise de rendez-vous en ligne</p>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={theme.toggle}
            aria-label={theme.dark ? 'Passer en thème clair' : 'Passer en thème sombre'}
            title={theme.dark ? 'Thème clair' : 'Thème sombre'}
          >
            {theme.dark ? <SunIcon /> : <MoonIcon />}
          </button>
        </header>
        <main className="rdv-main">{children}</main>
      </div>
    </div>
  );
}

function Notice({ kind, children, action }: { kind: 'error' | 'warn' | 'info'; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className={`rdv-notice ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <AlertIcon />
      <div className="rdv-notice-text">{children}</div>
      {action}
    </div>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <div className="rdv-loading" role="status" aria-live="polite">
      <span className="rdv-spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

/** Titre d'étape : reçoit le focus à chaque changement d'écran (lecteurs d'écran, clavier). */
function StepTitle({ children, sub }: { children: string; sub?: React.ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div className="rdv-title">
      <h1 ref={ref} tabIndex={-1}>
        {/* « rendez-vous » ne se coupe pas au trait d'union en fin de ligne. */}
        {typeof children === 'string'
          ? children.split(/(rendez-vous)/).map((part, i) => (part === 'rendez-vous' ? <span key={i} className="nb">{part}</span> : part))
          : children}
      </h1>
      {sub && <p>{sub}</p>}
    </div>
  );
}

function Steps({ current }: { current: 1 | 2 | 3 }) {
  const labels = ['Type', 'Créneau', 'Coordonnées'];
  return (
    <ol className="rdv-steps" aria-label="Étapes de la réservation">
      {labels.map((label, i) => (
        <li key={label} className={i + 1 === current ? 'current' : i + 1 < current ? 'done' : ''} aria-current={i + 1 === current ? 'step' : undefined}>
          <span className="rdv-step-num" aria-hidden="true">{i + 1 < current ? <CheckIcon /> : i + 1}</span>
          <span>{label}</span>
        </li>
      ))}
    </ol>
  );
}

/** Récapitulatif d'un rendez-vous : type, date, heure, lieu. */
function Recap({ typeName, start, end, timezone, location, mode, name }: {
  typeName: string; start: string; end: string; timezone: string; location: string; mode?: BookingMode; name?: string;
}) {
  return (
    <dl className="rdv-recap">
      <div className="rdv-recap-head">
        <dt className="sr-only">Rendez-vous</dt>
        <dd>{typeName}</dd>
      </div>
      <div>
        <dt><CalendarIcon /><span className="sr-only">Date</span></dt>
        <dd className="cap">{dayLongIn(timezone, start)}</dd>
      </div>
      <div>
        <dt><ClockIcon /><span className="sr-only">Heure</span></dt>
        <dd>
          {timeIn(timezone, start)} – {timeIn(timezone, end)}
          <span className="rdv-tz">{timezoneLabel(timezone)}</span>
        </dd>
      </div>
      {location && (
        <div>
          <dt><ModeIcon mode={mode ?? 'cabinet'} /><span className="sr-only">Lieu</span></dt>
          <dd>{location}</dd>
        </div>
      )}
      {name && (
        <div>
          <dt><UserIcon /><span className="sr-only">Nom</span></dt>
          <dd>{name}</dd>
        </div>
      )}
    </dl>
  );
}

// --- créneaux ---------------------------------------------------------------------

interface SlotsState {
  days: Map<string, string[]>;
  loaded: Set<string>;
  loading: boolean;
  error: string | null;
  /** Vrai après la première réponse : on sait s'il existe au moins un créneau. */
  ready: boolean;
}

const EMPTY_SLOTS: SlotsState = { days: new Map(), loaded: new Set(), loading: true, error: null, ready: false };
const PROBE_DAYS = 61;

/** Charge les créneaux d'un type, mois par mois, et propose le premier jour libre. */
function useSlots(type: PublicBookingType, timezone: string, preferredDay: string | null) {
  const today = useMemo(() => dayKeyIn(timezone, new Date()), [timezone]);
  const lastDay = useMemo(() => addDaysKey(today, type.horizonDays), [today, type.horizonDays]);
  const [state, setState] = useState<SlotsState>(EMPTY_SLOTS);
  const [month, setMonth] = useState(() => monthOf(today));
  const [day, setDay] = useState<string | null>(preferredDay);
  const dayRef = useRef(day);
  dayRef.current = day;
  const generation = useRef(0);

  const fetchRange = useCallback(async (from: string, to: string, months: string[], first: boolean) => {
    const gen = generation.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await publicApi.slots(type.slug, from, to);
      if (gen !== generation.current) return;
      setState((s) => {
        const days = new Map(s.days);
        for (const d of res.days) days.set(d.date, d.slots);
        return { days, loaded: new Set([...s.loaded, ...months]), loading: false, error: null, ready: true };
      });
      if (first && res.days.length > 0) {
        // Premier chargement : ouvrir le mois du premier jour libre et le présélectionner
        // (ou garder le jour déjà choisi s'il est encore libre, au retour du formulaire).
        const current = dayRef.current;
        const keep = current && res.days.some((d) => d.date === current) ? current : res.days[0].date;
        setDay(keep);
        setMonth(monthOf(keep));
      } else if (first) {
        setDay(null);
      }
    } catch (err) {
      if (gen !== generation.current) return;
      setState((s) => ({ ...s, loading: false, error: errorText(err), ready: s.ready }));
    }
  }, [type.slug]);

  // Sonde initiale : de aujourd'hui à 61 jours (limite de l'API : 62 jours par appel).
  const probe = useCallback(() => {
    generation.current++;
    setState(EMPTY_SLOTS);
    const to = addDaysKey(today, PROBE_DAYS) < lastDay ? addDaysKey(today, PROBE_DAYS) : lastDay;
    // Mois entièrement couverts par la sonde (le dernier l'est si la sonde va jusqu'à l'horizon).
    const months: string[] = [];
    for (let m = monthOf(today); m <= monthOf(to); m = addMonths(m, 1)) {
      if (lastDayOf(m) <= to || to === lastDay) months.push(m);
    }
    void fetchRange(today, to, months, true);
  }, [today, lastDay, fetchRange]);

  useEffect(() => probe(), [probe]);

  // Mois affiché pas encore chargé (au-delà de la sonde) : on le demande.
  useEffect(() => {
    if (!state.ready || state.loading || state.error || state.loaded.has(month)) return;
    void fetchRange(firstDayOf(month), lastDayOf(month), [month], false);
  }, [month, state.ready, state.loading, state.error, state.loaded, fetchRange]);

  return {
    ...state, today, month, day, setDay,
    minMonth: monthOf(today), maxMonth: monthOf(lastDay),
    setMonth: (m: string) => setMonth(m),
    retry: () => (state.ready ? setState((s) => ({ ...s, error: null })) : probe()),
  };
}

const DOW = [['L', 'lundi'], ['M', 'mardi'], ['M', 'mercredi'], ['J', 'jeudi'], ['V', 'vendredi'], ['S', 'samedi'], ['D', 'dimanche']];

function SlotPicker({ type, timezone, preferredDay, onPick }: {
  type: PublicBookingType; timezone: string; preferredDay: string | null; onPick: (start: string) => void;
}) {
  const s = useSlots(type, timezone, preferredDay);
  const weeks = useMemo(() => monthWeeks(s.month), [s.month]);
  const slots = s.day ? s.days.get(s.day) ?? [] : [];
  // Rien du tout : tous les mois jusqu'à l'horizon sont chargés et aucun n'a de créneau.
  const noneAtAll = s.ready && !s.loading && !s.error && s.days.size === 0 && s.loaded.has(s.maxMonth);
  const monthEmpty = s.loaded.has(s.month) && ![...s.days.keys()].some((d) => monthOf(d) === s.month);
  const groups = useMemo(() => {
    const parts: [string, string[]][] = [['Matin', []], ['Après-midi', []], ['Soir', []]];
    for (const iso of slots) {
      const h = hourIn(timezone, iso);
      parts[h < 12 ? 0 : h < 18 ? 1 : 2][1].push(iso);
    }
    return parts.filter(([, list]) => list.length > 0);
  }, [slots, timezone]);

  if (!s.ready && s.loading) return <Loading label="Recherche des créneaux libres…" />;
  if (!s.ready && s.error) {
    return <Notice kind="error" action={<button type="button" className="btn" onClick={s.retry}>Réessayer</button>}>{s.error}</Notice>;
  }
  if (noneAtAll) {
    return (
      <div className="rdv-empty">
        <span className="rdv-empty-icon" aria-hidden="true"><CalendarIcon /></span>
        <h2>Aucun créneau disponible pour le moment</h2>
        <p>Tous les créneaux sont pris pour les prochaines semaines. Revenez un peu plus tard : de nouvelles disponibilités s’ouvrent chaque jour.</p>
      </div>
    );
  }

  return (
    <div className="rdv-picker">
      <section className="rdv-cal" aria-label="Choix du jour">
        <div className="rdv-cal-head">
          <h2 aria-live="polite">{monthLabel(s.month)}</h2>
          <div className="rdv-cal-nav">
            <button type="button" className="icon-btn" onClick={() => s.setMonth(addMonths(s.month, -1))} disabled={s.month <= s.minMonth} aria-label="Mois précédent"><Chevron dir="left" /></button>
            <button type="button" className="icon-btn" onClick={() => s.setMonth(addMonths(s.month, 1))} disabled={s.month >= s.maxMonth} aria-label="Mois suivant"><Chevron dir="right" /></button>
          </div>
        </div>
        <div className={`rdv-cal-grid${s.loading ? ' busy' : ''}`} role="group" aria-label={monthLabel(s.month)}>
          {DOW.map(([short, long], i) => (
            <span key={i} className="rdv-dow"><abbr title={long}>{short}</abbr></span>
          ))}
          {weeks.flat().map((key) => {
            if (monthOf(key) !== s.month) return <span key={key} className="rdv-day-pad" aria-hidden="true" />;
            const count = s.days.get(key)?.length ?? 0;
            const label = count === 0 ? `${dayLabel(key)}, aucun créneau` : `${dayLabel(key)}, ${count} créneau${count > 1 ? 'x' : ''} libre${count > 1 ? 's' : ''}`;
            return (
              <button
                key={key}
                type="button"
                className={`rdv-day${count > 0 ? ' free' : ''}${key === s.day ? ' selected' : ''}${key === s.today ? ' today' : ''}`}
                disabled={count === 0}
                aria-pressed={count > 0 ? key === s.day : undefined}
                aria-label={label}
                onClick={() => s.setDay(key)}
              >
                {dayNumber(key)}
              </button>
            );
          })}
        </div>
        {s.error && <Notice kind="error" action={<button type="button" className="btn small" onClick={s.retry}>Réessayer</button>}>{s.error}</Notice>}
        {!s.error && monthEmpty && <p className="rdv-cal-note">Aucun créneau libre ce mois-ci.</p>}
        {!s.error && !monthEmpty && (
          <p className="rdv-cal-note legend"><span className="rdv-legend-dot" aria-hidden="true" />Jours avec des créneaux libres</p>
        )}
      </section>

      <section className="rdv-slots" aria-label="Choix de l’heure">
        {s.day && slots.length > 0 ? (
          <>
            <h2 className="cap">{dayLabel(s.day)}</h2>
            {groups.map(([label, list]) => (
              <div key={label} className="rdv-slot-group">
                <h3>{label}</h3>
                <ul>
                  {list.map((iso) => (
                    <li key={iso}>
                      <button type="button" className="rdv-slot" onClick={() => onPick(iso)} aria-label={`${timeIn(timezone, iso)}, ${dayLabel(s.day!)}`}>
                        {timeIn(timezone, iso)}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </>
        ) : (
          <p className="rdv-slots-empty">{s.loading ? 'Chargement…' : 'Choisissez un jour disponible dans le calendrier pour voir les heures libres.'}</p>
        )}
        <p className="rdv-tz-note"><ClockIcon />Heures affichées en {timezoneLabel(timezone)}.</p>
      </section>
    </div>
  );
}

// --- formulaire ---------------------------------------------------------------------

interface FormValues {
  name: string;
  email: string;
  phone: string;
  message: string;
  trap: string;
}

const EMPTY_FORM: FormValues = { name: '', email: '', phone: '', message: '', trap: '' };

function Field({ label, error, hint, optional, children }: {
  label: string; error?: string; hint?: string; optional?: boolean;
  children: (props: { id: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }) => React.ReactNode;
}) {
  const id = useId();
  const describedBy = error ? `${id}-err` : hint ? `${id}-hint` : undefined;
  return (
    <div className={`fld${error ? ' invalid' : ''}`}>
      <label htmlFor={id}>
        {label}
        {optional && <span className="fld-opt">facultatif</span>}
      </label>
      {children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy })}
      {error ? <p className="fld-err" id={`${id}-err`}>{error}</p> : hint ? <p className="fld-hint" id={`${id}-hint`}>{hint}</p> : null}
    </div>
  );
}

function validate(v: FormValues, phoneRequired: boolean): Record<string, string> {
  const errors: Record<string, string> = {};
  if (v.name.trim().length < 2) errors.name = 'Indiquez votre nom et votre prénom.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email.trim())) errors.email = 'Indiquez une adresse e-mail valide.';
  if (phoneRequired && !v.phone.trim()) errors.phone = 'Indiquez le numéro auquel vous joindre.';
  return errors;
}

function BookingForm({ type, start, timezone, values, onChange, onBack, onDone, onSlotLost, onClosed }: {
  type: PublicBookingType; start: string; timezone: string; values: FormValues;
  onChange: (v: FormValues) => void; onBack: () => void;
  onDone: (c: BookingConfirmation, email: string) => void; onSlotLost: () => void; onClosed: () => void;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const end = new Date(new Date(start).getTime() + type.durationMin * 60_000).toISOString();
  const set = (patch: Partial<FormValues>) => {
    onChange({ ...values, ...patch });
    const key = Object.keys(patch)[0];
    if (errors[key]) setErrors((e) => ({ ...e, [key]: '' }));
  };

  const focusFirstError = () => requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const local = validate(values, type.phoneRequired);
    setErrors(local);
    setFailure(null);
    if (Object.keys(local).length > 0) return focusFirstError();
    setBusy(true);
    try {
      const confirmation = await publicApi.book({
        typeSlug: type.slug, start, name: values.name.trim(), email: values.email.trim(),
        phone: values.phone.trim(), message: values.message.trim(), website: values.trap,
      });
      onDone(confirmation, values.email.trim());
    } catch (err) {
      if (err instanceof ApiError && err.code === 'slot_unavailable') return onSlotLost();
      if (err instanceof ApiError && (err.code === 'closed' || err.code === 'unknown_type')) return onClosed();
      if (err instanceof ApiError && err.code === 'invalid' && err.fields) {
        const { start: _start, typeSlug: _type, ...rest } = err.fields;
        setErrors(rest);
        if (Object.keys(rest).length > 0) return focusFirstError();
      }
      setFailure(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form ref={formRef} className="rdv-form" onSubmit={(e) => void submit(e)} noValidate>
      <Recap typeName={`${type.name} · ${durationLabel(type.durationMin)}`} start={start} end={end} timezone={timezone} location={type.locationLabel} mode={type.mode} />
      <button type="button" className="rdv-link" onClick={onBack}>Choisir un autre créneau</button>

      <Field label="Nom et prénom" error={errors.name}>
        {(p) => <input {...p} type="text" name="name" autoComplete="name" maxLength={80} required value={values.name} onChange={(e) => set({ name: e.target.value })} />}
      </Field>
      <Field label="Adresse e-mail" error={errors.email} hint="La confirmation et le lien d’annulation y sont envoyés.">
        {(p) => <input {...p} type="email" name="email" autoComplete="email" inputMode="email" maxLength={254} required value={values.email} onChange={(e) => set({ email: e.target.value })} />}
      </Field>
      <Field label="Téléphone" error={errors.phone} optional={!type.phoneRequired} hint={type.phoneRequired ? 'Le numéro auquel vous serez appelé.' : undefined}>
        {(p) => <input {...p} type="tel" name="tel" autoComplete="tel" inputMode="tel" maxLength={29} required={type.phoneRequired} value={values.phone} onChange={(e) => set({ phone: e.target.value })} />}
      </Field>
      <Field label="Message" error={errors.message} optional>
        {(p) => <textarea {...p} name="message" rows={3} maxLength={2000} value={values.message} onChange={(e) => set({ message: e.target.value })} />}
      </Field>
      {/* Champ piège : invisible et hors de l'ordre de tabulation, un humain le laisse vide. */}
      <div className="rdv-trap" aria-hidden="true">
        <label htmlFor="rdv-ne-pas-remplir">Ne remplissez pas ce champ</label>
        <input id="rdv-ne-pas-remplir" type="text" name="rdv-ne-pas-remplir" tabIndex={-1} autoComplete="off" value={values.trap} onChange={(e) => set({ trap: e.target.value })} />
      </div>

      {failure && <Notice kind="error">{failure}</Notice>}
      <button className="btn primary rdv-submit" disabled={busy} aria-busy={busy}>
        {busy && <span className="rdv-spinner light" aria-hidden="true" />}
        {busy ? 'Réservation en cours…' : 'Confirmer le rendez-vous'}
      </button>
      <p className="rdv-fine">Vos coordonnées servent uniquement à l’organisation de ce rendez-vous.</p>
    </form>
  );
}

// --- parcours de réservation -----------------------------------------------------------

type Step = 'types' | 'slots' | 'form' | 'done';

function slugFromPath(): string | null {
  const m = /^\/rdv\/([a-z0-9-]+)\/?$/.exec(location.pathname);
  return m ? m[1] : null;
}

function BookingFlow() {
  const [info, setInfo] = useState<PublicBookingInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [slug, setSlug] = useState<string | null>(slugFromPath);
  const [step, setStep] = useState<Step>(() => (slugFromPath() ? 'slots' : 'types'));
  const [start, setStart] = useState<string | null>(null);
  const [values, setValues] = useState<FormValues>(EMPTY_FORM);
  const [done, setDone] = useState<{ confirmation: BookingConfirmation; email: string } | null>(null);
  const [slotLost, setSlotLost] = useState(false);
  const [preferredDay, setPreferredDay] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    publicApi.info().then(setInfo, (err) => setLoadError(errorText(err)));
  }, []);
  useEffect(load, [load]);

  useEffect(() => {
    const onPop = () => {
      const s = slugFromPath();
      setSlug(s);
      setStart(null);
      setStep((prev) => (prev === 'done' ? 'done' : s ? 'slots' : 'types'));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const type = info?.types.find((t) => t.slug === slug) ?? null;
  const name = info?.publicName ?? '';

  useEffect(() => {
    document.title = name ? `Prendre rendez-vous – ${name}` : 'Prendre rendez-vous';
  }, [name]);
  useEffect(() => {
    // Entre accolades : scrollTo peut renvoyer une promesse, qu'un effet ne doit pas retourner.
    window.scrollTo(0, 0);
  }, [step]);

  const go = (path: string) => {
    if (location.pathname !== path) history.pushState(null, '', path);
  };
  const chooseType = (t: PublicBookingType) => {
    go(`/rdv/${t.slug}`);
    setSlug(t.slug);
    setStart(null);
    setSlotLost(false);
    setStep('slots');
  };
  const backToTypes = () => {
    go('/rdv');
    setSlug(null);
    setStart(null);
    setSlotLost(false);
    setStep('types');
  };
  const restart = () => {
    setDone(null);
    setValues(EMPTY_FORM);
    setPreferredDay(null);
    backToTypes();
    load();
  };

  if (loadError) {
    return (
      <Shell name="">
        <div className="rdv-panel">
          <Notice kind="error" action={<button type="button" className="btn" onClick={load}>Réessayer</button>}>{loadError}</Notice>
        </div>
      </Shell>
    );
  }
  if (!info) return <Shell name=""><div className="rdv-panel"><Loading label="Chargement…" /></div></Shell>;

  if (!info.enabled) {
    return (
      <Shell name={name}>
        <div className="rdv-panel rdv-empty">
          <span className="rdv-empty-icon" aria-hidden="true"><CalendarIcon /></span>
          <StepTitle>La prise de rendez-vous n’est pas ouverte</StepTitle>
          <p>Il n’est pas possible de réserver en ligne pour le moment. Revenez un peu plus tard.</p>
        </div>
      </Shell>
    );
  }

  if (step === 'done' && done) {
    const b = done.confirmation.booking;
    let cancelPath = done.confirmation.cancelUrl;
    try {
      cancelPath = new URL(done.confirmation.cancelUrl).pathname;
    } catch {
      // adresse relative : on la garde telle quelle
    }
    return (
      <Shell name={name}>
        <div className="rdv-panel rdv-done">
          <span className="rdv-badge ok" aria-hidden="true"><CheckIcon /></span>
          <StepTitle sub={done.confirmation.emailSent
            ? <>Un e-mail de confirmation vient d’être envoyé à <strong>{done.email}</strong>. Il contient le récapitulatif, un fichier à ajouter à votre agenda et le lien d’annulation.</>
            : undefined}
          >
            Votre rendez-vous est confirmé
          </StepTitle>
          {!done.confirmation.emailSent && (
            <Notice kind="warn">
              Votre rendez-vous est bien enregistré, mais l’e-mail de confirmation n’a pas pu être envoyé. Notez la date et l’heure ci-dessous, et conservez le lien d’annulation.
            </Notice>
          )}
          <Recap typeName={b.typeName} start={b.start} end={b.end} timezone={b.timezone} location={b.locationLabel} mode={type?.mode} name={b.name} />
          <div className="rdv-actions">
            <button type="button" className="btn" onClick={restart}>Prendre un autre rendez-vous</button>
            <a className="rdv-link danger" href={cancelPath}>Annuler ce rendez-vous</a>
          </div>
        </div>
      </Shell>
    );
  }

  if (!type || step === 'types') {
    const unknown = slug !== null && !type;
    return (
      <Shell name={name}>
        <div className="rdv-panel">
          <Steps current={1} />
          <StepTitle sub={info.types.length > 0 ? 'Choisissez le type de rendez-vous qui vous convient.' : undefined}>Prendre rendez-vous</StepTitle>
          {info.welcomeText && <p className="rdv-welcome">{info.welcomeText}</p>}
          {unknown && <Notice kind="warn">Ce type de rendez-vous n’est plus proposé. Choisissez-en un autre ci-dessous.</Notice>}
          {info.types.length === 0 ? (
            <div className="rdv-empty">
              <span className="rdv-empty-icon" aria-hidden="true"><CalendarIcon /></span>
              <h2>Aucun rendez-vous n’est proposé pour le moment</h2>
              <p>Revenez un peu plus tard.</p>
            </div>
          ) : (
            <ul className="rdv-types">
              {info.types.map((t) => (
                <li key={t.slug}>
                  <button type="button" className="rdv-type" onClick={() => chooseType(t)}>
                    <span className="rdv-type-body">
                      <span className="rdv-type-name">{t.name}</span>
                      <span className="rdv-type-meta">
                        <span><ClockIcon />{durationLabel(t.durationMin)}</span>
                        {t.locationLabel && <span><ModeIcon mode={t.mode} />{t.locationLabel}</span>}
                      </span>
                      {t.description && <span className="rdv-type-desc">{t.description}</span>}
                    </span>
                    <span className="rdv-type-go" aria-hidden="true"><Chevron dir="right" /></span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Shell>
    );
  }

  const typeSummary = (
    <div className="rdv-chosen">
      <div>
        <p className="rdv-type-name">{type.name}</p>
        <p className="rdv-type-meta">
          <span><ClockIcon />{durationLabel(type.durationMin)}</span>
          {type.locationLabel && <span><ModeIcon mode={type.mode} />{type.locationLabel}</span>}
        </p>
      </div>
      {info.types.length > 1 && <button type="button" className="btn small" onClick={backToTypes}>Changer</button>}
    </div>
  );

  if (step === 'form' && start) {
    return (
      <Shell name={name}>
        <div className="rdv-panel narrow">
          <button type="button" className="rdv-back" onClick={() => setStep('slots')}><ArrowLeftIcon />Retour</button>
          <Steps current={3} />
          <StepTitle sub="Plus qu’une étape : indiquez comment vous joindre.">Vos coordonnées</StepTitle>
          <BookingForm
            type={type}
            start={start}
            timezone={info.timezone}
            values={values}
            onChange={setValues}
            onBack={() => setStep('slots')}
            onDone={(confirmation, email) => {
              setDone({ confirmation, email });
              setStep('done');
            }}
            onSlotLost={() => {
              setSlotLost(true);
              setStart(null);
              setStep('slots');
            }}
            onClosed={() => {
              setStart(null);
              setStep('types');
              go('/rdv');
              setSlug(null);
              load();
            }}
          />
        </div>
      </Shell>
    );
  }

  return (
    <Shell name={name}>
      <div className="rdv-panel wide">
        {info.types.length > 1 && <button type="button" className="rdv-back" onClick={backToTypes}><ArrowLeftIcon />Tous les rendez-vous</button>}
        <Steps current={2} />
        <StepTitle sub="Sélectionnez un jour, puis une heure.">Choisissez un créneau</StepTitle>
        {typeSummary}
        {slotLost && (
          <Notice kind="warn">
            Ce créneau vient d’être réservé par quelqu’un d’autre. Choisissez-en un autre : vos coordonnées sont conservées.
          </Notice>
        )}
        <SlotPicker
          key={type.slug}
          type={type}
          timezone={info.timezone}
          preferredDay={preferredDay}
          onPick={(iso) => {
            setStart(iso);
            setPreferredDay(dayKeyIn(info.timezone, new Date(iso)));
            setSlotLost(false);
            setStep('form');
          }}
        />
      </div>
    </Shell>
  );
}

// --- annulation -------------------------------------------------------------------------

type CancelState =
  | { kind: 'loading' }
  | { kind: 'gone' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; booking: PublicBooking; failure: string | null; busy: boolean }
  | { kind: 'cancelled'; booking: PublicBooking };

function CancelPage({ token }: { token: string }) {
  const [state, setState] = useState<CancelState>({ kind: 'loading' });
  const [name, setName] = useState('');
  useEffect(() => {
    // Le nom affiché en tête de page ; sans lui, la page fonctionne quand même.
    publicApi.info().then((info) => setName(info.publicName), () => undefined);
  }, []);

  // Consulter n'annule rien : l'annulation n'est envoyée qu'au clic (les aperçus de liens ouvrent les e-mails).
  const load = useCallback(() => {
    setState({ kind: 'loading' });
    publicApi.getByToken(token).then(
      (booking) => setState({ kind: 'ready', booking, failure: null, busy: false }),
      (err) => setState(err instanceof ApiError && err.status === 404 ? { kind: 'gone' } : { kind: 'error', message: errorText(err) }),
    );
  }, [token]);
  useEffect(load, [load]);
  useEffect(() => {
    document.title = 'Annuler un rendez-vous';
  }, []);

  const cancel = async (booking: PublicBooking) => {
    setState({ kind: 'ready', booking, failure: null, busy: true });
    try {
      setState({ kind: 'cancelled', booking: await publicApi.cancel(token) });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return setState({ kind: 'gone' });
      if (err instanceof ApiError && err.code === 'too_late') return setState({ kind: 'ready', booking: { ...booking, cancellable: false }, failure: null, busy: false });
      setState({ kind: 'ready', booking, failure: errorText(err), busy: false });
    }
  };

  const recap = (b: PublicBooking) => <Recap typeName={b.typeName} start={b.start} end={b.end} timezone={b.timezone} location={b.locationLabel} name={b.name} />;
  const again = <a className="btn" href="/rdv">Prendre un nouveau rendez-vous</a>;

  return (
    <Shell name={name}>
      <div className="rdv-panel narrow rdv-done">
        {state.kind === 'loading' && <Loading label="Chargement du rendez-vous…" />}
        {state.kind === 'error' && (
          <Notice kind="error" action={<button type="button" className="btn" onClick={load}>Réessayer</button>}>{state.message}</Notice>
        )}
        {state.kind === 'gone' && (
          <>
            <span className="rdv-badge muted" aria-hidden="true"><CalendarIcon /></span>
            <StepTitle sub="Rendez-vous introuvable ou déjà annulé. Si vous l’avez annulé, vous n’avez plus rien à faire.">Ce lien n’est plus valable</StepTitle>
            <div className="rdv-actions">{again}</div>
          </>
        )}
        {state.kind === 'ready' && state.booking.cancellable && (
          <>
            <StepTitle sub="Vérifiez qu’il s’agit bien du rendez-vous à annuler. Cette action est définitive : le créneau sera libéré.">Annuler ce rendez-vous ?</StepTitle>
            {recap(state.booking)}
            {state.failure && <Notice kind="error">{state.failure}</Notice>}
            <div className="rdv-actions">
              <button type="button" className="btn danger-solid" disabled={state.busy} aria-busy={state.busy} onClick={() => void cancel(state.booking)}>
                {state.busy && <span className="rdv-spinner light" aria-hidden="true" />}
                {state.busy ? 'Annulation…' : 'Annuler ce rendez-vous'}
              </button>
            </div>
            <p className="rdv-fine">Vous souhaitez le conserver ? Fermez simplement cette page.</p>
          </>
        )}
        {state.kind === 'ready' && !state.booking.cancellable && (
          <>
            <StepTitle sub="Ce rendez-vous a déjà commencé ou est passé : il ne peut plus être annulé en ligne.">Annulation impossible</StepTitle>
            {recap(state.booking)}
          </>
        )}
        {state.kind === 'cancelled' && (
          <>
            <span className="rdv-badge ok" aria-hidden="true"><CheckIcon /></span>
            <StepTitle sub="Le créneau est libéré. Un e-mail vous confirme l’annulation.">Votre rendez-vous est annulé</StepTitle>
            <div className="rdv-struck">{recap(state.booking)}</div>
            <div className="rdv-actions">{again}</div>
          </>
        )}
      </div>
    </Shell>
  );
}

export function PublicApp() {
  const cancel = /^\/rdv\/annulation\/([^/]*)\/?$/.exec(location.pathname);
  return cancel ? <CancelPage token={cancel[1]} /> : <BookingFlow />;
}
