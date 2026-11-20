function run() {
    ObjC.import('AppKit');
    const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
    const frontPid = front ? front.processIdentifier : -1;
    const list = $.NSWorkspace.sharedWorkspace.runningApplications;
    const out = [];
    // The bridge hands NSInteger properties back as strings, hence Number().
    for (let i = 0; i < Number(list.count); i++) {
      const a = list.objectAtIndex(i);
      if (Number(a.activationPolicy) !== 0) continue; // NSApplicationActivationPolicyRegular
      out.push({ name: ObjC.unwrap(a.localizedName) || '', pid: Number(a.processIdentifier), bundle_id: ObjC.unwrap(a.bundleIdentifier) || '', frontmost: Number(a.processIdentifier) === Number(frontPid) });
    }
    return JSON.stringify(out);
  }