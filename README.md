# Aihuishou Electricals website

A website and Node.js backend for Aihuishou Electricals Limited.

See [DEPLOYMENT.md](DEPLOYMENT.md) for the production deployment checklist.

## Run locally

Install dependencies and start the server:

```bash
npm install
npm start
```

Open `http://localhost:3000` in a browser. The `images` folder is ready for local image assets.

The admin pages are intended to be hosted on a separate admin subdomain, such as `admin.yourdomain.com`. Deploy `admin-login.html` and `admin-dashboard.html` there, and keep `ADMIN_EMAIL` and `ADMIN_PASSWORD` in the server environment. Do not add an admin link to the public website.

Field employees use the separate portal at `field-employee-login.html`. They can create a dedicated field employee account or sign in, then submit location-free collection reports from `field-employee-dashboard.html`.

## Email setup

Copy `.env.example` to `.env` and provide an SMTP account. For Gmail, use a Google app password rather than the account password. The agent application endpoint sends submissions to `aihuishoulimited@gmail.com`.

