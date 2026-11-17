import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CalendarInfo, EditScope, SyncStatus } from '../../shared/types';
import { api, ApiError } from './api';
import { addDays, addMonths, capitalize, fmt, startOfDay, startOfWeek } from './dates';
import { EventDialog, ScopeDialog } from './EventDialog';
import { CalendarIcon, Chevron, ClockIcon, GearIcon, MenuIcon, PlusIcon } from './icons';
import { draftFromOcc, draftToInput, movedInput, newDraft, toOcc, type CalendarMap, type Draft, type Occ } from './model';
import { MiniMonth, monthGrid, MonthView } from './MonthView';
import { MoonIcon, SunIcon, ThemeSwitch, useTheme } from './theme';
import { WeekView } from './WeekView';

// L'écran « Rendez-vous » n'est chargé que lorsqu'on l'ouvre.
const BookingAdmin = lazy(() => import('./rdv/BookingAdmin').then((m) => ({ default: m.BookingAdmin })));

// L'écran « Réglages » (connexions iCloud et e-mails) aussi.
const ConnectionsScreen = lazy(() => import('./settings/ConnectionsScreen').then((m) => ({ default: m.ConnectionsScreen })));

type Section = 'calendar' | 'booking' | 'settings';
const SECTION_HASH: Record<Section, string> = { calendar: '', booking: '#rendez-vous', settings: '#reglages' };
// « #rendez-vous/reglages » ouvre la rubrique Rendez-vous sur son onglet Réglages.
const sectionFromHash = (): Section => (location.hash.startsWith('#rendez-vous') ? 'booking' : location.hash === '#reglages' ? 'settings' : 'calendar');

type View = 'day' | 'week' | 'month';
const VIEW_LABELS: Record<View, string> = { day: 'Jour', week: 'Semaine', month: 'Mois' };

function initialView(): View {
  const saved = localStorage.getItem('alfred:view') as View | null;
  if (saved && saved in VIEW_LABELS) return saved;
  return window.innerWidth < 720 ? 'day' : 'week';
}

function viewRange(view: View, cursor: Date): [Date, Date] {
  if (view === 'day') return [startOfDay(cursor), addDays(startOfDay(cursor), 1)];
  if (view === 'week') return [startOfWeek(cursor), addDays(startOfWeek(cursor), 7)];
  const grid = monthGrid(cursor);
  return [grid[0], addDays(grid[41], 1)];
}

function title(view: View, cursor: Date): string {
  if (view === 'day') return capitalize(fmt(cursor, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
  if (view === 'month') return capitalize(fmt(cursor, { month: 'long', year: 'numeric' }));
  const a = startOfWeek(cursor);
  const b = addDays(a, 6);
  if (a.getMonth() === b.getMonth()) return `${a.getDate()} – ${fmt(b, { day: 'numeric', month: 'long', year: 'numeric' })}`;
  return `${fmt(a, { day: 'numeric', month: 'short' })} – ${fmt(b, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

function syncLabel(s: SyncStatus | null): string {
  if (!s) return '';
  if (!s.configured) return 'Calendrier local (iCloud non relié)';
  if (s.running) return 'Synchronisation…';
  if (s.lastError) return 'Synchro iCloud en échec';
  if (!s.lastSuccessAt) return 'En attente de synchro';
  const min = Math.round((Date.now() - new Date(s.lastSuccessAt).getTime()) / 60_000);
  return min < 1 ? 'Synchronisé à l’instant' : `Synchronisé il y a ${min} min`;
}

/** Titre de la période : l'année passe en retrait pour laisser lire le jour ou le mois. */
function Title({ text }: { text: string }) {
  const m = /^(.*) (\d{4})$/.exec(text);
  if (!m) return <h1>{text}</h1>;
  return (
    <h1>
      {m[1]} <span className="title-year">{m[2]}</span>
    </h1>
  );
}

export function App({ onLogout }: { onLogout: () => void }) {
  const [section, setSectionState] = useState<Section>(sectionFromHash);
  const [view, setView] = useState<View>(initialView);
  const [cursor, setCursor] = useState(() => new Date());
  const [calendars, setCalendars] = useState<CalendarInfo[]>([]);
  const [occs, setOccs] = useState<Occ[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pendingMove, setPendingMove] = useState<{ occ: Occ; start: Date; end: Date } | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [miniCursor, setMiniCursor] = useState(() => new Date());
  const requestId = useRef(0);
  const theme = useTheme();

  useEffect(() => {
    const onHash = () => setSectionState(sectionFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const setSection = useCallback((next: Section) => {
    setSectionState(next);
    setMenuOpen(false);
    const hash = SECTION_HASH[next];
    if (sectionFromHash() !== next || (next !== 'booking' && location.hash !== hash)) history.pushState(null, '', location.pathname + location.search + hash);
  }, []);

  const [from, to] = useMemo(() => viewRange(view, cursor), [view, cursor]);
  const calendarMap: CalendarMap = useMemo(() => new Map(calendars.map((c) => [c.id, c])), [calendars]);

  const showError = useCallback((err: unknown) => {
    if (err instanceof ApiError && err.status === 401) return;
    setToast(err instanceof Error ? err.message : 'Une erreur est survenue');
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const loadEvents = useCallback(async () => {
    const id = ++requestId.current;
    try {
      const list = await api.events(from, to);
      if (id === requestId.current) setOccs(list.map(toOcc));
    } catch (err) {
      showError(err);
    }
  }, [from, to, showError]);

  // Toujours la version courante : une action lancée avant un changement de semaine recharge la bonne période.
  const loadEventsRef = useRef(loadEvents);
  loadEventsRef.current = loadEvents;

  const loadMeta = useCallback(async () => {
    try {
      const [cals, status] = await Promise.all([api.calendars(), api.syncStatus()]);
      setCalendars(cals);
      setSync(status);
    } catch (err) {
      showError(err);
    }
  }, [showError]);

  useEffect(() => void loadEvents(), [loadEvents]);
  useEffect(() => void loadMeta(), [loadMeta]);
  // Au retour de l'écran « Rendez-vous » : une réservation ou une annulation a pu changer l'agenda.
  useEffect(() => {
    if (section === 'calendar') void loadEventsRef.current();
  }, [section]);

  // Rafraîchissement régulier et au retour sur l'app.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      void loadEvents();
      void loadMeta();
    };
    const t = setInterval(refresh, 60_000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [loadEvents, loadMeta]);

  useEffect(() => localStorage.setItem('alfred:view', view), [view]);
  useEffect(() => setMiniCursor(cursor), [cursor]);

  const navigate = useCallback(
    (delta: number) => setCursor((c) => (view === 'month' ? addMonths(c, delta) : addDays(c, delta * (view === 'week' ? 7 : 1)))),
    [view],
  );

  const defaultCalendar = calendars.find((c) => !c.readOnly && c.visible) ?? calendars.find((c) => !c.readOnly);

  const openCreate = useCallback(
    (start: Date, end: Date, allDay: boolean) => {
      if (!defaultCalendar) return setToast('Aucun calendrier disponible pour l’instant.');
      const last = localStorage.getItem('alfred:calendar');
      const calendarId = last && calendarMap.get(last) && !calendarMap.get(last)!.readOnly ? last : defaultCalendar.id;
      setDraft(newDraft(calendarId, start, end, allDay));
    },
    [defaultCalendar, calendarMap],
  );

  const openNew = useCallback(() => {
    const base = view === 'month' ? startOfDay(new Date()) : startOfDay(cursor);
    const now = new Date();
    base.setHours(Math.min(22, now.getHours() + 1));
    openCreate(base, new Date(base.getTime() + 3_600_000), false);
  }, [view, cursor, openCreate]);

  // Raccourcis clavier.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (section !== 'calendar' || draft || pendingMove || e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'ArrowLeft') navigate(-1);
      else if (e.key === 'ArrowRight') navigate(1);
      else if (e.key === 't') setCursor(new Date());
      else if (e.key === 'j') setView('day');
      else if (e.key === 's') setView('week');
      else if (e.key === 'm') setView('month');
      else if (e.key === 'n') {
        e.preventDefault();
        openNew();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [section, draft, pendingMove, navigate, openNew]);

  const run = async (fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    try {
      await fn();
      after?.();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
      void loadEventsRef.current();
    }
  };

  const save = (d: Draft, scope: EditScope) => {
    const input = draftToInput(d);
    localStorage.setItem('alfred:calendar', d.calendarId);
    if (!d.occ) return run(() => api.createEvent(input), () => setDraft(null));
    const occ = d.occ;
    return run(() => api.updateEvent(occ.eventId, input, occ.recurring ? scope : 'all', occ.occurrenceId), () => setDraft(null));
  };

  const remove = (d: Draft, scope: EditScope) => {
    const occ = d.occ!;
    return run(() => api.deleteEvent(occ.eventId, occ.recurring ? scope : 'all', occ.occurrenceId), () => setDraft(null));
  };

  const applyMove = (occ: Occ, start: Date, end: Date, scope: EditScope) => {
    // Affichage immédiat, la base suit.
    setOccs((list) => list.map((o) => (o.key === occ.key ? { ...o, startDate: start, endDate: end } : o)));
    return run(() => api.updateEvent(occ.eventId, movedInput(occ, start, end), scope, occ.occurrenceId));
  };

  const move = (occ: Occ, start: Date, end: Date) => {
    if (calendarMap.get(occ.calendarId)?.readOnly) return;
    if (occ.recurring) setPendingMove({ occ, start, end });
    else void applyMove(occ, start, end, 'all');
  };

  const toggleCalendar = async (cal: CalendarInfo) => {
    setCalendars((list) => list.map((c) => (c.id === cal.id ? { ...c, visible: !c.visible } : c)));
    try {
      await api.setCalendarVisible(cal.id, !cal.visible);
      await loadEventsRef.current();
    } catch (err) {
      showError(err);
    }
  };

  const syncNow = async () => {
    setSync((s) => (s ? { ...s, running: true } : s));
    try {
      setSync(await api.sync());
      await Promise.all([loadEventsRef.current(), loadMeta()]);
    } catch (err) {
      showError(err);
      void loadMeta();
    }
  };

  const pickDay = (d: Date) => {
    setCursor(d);
    setView('day');
    setMenuOpen(false);
  };

  const days = view === 'day' ? [startOfDay(cursor)] : Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(cursor), i));

  return (
    <div className="app">
      <aside className={`sidebar${menuOpen ? ' open' : ''}`}>
        <div className="brand">
          <span className="logo">A</span>
          <span>Alfred</span>
        </div>
        <nav className="side-nav" aria-label="Rubriques">
          <button className={section === 'calendar' ? 'active' : ''} aria-current={section === 'calendar' ? 'page' : undefined} onClick={() => setSection('calendar')}>
            <CalendarIcon />
            <span>Calendrier</span>
          </button>
          <button className={section === 'booking' ? 'active' : ''} aria-current={section === 'booking' ? 'page' : undefined} onClick={() => setSection('booking')}>
            <ClockIcon />
            <span>Rendez-vous</span>
          </button>
          <button className={section === 'settings' ? 'active' : ''} aria-current={section === 'settings' ? 'page' : undefined} onClick={() => setSection('settings')}>
            <GearIcon />
            <span>Réglages</span>
          </button>
        </nav>
        <button className="btn primary new-btn" onClick={() => { setSection('calendar'); openNew(); }}>
          <PlusIcon />
          <span>Nouvel événement</span>
          <kbd>N</kbd>
        </button>
        <MiniMonth
          cursor={miniCursor}
          selected={cursor}
          onPick={(d) => { setCursor(d); setSection('calendar'); }}
          onNavigate={(delta) => setMiniCursor((c) => addMonths(c, delta))}
        />
        <div className="cal-list">
          <h3>Calendriers</h3>
          {calendars.map((c) => (
            <label key={c.id} className="cal-item" style={{ '--c': c.color } as React.CSSProperties}>
              <input type="checkbox" checked={c.visible} onChange={() => void toggleCalendar(c)} />
              <span className="swatch" />
              <span className="cal-name">{c.name}</span>
            </label>
          ))}
          {calendars.length === 0 && <p className="muted">Aucun calendrier pour l’instant.</p>}
        </div>
        <div className="sidebar-foot">
          <ThemeSwitch theme={theme.theme} onChange={theme.setTheme} />
          <div className={`sync${sync?.lastError ? ' error' : ''}`} title={sync?.lastError ?? undefined}>
            <span className="sync-dot" />
            <span>{syncLabel(sync)}</span>
          </div>
          {sync?.lastError && <p className="sync-detail">{sync.lastError}</p>}
          {sync && (sync.lastError || !sync.configured) && section !== 'settings' && (
            <button className="sync-link" onClick={() => setSection('settings')}>{sync.configured ? 'Ouvrir les réglages iCloud' : 'Relier iCloud'}</button>
          )}
          <div className="foot-actions">
            {sync?.configured && (
              <button className="btn ghost small" onClick={() => void syncNow()} disabled={sync.running}>Synchroniser</button>
            )}
            <button className="btn ghost small" onClick={() => void api.logout().finally(onLogout)}>Se déconnecter</button>
          </div>
        </div>
      </aside>
      {menuOpen && <div className="scrim" onClick={() => setMenuOpen(false)} />}

      {section === 'booking' ? (
        <Suspense fallback={<main className="main" />}>
          <BookingAdmin onMenu={() => setMenuOpen(true)} onCalendarChanged={() => { void loadMeta(); void loadEventsRef.current(); }} />
        </Suspense>
      ) : section === 'settings' ? (
        <Suspense fallback={<main className="main" />}>
          <ConnectionsScreen onMenu={() => setMenuOpen(true)} onCalendarChanged={() => { void loadMeta(); void loadEventsRef.current(); }} />
        </Suspense>
      ) : (
      <main className="main">
        <header className="toolbar">
          <button className="icon-btn menu-btn" onClick={() => setMenuOpen(true)} aria-label="Menu"><MenuIcon /></button>
          <Title text={title(view, cursor)} />
          <button className="btn today-btn" onClick={() => setCursor(new Date())}>Aujourd’hui</button>
          <div className="nav">
            <button className="icon-btn" onClick={() => navigate(-1)} aria-label="Précédent"><Chevron dir="left" /></button>
            <button className="icon-btn" onClick={() => navigate(1)} aria-label="Suivant"><Chevron dir="right" /></button>
          </div>
          <button className="icon-btn theme-btn" onClick={theme.toggle} aria-label={theme.dark ? 'Passer en thème clair' : 'Passer en thème sombre'} title={theme.dark ? 'Thème clair' : 'Thème sombre'}>
            {theme.dark ? <SunIcon /> : <MoonIcon />}
          </button>
          <div className="seg" role="tablist" aria-label="Vue">
            {(Object.keys(VIEW_LABELS) as View[]).map((v) => (
              <button key={v} role="tab" aria-selected={view === v} className={view === v ? 'active' : ''} onClick={() => setView(v)}>
                {VIEW_LABELS[v]}
              </button>
            ))}
          </div>
        </header>

        {view === 'month' ? (
          <MonthView cursor={cursor} occs={occs} calendars={calendarMap} onCreate={openCreate} onOpen={(o) => setDraft(draftFromOcc(o))} onPickDay={pickDay} />
        ) : (
          <WeekView
            key={view}
            days={days}
            occs={occs}
            calendars={calendarMap}
            onCreate={openCreate}
            onOpen={(o) => setDraft(draftFromOcc(o))}
            onMove={move}
            onPickDay={pickDay}
          />
        )}
        <button className="fab" onClick={openNew} aria-label="Nouvel événement"><PlusIcon /></button>
      </main>
      )}

      {draft && (
        <EventDialog
          key={draft.occ?.key ?? 'new'}
          initial={draft}
          calendars={calendars}
          busy={busy}
          onSave={(d, scope) => void save(d, scope)}
          onDelete={(d, scope) => void remove(d, scope)}
          onClose={() => setDraft(null)}
        />
      )}
      {pendingMove && (
        <ScopeDialog
          onChoose={(scope) => {
            const m = pendingMove;
            setPendingMove(null);
            void applyMove(m.occ, m.start, m.end, scope);
          }}
          onCancel={() => setPendingMove(null)}
        />
      )}
      {toast && (
        <div className="toast" role="alert" onClick={() => setToast(null)}>{toast}</div>
      )}
    </div>
  );
}
