# Aihuishou Electricals website

A website and Node.js backend for Aihuishou Electricals Limited.

Deploy this project on Vercel. See [DEPLOYMENT.md](DEPLOYMENT.md) for the production deployment checklist.

## Run locally

Install dependencies and start the server:

```bash
npm install
npm start
```

Open `http://localhost:3000` in a browser. The `images` folder is ready for local image assets.

The admin pages are intended to be hosted on a separate admin subdomain, such as `admin.yourdomain.com`. Deploy `admin-login.html` and `admin-dashboard.html` there, and keep `ADMIN_EMAIL` and `ADMIN_PASSWORD` in the server environment. Do not add an admin link to the public website.

Field employees use the separate portal at `field-employee-login.html`. They can create a dedicated field employee account or sign in, then submit location-free collection reports from `field-employee-dashboard.html`.

Prospective agents use `agent-application.html` to submit their first name, last name, email, phone number, business name and location. Applications appear in the **Agent applications** area of the admin dashboard. Approval creates an inactive Agent account and emails a one-time password-setup link to `agent-login.html`; rejection sends the applicant the regional-recruitment response.

## Email setup

Copy `.env.example` to `.env` and provide an SMTP account. For Gmail, use a Google app password rather than the account password. SMTP delivers admin application notifications, approval access links and rejection emails.

