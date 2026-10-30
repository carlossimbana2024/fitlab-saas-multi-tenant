import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const requireFrontend = createRequire(new URL('../../frontend/package.json', import.meta.url));
const React = requireFrontend('react');
const { act, create } = requireFrontend('react-test-renderer');
const axios = requireFrontend('axios/dist/node/axios.cjs');
const source = readFileSync(new URL('../../frontend/src/components/FitnessOnboardingGate.tsx', import.meta.url), 'utf8');
const output: any = {};
new Function('exports', 'require', 'React', ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true,
} }).outputText)(output, (id: string) => id === 'axios' ? axios : requireFrontend(id), React);
const { FitnessOnboardingGate, isFitnessWriteRestricted } = output;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const trees: any[] = [];
afterEach(async () => { await act(async () => trees.splice(0).forEach(tree => tree.unmount())); });
const failure = (status: number, code: string) => new axios.AxiosError('failure', undefined, undefined, undefined, { status, data: { error: { code } } });
const codes = ['SUBSCRIPTION_NOT_CONFIGURED', 'SUBSCRIPTION_READ_ONLY', 'SUBSCRIPTION_GRACE_EXPIRED'];
async function mount(errors: unknown[] = [], existing = false) {
  let stored = existing; const save = vi.fn(async () => { if (errors.length) throw errors.shift(); stored = true; });
  function Form({ action, onSave }: any) {
    const [value, setValue] = React.useState('80');
    return React.createElement('form', { onSubmit: (e: any) => { e.preventDefault(); onSave(); } },
      action, React.createElement('input', { value, onChange: (e: any) => setValue(e.target.value) }), React.createElement('button', { type: 'submit' }, 'Guardar'));
  }
  function Portal() {
    const [complete, setComplete] = React.useState(stored);
    const [error, setError] = React.useState(null);
    const [pending, setPending] = React.useState(false);
    if (complete) return React.createElement('p', null, 'PORTAL COMPLETO');
    return React.createElement(FitnessOnboardingGate, { required: true, pending, error }, (action: any) => React.createElement(Form, { action, onSave: async () => {
      setPending(true); setError(null);
      try { await save(); setComplete(true); } catch (e) { setError(e); } finally { setPending(false); }
    } }));
  }
  let tree: any;
  await act(async () => { tree = create(React.createElement(Portal)); }); trees.push(tree);
  return { tree, save, get stored() { return stored; },
    async submit() { await act(async () => { tree.root.findByType('form').props.onSubmit({ preventDefault() {} }); }); },
    async click(label: string) { await act(async () => tree.root.findAllByType('button').find((b: any) => b.props.children === label).props.onClick()); },
    async remount() { await act(async () => tree.update(React.createElement(Portal, { key: 'new-visit' }))); },
  };
}
const hasSkip = (tree: any) => tree.root.findAllByType('button').some((b: any) => b.props.children === 'Continuar en modo lectura');
describe('FIT-MEMBER-007', () => {
  it('normal saving remains mandatory and closes only after success', async () => {
    const s = await mount(); expect(hasSkip(s.tree)).toBe(false); await s.submit(); expect(s.stored).toBe(true);
    expect(JSON.stringify(s.tree.toJSON())).toContain('PORTAL COMPLETO');
  });
  it.each(codes)('%s permits only temporary deferral and retains the draft', async code => {
    const s = await mount([failure(402, code)]); await s.submit(); expect(hasSkip(s.tree)).toBe(true);
    await s.click('Continuar en modo lectura'); expect(s.stored).toBe(false); expect(s.save).toHaveBeenCalledOnce();
    expect(JSON.stringify(s.tree.toJSON())).toContain('Tu encuesta deportiva sigue pendiente');
    await s.click('Completar encuesta pendiente'); expect(s.tree.root.findByType('input').props.value).toBe('80');
    await s.submit(); expect(s.stored).toBe(true);
  });
  it.each([400, 401, 403, 404, 409, 500, 502, 503])('status %i never enables skipping, even with a matching code', async status => {
    const s = await mount([failure(status, codes[1])]); await s.submit(); expect(hasSkip(s.tree)).toBe(false); expect(s.stored).toBe(false);
  });
  it.each([failure(402, 'UNKNOWN'), new axios.AxiosError('network', 'ERR_NETWORK'), new axios.AxiosError('timeout', 'ECONNABORTED'), new Error('unknown')])('other errors keep the required form', async error => {
    const s = await mount([error]); await s.submit(); expect(hasSkip(s.tree)).toBe(false);
  });
  it('deferral does not survive a new visit without a stored profile', async () => {
    const s = await mount([failure(402, codes[0])]); await s.submit(); await s.click('Continuar en modo lectura'); await s.remount();
    expect(hasSkip(s.tree)).toBe(false); expect(s.tree.root.findByType('form')).toBeDefined(); expect(s.stored).toBe(false);
  });
  it('completed profiles do not show onboarding', async () => { const s = await mount([], true); expect(s.tree.root.findAllByType('form')).toHaveLength(0); });
  it('requires the real Axios error contract', () => { expect(isFitnessWriteRestricted({ response: { status: 402, data: { error: { code: codes[0] } } } })).toBe(false); });
});
