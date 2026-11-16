import type { LocalVideoTrack, TrackProcessor, Track } from 'livekit-client';

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

/** Active ou retire le flou sur une piste déjà ouverte. */
export async function setBlur(track: LocalVideoTrack, on: boolean): Promise<void> {
  if (on) {
    if (!track.getProcessor()) await track.setProcessor(await createBlur());
  } else if (track.getProcessor()) {
    await track.stopProcessor();
  }
}
