const TEMPLATES = {
  welcome: 'Welcome, {name}!',
  'account-closed': 'Goodbye, {name}. Your account is closed.',
  'invoice-overdue': 'Invoice {number} is overdue.',
};

export function render(name, data = {}) {
  return (TEMPLATES[name] ?? '').replace(/\{(\w+)\}/g, (_, key) => String(data[key] ?? ''));
}
