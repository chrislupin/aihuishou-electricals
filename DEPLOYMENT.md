# Deployment checklist

## Vercel deployment

Deploy this repository as one Vercel project. The included `vercel.json` sends every page and API request to the Express application in `server.js`.

Use the public production domain as `APP_URL`, including `https://` and no trailing slash. You can point an admin subdomain at the same Vercel project; it serves the same application and keeps the API calls same-origin for that subdomain.

## Required environment variables

Configure these in Vercel Project Settings → Environment Variables, never in Git. Set every value for the **Production** environment:

- `NODE_ENV=production`
- `MONGODB_URI`: Atlas connection string (the database user must have read/write access)
- `MONGODB_DB=aihuishou` (or your chosen database name)
- `SESSION_SECRET`: a unique, random value of at least 32 characters; required for the stateless login cookies
- `APP_URL`: the production public URL, used in password-reset and approved-agent access emails
- `SMTP_HOST=smtp.gmail.com`
- `SMTP_PORT=587`
- `SMTP_SECURE=false`
- `SMTP_USER`: the Gmail account used to send notifications
- `SMTP_PASS`: a new Gmail App Password
- `SMTP_FROM`: the same Gmail address as `SMTP_USER`
- `ADMIN_EMAIL`: real admin login email
- `ADMIN_PASSWORD`: long unique admin password

For Preview deployments, use a separate test MongoDB database and email account, or leave the project without Preview deployments until they are ready. Never reuse production credentials in a preview environment.

For local development, the server can load MongoDB values from `MONGODB_CREDENTIALS_FILE`. On Vercel, set `MONGODB_URI` and `MONGODB_DB` directly as encrypted environment variables instead.

Never deploy the local `.env` file.

## Before launch

1. Create a new Gmail App Password and verify the SMTP account can send mail.
2. Import the repository into Vercel and add every required Production environment variable.
3. Deploy, then add the public domain and (if used) the admin subdomain to that Vercel project. Set `APP_URL` to the public production domain and redeploy after changing it.
4. Confirm `https://your-domain/health` returns `{"status":"ok","database":"connected"}`.
5. Test agent application submission, admin approval and rejection emails, the approved-agent password-setup link, field employee signup, pickup submission, admin login, account deletion, filtering, and password reset.
6. Rotate any credentials used during local testing.

## Local production-like run

```powershell
npm.cmd ci --omit=dev
$env:NODE_ENV="production"
npm.cmd start
```

The admin entry point is `/admin-login.html`; it is intentionally not linked from the public pages.
