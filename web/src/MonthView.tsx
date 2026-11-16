import { addDays, capitalize, fmt, fmtTime, sameDay, startOfDay, startOfMonth, startOfWeek } from './dates';
import { Chevron } from './icons';
import { overlapsDay, type CalendarMap, type Occ } from './model';

interface Props {
  cursor: Date;
  occs: Occ[];
  calendars: CalendarMap;
  onCreate: (start: Date, end: Date, allDay: boolean) => void;
  onOpen: (occ: Occ) => void;
  onPickDay: (day: Date) => void;
}

const MAX_CHIPS = 4;

export function monthGrid(cursor: Date): Date[] {
  const first = startOfWeek(startOfMonth(cursor));
  return Array.from({ length: 42 }, (_, i) => addDays(first, i));
}

export function MonthView({ cursor, occs, calendars, onCreate, onOpen, onPickDay }: Props) {
  const days = monthGrid(cursor);
  const today = new Date();
  return (
    <div className="month">
      <div className="month-head">
        {days.slice(0, 7).map((d) => (
          <div key={d.getDay()}>{capitalize(fmt(d, { weekday: 'short' }).replace('.', ''))}</div>
        ))}
      </div>
      <div className="month-grid">
        {days.map((d) => {
          const list = occs
            .filter((o) => overlapsDay(o, d))
            .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startDate.getTime() - b.startDate.getTime());
          const outside = d.getMonth() !== cursor.getMonth();
          const weekend = d.getDay() === 0 || d.getDay() === 6;
          return (
            <div
              key={d.getTime()}
              className={`month-cell${outside ? ' outside' : ''}${weekend ? ' weekend' : ''}${sameDay(d, today) ? ' today' : ''}`}
              onClick={(e) => {
                if (e.target !== e.currentTarget) return;
                const start = startOfDay(d);
                start.setHours(9);
                onCreate(start, new Date(start.getTime() + 3_600_000), false);
              }}
            >
              <button className="month-num" onClick={() => onPickDay(d)} aria-label={fmt(d, { dateStyle: 'full' })}>
                {d.getDate() === 1 ? fmt(d, { day: 'numeric', month: 'short' }) : d.getDate()}
              </button>
              {list.slice(0, list.length > MAX_CHIPS ? MAX_CHIPS - 1 : MAX_CHIPS).map((o) => {
                const color = calendars.get(o.calendarId)?.color ?? '#888';
                const startsHere = sameDay(o.startDate, d);
                return (
                  <button
                    key={o.key}
                    className={`chip${o.allDay ? ' solid' : ''}`}
                    style={{ '--c': color } as React.CSSProperties}
                    onClick={() => onOpen(o)}
                    title={o.title}
                  >
                    {!o.allDay && <span className="dot" />}
                    {!o.allDay && startsHere && <span className="chip-time">{fmtTime(o.startDate)}</span>}
                    <span className="chip-title">{o.title || '(Sans titre)'}</span>
                  </button>
                );
              })}
              {list.length > MAX_CHIPS && (
                <button className="more" onClick={() => onPickDay(d)}>
                  +{list.length - (MAX_CHIPS - 1)} autres
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function MiniMonth({ cursor, selected, onPick, onNavigate }: { cursor: Date; selected: Date; onPick: (d: Date) => void; onNavigate: (delta: number) => void }) {
  const days = monthGrid(cursor);
  const today = new Date();
  return (
    <div className="mini">
      <div className="mini-head">
        <span>{capitalize(fmt(cursor, { month: 'long', year: 'numeric' }))}</span>
        <span className="mini-nav">
          <button className="icon-btn" onClick={() => onNavigate(-1)} aria-label="Mois précédent"><Chevron dir="left" /></button>
          <button className="icon-btn" onClick={() => onNavigate(1)} aria-label="Mois suivant"><Chevron dir="right" /></button>
        </span>
      </div>
      <div className="mini-grid">
        {['L', 'M', 'M', 'J', 'V', 'S', 'D'].map((l, i) => (
          <span key={i} className="mini-dow">{l}</span>
        ))}
        {days.map((d) => (
          <button
            key={d.getTime()}
            className={`mini-day${d.getMonth() !== cursor.getMonth() ? ' outside' : ''}${sameDay(d, today) ? ' today' : ''}${sameDay(d, selected) ? ' selected' : ''}`}
            onClick={() => onPick(d)}
          >
            {d.getDate()}
          </button>
        ))}
      </div>
    </div>
  );
}
