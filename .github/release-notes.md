**Saturn** runs AI agents on your own computer: the agent app, its local runtime and Saturn IDE in one download.

> **Preview build.** The macOS app is not signed with an Apple Developer ID (Apple Silicon only), and the Windows installer is not code-signed, so both systems warn the first time you open them.

## Install

**macOS (Apple Silicon)**

1. Download `Saturn-__VERSION__-mac-arm64-unsigned.dmg`, open it, and drag **Saturn** into **Applications** (the `.zip` has the same app).
2. Open Saturn. When macOS says it can't verify the developer, go to **System Settings → Privacy & Security** and click **Open Anyway**.

**Windows (x64)**

1. Download `Saturn-__VERSION__-win-x64-setup.exe` and run it.
2. If SmartScreen stops it, click **More info → Run anyway**. Later versions update themselves.

Then open **Settings → Models**, connect a model, create an agent, and give it a task (the first launch walks you through it).

**Check a download** (optional): each file has a `.sha256` beside it, and a signed build attestation that proves it was built from this repository's source by its public release workflow:

```bash
shasum -a 256 -c Saturn-__VERSION__-mac-arm64-unsigned.dmg.sha256
gh attestation verify Saturn-__VERSION__-mac-arm64-unsigned.dmg -R Saturn-Technology-Project/Saturn-App
```

## Changes
