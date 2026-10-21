import { load, save } from './store.js';

/** Runs one command (`add <title>`, `done <n>`, `list`) against the todo file and returns what it prints. */
export function run(argv, file) {
  const [command, ...rest] = argv;
  const data = load(file);
  if (command === 'add') {
    const title = rest.join(' ').trim();
    if (!title) throw new Error('Give a title');
    data.todos.push({ title, done: false });
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
    return data.todos.map((todo, index) => `${index + 1}. [${todo.done ? 'x' : ' '}] ${todo.title}`).join('\n');
  }
  throw new Error(`Unknown command: ${command}`);
}
