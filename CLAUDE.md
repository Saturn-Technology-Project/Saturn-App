@AGENTS.md

## Claude Code
- Preview the desktop UI with the `desktop-web` configuration in `.claude/launch.json` (Vite on port 5181). Outside
  the Tauri shell there is no runtime token, so calls to the runtime fail there; check data flows with the contract
  tests or an isolated runtime instead.
- To see the real Tauri window with computer use, build a copy with its own identity, so it runs beside the user's Saturn:
  `npx tauri build --debug --bundles app --ci --no-sign --config '{"identifier":"inc.saturntechnology.desktop.verify","productName":"Saturn Verify"}'`
  in `desktop/`, then `open -n --env SATURN_DATA_DIR=<scratch> --env SATURN_RUNTIME_PORT=4793 --env SATURN_SECRET_STORE=file` on the
  bundle. A debug build loads its interface from Vite on 5174 (`desktop-vite`). In the background, computer use can read
  and click it but not type into it. Editing `desktop/src-tauri` restarts a running `npm run desktop`.
- Before a pull request, run the checks in `CONTRIBUTING.md` ("Before a pull request").
