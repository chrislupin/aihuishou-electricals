# Deployment checklist

## Recommended architecture

Deploy this Node service as the single origin for the public site, API, agent portal and admin portal. Point both the public domain and an admin subdomain at the same service through the hosting provider or reverse proxy. This keeps the API requests and secure cookies on one origin.

## Required environment variables

Configure these in the hosting provider, not in Git:

- `NODE_ENV=production`
- `SMTP_HOST=smtp.gmail.com`
- `SMTP_PORT=587`
- `SMTP_SECURE=false`
- `SMTP_USER`: the Gmail account used to send notifications
- `SMTP_PASS`: a new Gmail App Password
- `SMTP_FROM`: the same Gmail address as `SMTP_USER`
- `ADMIN_EMAIL`: real admin login email
- `ADMIN_PASSWORD`: long unique admin password

For local development, the server can load MongoDB values from `MONGODB_CREDENTIALS_FILE`. On a hosting provider, set `MONGODB_URI` and `MONGODB_DB` directly as secret environment variables instead.

Never deploy the local `.env` file.

## Before launch

1. Create a new Gmail App Password and run the SMTP verification test.
2. Deploy with a persistent disk or replace JSON storage with a managed database.
3. Configure HTTPS and point the admin subdomain to the same service.
4. Confirm `/health` returns `{"status":"ok"}`.
5. Test agent signup, field employee signup, pickup submission, admin login and approval.
6. Rotate any credentials used during local testing.
7. Back up the `data` directory if using file storage.

## Local production-like run

```powershell
npm.cmd ci --omit=dev
$env:NODE_ENV="production"
npm.cmd start
```

The admin entry point is `/admin-login.html`; it is intentionally not linked from the public pages.
