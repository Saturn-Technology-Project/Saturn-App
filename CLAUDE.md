@AGENTS.md

## Claude Code
- Preview the desktop UI with the `desktop-web` configuration in `.claude/launch.json` (Vite on port 5181). Outside
  the Tauri shell there is no runtime token, so calls to the runtime fail there; check data flows with the contract
  tests or an isolated runtime instead.
- Before a pull request, run the checks in `CONTRIBUTING.md` ("Before a pull request").
