import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter/opsz.css';
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
