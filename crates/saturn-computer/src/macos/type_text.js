function run(argv) {
    const p = JSON.parse(argv[0]);
    const se = Application('System Events');
    if (/^[\x20-\x7e\n\t]*$/.test(p.text)) {
      const lines = p.text.split('\n');
      lines.forEach((line, i) => { if (line) se.keystroke(line); if (i < lines.length - 1) se.keyCode(36); });
      return 'null';
    }
    const app = Application.currentApplication(); app.includeStandardAdditions = true;
    let saved = null; try { saved = app.theClipboard(); } catch (e) {}
    app.setTheClipboardTo(p.text);
    se.keystroke('v', { using: ['command down'] });
    delay(0.25);
    if (saved !== null) { try { app.setTheClipboardTo(saved); } catch (e) {} }
    return 'null';
  }