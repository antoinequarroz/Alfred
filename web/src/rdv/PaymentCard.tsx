import { useCallback, useEffect, useState } from 'react';
import type { ConnectionTest, PaymentSettingsState } from '../../../shared/types';
import { ApiError, paymentsApi } from '../api';
import { ExternalIcon } from '../icons';
import { TestResult } from '../settings/ConnectionCards';
import { Card, Fld } from './ui';

const message = (err: unknown) => (err instanceof Error ? err.message : 'Une erreur est survenue');

/** État du paiement en ligne, partagé par la carte des Réglages et la fenêtre des types (acompte). */
export function usePayments(): { state: PaymentSettingsState | null; set: (s: PaymentSettingsState) => void; reload: () => Promise<void> } {
  const [state, setState] = useState<PaymentSettingsState | null>(null);
  const reload = useCallback(async () => {
    try {
      setState(await paymentsApi.state());
    } catch {
      // Sans réponse, la carte reste en chargement ; le reste de l'écran fonctionne.
    }
  }, []);
  useEffect(() => void reload(), [reload]);
  return { state, set: setState, reload };
}

/**
 * Réglages Stripe : clé secrète (jamais réaffichée), TWINT, règle de remboursement.
 * Tout se fait ici, sans terminal.
 */
export function PaymentCard({ state, onState, notify }: { state: PaymentSettingsState; onState: (s: PaymentSettingsState) => void; notify: (msg: string) => void }) {
  const [key, setKey] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'save' | 'test' | 'clear' | null>(null);
  const [result, setResult] = useState<Pick<ConnectionTest, 'ok' | 'message'> | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [hoursText, setHoursText] = useState(String(state.refundHours ?? 24));
  useEffect(() => setHoursText(String(state.refundHours ?? 24)), [state.refundHours]);

  const save = async (patch: { secretKey?: string; twint?: boolean; refundHours?: number | null }, done: string) => {
    setBusy('save');
    setErrors({});
    setResult(null);
    try {
      const res = await paymentsApi.save(patch);
      onState(res.state);
      if (patch.secretKey) setKey('');
      if (res.test) setResult(res.test);
      notify(done);
    } catch (err) {
      if (err instanceof ApiError && err.fields) setErrors(err.fields);
      else setResult({ ok: false, message: message(err) });
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy('test');
    setResult(null);
    try {
      const res = await paymentsApi.test();
      onState(res.state);
      setResult(res.test);
    } catch (err) {
      setResult({ ok: false, message: message(err) });
    } finally {
      setBusy(null);
    }
  };

  const clear = async () => {
    setBusy('clear');
    try {
      onState((await paymentsApi.clear()).state);
      setConfirmClear(false);
      setResult(null);
      notify('Clé Stripe retirée : plus aucun acompte n’est demandé');
    } catch (err) {
      setResult({ ok: false, message: message(err) });
    } finally {
      setBusy(null);
    }
  };

  const saveHours = () => {
    const n = Number(hoursText);
    if (!Number.isInteger(n) || n < 0 || n > 720) {
      setErrors({ refundHours: 'Nombre entier d’heures entre 0 et 720' });
      return;
    }
    if (n !== state.refundHours) void save({ refundHours: n }, 'Règle de remboursement enregistrée');
  };

  const statusKind = state.unreadable ? 'bad' : state.configured ? (state.lastTest && !state.lastTest.ok ? 'bad' : 'ok') : 'off';
  const statusTitle = state.unreadable
    ? 'Clé à ressaisir'
    : state.configured
      ? `Paiement en ligne actif${state.mode === 'test' ? ', en mode test' : ''}`
      : 'Paiement en ligne non configuré';
  const statusText = state.unreadable
    ? 'La clé enregistrée ne peut plus être déchiffrée. Ressaisis-la ci-dessous : en attendant, les types avec acompte ne sont pas proposés.'
    : state.configured
      ? state.mode === 'test'
        ? `Clé de test (…${state.keyHint}) : aucun vrai paiement. Paie avec la carte 4242 4242 4242 4242 pour essayer, puis remplace-la par ta clé « live ».`
        : `Clé « live » (…${state.keyHint}) : les acomptes arrivent sur ton compte Stripe.`
      : 'Ajoute ta clé Stripe, puis indique un acompte dans les types de rendez-vous concernés.';

  return (
    <Card id="bk-paiement" title="Paiement en ligne" sub="Acompte demandé à la réservation, par carte ou TWINT, encaissé sur ton compte Stripe.">
      <div className={`bk-status ${statusKind}`}>
        <span className="sync-dot" />
        <div>
          <p className="bk-status-title">{statusTitle}</p>
          <p className="bk-meta">{statusText}</p>
        </div>
      </div>

      <form className="bk-form cx-form" autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (key.trim()) void save({ secretKey: key.trim() }, 'Clé Stripe enregistrée'); }}>
        <div className="bk-grid cx-grid">
          <Fld
            label={state.configured ? 'Nouvelle clé secrète' : 'Clé secrète Stripe'}
            error={errors.secretKey}
            className="span-2"
            hint={<>Dans Stripe : Développeurs, puis Clés API. La clé secrète commence par <code>sk_live_</code> (ou <code>sk_test_</code> pour essayer). Elle est vérifiée auprès de Stripe, puis enregistrée chiffrée ; elle ne s’affiche plus ensuite.</>}
          >
            {(id) => (
              <input id={id} type="password" name="stripe-cle" autoComplete="new-password" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                maxLength={300} placeholder={state.configured ? 'Laisse vide pour garder la clé actuelle' : 'sk_live_…'} value={key} onChange={(e) => setKey(e.target.value)} />
            )}
          </Fld>
        </div>
        {key.trim() && (
          <div className="bk-savebar static">
            <span />
            <button type="button" className="btn ghost" disabled={busy !== null} onClick={() => { setKey(''); setErrors({}); }}>Annuler</button>
            <button type="submit" className="btn primary" disabled={busy !== null}>{busy === 'save' ? 'Vérification…' : 'Vérifier et enregistrer'}</button>
          </div>
        )}
      </form>

      <TestResult test={result ?? state.lastTest} />

      <div className="bk-form">
        <label className="check">
          <input type="checkbox" checked={state.twint} disabled={busy !== null} onChange={(e) => void save({ twint: e.target.checked }, e.target.checked ? 'TWINT proposé' : 'TWINT retiré')} />
          Proposer TWINT en plus de la carte
        </label>
        <p className="fld-hint">TWINT doit aussi être activé dans Stripe : Paramètres, puis Moyens de paiement. S’il ne l’est pas, la page de paiement ne s’ouvre pas : décoche alors cette case.</p>

        <label className="check">
          <input type="checkbox" checked={state.refundHours !== null} disabled={busy !== null}
            onChange={(e) => void save({ refundHours: e.target.checked ? Number(hoursText) || 24 : null }, e.target.checked ? 'Remboursement automatique activé' : 'Remboursement automatique désactivé')} />
          Rembourser automatiquement le client qui annule à temps
        </label>
        {state.refundHours !== null && (
          <div className="bk-grid">
            <Fld label="Au moins (heures avant le rendez-vous)" error={errors.refundHours} hint="Une annulation plus tardive garde l’acompte. Quand c’est toi qui annules, l’acompte est remboursé (tu peux décocher).">
              {(id) => (
                <input id={id} type="number" inputMode="numeric" min={0} max={720} value={hoursText}
                  onChange={(e) => setHoursText(e.target.value)} onBlur={saveHours} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveHours(); } }} />
              )}
            </Fld>
          </div>
        )}
        {state.refundHours === null && <p className="fld-hint">L’acompte n’est jamais remboursé quand le client annule. Tu peux toujours rembourser à la main depuis la liste des réservations.</p>}
      </div>

      {state.pendingCount > 0 && <p className="bk-meta">{state.pendingCount} paiement{state.pendingCount > 1 ? 's' : ''} en cours : le créneau reste retenu jusqu’à 30 minutes.</p>}

      {confirmClear ? (
        <div className="bk-savebar static">
          <span>Retirer la clé ? Les types avec acompte ne seront plus proposés tant qu’une clé n’est pas remise.</span>
          <button type="button" className="btn ghost" onClick={() => setConfirmClear(false)}>Garder</button>
          <button type="button" className="btn danger" disabled={busy !== null} onClick={() => void clear()}>Retirer</button>
        </div>
      ) : state.configured || state.unreadable ? (
        <div className="bk-savebar static">
          <a className="btn ghost" href={`https://dashboard.stripe.com/${state.mode === 'test' ? 'test/' : ''}payments`} target="_blank" rel="noopener"><ExternalIcon />Tableau de bord Stripe</a>
          <span />
          <button type="button" className="btn ghost danger" disabled={busy !== null} onClick={() => setConfirmClear(true)}>Retirer la clé</button>
          {state.configured && <button type="button" className="btn" disabled={busy !== null} onClick={() => void test()}>{busy === 'test' ? 'Essai…' : 'Tester la clé'}</button>}
        </div>
      ) : null}
    </Card>
  );
}
