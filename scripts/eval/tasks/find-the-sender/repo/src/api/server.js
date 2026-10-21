import { routes } from './routes.js';

export function handle(method, path, input) {
  const key = Object.keys(routes).find((route) => route.startsWith(method + ' ') && match(route.slice(method.length + 1), path));
  return key ? routes[key](input) : { status: 404 };
}

function match(pattern, path) {
  const a = pattern.split('/');
  const b = path.split('/');
  return a.length === b.length && a.every((part, i) => part.startsWith(':') || part === b[i]);
}
