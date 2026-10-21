import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const requireFrontend = createRequire(new URL('../../../frontend/package.json', import.meta.url));
export const React = requireFrontend('react');
export const { renderToStaticMarkup } = requireFrontend('react-dom/server');
export const { MemoryRouter, Link } = requireFrontend('react-router-dom');
const icons = requireFrontend('lucide-react');

function compile(source: string, dependencies: Record<string, unknown> = {}) {
  const compiled = ts.transpileModule(source, { compilerOptions: {
    jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  const output: any = {};
  new Function('exports', 'require', 'React', compiled)(output,
    (id: string) => dependencies[id] ?? requireFrontend(id), React);
  return output;
}
const read = (path: string) => readFileSync(new URL('../../../frontend/src/' + path, import.meta.url), 'utf8');
export const economicsLabels = compile(read('utils/classBookingEconomics.ts'));
export const { ClassBookingConditions } = compile(read('components/ClassBookingConditions.tsx'), {
  '../utils/classBookingEconomics': economicsLabels,
});
export function pageComponents(page: string, start: string, end: string | undefined, names: string[]) {
  const source = read('pages/' + page);
  const body = source.slice(source.indexOf(start), end ? source.indexOf(end) : undefined);
  const scope = {
    React, Link, ...icons, ClassBookingConditions, ...economicsLabels,
    money: (amount: number, currency: string) => new Intl.NumberFormat('es-EC', { style: 'currency', currency }).format(amount),
    dateTime: (date: string) => date,
    bookingNames: { reserved: 'Programada', cancelled: 'Cancelada', attended: 'Asistió', no_show: 'No asistió' },
    bookingPaymentLabel: economicsLabels.classPaymentLabel,
  };
  const compiled = ts.transpileModule(body + '\nexports.components={' + names.join(',') + '};', { compilerOptions: {
    jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  const output: any = {};
  new Function('exports', ...Object.keys(scope), compiled)(output, ...Object.values(scope));
  return output.components;
}
