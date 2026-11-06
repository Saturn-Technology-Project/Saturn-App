function run(argv) {
    const p = JSON.parse(argv[0]);
    const pick = (proc) => { const all = proc.windows(); for (let i = 0; i < all.length; i++) { try { if (all[i].name() !== 'Saturn pointer') return proc.windows[i]; } catch (e) { return proc.windows[i]; } } return proc.windows[0]; };
    let el = pick(Application('System Events').processes.whose({ unixId: p.pid })[0]);
    for (const i of p.path) el = el.uiElements[i];
    el.actions.byName(p.action).perform();
    return 'null';
  }