function run(argv) {
    const p = JSON.parse(argv[0]);
    const se = Application('System Events');
    const using = p.modifiers.length ? { using: p.modifiers } : {};
    if (p.code !== undefined) se.keyCode(p.code, using); else se.keystroke(p.key, using);
    return 'null';
  }