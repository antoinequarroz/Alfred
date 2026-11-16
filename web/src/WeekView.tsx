import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { addDays, addMinutes, capitalize, fmt, fmtTime, minutesOfDay, sameDay, snapMinutes, startOfDay } from './dates';
import { overlapsDay, type CalendarMap, type Occ } from './model';

const HOUR = 48; // hauteur d'une heure en pixels
const MIN_BLOCK = 20; // durée minimale affichée, en minutes
const DRAG_THRESHOLD = 4;

interface Props {
  days: Date[];
  occs: Occ[];
  calendars: CalendarMap;
  onCreate: (start: Date, end: Date, allDay: boolean) => void;
  onOpen: (occ: Occ) => void;
  onMove: (occ: Occ, start: Date, end: Date) => void;
  onPickDay: (day: Date) => void;
}

interface Segment {
  occ: Occ;
  startMin: number;
  endMin: number;
  col: number;
  cols: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

/** Répartit en colonnes les événements qui se chevauchent sur une journée. */
function layoutDay(occs: Occ[], day: Date): Segment[] {
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);
  const segs: Segment[] = occs
    .filter((o) => !o.allDay && overlapsDay(o, day))
    .map((o) => {
      const startMin = o.startDate < dayStart ? 0 : minutesOfDay(o.startDate);
      const rawEnd = o.endDate >= dayEnd ? 1440 : minutesOfDay(o.endDate);
      return {
        occ: o,
        startMin,
        endMin: Math.min(1440, Math.max(rawEnd, startMin + MIN_BLOCK)),
        col: 0,
        cols: 1,
        continuesBefore: o.startDate < dayStart,
        continuesAfter: o.endDate > dayEnd,
      };
    })
    .sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);

  let cluster: Segment[] = [];
  let clusterEnd = -1;
  let columns: number[] = [];
  const flush = () => {
    for (const s of cluster) s.cols = columns.length;
    cluster = [];
    columns = [];
  };
  for (const s of segs) {
    if (s.startMin >= clusterEnd) flush();
    let col = columns.findIndex((end) => end <= s.startMin);
    if (col === -1) col = columns.length;
    columns[col] = s.endMin;
    s.col = col;
    cluster.push(s);
    clusterEnd = Math.max(clusterEnd, s.endMin);
  }
  flush();
  return segs;
}

type Drag =
  | { kind: 'create'; dayIndex: number; anchorMin: number; curMin: number }
  | { kind: 'move'; occ: Occ; grabDay: number; grabMin: number; deltaMin: number }
  | { kind: 'resize'; occ: Occ; end: Date };

export function WeekView({ days, occs, calendars, onCreate, onOpen, onMove, onPickDay }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const colsRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Au premier affichage, on se place vers 7 h (ou un peu avant l'heure actuelle).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const hour = Math.max(0, Math.min(7, new Date().getHours() - 1));
    el.scrollTop = hour * HOUR;
  }, []);

  const pointerPos = (e: { clientX: number; clientY: number }) => {
    const rect = colsRef.current!.getBoundingClientRect();
    const dayIndex = Math.max(0, Math.min(days.length - 1, Math.floor(((e.clientX - rect.left) / rect.width) * days.length)));
    const min = Math.max(0, Math.min(1440, ((e.clientY - rect.top) / HOUR) * 60));
    return { dayIndex, min };
  };

  const at = (dayIndex: number, min: number) => addMinutes(startOfDay(days[dayIndex]), min);

  const startDrag = (e: React.PointerEvent, initial: Drag) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return; // au doigt : simple appui, pas de glisser
    e.preventDefault();
    const origin = { x: e.clientX, y: e.clientY };
    let moved = false;
    dragRef.current = initial;

    const onMoveEvt = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) < DRAG_THRESHOLD) return;
      moved = true;
      const p = pointerPos(ev);
      const d = dragRef.current!;
      let next: Drag;
      if (d.kind === 'create') next = { ...d, curMin: snapMinutes(p.min) };
      else if (d.kind === 'move') next = { ...d, deltaMin: (p.dayIndex - d.grabDay) * 1440 + snapMinutes(p.min - d.grabMin) };
      else {
        const minEnd = addMinutes(d.occ.startDate, 15);
        const end = at(p.dayIndex, snapMinutes(p.min));
        next = { ...d, end: end < minEnd ? minEnd : end };
      }
      dragRef.current = next;
      setDrag(next);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMoveEvt);
      window.removeEventListener('pointerup', onUp);
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!moved || !d) return;
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false), 0);
      if (d.kind === 'create') {
        const a = Math.min(d.anchorMin, d.curMin);
        const b = Math.max(d.anchorMin, d.curMin);
        if (b > a) onCreate(at(d.dayIndex, a), at(d.dayIndex, b), false);
      } else if (d.kind === 'move') {
        if (d.deltaMin !== 0) onMove(d.occ, addMinutes(d.occ.startDate, d.deltaMin), addMinutes(d.occ.endDate, d.deltaMin));
      } else if (d.end.getTime() !== d.occ.endDate.getTime()) {
        onMove(d.occ, d.occ.startDate, d.end);
      }
    };
    window.addEventListener('pointermove', onMoveEvt);
    window.addEventListener('pointerup', onUp);
  };

  // Pendant un glisser, l'événement est affiché à sa position provisoire.
  const shown = useMemo(() => {
    if (!drag || drag.kind === 'create') return occs;
    return occs.map((o) => {
      if (o.key !== drag.occ.key) return o;
      if (drag.kind === 'move') return { ...o, startDate: addMinutes(o.startDate, drag.deltaMin), endDate: addMinutes(o.endDate, drag.deltaMin) };
      return { ...o, endDate: drag.end };
    });
  }, [occs, drag]);

  const draggingKey = drag && drag.kind !== 'create' ? drag.occ.key : null;
  const allDay = shown.filter((o) => o.allDay);
  const hasAllDay = allDay.some((o) => days.some((d) => overlapsDay(o, d)));

  return (
    <div className="week">
      <div className="week-head">
        <div className="gutter" />
        {days.map((d) => (
          <button key={d.getTime()} className={`week-day${sameDay(d, now) ? ' today' : ''}`} onClick={() => onPickDay(d)}>
            <span className="dow">{capitalize(fmt(d, { weekday: 'short' }).replace('.', ''))}</span>
            <span className="num">{d.getDate()}</span>
          </button>
        ))}
      </div>

      <div className={`allday-row${hasAllDay ? '' : ' empty'}`}>
        <div className="gutter small">{hasAllDay ? 'Journée' : ''}</div>
        {days.map((d) => (
          <div
            key={d.getTime()}
            className="allday-cell"
            onClick={(e) => {
              if (e.target === e.currentTarget) onCreate(startOfDay(d), addDays(startOfDay(d), 1), true);
            }}
          >
            {allDay.filter((o) => overlapsDay(o, d)).map((o) => (
              <button
                key={o.key}
                className="chip solid"
                style={{ '--c': calendars.get(o.calendarId)?.color ?? '#888' } as React.CSSProperties}
                onClick={() => onOpen(o)}
                title={o.title}
              >
                {o.title || '(Sans titre)'}
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="tg-scroll" ref={scrollRef}>
        <div className="tg-body" style={{ height: 24 * HOUR }}>
          <div className="gutter hours">
            {Array.from({ length: 23 }, (_, i) => (
              <span key={i} style={{ top: (i + 1) * HOUR }}>{String(i + 1).padStart(2, '0')}:00</span>
            ))}
          </div>
          <div className="tg-cols" ref={colsRef}>
            {days.map((d, dayIndex) => {
              const segs = layoutDay(shown, d);
              const isToday = sameDay(d, now);
              return (
                <div
                  key={d.getTime()}
                  className={`tg-col${isToday ? ' today' : ''}`}
                  onPointerDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    const p = pointerPos(e);
                    const m = snapMinutes(p.min);
                    startDrag(e, { kind: 'create', dayIndex, anchorMin: m, curMin: m });
                  }}
                  onClick={(e) => {
                    if (e.target !== e.currentTarget || suppressClick.current) return;
                    const p = pointerPos(e);
                    const m = Math.min(1380, Math.floor(p.min / 30) * 30);
                    onCreate(at(dayIndex, m), at(dayIndex, m + 60), false);
                  }}
                >
                  {segs.map((s) => {
                    const color = calendars.get(s.occ.calendarId)?.color ?? '#888';
                    const height = ((s.endMin - s.startMin) / 60) * HOUR;
                    return (
                      <div
                        key={s.occ.key}
                        role="button"
                        tabIndex={0}
                        className={`ev${height < 34 ? ' short' : ''}${draggingKey === s.occ.key ? ' dragging' : ''}`}
                        style={{
                          '--c': color,
                          top: (s.startMin / 60) * HOUR,
                          height: Math.max(height - 2, 14),
                          left: `calc(${(s.col / s.cols) * 100}% + 1px)`,
                          width: `calc(${100 / s.cols}% - 3px)`,
                        } as React.CSSProperties}
                        title={`${s.occ.title}\n${fmtTime(s.occ.startDate)} – ${fmtTime(s.occ.endDate)}${s.occ.location ? `\n${s.occ.location}` : ''}`}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          const p = pointerPos(e);
                          startDrag(e, { kind: 'move', occ: s.occ, grabDay: p.dayIndex, grabMin: p.min, deltaMin: 0 });
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!suppressClick.current) onOpen(s.occ);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onOpen(s.occ);
                          }
                        }}
                      >
                        <span className="ev-title">{s.occ.title || '(Sans titre)'}</span>
                        <span className="ev-time">
                          {fmtTime(s.occ.startDate)} – {fmtTime(s.occ.endDate)}
                          {s.occ.location ? ` · ${s.occ.location}` : ''}
                        </span>
                        {!s.continuesAfter && (
                          <span
                            className="ev-resize"
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              startDrag(e, { kind: 'resize', occ: s.occ, end: s.occ.endDate });
                            }}
                          />
                        )}
                      </div>
                    );
                  })}
                  {drag?.kind === 'create' && drag.dayIndex === dayIndex && drag.curMin !== drag.anchorMin && (
                    <div
                      className="ev ghost"
                      style={{
                        top: (Math.min(drag.anchorMin, drag.curMin) / 60) * HOUR,
                        height: (Math.abs(drag.curMin - drag.anchorMin) / 60) * HOUR - 2,
                        left: 1,
                        width: 'calc(100% - 3px)',
                      }}
                    >
                      <span className="ev-time">
                        {fmtTime(at(dayIndex, Math.min(drag.anchorMin, drag.curMin)))} – {fmtTime(at(dayIndex, Math.max(drag.anchorMin, drag.curMin)))}
                      </span>
                    </div>
                  )}
                  {isToday && <div className="now-line" style={{ top: (minutesOfDay(now) / 60) * HOUR }} />}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
