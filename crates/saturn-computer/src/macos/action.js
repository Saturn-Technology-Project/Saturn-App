function run(argv) {
    const p = JSON.parse(argv[0]);
    let el = Application('System Events').processes.whose({ unixId: p.pid })[0].windows[0];
    for (const i of p.path) el = el.uiElements[i];
    el.actions.byName(p.action).perform();
    return 'null';
  }