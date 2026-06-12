# Security policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository ("Security" →
"Report a vulnerability"). Please don't open public issues for security
problems.

You can expect an acknowledgment within a few business days.

## Scope notes

- The CLI and core engine consume a public, keyless API and hold no secrets.
- The feed Worker optionally holds a webhook URL as a Cloudflare secret and
  sends fail-closed (watch-only unless configured). Reports about secret
  exposure, send-gate bypasses, or the public status page are very welcome.
- False positives/negatives in drain detection are not security issues.
  Please use the dedicated issue template for those.
