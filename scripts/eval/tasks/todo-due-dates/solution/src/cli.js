import { load, save } from './store.js';

function parseDue(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
  const date = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
  if (!date || date.getUTCMonth() !== Number(match[2]) - 1 || date.getUTCDate() !== Number(match[3])) throw new Error(`Invalid due date: ${value} (use YYYY-MM-DD)`);
  return value;
}

/** Runs one command (`add <title> [--due YYYY-MM-DD]`, `done <n>`, `list`) against the todo file and returns what it prints. */
export function run(argv, file) {
  const [command, ...rest] = argv;
  const data = load(file);
  if (command === 'add') {
    const at = rest.indexOf('--due');
    const due = at >= 0 ? parseDue(rest[at + 1]) : undefined;
    const words = at >= 0 ? [...rest.slice(0, at), ...rest.slice(at + 2)] : rest;
    const title = words.join(' ').trim();
    if (!title) throw new Error('Give a title');
    data.todos.push(due ? { title, done: false, due } : { title, done: false });
    save(file, data);
    return `Added: ${title}`;
  }
  if (command === 'done') {
    const todo = data.todos[Number(rest[0]) - 1];
    if (!todo) throw new Error(`No todo ${rest[0]}`);
    todo.done = true;
    save(file, data);
    return `Done: ${todo.title}`;
  }
  if (command === 'list') {
    const numbered = data.todos.map((todo, index) => ({ todo, number: index + 1 }));
    const dated = numbered.filter((item) => item.todo.due).sort((a, b) => a.todo.due.localeCompare(b.todo.due));
    const undated = numbered.filter((item) => !item.todo.due);
    return [...dated, ...undated].map(({ todo, number }) => `${number}. [${todo.done ? 'x' : ' '}] ${todo.title}${todo.due ? ` (due ${todo.due})` : ''}`).join('\n');
  }
  throw new Error(`Unknown command: ${command}`);
}
