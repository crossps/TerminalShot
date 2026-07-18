# Security policy

## Supported version

Security fixes are made against the latest release and the `main` branch.

## Report a vulnerability

Please do not open a public issue for a vulnerability that could expose captures, clipboard contents, filesystem paths, or local execution. Use GitHub's **Report a vulnerability** flow under the repository's Security tab.

Include the affected version, Windows version, reproduction steps, and the practical impact. Reports that require another local process already running with the same or higher Windows privileges may be treated as local-hardening issues rather than privilege-boundary vulnerabilities.

## Security boundaries

TerminalShot processes screenshots and clipboard data locally. It does not provide a network service or upload captures. Automatic scrolling sends window-addressed `WM_MOUSEWHEEL` messages; it does not inject system-wide keyboard or mouse input.
