function run() {
    ObjC.import('CoreGraphics');
    const session = ObjC.castRefToObject($.CGSessionCopyCurrentDictionary());
    const locked = session.objectForKey('CGSSessionScreenIsLocked');
    return JSON.stringify(!!(locked && !locked.isNil() && locked.boolValue));
  }