import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter/opsz.css';
import './styles.css';

// Deux apps dans la même page : le visiteur de /rdv ne télécharge ni n'appelle rien de privé.
const isPublic = /^\/rdv(\/|$)/.test(location.pathname);
const Root = isPublic
  ? lazy(() => import('./rdv/PublicApp').then((m) => ({ default: m.PublicApp })))
  : lazy(() => import('./PrivateRoot').then((m) => ({ default: m.PrivateRoot })));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Root />
    </Suspense>
  </StrictMode>,
);
