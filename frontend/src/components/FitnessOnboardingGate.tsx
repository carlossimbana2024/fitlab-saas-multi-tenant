import axios from 'axios';
import { useState, type ReactNode } from 'react';

export function isFitnessWriteRestricted(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response?.status === 402
    && ['SUBSCRIPTION_NOT_CONFIGURED', 'SUBSCRIPTION_READ_ONLY', 'SUBSCRIPTION_GRACE_EXPIRED']
      .includes(error.response?.data?.error?.code);
}

/** A mounted UI exception only: never changes profile data or persists consent. */
export function FitnessOnboardingGate({ required, pending, error, children }: {
  required: boolean; pending: boolean; error: unknown;
  children: (readOnlyAction: ReactNode) => ReactNode;
}) {
  const [deferred, setDeferred] = useState(false);
  const canDefer = required && !pending && isFitnessWriteRestricted(error);
  const hidden = required && deferred;
  return <>
    {hidden && <section className="alert" role="status">
      <p>Tu encuesta deportiva sigue pendiente. Puedes consultar el portal; las acciones de escritura siguen sujetas a las restricciones de tu gimnasio.</p>
      <button type="button" className="ghost" onClick={() => setDeferred(false)}>Completar encuesta pendiente</button>
    </section>}
    <div style={hidden ? { display: 'none' } : undefined}>
      {children(canDefer ? <div className="alert" role="status">
        <p>Algunas funciones de tu gimnasio están temporalmente limitadas y no podemos guardar tu información. Puedes continuar consultando tu portal y completar estos datos más adelante.</p>
        <button type="button" className="ghost" onClick={() => { if (canDefer) setDeferred(true); }}>Continuar en modo lectura</button>
      </div> : null)}
    </div>
  </>;
}
