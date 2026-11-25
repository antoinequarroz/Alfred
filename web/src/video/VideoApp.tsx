import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ConnectionState, DisconnectReason, LocalAudioTrack, LocalVideoTrack, Room, RoomEvent, Track, VideoPresets,
  createLocalAudioTrack, createLocalVideoTrack, type Participant, type RemoteParticipant, type TrackPublication,
} from 'livekit-client';
import type { PublicVideoRoom, VideoJoinInfo, VideoJoinResult, VideoWaiter, VideoWaitStatus } from '../../../shared/types';
import { ApiError, requestJson } from '../http';
import {
  AlertIcon, BlurIcon, ChatIcon, CheckIcon, CloseIcon, CopyIcon, FlipIcon, HangupIcon, MicIcon, MicOffIcon, ScreenIcon,
  UsersIcon, VideoIcon, VideoOffIcon,
} from '../icons';
import { Logo } from '../Logo';
import { MoonIcon, SunIcon, useTheme } from '../theme';
import {
  BACKGROUND_IMAGES, BackgroundFailure, CUSTOM_ID, NO_BACKGROUND, backgroundSupported, backgroundWanted, customImageNow,
  importBackgroundImage, publishCameraWithBackground, rememberBackground, sameBackground, setBackground, type Background,
} from './background';
import '../rdv/rdv.css';
import './video.css';

// La page de la salle n'appelle que /api/public/video/* (plus, pour l'hôte connecté, la fin de réunion).
const BASE = '/api/public/video/rooms';
const NAME_KEY = 'alfred:video-name';
/** Laissez-passer de la suite (Lamio, ALFRED-313) : entrée sans salle d'attente, sous le nom donné par la suite. */
const PASS = (() => {
  try {
    const p = new URLSearchParams(location.search).get('pass');
    return p && /^[A-Za-z0-9_-]{20,100}$/.test(p) ? p : null;
  } catch {
    return null;
  }
})();
const passQuery = PASS ? `?pass=${encodeURIComponent(PASS)}` : '';
const passBody = PASS ? { pass: PASS } : {};

// Un lien abîmé (mal encodé) doit mener à « lien introuvable », pas à une page blanche.
const slug = (() => {
  const raw = location.pathname.replace(/^\/v\//, '').replace(/\/+$/, '');
  try {
    return decodeURIComponent(raw);
  } catch {
    return '-';
  }
})();

function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'network') return 'Connexion impossible. Vérifiez votre réseau, puis réessayez.';
    if (err.code === 'rate_limited') return 'Trop d’essais en peu de temps. Patientez quelques minutes, puis réessayez.';
    if (err.status >= 500 && !err.code) return 'Une erreur est survenue. Réessayez dans un instant.';
    return err.message;
  }
  const media = mediaErrorText(err);
  if (media) return media;
  return 'La connexion à la visio a échoué. Vérifiez votre réseau, puis réessayez.';
}

/** Erreur d'accès à la caméra ou au micro, dite simplement ; null si ce n'en est pas une. */
function mediaErrorText(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const kind = `${err.name} ${err.message}`;
  if (/permission|notallowed|security/i.test(kind)) return 'L’accès à la caméra ou au micro a été refusé. Autorisez-le dans les réglages du navigateur, puis réessayez.';
  if (/notfound|devicesnotfound|overconstrained/i.test(kind)) return 'Aucune caméra ou aucun micro détecté. Vous pouvez tout de même rejoindre la visio.';
  if (/notreadable|trackstart|abort/i.test(kind)) return 'La caméra ou le micro est déjà utilisé par une autre application. Vous pouvez tout de même rejoindre la visio.';
  return null;
}

const BLUR_FAILED = 'L’arrière-plan choisi n’a pas pu démarrer sur cet appareil.';
const BLUR_FAILED_CAMERA_OFF = 'L’arrière-plan choisi n’a pas pu démarrer : la caméra reste coupée. Touchez à nouveau la caméra pour l’ouvrir sans arrière-plan.';

/**
 * Choix de l'arrière-plan : la pièce telle quelle, floutée, ou remplacée par un fond proposé ou par
 * une image de la personne (gardée dans son navigateur). S'ouvre au-dessus du bouton.
 */
function BackgroundPicker({ value, onChange, onError }: { value: Background; onChange: (bg: Background) => void; onError: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(customImageNow);
  const [importing, setImporting] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  // Le panneau est placé par rapport à la fenêtre (au-dessus du bouton) : l'aperçu, arrondi, le rognerait.
  const [place, setPlace] = useState<React.CSSProperties>({});
  const toggle = () => {
    const rect = wrap.current?.getBoundingClientRect();
    if (rect) {
      const width = Math.min(316, window.innerWidth - 24);
      const left = Math.min(Math.max(12, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 12);
      const above = rect.top - 12;
      // Pas assez de place au-dessus (petit écran) : le panneau se cale en haut de la fenêtre, quitte à couvrir le bouton, et défile.
      const maxHeight = Math.min(Math.max(160, above - 12), window.innerHeight - 24);
      const bottom = Math.min(window.innerHeight - above, window.innerHeight - 12 - maxHeight);
      setPlace({ left, width, bottom, maxHeight });
    }
    setOpen((v) => !v);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const pick = (bg: Background) => {
    onChange(bg);
    setOpen(false);
  };
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const chosen = e.target.files?.[0];
    e.target.value = '';
    if (!chosen) return;
    setImporting(true);
    try {
      await importBackgroundImage(chosen);
      setCustom(customImageNow());
      pick({ kind: 'image', id: CUSTOM_ID });
    } catch {
      onError('Cette image n’a pas pu être lue. Essayez avec une photo JPEG ou PNG.');
    } finally {
      setImporting(false);
    }
  };
  const is = (bg: Background) => sameBackground(value, bg);
  const active = value.kind !== 'none';
  return (
    <div className="vc-bg" ref={wrap}>
      <button type="button" className={`vc-round${active ? ' on' : ''}`} onClick={toggle} aria-expanded={open} aria-haspopup="dialog" aria-label="Arrière-plan" title="Arrière-plan">
        <BlurIcon />
      </button>
      {open && (
        <div className="vc-bg-panel" role="dialog" aria-label="Arrière-plan" style={place}>
          <p className="vc-bg-title">Arrière-plan</p>
          <div className="vc-bg-grid">
            <button type="button" className={`vc-bg-opt${is(NO_BACKGROUND) ? ' sel' : ''}`} aria-pressed={is(NO_BACKGROUND)} onClick={() => pick(NO_BACKGROUND)}>
              <span className="vc-bg-thumb none"><VideoIcon /></span><span>Aucun</span>
            </button>
            <button type="button" className={`vc-bg-opt${is({ kind: 'blur' }) ? ' sel' : ''}`} aria-pressed={is({ kind: 'blur' })} onClick={() => pick({ kind: 'blur' })}>
              <span className="vc-bg-thumb blur"><BlurIcon /></span><span>Flou</span>
            </button>
            {BACKGROUND_IMAGES.map((img) => {
              const bg: Background = { kind: 'image', id: img.id };
              return (
                <button key={img.id} type="button" className={`vc-bg-opt${is(bg) ? ' sel' : ''}`} aria-pressed={is(bg)} onClick={() => pick(bg)}>
                  <span className="vc-bg-thumb" style={{ backgroundImage: `url(${img.src})` }} /><span>{img.label}</span>
                </button>
              );
            })}
            {custom && (
              <button type="button" className={`vc-bg-opt${is({ kind: 'image', id: CUSTOM_ID }) ? ' sel' : ''}`} aria-pressed={is({ kind: 'image', id: CUSTOM_ID })} onClick={() => pick({ kind: 'image', id: CUSTOM_ID })}>
                <span className="vc-bg-thumb" style={{ backgroundImage: `url(${custom})` }} /><span>Mon image</span>
              </button>
            )}
            <button type="button" className="vc-bg-opt" disabled={importing} onClick={() => file.current?.click()}>
              <span className="vc-bg-thumb add">+</span><span>{importing ? 'Lecture…' : custom ? 'Changer' : 'Importer'}</span>
            </button>
          </div>
          <p className="vc-bg-note">Calculé sur cet appareil. Une image importée reste dans ce navigateur.</p>
        </div>
      )}
      {/* Toujours présent : le choix d'un fichier aboutit même si le panneau s'est refermé entre-temps (rotation du téléphone). */}
      <input ref={file} type="file" accept="image/*" hidden onChange={(e) => void onFile(e)} />
    </div>
  );
}

/** Deux notes brèves : quelqu'un attend d'entrer. Sans effet si le navigateur bloque le son. */
function chime(): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    [660, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const at = ctx.currentTime + i * 0.16;
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.gain.exponentialRampToValueAtTime(0.12, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.15);
      osc.start(at);
      osc.stop(at + 0.16);
    });
    setTimeout(() => void ctx.close().catch(() => undefined), 800);
  } catch {
    // pas de son : le panneau reste visible
  }
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? '?') + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
}

function whenLabel(room: PublicVideoRoom): string | null {
  if (!room.startsAt || !room.endsAt) return null;
  const start = new Date(room.startsAt);
  const day = new Intl.DateTimeFormat('fr-CH', { timeZone: room.timezone, weekday: 'long', day: 'numeric', month: 'long' }).format(start);
  const time = new Intl.DateTimeFormat('fr-CH', { timeZone: room.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return `${day.charAt(0).toUpperCase()}${day.slice(1)}, ${time.format(start)} – ${time.format(new Date(room.endsAt))}`;
}

const isTouch = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
const canShareScreen = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices && 'getDisplayMedia' in navigator.mediaDevices) && !isTouch;

/** Rôle porté par les métadonnées du participant (posées par Alfred dans le jeton). */
function isHostParticipant(p: Participant): boolean {
  try {
    return (JSON.parse(p.metadata || '{}') as { role?: string }).role === 'host';
  } catch {
    return false;
  }
}

// --- cadre --------------------------------------------------------------------

function Frame({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  const theme = useTheme();
  return (
    <div className={`vc${wide ? ' vc-wide' : ''}`}>
      <header className="vc-top">
        <span className="vc-brand"><Logo /><span>Alfred</span></span>
        <button type="button" className="icon-btn" onClick={theme.toggle} aria-label={theme.dark ? 'Passer en thème clair' : 'Passer en thème sombre'}>
          {theme.dark ? <SunIcon /> : <MoonIcon />}
        </button>
      </header>
      {children}
    </div>
  );
}

function Message({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <Frame>
      <main className="vc-center">
        <div className="vc-card vc-msg">
          <span className="vc-msg-icon"><VideoIcon /></span>
          <h1>{title}</h1>
          {children && <p>{children}</p>}
          {action}
        </div>
      </main>
    </Frame>
  );
}

// --- pistes -------------------------------------------------------------------

function VideoView({ track, mirror, fit }: { track: Track; mirror?: boolean; fit?: 'cover' | 'contain' }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);
  return <video ref={ref} className={`vc-video${mirror ? ' mirror' : ''}${fit === 'contain' ? ' contain' : ''}`} autoPlay playsInline muted />;
}

function AudioView({ track }: { track: Track }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);
  return <audio ref={ref} autoPlay />;
}

function Tile({ participant, local, speaking, hostName, mirror }: { participant: Participant; local: boolean; speaking: boolean; hostName: string; mirror?: boolean }) {
  const cam = participant.getTrackPublication(Track.Source.Camera);
  const mic = participant.getTrackPublication(Track.Source.Microphone);
  const video = cam && !cam.isMuted && cam.track ? cam.track : null;
  const name = participant.name || (isHostParticipant(participant) ? hostName : 'Invité');
  const muted = !mic || mic.isMuted;
  return (
    <div className={`vc-tile${speaking ? ' speaking' : ''}`}>
      {video ? <VideoView track={video} mirror={local && mirror !== false} /> : <span className="vc-avatar" aria-hidden="true">{initials(name)}</span>}
      <span className="vc-label">
        {muted && <MicOffIcon />}
        <span>{local ? `${name} (vous)` : isHostParticipant(participant) ? `${name} · hôte` : name}</span>
      </span>
    </div>
  );
}

// --- avant d'entrer -----------------------------------------------------------

interface Prefs {
  name: string;
  camera: boolean;
  microphone: boolean;
  cameraId?: string;
  microphoneId?: string;
  /** Arrière-plan demandé : aucun, flou ou image. */
  background: Background;
}

/** L'invité patiente : l'hôte est-il déjà dans la salle (null : on ne sait pas). */
interface Waiting {
  hostPresent: boolean | null;
}

function Lobby({ room, onJoin, onPrefs, onCancel, waiting, busy, error }: {
  room: PublicVideoRoom;
  onJoin: (prefs: Prefs) => void;
  /** Les choix (micro, caméra, flou) peuvent encore changer pendant l'attente. */
  onPrefs: (prefs: Prefs) => void;
  onCancel: () => void;
  waiting: Waiting | null;
  busy: boolean;
  error: string | null;
}) {
  const [name, setName] = useState(() => {
    if (room.passName) return room.passName;
    try {
      return localStorage.getItem(NAME_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [camera, setCamera] = useState(true);
  const [microphone, setMicrophone] = useState(true);
  const [videoTrack, setVideoTrack] = useState<LocalVideoTrack | null>(null);
  const [audioTrack, setAudioTrack] = useState<LocalAudioTrack | null>(null);
  const [devices, setDevices] = useState<{ cams: MediaDeviceInfo[]; mics: MediaDeviceInfo[] }>({ cams: [], mics: [] });
  const [cameraId, setCameraId] = useState<string | undefined>();
  // Caméra réellement ouverte, relevée avant tout traitement (le flou remplace la piste par une image calculée).
  const [openedCameraId, setOpenedCameraId] = useState<string | undefined>();
  const [microphoneId, setMicrophoneId] = useState<string | undefined>();
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [background, setBackgroundChoice] = useState<Background>(backgroundWanted);

  // Aperçu de la caméra : refait à chaque changement d'appareil ou de choix.
  useEffect(() => {
    if (!camera) return;
    let track: LocalVideoTrack | null = null;
    let cancelled = false;
    createLocalVideoTrack({ deviceId: cameraId, resolution: VideoPresets.h540.resolution }).then((t) => {
      if (cancelled) return t.stop();
      track = t;
      setOpenedCameraId(t.mediaStreamTrack.getSettings().deviceId);
      setVideoTrack(t);
      setMediaError(null);
    }, (err: unknown) => {
      if (!cancelled) {
        setCamera(false);
        setMediaError(mediaErrorText(err) ?? 'La caméra ou le micro n’a pas pu être ouvert. Vous pouvez tout de même rejoindre la visio.');
      }
    });
    return () => {
      cancelled = true;
      track?.stop();
      setVideoTrack(null);
    };
  }, [camera, cameraId]);

  useEffect(() => {
    if (!microphone) return;
    let track: LocalAudioTrack | null = null;
    let cancelled = false;
    createLocalAudioTrack({ deviceId: microphoneId, echoCancellation: true, noiseSuppression: true }).then((t) => {
      if (cancelled) return t.stop();
      track = t;
      setAudioTrack(t);
    }, (err: unknown) => {
      if (!cancelled) {
        setMicrophone(false);
        setMediaError(mediaErrorText(err) ?? 'La caméra ou le micro n’a pas pu être ouvert. Vous pouvez tout de même rejoindre la visio.');
      }
    });
    return () => {
      cancelled = true;
      track?.stop();
      setAudioTrack(null);
    };
  }, [microphone, microphoneId]);

  // Indicateur de niveau du micro : on voit tout de suite que le bon micro capte.
  useEffect(() => {
    const stream = audioTrack?.mediaStreamTrack;
    if (!stream) {
      setLevel(0);
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(new MediaStream([stream])).connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    let raf = 0;
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += ((v - 128) / 128) ** 2;
      setLevel(Math.min(1, Math.sqrt(sum / data.length) * 4));
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      void ctx.close();
    };
  }, [audioTrack]);

  // Les noms des appareils ne sont lisibles qu'une fois l'accès accordé.
  useEffect(() => {
    if (!videoTrack && !audioTrack) return;
    void Room.getLocalDevices(undefined, false).then((list) => {
      setDevices({ cams: list.filter((d) => d.kind === 'videoinput'), mics: list.filter((d) => d.kind === 'audioinput') });
    }, () => undefined);
  }, [videoTrack, audioTrack]);

  const pendingRef = useRef(false);
  pendingRef.current = busy || Boolean(waiting);
  // Arrière-plan sur l'aperçu : on voit ce que verront les autres avant d'entrer.
  useEffect(() => {
    if (!videoTrack) return;
    let cancelled = false;
    setBackground(videoTrack, background).catch(() => {
      if (cancelled || background.kind === 'none') return;
      setBackgroundChoice(NO_BACKGROUND);
      // Entrée déjà demandée (connexion, salle d'attente) : la caméra est coupée plutôt que d'entrer en montrant la pièce.
      if (pendingRef.current) {
        setCamera(false);
        setMediaError(BLUR_FAILED_CAMERA_OFF);
      } else {
        setMediaError(BLUR_FAILED);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [videoTrack, background]);

  const prefs = (): Prefs => ({
    name: name.trim(), camera, microphone, background,
    cameraId: cameraId ?? openedCameraId,
    microphoneId: microphoneId ?? audioTrack?.mediaStreamTrack.getSettings().deviceId,
  });
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  useEffect(() => onPrefs(prefsRef.current()), [onPrefs, camera, microphone, background, cameraId, openedCameraId, microphoneId, videoTrack, audioTrack]);

  const when = whenLabel(room);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = name.trim();
    if (!room.isHost && !clean) return;
    try {
      if (clean && !room.isHost) localStorage.setItem(NAME_KEY, clean);
    } catch {
      // stockage indisponible (navigation privée) : rien de grave
    }
    // L'aperçu reste affiché pendant la connexion ; ses pistes sont libérées quand la salle s'ouvre.
    onJoin(prefs());
  };
  const host = room.hostName || 'votre hôte';

  return (
    <Frame>
      <main className="vc-center">
        <form className="vc-card vc-lobby" onSubmit={submit}>
          <div className="vc-preview">
            {videoTrack ? <VideoView track={videoTrack} mirror /> : (
              <span className="vc-preview-off">{camera ? 'Ouverture de la caméra…' : 'Caméra coupée'}</span>
            )}
            <div className="vc-preview-bar">
              <button type="button" className={`vc-round${microphone ? '' : ' off'}`} onClick={() => setMicrophone((v) => !v)} aria-pressed={!microphone} aria-label={microphone ? 'Couper le micro' : 'Activer le micro'}>
                {microphone ? <MicIcon /> : <MicOffIcon />}
              </button>
              <button type="button" className={`vc-round${camera ? '' : ' off'}`} onClick={() => setCamera((v) => !v)} aria-pressed={!camera} aria-label={camera ? 'Couper la caméra' : 'Activer la caméra'}>
                {camera ? <VideoIcon /> : <VideoOffIcon />}
              </button>
              {backgroundSupported && camera && (
                <BackgroundPicker value={background} onChange={(bg) => { rememberBackground(bg); setBackgroundChoice(bg); }} onError={setMediaError} />
              )}
            </div>
            {microphone && <span className="vc-level" aria-hidden="true"><span style={{ transform: `scaleX(${level})` }} /></span>}
          </div>
          <div className="vc-lobby-side">
            <div>
              <p className="vc-kicker">{room.isHost ? 'Ta salle' : `Visio avec ${room.hostName || 'votre hôte'}`}</p>
              <h1>{room.title}</h1>
              {when && <p className="vc-when">{when}</p>}
            </div>
            {room.isHost ? (
              <p className="vc-hint">Tu entres comme hôte{room.hostName ? `, sous le nom « ${room.hostName} »` : ''}.</p>
            ) : (
              <div className="fld">
                <label htmlFor="vc-name">Votre nom</label>
                <input id="vc-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={50} autoComplete="name" required autoFocus placeholder="Prénom Nom" disabled={Boolean(waiting)} readOnly={Boolean(room.passName)} />
              </div>
            )}
            {(devices.cams.length > 1 || devices.mics.length > 1) && (
              <div className="vc-devices">
                {devices.cams.length > 1 && (
                  <div className="fld">
                    <label htmlFor="vc-cam">Caméra</label>
                    <select id="vc-cam" value={cameraId ?? openedCameraId ?? ''} onChange={(e) => setCameraId(e.target.value)}>
                      {devices.cams.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Caméra ${i + 1}`}</option>)}
                    </select>
                  </div>
                )}
                {devices.mics.length > 1 && (
                  <div className="fld">
                    <label htmlFor="vc-mic">Micro</label>
                    <select id="vc-mic" value={microphoneId ?? audioTrack?.mediaStreamTrack.getSettings().deviceId ?? ''} onChange={(e) => setMicrophoneId(e.target.value)}>
                      {devices.mics.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Micro ${i + 1}`}</option>)}
                    </select>
                  </div>
                )}
              </div>
            )}
            {mediaError && <p className="vc-warn" role="status"><AlertIcon /><span>{mediaError}</span></p>}
            {error && <p className="form-error" role="alert">{error}</p>}
            {waiting ? (
              <div className="vc-wait" role="status">
                <span className="rdv-spinner" aria-hidden="true" />
                <div>
                  <strong>{waiting.hostPresent === false ? `${host.charAt(0).toUpperCase()}${host.slice(1)} n’est pas encore là` : 'Vous êtes en salle d’attente'}</strong>
                  <span>
                    {waiting.hostPresent === false
                      ? 'Vous entrerez dès qu’il vous aura fait entrer. Gardez cette page ouverte.'
                      : `${host.charAt(0).toUpperCase()}${host.slice(1)} a été prévenu et vous fera entrer dans un instant. Gardez cette page ouverte.`}
                  </span>
                </div>
              </div>
            ) : (
              <button className="btn primary vc-join" disabled={busy || (!room.isHost && !name.trim())}>
                {busy ? 'Connexion…' : room.waitingRoom ? 'Demander à entrer' : 'Rejoindre la visio'}
              </button>
            )}
            {waiting && <button type="button" className="btn ghost vc-join" onClick={onCancel}>Annuler</button>}
            <p className="vc-small">
              {room.waitingRoom && !waiting ? `${host.charAt(0).toUpperCase()}${host.slice(1)} vous fera entrer : personne ne vous voit ni ne vous entend d’ici là. ` : ''}
              Rien à installer. La vidéo passe par le serveur privé d’Alfred, en Suisse, et n’est pas enregistrée.
            </p>
          </div>
        </form>
      </main>
    </Frame>
  );
}

// --- dans la salle ------------------------------------------------------------

interface ChatLine {
  id: number;
  from: string;
  text: string;
  mine: boolean;
}

function Call({ room, info, publicRoom, initialBackground, onLeave }: { room: Room; info: VideoJoinInfo; publicRoom: PublicVideoRoom; initialBackground: Background; onLeave: (reason: 'left' | 'ended' | 'replaced' | 'lost') => void }) {
  const [, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const [speakers, setSpeakers] = useState<Set<string>>(new Set());
  const [chatOpen, setChatOpen] = useState(false);
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [unread, setUnread] = useState(0);
  const [draft, setDraft] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [canPlayAudio, setCanPlayAudio] = useState(room.canPlaybackAudio);
  const [confirmEnd, setConfirmEnd] = useState(false);
  // Caméra demandée en dernier : certains navigateurs ne disent pas laquelle est active.
  const [facing, setFacing] = useState<'user' | 'environment'>('user');
  const [background, setBackgroundChoice] = useState<Background>(initialBackground);
  const [waiters, setWaiters] = useState<VideoWaiter[]>([]);
  const [admitting, setAdmitting] = useState<string | null>(null);
  const chatId = useRef(0);
  const chatOpenRef = useRef(chatOpen);
  chatOpenRef.current = chatOpen;

  // Salle d'attente : l'hôte voit qui demande à entrer, avec un signal sonore à chaque nouvelle personne.
  useEffect(() => {
    if (!info.isHost) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const known = new Set<string>();
    // Une seule relève à la fois : celle lancée en dernier l'emporte.
    let gen = 0;
    const tick = async () => {
      const my = ++gen;
      try {
        const res = await requestJson<{ waiting: VideoWaiter[] }>('GET', `/api/video/by-slug/${encodeURIComponent(slug)}/waiting`);
        if (stopped || my !== gen) return;
        if (res.waiting.some((w) => !known.has(w.id))) chime();
        known.clear();
        for (const w of res.waiting) known.add(w.id);
        setWaiters(res.waiting);
      } catch (err) {
        // Session expirée : la file n'est plus lisible, inutile d'insister.
        if (err instanceof ApiError && err.status === 401) return;
      }
      if (!stopped && my === gen) timer = setTimeout(() => void tick(), 3000);
    };
    void tick();
    // Un onglet en arrière-plan est ralenti par le navigateur : au retour, la file est relue tout de suite.
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || stopped) return;
      clearTimeout(timer);
      void tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [info.isHost]);

  const decide = async (id: string, action: 'admit' | 'deny') => {
    setAdmitting(id);
    try {
      const res = await requestJson<{ waiting: VideoWaiter[] }>('POST', `/api/video/by-slug/${encodeURIComponent(slug)}/${action}`, { id });
      setWaiters(res.waiting);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'wait_gone') setWaiters((list) => list.filter((w) => w.id !== id));
      setToast(errorText(err));
    } finally {
      setAdmitting(null);
    }
  };

  useEffect(() => {
    const events = [
      RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected, RoomEvent.TrackSubscribed, RoomEvent.TrackUnsubscribed,
      RoomEvent.TrackMuted, RoomEvent.TrackUnmuted, RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished,
      RoomEvent.ConnectionStateChanged, RoomEvent.ParticipantNameChanged, RoomEvent.TrackPublished, RoomEvent.TrackUnpublished,
    ] as const;
    for (const e of events) room.on(e, refresh);
    const onSpeakers = (list: Participant[]) => setSpeakers(new Set(list.map((p) => p.identity)));
    const onAudio = () => setCanPlayAudio(room.canPlaybackAudio);
    const onData = (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
      if (topic !== 'chat' || !participant) return;
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload)) as { text?: unknown };
        if (typeof msg.text !== 'string' || !msg.text.trim()) return;
        const text = msg.text.slice(0, 2000);
        setChat((c) => [...c.slice(-199), { id: ++chatId.current, from: `${participant.name || 'Invité'}${isHostParticipant(participant) ? ' · hôte' : ''}`, text, mine: false }]);
        if (!chatOpenRef.current) setUnread((n) => n + 1);
      } catch {
        // message illisible : ignoré
      }
    };
    const onJoined = (p: RemoteParticipant) => setToast(`${p.name || 'Un invité'} a rejoint la visio`);
    const onDisconnected = (reason?: DisconnectReason) => {
      if (reason === DisconnectReason.ROOM_DELETED || reason === DisconnectReason.PARTICIPANT_REMOVED) onLeave('ended');
      else if (reason === DisconnectReason.DUPLICATE_IDENTITY) onLeave('replaced');
      else if (reason === DisconnectReason.CLIENT_INITIATED) onLeave('left');
      else onLeave('lost');
    };
    // La salle a pu se fermer entre la connexion et l'affichage (réunion terminée, autre onglet).
    if (room.state === ConnectionState.Disconnected) onLeave('lost');
    room.on(RoomEvent.ActiveSpeakersChanged, onSpeakers);
    room.on(RoomEvent.AudioPlaybackStatusChanged, onAudio);
    room.on(RoomEvent.DataReceived, onData);
    room.on(RoomEvent.ParticipantConnected, onJoined);
    room.on(RoomEvent.Disconnected, onDisconnected);
    return () => {
      for (const e of events) room.off(e, refresh);
      room.off(RoomEvent.ActiveSpeakersChanged, onSpeakers);
      room.off(RoomEvent.AudioPlaybackStatusChanged, onAudio);
      room.off(RoomEvent.DataReceived, onData);
      room.off(RoomEvent.ParticipantConnected, onJoined);
      room.off(RoomEvent.Disconnected, onDisconnected);
    };
  }, [room, refresh, onLeave]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (chatOpen) setUnread(0);
  }, [chatOpen]);

  const local = room.localParticipant;
  const remotes = Array.from(room.remoteParticipants.values());
  const everyone: Participant[] = [local, ...remotes];
  const micOn = local.isMicrophoneEnabled;
  const camOn = local.isCameraEnabled;
  const sharing = local.isScreenShareEnabled;

  // Partage d'écran : le premier écran partagé passe en grand.
  let screen: { track: Track; who: Participant } | null = null;
  for (const p of everyone) {
    const pub: TrackPublication | undefined = p.getTrackPublication(Track.Source.ScreenShare);
    if (pub?.track && !pub.isMuted) {
      screen = { track: pub.track, who: p };
      break;
    }
  }
  const audioTracks = remotes.flatMap((p) => Array.from(p.audioTrackPublications.values())).filter((pub) => pub.track).map((pub) => pub.track!);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      if (err instanceof Error && err.name === 'NotAllowedError' && label === 'screen') return;
      setToast(errorText(err));
    } finally {
      refresh();
    }
  };

  // Caméra : si un arrière-plan est demandé, il est posé avant que l'image parte vers les autres.
  const toggleCamera = () => run('cam', async () => {
    if (camOn) return local.setCameraEnabled(false);
    const existing = local.getTrackPublication(Track.Source.Camera)?.track as LocalVideoTrack | undefined;
    if (background.kind === 'none' || existing) return local.setCameraEnabled(true);
    try {
      await publishCameraWithBackground(local, { resolution: (info.quality === 'eco' ? VideoPresets.h360 : VideoPresets.h720).resolution }, background);
    } catch (err) {
      if (!(err instanceof BackgroundFailure)) throw err;
      // Jamais la pièce réelle à la place de l'arrière-plan demandé : la caméra reste coupée, un second clic l'ouvre sans.
      setBackgroundChoice(NO_BACKGROUND);
      setToast(BLUR_FAILED_CAMERA_OFF);
    }
  });

  const changeBackground = (next: Background) => run('background', async () => {
    const track = local.getTrackPublication(Track.Source.Camera)?.track as LocalVideoTrack | undefined;
    const previous = background;
    rememberBackground(next);
    setBackgroundChoice(next);
    if (!track) return;
    try {
      await setBackground(track, next);
    } catch {
      // Le nouveau choix n'a pas démarré : on garde l'arrière-plan précédent s'il tient encore, sinon la caméra est coupée
      // plutôt que de montrer la pièce sans que la personne l'ait décidé.
      if (next.kind === 'none') return;
      if (previous.kind !== 'none' && track.getProcessor()) {
        setBackgroundChoice(previous);
        await setBackground(track, previous).catch(() => undefined);
        setToast(BLUR_FAILED);
      } else if (previous.kind === 'none') {
        setBackgroundChoice(NO_BACKGROUND);
        setToast(BLUR_FAILED);
      } else {
        setBackgroundChoice(NO_BACKGROUND);
        await local.setCameraEnabled(false).catch(() => undefined);
        setToast(BLUR_FAILED_CAMERA_OFF);
      }
    }
  });

  const flip = () => run('flip', async () => {
    const pub = local.getTrackPublication(Track.Source.Camera);
    const track = pub?.track as LocalVideoTrack | undefined;
    if (!track) return;
    const next = facing === 'environment' ? 'user' : 'environment';
    await track.restartTrack({ facingMode: next });
    setFacing(next);
  });

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      setToast('Lien copié');
    } catch {
      setToast(location.href);
    }
  };

  const sendChat = (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    setChat((c) => [...c.slice(-199), { id: ++chatId.current, from: local.name || 'Moi', text, mine: true }]);
    void local.publishData(new TextEncoder().encode(JSON.stringify({ text })), { reliable: true, topic: 'chat' }).catch(() => setToast('Message non envoyé'));
  };

  const endForAll = async () => {
    setConfirmEnd(false);
    try {
      await requestJson('POST', `/api/video/by-slug/${encodeURIComponent(slug)}/end`, {});
    } catch (err) {
      setToast(errorText(err));
    }
  };

  const reconnecting = room.state === ConnectionState.Reconnecting || room.state === ConnectionState.SignalReconnecting;
  const alone = remotes.length === 0;
  const waitingFor = info.isHost ? 'ton invité' : (publicRoom.hostName || 'votre hôte');

  return (
    <div className="vc vc-call">
      <div className="vc-call-main">
        <div className="vc-stage-wrap">
          {reconnecting && <p className="vc-banner" role="status">Connexion perdue, reconnexion en cours…</p>}
          {!canPlayAudio && (
            <button className="vc-banner action" onClick={() => void room.startAudio().then(() => setCanPlayAudio(true), () => setToast('Le son n’a pas pu être activé. Touchez à nouveau.'))}>
              Le navigateur a bloqué le son : touchez ici pour l’activer
            </button>
          )}
          {screen ? (
            <div className="vc-screen-layout">
              <div className="vc-screen">
                <VideoView track={screen.track} fit="contain" />
                <span className="vc-label"><ScreenIcon /><span>Écran de {screen.who === local ? 'vous' : screen.who.name || 'Invité'}</span></span>
              </div>
              <div className="vc-strip">
                {everyone.map((p) => <Tile key={p.identity} participant={p} local={p === local} speaking={speakers.has(p.identity)} hostName={publicRoom.hostName} mirror={facing === 'user'} />)}
              </div>
            </div>
          ) : (
            <div className={`vc-grid n${Math.min(everyone.length, 9)}`}>
              {everyone.map((p) => <Tile key={p.identity} participant={p} local={p === local} speaking={speakers.has(p.identity)} hostName={publicRoom.hostName} mirror={facing === 'user'} />)}
            </div>
          )}
          {waiters.length > 0 && (
            <section className="vc-admit" aria-label="Salle d’attente">
              <h2>Salle d’attente <span>{waiters.length}</span></h2>
              <ul>
                {waiters.map((w) => (
                  <li key={w.id}>
                    <span className="vc-admit-name">{w.name}</span>
                    <button className="btn small primary" disabled={admitting === w.id} onClick={() => void decide(w.id, 'admit')}><CheckIcon />Faire entrer</button>
                    <button className="btn small" disabled={admitting === w.id} onClick={() => void decide(w.id, 'deny')} aria-label={`Refuser ${w.name}`} title="Refuser"><CloseIcon /></button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {alone && !screen && waiters.length === 0 && (
            <p className="vc-waiting" role="status">
              <span className="rdv-spinner" aria-hidden="true" />
              En attente de {waitingFor}…
            </p>
          )}
        </div>
        {chatOpen && (
          <aside className="vc-chat" aria-label="Messages">
            <header>
              <h2>Messages</h2>
              <button className="icon-btn" onClick={() => setChatOpen(false)} aria-label="Fermer les messages"><CloseIcon /></button>
            </header>
            <ol>
              {chat.length === 0 && <li className="vc-chat-empty">Les messages ne sont visibles que pendant la visio et ne sont pas conservés.</li>}
              {chat.map((m) => (
                <li key={m.id} className={m.mine ? 'mine' : ''}>
                  <span className="vc-chat-from">{m.mine ? 'Vous' : m.from}</span>
                  <span className="vc-chat-text">{m.text}</span>
                </li>
              ))}
            </ol>
            <form onSubmit={sendChat}>
              <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Écrire un message" maxLength={2000} aria-label="Message" />
              <button className="btn primary small" disabled={!draft.trim()}>Envoyer</button>
            </form>
          </aside>
        )}
      </div>

      <footer className="vc-controls">
        <div className="vc-controls-side">
          <span className="vc-room-title">{publicRoom.title}</span>
          <span className="vc-count"><UsersIcon />{everyone.length}</span>
        </div>
        <div className="vc-controls-main">
          <button className={`vc-round${micOn ? '' : ' off'}`} onClick={() => void run('mic', () => local.setMicrophoneEnabled(!micOn))} aria-pressed={!micOn} aria-label={micOn ? 'Couper le micro' : 'Activer le micro'} title={micOn ? 'Couper le micro' : 'Activer le micro'}>
            {micOn ? <MicIcon /> : <MicOffIcon />}
          </button>
          <button className={`vc-round${camOn ? '' : ' off'}`} onClick={() => void toggleCamera()} aria-pressed={!camOn} aria-label={camOn ? 'Couper la caméra' : 'Activer la caméra'} title={camOn ? 'Couper la caméra' : 'Activer la caméra'}>
            {camOn ? <VideoIcon /> : <VideoOffIcon />}
          </button>
          {isTouch && camOn && (
            <button className="vc-round" onClick={() => void flip()} aria-label="Changer de caméra" title="Changer de caméra"><FlipIcon /></button>
          )}
          {backgroundSupported && camOn && (
            <BackgroundPicker value={background} onChange={(bg) => void changeBackground(bg)} onError={setToast} />
          )}
          {canShareScreen && (
            <button className={`vc-round${sharing ? ' on' : ''}`} onClick={() => void run('screen', () => local.setScreenShareEnabled(!sharing, { audio: true }))} aria-pressed={sharing} aria-label={sharing ? 'Arrêter le partage d’écran' : 'Partager l’écran'} title={sharing ? 'Arrêter le partage' : 'Partager l’écran'}>
              <ScreenIcon />
            </button>
          )}
          <button className={`vc-round${chatOpen ? ' on' : ''}`} onClick={() => setChatOpen((v) => !v)} aria-pressed={chatOpen} aria-label="Messages" title="Messages">
            <ChatIcon />
            {unread > 0 && <span className="vc-badge">{unread}</span>}
          </button>
          <button className="vc-round hang" onClick={() => void room.disconnect()} aria-label="Quitter la visio" title="Quitter">
            <HangupIcon />
          </button>
        </div>
        <div className="vc-controls-side end">
          {info.isHost && (
            <>
              <button className="btn small" onClick={() => void copyLink()}><CopyIcon />Copier le lien</button>
              <button className="btn small danger" onClick={() => setConfirmEnd(true)}>Terminer pour tous</button>
            </>
          )}
        </div>
      </footer>

      {confirmEnd && (
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setConfirmEnd(false)}>
          <div className="dialog ask" role="dialog" aria-label="Terminer la visio">
            <h2>Terminer la visio pour tout le monde ?</h2>
            <p>Tous les participants seront déconnectés. Le lien reste valable : la salle pourra être rouverte.</p>
            <button className="btn wide danger" onClick={() => void endForAll()}>Terminer pour tous</button>
            <button className="btn wide ghost" onClick={() => setConfirmEnd(false)}>Annuler</button>
          </div>
        </div>
      )}
      {audioTracks.map((t) => <AudioView key={t.sid ?? t.mediaStreamTrack.id} track={t} />)}
      {toast && <div className="toast" role="status" onClick={() => setToast(null)}>{toast}</div>}
    </div>
  );
}

// --- page ---------------------------------------------------------------------

/** Renonce à une demande d'entrée (bouton Annuler, page fermée) ; l'envoi survit à la fermeture de la page. */
function leaveWait(ticket: string): void {
  void fetch(`${BASE}/${encodeURIComponent(slug)}/wait/leave`, {
    method: 'POST', keepalive: true, credentials: 'same-origin',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket }),
  }).catch(() => undefined);
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'error'; title: string; text: string }
  | { kind: 'lobby' }
  | { kind: 'call'; room: Room; info: VideoJoinInfo; background: Background }
  | { kind: 'left'; reason: 'left' | 'ended' | 'replaced' | 'lost' | 'refused' };

export function VideoApp() {
  const [publicRoom, setPublicRoom] = useState<PublicVideoRoom | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [wait, setWait] = useState<({ ticket: string } & Waiting) | null>(null);
  const roomRef = useRef<Room | null>(null);
  const prefsRef = useRef<Prefs>({ name: '', camera: true, microphone: true, background: NO_BACKGROUND });
  const waitRef = useRef(wait);
  waitRef.current = wait;
  const onPrefs = useCallback((p: Prefs) => { prefsRef.current = p; }, []);

  const load = useCallback(async () => {
    try {
      const r = await requestJson<PublicVideoRoom>('GET', `${BASE}/${encodeURIComponent(slug || '-')}${passQuery}`);
      setPublicRoom(r);
      document.title = `${r.title} · Visio`;
      if (r.status === 'open') setPhase({ kind: 'lobby' });
      else if (r.status === 'ended') setPhase({ kind: 'error', title: 'Cette visio est terminée', text: 'Le rendez-vous est passé. Si vous pensez qu’il s’agit d’une erreur, contactez votre interlocuteur.' });
      else if (r.status === 'closed') setPhase({ kind: 'error', title: 'Cette visio a été annulée', text: 'Ce lien n’est plus valable.' });
      else setPhase({ kind: 'error', title: 'Visio indisponible', text: 'La visio n’est pas disponible pour le moment. Réessayez un peu plus tard.' });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setPhase({ kind: 'error', title: 'Lien introuvable', text: 'Ce lien de visio n’existe pas. Vérifiez qu’il est complet.' });
      else setPhase({ kind: 'error', title: 'Connexion impossible', text: errorText(err) });
    }
  }, []);

  useEffect(() => void load(), [load]);

  // En quittant la page, la connexion est fermée proprement (les autres le voient tout de suite).
  useEffect(() => {
    const onUnload = () => {
      void roomRef.current?.disconnect();
      // Page fermée pendant l'attente : l'hôte ne voit plus la demande.
      if (waitRef.current) leaveWait(waitRef.current.ticket);
    };
    window.addEventListener('pagehide', onUnload);
    return () => window.removeEventListener('pagehide', onUnload);
  }, []);

  const waitUrl = `${BASE}/${encodeURIComponent(slug)}/wait`;

  // Ouvre la salle avec un jeton d'entrée, puis la caméra et le micro selon les choix faits avant d'entrer.
  const connect = async (info: VideoJoinInfo, prefs: Prefs): Promise<boolean> => {
    let room: Room | null = null;
    try {
      const eco = info.quality === 'eco';
      room = new Room({
        adaptiveStream: true,
        dynacast: true,
        videoCaptureDefaults: { resolution: (eco ? VideoPresets.h360 : VideoPresets.h720).resolution },
        publishDefaults: {
          simulcast: true,
          videoSimulcastLayers: eco ? [VideoPresets.h180] : [VideoPresets.h180, VideoPresets.h360],
          videoEncoding: (eco ? VideoPresets.h360 : VideoPresets.h720).encoding,
          dtx: true,
          red: true,
        },
        audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      // Une déconnexion pendant l'ouverture de la caméra et du micro (réunion terminée, autre onglet,
      // coupure) ne doit pas se perdre : l'écran d'appel n'écoute qu'une fois affiché.
      let early: DisconnectReason | 'none' | undefined;
      const onEarly = (reason?: DisconnectReason) => { early = reason ?? 'none'; };
      room.on(RoomEvent.Disconnected, onEarly);
      await room.connect(info.url, info.token);
      roomRef.current = room;
      // Caméra et micro : un refus n'empêche pas d'entrer (on peut écouter et parler par messages).
      const problems: string[] = [];
      let background: Background = backgroundSupported ? prefs.background : NO_BACKGROUND;
      const local = room.localParticipant;
      if (prefs.microphone) await local.setMicrophoneEnabled(true, { deviceId: prefs.microphoneId }).catch(() => problems.push('micro'));
      if (prefs.camera) {
        // Flou demandé : il est posé avant la publication, aucune image nette ne part vers les autres.
        // S'il ne démarre pas, la caméra reste coupée : à la personne de décider si elle l'ouvre sans flou.
        const opening = background.kind !== 'none'
          ? publishCameraWithBackground(local, { deviceId: prefs.cameraId, resolution: (eco ? VideoPresets.h360 : VideoPresets.h720).resolution }, background)
          : local.setCameraEnabled(true, { deviceId: prefs.cameraId });
        await opening.catch((err: unknown) => {
          if (err instanceof BackgroundFailure) {
            background = NO_BACKGROUND;
            problems.push('arrière-plan choisi (caméra laissée coupée)');
          } else {
            problems.push('caméra');
          }
        });
      }
      room.off(RoomEvent.Disconnected, onEarly);
      if (early !== undefined || room.state === ConnectionState.Disconnected) {
        roomRef.current = null;
        setPhase({
          kind: 'left',
          reason: early === DisconnectReason.ROOM_DELETED || early === DisconnectReason.PARTICIPANT_REMOVED ? 'ended' : early === DisconnectReason.DUPLICATE_IDENTITY ? 'replaced' : 'lost',
        });
        return true;
      }
      setPhase({ kind: 'call', room, info, background });
      if (problems.length > 0) setJoinError(`Impossible d’ouvrir : ${problems.join(' et ')}.`);
      return true;
    } catch (err) {
      await room?.disconnect().catch(() => undefined);
      roomRef.current = null;
      setJoinError(errorText(err));
      return false;
    }
  };

  const join = async (prefs: Prefs) => {
    if (!publicRoom) return;
    setBusy(true);
    setJoinError(null);
    prefsRef.current = prefs;
    try {
      const result = await requestJson<VideoJoinResult>('POST', `${BASE}/${encodeURIComponent(slug)}/join`, { name: prefs.name, ...passBody });
      if ('waiting' in result) setWait({ ticket: result.ticket, hostPresent: result.hostPresent });
      else await connect(result, prefs);
    } catch (err) {
      setJoinError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  // Salle d'attente : la demande est suivie toutes les 3 secondes, jusqu'à l'admission ou au refus.
  const ticket = wait?.ticket;
  useEffect(() => {
    if (!ticket) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Une seule relève à la fois : celle lancée en dernier l'emporte (retour sur l'onglet pendant une relève).
    let gen = 0;
    // Entrée avec le jeton reçu ; en cas d'échec, la place gardée par ce ticket est rendue tout de suite.
    const enter = async (info: VideoJoinInfo, held: string | null) => {
      stopped = true;
      setBusy(true);
      setWait(null);
      const ok = await connect(info, prefsRef.current);
      if (!ok && held) leaveWait(held);
      setBusy(false);
    };
    const tick = async () => {
      const my = ++gen;
      const stale = () => stopped || my !== gen;
      let delay = 3000;
      try {
        const status = await requestJson<VideoWaitStatus>('POST', waitUrl, { ticket });
        if (stale()) return;
        if (status.state === 'waiting') {
          setWait((w) => (w && w.ticket === ticket ? { ...w, hostPresent: status.hostPresent } : w));
        } else if (status.state === 'denied') {
          stopped = true;
          setWait(null);
          setPhase({ kind: 'left', reason: 'refused' });
          return;
        } else {
          await enter(status.join, ticket);
          return;
        }
      } catch (err) {
        if (stale()) return;
        if (err instanceof ApiError && err.code === 'wait_expired') {
          // Page restée longtemps en arrière-plan : la demande est refaite sans rien redemander.
          stopped = true;
          try {
            const again = await requestJson<VideoJoinResult>('POST', `${BASE}/${encodeURIComponent(slug)}/join`, { name: prefsRef.current.name, ...passBody });
            if (cancelled) {
              if ('waiting' in again) leaveWait(again.ticket);
              return;
            }
            if ('waiting' in again) setWait({ ticket: again.ticket, hostPresent: again.hostPresent });
            else await enter(again, null);
          } catch (inner) {
            if (cancelled) return;
            setWait(null);
            setJoinError(errorText(inner));
          }
          return;
        }
        if (err instanceof ApiError && (err.status === 410 || err.status === 404 || err.status === 403)) {
          stopped = true;
          setWait(null);
          void load();
          return;
        }
        // Coupure passagère, serveur occupé : on réessaie, moins souvent.
        delay = 6000;
      }
      if (!stale()) timer = setTimeout(() => void tick(), delay);
    };
    // L'effet a été défait (annulation, page quittée) : à distinguer d'un arrêt décidé par la relève elle-même.
    let cancelled = false;
    timer = setTimeout(() => void tick(), 1500);
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || stopped) return;
      clearTimeout(timer);
      void tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket]);

  const cancelWait = () => {
    if (wait) leaveWait(wait.ticket);
    setWait(null);
  };

  const onLeave = useCallback((reason: 'left' | 'ended' | 'replaced' | 'lost') => {
    roomRef.current = null;
    setPhase({ kind: 'left', reason });
  }, []);

  const content = useMemo(() => {
    if (phase.kind === 'loading') {
      return (
        <Frame>
          <main className="vc-center"><div className="rdv-loading" role="status"><span className="rdv-spinner" aria-hidden="true" /><span>Chargement de la visio…</span></div></main>
        </Frame>
      );
    }
    if (phase.kind === 'error') return <Message title={phase.title}>{phase.text}</Message>;
    if (phase.kind === 'left') {
      const texts = {
        left: ['Vous avez quitté la visio', 'Vous pouvez la rejoindre à nouveau tant qu’elle est ouverte.'],
        ended: ['La visio est terminée', 'L’hôte a terminé la réunion pour tout le monde.'],
        replaced: ['Visio ouverte ailleurs', 'Vous avez rejoint cette visio depuis un autre appareil ou un autre onglet.'],
        lost: ['Connexion perdue', 'La connexion à la visio a été interrompue. Vérifiez votre réseau, puis rejoignez-la à nouveau.'],
        refused: ['Votre demande n’a pas été acceptée', 'Votre hôte ne vous a pas fait entrer. S’il s’agit d’une erreur, contactez-le, puis demandez à nouveau à entrer.'],
      } as const;
      const [title, text] = texts[phase.reason];
      return (
        <Message title={title} action={<button className="btn primary" onClick={() => { setJoinError(null); void load(); }}>{phase.reason === 'refused' ? 'Demander à nouveau' : 'Rejoindre à nouveau'}</button>}>
          {text}
        </Message>
      );
    }
    if (!publicRoom) return null;
    if (phase.kind === 'lobby') return <Lobby room={publicRoom} onJoin={(p) => void join(p)} onPrefs={onPrefs} onCancel={cancelWait} waiting={wait} busy={busy} error={joinError} />;
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, publicRoom, busy, joinError, load, wait, onPrefs]);

  if (phase.kind === 'call' && publicRoom) {
    return (
      <>
        <Call room={phase.room} info={phase.info} publicRoom={publicRoom} initialBackground={phase.background} onLeave={onLeave} />
        {joinError && <div className="toast" role="alert" onClick={() => setJoinError(null)}><AlertIcon />{joinError}</div>}
      </>
    );
  }
  return content;
}
