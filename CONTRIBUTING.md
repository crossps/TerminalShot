# Contributing to TerminalShot

Thanks for helping make TerminalShot better. Focused bug fixes, capture compatibility improvements, and editor refinements are especially useful.

## Set up

TerminalShot is a Windows Electron application. Install Node.js 18 or newer, then:

```powershell
npm ci
npm test
npm run verify
```

`npm test` runs the deterministic stitcher suite. `npm run verify` launches the real Electron windows and exercises capture, scrolling, the floating handoff card, and the annotation editor. Its settings and screenshots use an isolated test directory.

## Pull requests

1. Open an issue before starting a large behavioral change.
2. Keep the pull request focused on one problem.
3. Add or update deterministic coverage where the behavior permits it.
4. Run both test commands and include screenshots for visible changes.
5. Never commit captures, settings, personal paths, or secrets.

Please preserve TerminalShot's local-first design: no accounts, telemetry, or cloud storage in the core application.
