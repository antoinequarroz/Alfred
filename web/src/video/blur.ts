import { createLocalVideoTrack, type LocalParticipant, type LocalVideoTrack, type Track, type TrackProcessor, type VideoCaptureOptions } from 'livekit-client';

// Dossier servi par Alfred (voir vite.config.ts) : moteur WebAssembly et modèle de détourage.
declare const __BLUR_ASSETS__: string;

const BLUR_KEY = 'alfred:video-blur';

export type VideoProcessor = TrackProcessor<Track.Kind.Video>;

/**
 * Le navigateur sait flouter l'arrière-plan : il lui faut WebGL 2 et le traitement des images
 * de la caméra. Même test que la bibliothèque, sans la charger (elle ne l'est qu'à la demande).
 */
export const blurSupported: boolean = (() => {
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

/** Dernier choix de la personne sur cet appareil. */
export function blurWanted(): boolean {
  try {
    return blurSupported && localStorage.getItem(BLUR_KEY) === '1';
  } catch {
    return false;
  }
}

export function rememberBlur(on: boolean): void {
  try {
    localStorage.setItem(BLUR_KEY, on ? '1' : '0');
  } catch {
    // stockage indisponible : le choix vaut pour cette visio seulement
  }
}

/** Nouveau traitement de flou, à poser sur une piste de caméra (un par piste). Tout se calcule dans le navigateur. */
export async function createBlur(): Promise<VideoProcessor> {
  const { BackgroundProcessor } = await import('@livekit/track-processors');
  return BackgroundProcessor({
    mode: 'background-blur',
    blurRadius: 12,
    assetPaths: { tasksVisionFileSet: __BLUR_ASSETS__, modelAssetPath: `${__BLUR_ASSETS__}/selfie_segmenter.tflite` },
  }) as unknown as VideoProcessor;
}

/** Le flou n'a pas pu démarrer (à distinguer d'une caméra refusée ou absente). */
export class BlurFailure extends Error {}

/**
 * Ouvre la caméra et ne la publie qu'une fois le flou posé : aucune image nette ne part vers les
 * autres. Si le flou ne démarre pas, la caméra est refermée (voyant éteint) et BlurFailure est levée.
 */
export async function publishBlurredCamera(local: LocalParticipant, options: VideoCaptureOptions): Promise<void> {
  let processor: VideoProcessor;
  try {
    processor = await createBlur();
  } catch (err) {
    throw new BlurFailure(String(err));
  }
  const track = await createLocalVideoTrack(options);
  try {
    await track.setProcessor(processor);
  } catch (err) {
    track.stop();
    throw new BlurFailure(String(err));
  }
  try {
    await local.publishTrack(track);
  } catch (err) {
    track.stop();
    throw err;
  }
}

const wanted = new WeakMap<LocalVideoTrack, boolean>();
const chain = new WeakMap<LocalVideoTrack, Promise<void>>();

/**
 * Active ou retire le flou sur une piste déjà ouverte. Les demandes sont traitées une à une et la
 * dernière l'emporte : des clics rapprochés ne laissent pas le flou dans l'état inverse du bouton.
 */
export function setBlur(track: LocalVideoTrack, on: boolean): Promise<void> {
  wanted.set(track, on);
  const next = (chain.get(track) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const want = wanted.get(track) ?? false;
    if (want && !track.getProcessor()) await track.setProcessor(await createBlur());
    else if (!want && track.getProcessor()) await track.stopProcessor();
  });
  chain.set(track, next);
  return next;
}
