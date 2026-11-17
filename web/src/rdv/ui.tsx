import { useId } from 'react';
import './rdv.css';

/** Champ de formulaire : libellé, contenu, puis erreur ou aide. `badge` : précision à droite du libellé. */
export function Fld({ label, error, hint, children, className, badge }: { label: string; error?: string; hint?: React.ReactNode; children: (id: string) => React.ReactNode; className?: string; badge?: React.ReactNode }) {
  const id = useId();
  return (
    <div className={`fld${error ? ' invalid' : ''}${className ? ` ${className}` : ''}`}>
      <label htmlFor={id}>{label}{badge}</label>
      {children(id)}
      {error ? <p className="fld-err" role="alert">{error}</p> : hint ? <p className="fld-hint">{hint}</p> : null}
    </div>
  );
}

export function Card({ title, sub, action, children, id }: { title: string; sub?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; id?: string }) {
  return (
    <section className="bk-card" id={id}>
      <header className="bk-card-head">
        <div>
          <h2>{title}</h2>
          {sub && <p>{sub}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}
