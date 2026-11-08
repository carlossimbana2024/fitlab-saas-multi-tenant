import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const req = createRequire(new URL('../../frontend/package.json', import.meta.url));
const React = req('react');
const { act, create } = req('react-test-renderer');
const api = { put: vi.fn() };
const source = readFileSync(new URL('../../frontend/src/components/MemberAccountDialog.tsx', import.meta.url), 'utf8');
const output: any = {};
new Function('exports', 'require', 'React', ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true,
} }).outputText)(output, (id: string) => {
  if (id === '../services/api') return { api };
  if (id === './ProfileDialog') return { ProfileDialog: ({ children }: any) => React.createElement('section', null, children) };
  return req(id);
}, React);
const { MemberAccountDialog } = output;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const trees: any[] = [];
const visible = (node: any): string => node == null ? '' : Array.isArray(node) ? node.map(visible).join(' ') : typeof node === 'object' ? visible(node.children) : String(node);
const text = (tree: any) => visible(tree.toJSON());
const urls = () => api.put.mock.calls.map(([url]) => url);
const passwordInputs = (tree: any) => tree.root.findAllByType('input').filter((n: any) => n.props.type === 'password');
const profileInputs = (tree: any) => tree.root.findAllByType('input').filter((n: any) => n.props.type !== 'password');
const error = (code: string) => ({ response: { status: 400, data: { error: { code } } } });
async function mount() {
  const onClose = vi.fn();
  const onIdentitySaved = vi.fn(async () => undefined);
  const onProfileSaved = vi.fn();
  let tree: any;
  await act(async () => { tree = create(React.createElement(MemberAccountDialog, {
    initialProfile: { fullName: 'Miembro inicial', phone: '0990000000' }, onClose, onIdentitySaved, onProfileSaved,
  })); });
  trees.push(tree);
  return { tree, onClose, onIdentitySaved, onProfileSaved };
}
async function changeProfile(tree: any, name = 'Nombre actualizado') {
  await act(async () => { profileInputs(tree)[0].props.onChange({ target: { value: name } }); });
}
async function fillPasswords(tree: any, values = ['previous-secret', 'different-secret', 'different-secret']) {
  for (let index = 0; index < values.length; index++) {
    await act(async () => { passwordInputs(tree)[index].props.onChange({ target: { value: values[index] } }); });
  }
}
async function submit(tree: any) {
  await act(async () => { await tree.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
}
beforeEach(() => { api.put.mockReset(); api.put.mockResolvedValue({ data: {} }); });
afterEach(async () => { await act(async () => trees.splice(0).forEach(tree => tree.unmount())); });

describe('FIT-MEMBER-017 account write checkpoints', () => {
  it('A/K: a profile-only write updates the visible confirmed fields and reconciles identity exactly once', async () => {
    const { tree, onIdentitySaved, onProfileSaved } = await mount();
    await changeProfile(tree); await submit(tree);
    expect(urls()).toEqual(['/members/me/profile']);
    expect(text(tree)).toContain('Datos de cuenta guardados.');
    expect(text(tree)).not.toContain('Contraseña actualizada.');
    expect(profileInputs(tree)[0].props.value).toBe('Nombre actualizado');
    expect(onIdentitySaved).toHaveBeenCalledTimes(1);
    expect(onProfileSaved).toHaveBeenCalledWith({ fullName: 'Nombre actualizado', phone: '0990000000' });
    await submit(tree);
    expect(urls()).toEqual(['/members/me/profile']);
    expect(onIdentitySaved).toHaveBeenCalledTimes(1);
    expect(onProfileSaved).toHaveBeenCalledTimes(1);
  });
  it('B/L: a password-only success clears secret inputs without writing or invalidating profile data', async () => {
    const { tree, onIdentitySaved, onClose } = await mount();
    await fillPasswords(tree); await submit(tree);
    expect(urls()).toEqual(['/auth/change-password']);
    expect(text(tree)).toContain('Contraseña actualizada.');
    expect(passwordInputs(tree).every((n: any) => n.props.value === '')).toBe(true);
    expect(onIdentitySaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    await submit(tree);
    expect(urls()).toHaveLength(1);
  });
  it('C/I: a rejected password change shows an error, clears secrets and does not mark profile or password saved', async () => {
    const { tree, onIdentitySaved } = await mount();
    api.put.mockRejectedValueOnce(error('CURRENT_PASSWORD_INVALID'));
    await fillPasswords(tree); await submit(tree);
    expect(text(tree)).toContain('La contraseña actual no es correcta.');
    expect(text(tree)).not.toContain('Datos de cuenta guardados.');
    expect(text(tree)).not.toContain('Contraseña actualizada.');
    expect(passwordInputs(tree).every((n: any) => n.props.value === '')).toBe(true);
    expect(onIdentitySaved).not.toHaveBeenCalled();
  });
  it('D: mismatched confirmation prevents every remote write, including a dirty profile', async () => {
    const { tree, onIdentitySaved } = await mount();
    await changeProfile(tree); await fillPasswords(tree, ['previous-secret', 'different-secret', 'unmatched-secret']);
    await submit(tree);
    expect(urls()).toEqual([]);
    expect(text(tree)).toContain('Las contraseñas nuevas no coinciden.');
    expect(onIdentitySaved).not.toHaveBeenCalled();
  });
  it('E/G/K: profile success plus password failure is explicit; retry only writes the password', async () => {
    const { tree, onIdentitySaved } = await mount();
    api.put.mockImplementation(async (url: string) => {
      if (url === '/auth/change-password') throw error('CURRENT_PASSWORD_INVALID');
      return { data: {} };
    });
    await changeProfile(tree); await fillPasswords(tree); await submit(tree);
    expect(urls()).toEqual(['/members/me/profile', '/auth/change-password']);
    expect(text(tree)).toContain('Datos de cuenta guardados.');
    expect(text(tree)).toContain('La contraseña actual no es correcta.');
    expect(text(tree)).not.toContain('Contraseña actualizada.');
    expect(onIdentitySaved).toHaveBeenCalledTimes(1);
    api.put.mockResolvedValue({ data: {} });
    await fillPasswords(tree); await submit(tree);
    expect(urls()).toEqual(['/members/me/profile', '/auth/change-password', '/auth/change-password']);
    expect(onIdentitySaved).toHaveBeenCalledTimes(1);
    expect(text(tree)).toContain('Contraseña actualizada.');
    expect(passwordInputs(tree).every((n: any) => n.props.value === '')).toBe(true);
  });
  it('F: profile failure prevents the inverse partial state because password always follows a confirmed profile', async () => {
    const { tree, onIdentitySaved, onProfileSaved } = await mount();
    api.put.mockRejectedValueOnce(new Error('request unavailable'));
    await changeProfile(tree); await fillPasswords(tree); await submit(tree);
    expect(urls()).toEqual(['/members/me/profile']);
    expect(text(tree)).toContain('No se intentó cambiar la contraseña.');
    expect(text(tree)).not.toContain('guardados.');
    expect(onIdentitySaved).not.toHaveBeenCalled();
    expect(onProfileSaved).not.toHaveBeenCalled();
    expect(passwordInputs(tree).every((n: any) => n.props.value === '')).toBe(true);
  });
  it('H: synchronous double submit cannot duplicate a pending operation and fields are locked', async () => {
    const { tree } = await mount();
    let release!: () => void;
    api.put.mockImplementation(() => new Promise(resolve => { release = () => resolve({ data: {} }); }));
    await fillPasswords(tree);
    let first!: Promise<void>, second!: Promise<void>;
    await act(async () => {
      const form = tree.root.findByType('form');
      first = form.props.onSubmit({ preventDefault() {} });
      second = form.props.onSubmit({ preventDefault() {} });
      await second;
    });
    expect(urls()).toEqual(['/auth/change-password']);
    expect(tree.root.findByType('fieldset').props.disabled).toBe(true);
    expect(tree.root.findAllByType('button').find((b: any) => b.props.className === 'primary').props.disabled).toBe(true);
    await act(async () => { release(); await first; });
    expect(urls()).toHaveLength(1);
    expect(tree.root.findByType('fieldset').props.disabled).toBe(false);
  });
  it('identity read/cache failure is a separate warning and never repeats confirmed writes', async () => {
    const { tree, onIdentitySaved } = await mount();
    onIdentitySaved.mockRejectedValueOnce(new Error('read unavailable'));
    await changeProfile(tree); await submit(tree);
    expect(text(tree)).toContain('Datos de cuenta guardados.');
    expect(text(tree)).toContain('no pudimos actualizar todas las vistas');
    expect(text(tree)).not.toContain('No pudimos confirmar el guardado');
    await act(async () => { await tree.root.findAllByType('button').find((b: any) => b.props.children === 'Actualizar datos visibles').props.onClick(); });
    expect(urls()).toEqual(['/members/me/profile']);
    expect(onIdentitySaved).toHaveBeenCalledTimes(2);
    expect(text(tree)).not.toContain('no pudimos actualizar todas las vistas');
  });
  it.each(['AUTH_REQUIRED', 'INVALID_SESSION', 'INVALID_REFRESH_TOKEN', 'REFRESH_TOKEN_REQUIRED'])('J: %s requests reauthentication without inventing success or calling logout', async code => {
    const { tree, onIdentitySaved } = await mount();
    api.put.mockRejectedValueOnce(error(code));
    await fillPasswords(tree); await submit(tree);
    expect(text(tree)).toContain('Necesitas iniciar sesión nuevamente');
    expect(text(tree)).not.toContain('Contraseña actualizada.');
    expect(urls()).toEqual(['/auth/change-password']);
    expect(onIdentitySaved).not.toHaveBeenCalled();
  });
  it.each(['incomplete', 'too-short', 'too-long', 'unchanged'])('local password validation: %s never triggers profile/Auth writes', async kind => {
    const { tree } = await mount(); await changeProfile(tree);
    const values = kind === 'incomplete' ? ['', 'different-secret', 'different-secret']
      : kind === 'too-short' ? ['short', 'different-secret', 'different-secret']
      : kind === 'too-long' ? ['previous-secret', 'x'.repeat(129), 'x'.repeat(129)]
      : ['previous-secret', 'previous-secret', 'previous-secret'];
    await fillPasswords(tree, values); await submit(tree);
    expect(urls()).toEqual([]);
    expect(tree.root.findAll((n: any) => n.props.role === 'alert').length).toBeGreaterThan(0);
  });
});
