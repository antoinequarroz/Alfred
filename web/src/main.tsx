import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
// Typographie de la suite Media (Cairn, Lamio, Metricove) : Geist, Geist Mono, Instrument Serif.
import '@fontsource-variable/geist/wght.css';
import '@fontsource-variable/geist-mono/wght.css';
import '@fontsource/instrument-serif/latin-400.css';
import './styles.css';

// Trois apps dans la même page : le visiteur de /rdv ou d'une salle de visio (/v/…) ne télécharge rien de privé.
const isPublic = /^\/rdv(\/|$)/.test(location.pathname);
const isVideo = /^\/v\/[^/]+\/?$/.test(location.pathname);
const Root = isVideo
  ? lazy(() => import('./video/VideoApp').then((m) => ({ default: m.VideoApp })))
  : isPublic
    ? lazy(() => import('./rdv/PublicApp').then((m) => ({ default: m.PublicApp })))
    : lazy(() => import('./PrivateRoot').then((m) => ({ default: m.PrivateRoot })));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Root />
    </Suspense>
  </StrictMode>,
);
