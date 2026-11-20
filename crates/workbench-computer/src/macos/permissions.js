function run() {
    ObjC.import('ApplicationServices'); ObjC.import('CoreGraphics');
    // Not in JXA's CoreGraphics bridge (macOS 10.15+), so it is declared here.
    ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]);
    return JSON.stringify({ accessibility: !!$.AXIsProcessTrusted(), screenRecording: !!$.CGPreflightScreenCaptureAccess() });
  }