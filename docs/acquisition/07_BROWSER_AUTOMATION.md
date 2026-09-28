# CodePilot AI — Browser Automation

## Capability

Real browser automation via Playwright (system Chrome/Edge). 15 model-callable tools: navigate, back, forward, reload, click, type, press, scroll, wait, extract, screenshot, select, console, network, close.

## Security

- **SSRF enforcement:** every request passes the URL policy via a route interceptor. Private networks, loopback, link-local, and cloud-metadata endpoints blocked by default. 44/44 SSRF tests pass.
- **Console capture:** bounded (200), secret-redacted at capture time.
- **Network capture:** bounded (200), header-free (Authorization/Cookie never captured), URLs credential-scrubbed.
- **Screenshot → image pipeline:** bytes forwarded to the task store via `onImageCaptured`, hydrate into the provider conversation (vision-gated).

## E2E evidence

17/17 real-Chromium tests pass: navigate, inspect, type, click, select, console capture+redaction, network capture, screenshot (PNG magic bytes), SSRF blocks, session isolation, cancellation, dispose.

## Test-only SSRF override

A clearly isolated TEST-ONLY policy (`allowLoopbackForTests`) permits loopback navigation for local testing. It cannot be enabled in production (cloud-metadata endpoints remain blocked in all cases).
