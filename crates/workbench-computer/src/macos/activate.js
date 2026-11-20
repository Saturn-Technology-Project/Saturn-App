function run(argv) {
    ObjC.import('AppKit');
    const p = JSON.parse(argv[0]);
    const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(p.pid);
    if (!app || app.isNil()) throw new Error('No running app with pid ' + p.pid);
    app.activateWithOptions(2); // NSApplicationActivateIgnoringOtherApps
    delay(0.3);
    return 'null';
  }