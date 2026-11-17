import { createLocalVideoTrack, type LocalParticipant, type LocalVideoTrack, type Track, type TrackProcessor, type VideoCaptureOptions } from 'livekit-client';
import type { BackgroundProcessorWrapper, SwitchBackgroundProcessorOptions } from '@livekit/track-processors';
import bleu from './fonds/bleu.jpg';
import clair from './fonds/clair.jpg';
import foret from './fonds/foret.jpg';
import nuit from './fonds/nuit.jpg';
import sable from './fonds/sable.jpg';

// Dossier servi par Alfred (voir vite.config.ts) : moteur WebAssembly et modèle de détourage.
declare const __BLUR_ASSETS__: string;

const CHOICE_KEY = 'alfred:video-fond';
const LEGACY_BLUR_KEY = 'alfred:video-blur';
const CUSTOM_KEY = 'alfred:video-fond-image';

export type VideoProcessor = TrackProcessor<Track.Kind.Video>;

/** Arrière-plan choisi : la pièce telle quelle, floutée, ou remplacée par une image. */
export type Background = { kind: 'none' } | { kind: 'blur' } | { kind: 'image'; id: string };

export const NO_BACKGROUND: Background = { kind: 'none' };

/** Fonds proposés, servis par Alfred. « perso » désigne l'image importée par la personne. */
export const BACKGROUND_IMAGES: { id: string; label: string; src: string }[] = [
  { id: 'clair', label: 'Clair', src: clair },
  { id: 'sable', label: 'Sable', src: sable },
  { id: 'bleu', label: 'Bleu', src: bleu },
  { id: 'foret', label: 'Forêt', src: foret },
  { id: 'nuit', label: 'Nuit', src: nuit },
];
export const CUSTOM_ID = 'perso';

/**
 * Le navigateur sait traiter l'arrière-plan : il lui faut WebGL 2 et le traitement des images
 * de la caméra. Même test que la bibliothèque, sans la charger (elle ne l'est qu'à la demande).
 */
export const backgroundSupported: boolean = (() => {
  try {
    const w = window as unknown as Record<string, unknown>;
    const transformer = typeof OffscreenCanvas !== 'undefined' && typeof VideoFrame !== 'undefined' && typeof createImageBitmap !== 'undefined'
      && Boolean(document.createElement('canvas').getContext('webgl2'));
    const streams = typeof w.MediaStreamTrackGenerator !== 'undefined' && typeof w.MediaStreamTrackProcessor !== 'undefined';
    const canvas = typeof HTMLCanvasElement !== 'undefined' && 'captureStream' in HTMLCanvasElement.prototype;
    return transformer && (streams || canvas);
  } catch {
    return false;
  }
})();

export function sameBackground(a: Background, b: Background): boolean {
  return a.kind === b.kind && (a.kind !== 'image' || a.id === (b as { id: string }).id);
}

/** Image importée par la personne, gardée sur cet appareil seulement (jamais envoyée à Alfred). */
export function customImage(): string | null {
  try {
    const v = localStorage.getItem(CUSTOM_KEY);
    return v && v.startsWith('data:image/') ? v : null;
  } catch {
    return null;
  }
}

/** Adresse de l'image d'un fond, ou null (pas d'image, ou image importée disparue). */
export function backgroundSrc(bg: Background): string | null {
  if (bg.kind !== 'image') return null;
  if (bg.id === CUSTOM_ID) return customImage();
  return BACKGROUND_IMAGES.find((i) => i.id === bg.id)?.src ?? null;
}

/** Dernier choix de la personne sur cet appareil. */
export function backgroundWanted(): Background {
  if (!backgroundSupported) return NO_BACKGROUND;
  try {
    const v = localStorage.getItem(CHOICE_KEY);
    if (v === 'blur') return { kind: 'blur' };
    if (v?.startsWith('image:')) {
      const bg: Background = { kind: 'image', id: v.slice(6) };
      // Image importée disparue : le choix est gardé, et son échec est dit (caméra laissée coupée) plutôt que
      // de montrer la pièce sans prévenir.
      return bg;
    }
    if (v === null && localStorage.getItem(LEGACY_BLUR_KEY) === '1') return { kind: 'blur' };
  } catch {
    // stockage indisponible
  }
  return NO_BACKGROUND;
}

export function rememberBackground(bg: Background): void {
  try {
    localStorage.setItem(CHOICE_KEY, bg.kind === 'image' ? `image:${bg.id}` : bg.kind);
  } catch {
    // stockage indisponible : le choix vaut pour cette visio seulement
  }
}

/**
 * Prépare une image choisie par la personne : recadrée en 16:9 et réduite à 1280 × 720, pour rester
 * légère. Elle est gardée dans le navigateur ; si le stockage refuse, elle sert pour cette visio seulement.
 */
export async function importBackgroundImage(file: File): Promise<void> {
  if (!file.type.startsWith('image/')) throw new Error('not-an-image');
  const bitmap = await createImageBitmap(file);
  try {
    const W = 1280;
    const H = 720;
    const scale = Math.max(W / bitmap.width, H / bitmap.height);
    const w = bitmap.width * scale;
    const h = bitmap.height * scale;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no-canvas');
    ctx.drawImage(bitmap, (W - w) / 2, (H - h) / 2, w, h);
    const data = canvas.toDataURL('image/jpeg', 0.82);
    try {
      localStorage.setItem(CUSTOM_KEY, data);
      session = null;
    } catch {
      // Stockage plein ou indisponible : l'image reste en mémoire pour cette visio, et l'ancienne n'est plus proposée.
      session = data;
      try {
        localStorage.removeItem(CUSTOM_KEY);
      } catch {
        // stockage indisponible
      }
    }
  } finally {
    bitmap.close();
  }
}

/** Image importée pendant cette visite, si le stockage du navigateur l'a refusée. */
let session: string | null = null;
export function customImageNow(): string | null {
  return session ?? customImage();
}

/** L'arrière-plan n'a pas pu démarrer (à distinguer d'une caméra refusée ou absente). */
export class BackgroundFailure extends Error {}

/** Charge l'image avant de s'en servir : sans elle, l'arrière-plan réel resterait visible. */
function preload(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('image'));
    img.src = src;
  });
}

async function modeOf(bg: Background): Promise<SwitchBackgroundProcessorOptions> {
  if (bg.kind === 'blur') return { mode: 'background-blur', blurRadius: 12 };
  const src = bg.kind === 'image' ? (bg.id === CUSTOM_ID ? customImageNow() : backgroundSrc(bg)) : null;
  if (!src) throw new Error('no-image');
  await preload(src);
  return { mode: 'virtual-background', imagePath: src };
}

/** Nouveau traitement d'arrière-plan, à poser sur une piste de caméra (un par piste). Tout se calcule dans le navigateur. */
async function createProcessor(bg: Background): Promise<BackgroundProcessorWrapper> {
  const [{ BackgroundProcessor }, mode] = await Promise.all([import('@livekit/track-processors'), modeOf(bg)]);
  return BackgroundProcessor({
    ...mode,
    assetPaths: { tasksVisionFileSet: __BLUR_ASSETS__, modelAssetPath: `${__BLUR_ASSETS__}/selfie_segmenter.tflite` },
  });
}

/**
 * Ouvre la caméra et ne la publie qu'une fois l'arrière-plan posé : aucune image de la pièce ne part
 * vers les autres. S'il ne démarre pas, la caméra est refermée (voyant éteint) et BackgroundFailure est levée.
 */
export async function publishCameraWithBackground(local: LocalParticipant, options: VideoCaptureOptions, bg: Background): Promise<void> {
  let processor: BackgroundProcessorWrapper;
  try {
    processor = await createProcessor(bg);
  } catch (err) {
    throw new BackgroundFailure(String(err));
  }
  const track = await createLocalVideoTrack(options);
  try {
    await track.setProcessor(processor as unknown as VideoProcessor);
  } catch (err) {
    track.stop();
    throw new BackgroundFailure(String(err));
  }
  try {
    await local.publishTrack(track);
  } catch (err) {
    track.stop();
    throw err;
  }
}

const wanted = new WeakMap<LocalVideoTrack, Background>();
const chain = new WeakMap<LocalVideoTrack, Promise<void>>();

/**
 * Change l'arrière-plan d'une piste déjà ouverte. Les demandes sont traitées une à une et la
 * dernière l'emporte : des clics rapprochés ne laissent pas la piste dans un autre état que le choix affiché.
 * Passer du flou à une image (ou l'inverse) garde le même traitement, sans image nette entre les deux.
 */
export function setBackground(track: LocalVideoTrack, bg: Background): Promise<void> {
  wanted.set(track, bg);
  const next = (chain.get(track) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const want = wanted.get(track) ?? NO_BACKGROUND;
    const current = track.getProcessor() as unknown as BackgroundProcessorWrapper | undefined;
    if (want.kind === 'none') {
      if (current) await track.stopProcessor();
    } else if (current && typeof current.switchTo === 'function') {
      await current.switchTo(await modeOf(want));
    } else {
      if (current) await track.stopProcessor();
      await track.setProcessor((await createProcessor(want)) as unknown as VideoProcessor);
    }
  });
  chain.set(track, next);
  return next;
}
