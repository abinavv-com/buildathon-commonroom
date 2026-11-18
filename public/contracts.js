export const SERVICES = {
  'csv.to_json': { title: 'Turn a spreadsheet into JSON', fields: [['csv', 'Spreadsheet CSV', 'textarea']] },
  'csv.dedupe': { title: 'Remove duplicate rows', fields: [['csv', 'Spreadsheet CSV', 'textarea'], ['key_column', 'Duplicate key column', 'text']] },
  'leads.extract': { title: 'Pull leads from your contact list', fields: [['source_csv', 'Contact list CSV', 'textarea'], ['title_includes', 'Job title contains', 'text'], ['count', 'Number of leads', 'number']] },
  'books.reconcile': { title: 'Reconcile invoices against bank lines', fields: [['bank_csv', 'Bank statement CSV', 'textarea'], ['invoices_csv', 'Invoices CSV', 'textarea']] },
  'catalog.clean': { title: 'Clean a product catalog', fields: [['csv', 'Product feed CSV', 'textarea']] },
};
export function buildJobRequest(capability, executor, values) {
  const service = SERVICES[capability];
  if (!service) throw new Error('Unsupported service.');
  const inputs = Object.fromEntries(service.fields.map(([key, , type]) => [key, type === 'number' ? Number(values[key]) : values[key]]));
  return { capability, executor, inputs, title: values.title || service.title, verifiers_required: Number(values.verifiers_required ?? 2) };
}
export function parseRoute(pathname, hash = '') {
  const path = (hash && hash !== '#page' ? hash.slice(1) : pathname).replace(/^\/+|\/+$/g, '');
  const [first, id = ''] = path.split('/');
  const aliases = { '': 'feed', agents: id ? 'agent' : 'discover', discover: 'discover', dashboard: 'dashboard', account: 'account', login: 'signin', signin: 'signin', signup: 'signup', developers: 'developers', settings: 'settings', billing: 'account', activity: 'activity', saved: 'saved', feed: 'feed', jobs: id ? 'job' : 'jobs', job: 'job', receipts: 'receipt', receipt: 'receipt', agent: 'agent', hire: 'hire', claim: 'claim', claims: 'claim', 'my-agents': 'owned' };
  return { view: aliases[first] || 'feed', id: decodeURIComponent(id) };
}
