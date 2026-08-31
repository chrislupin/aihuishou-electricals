const path = require("node:path");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { promisify } = require("node:util");

const dotenv = require("dotenv");

dotenv.config();

// Keep optional local Atlas credentials outside the repository. In local
// development the external file is allowed to replace stale values from the
// checked-out .env file. In production, hosting-provider environment values
// always take precedence so secrets are never silently replaced by a file.
if (process.env.MONGODB_CREDENTIALS_FILE) {
  const result = dotenv.config({
    path: process.env.MONGODB_CREDENTIALS_FILE,
    override: process.env.NODE_ENV !== "production"
  });
  if (result.error) {
    console.warn("Unable to load MONGODB_CREDENTIALS_FILE:", result.error.message);
  }
}

const express = require("express");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const { MongoClient } = require("mongodb");
const nodemailer = require("nodemailer");

const app = express();
const emailTo = "aihuishoulimited@gmail.com";
const scrypt = promisify(crypto.scrypt);
const sessionSecret = process.env.SESSION_SECRET || (process.env.NODE_ENV === "production" ? "" : crypto.randomBytes(32).toString("hex"));
const GOODS_OPTIONS = new Set(['512GB','256GB','128GB','64GB','32GB','16GB','8GB','4GB','CHINESE','TABLET','BIGSMART','IPHONE','CPU','DISPLAY CARDS','BATTERY','HARD DISK','HARD DISK BOARD','RAMS','CAMERA','LAPTOP BOARD','LAPTOP LOW GRADE','ORIGINAL PHONES','COMPUTER 1 ICE','COMPUTER 2 ICE','GREEN BOARD HIGH GRADE','RUBBISH','RUBBISH HIGH GRADE','PRINTERS','CAR BOARD']);
const MAX_PASSWORD_LENGTH = 256;

let mongoClient = null;

if (process.env.MONGODB_URI) {
  try {
    mongoClient = new MongoClient(process.env.MONGODB_URI.trim(), {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
      maxPoolSize: 10
    });
  } catch (error) {
    console.error("Invalid MONGODB_URI configuration:", error.message);
  }
}

const database = mongoClient?.db(process.env.MONGODB_DB || "aihuishou");

const accountsCollection = database?.collection("agent_accounts");
const pickupRequestsCollection = database?.collection("pickup_requests");
const pickupDateRequestsCollection = database?.collection("pickup_date_requests");
const passwordResetCollection = database?.collection("password_resets");
const adminAccountsCollection = database?.collection("admin_accounts");
const agentApplicationsCollection = database?.collection("agent_applications");
const agentAccessInvitesCollection = database?.collection("agent_access_invites");

const adminEmail = normalizeConfiguredEmail(process.env.ADMIN_EMAIL);

let databaseReady;

function normalizeConfiguredEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
  console.warn(
    "SMTP_HOST, SMTP_USER and SMTP_PASS must be set before applications can be sent."
  );
}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

app.disable("x-powered-by");

app.set("trust proxy", 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
        frameSrc: ["'self'", "https://www.google.com"],
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        upgradeInsecureRequests: process.env.NODE_ENV === "production" ? [] : null
      }
    },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" }
  })
);

app.use((req, res, next) => {
  if (process.env.NODE_ENV !== "production" || req.secure) return next();
  const configuredUrl = typeof process.env.APP_URL === "string" ? process.env.APP_URL.trim().replace(/\/+$/, "") : "";
  if (!configuredUrl.startsWith("https://")) return next();
  return res.redirect(308, `${configuredUrl}${req.originalUrl}`);
});

app.use(
  express.json({
    limit: "32kb"
  })
);

app.use("/data", (req, res) => {
  res.status(404).end();
});

app.use(express.static(path.join(__dirname)));

// Serve the main website homepage
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/sitemap.xml", (req, res) => {
  const configuredBase = process.env.APP_URL || `${req.protocol}://${req.get("host")}`;
  const baseUrl = configuredBase.replace(/\/+$/, "");
  res.type("application/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    `  <url><loc>${baseUrl}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>\n` +
    `</urlset>`
  );
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false
});

const requestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false
});

app.get("/health", async (req, res) => {
  try {
    await ensureDatabase();
    res.json({ status: "ok", database: "connected" });
  } catch (error) {
    console.error("Health check database failure:", error.message);
    res.status(503).json({ status: "unavailable", database: "not connected" });
  }
});

app.use("/api", async (req, res, next) => {
  try {
    await ensureDatabase();
    return next();
  } catch (error) {
    console.error("Database connection failed:", error.message);

    return res.status(503).json({
      error: "Database is temporarily unavailable."
    });
  }
});

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function isValidPassword(password) {
  return typeof password === "string" && password.length >= 8 && password.length <= MAX_PASSWORD_LENGTH;
}

function isValidDateNotInPast(value) {
  if (!isValidDateOnly(value)) return false;
  const today = new Date();
  const localToday = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, "0"), String(today.getDate()).padStart(2, "0")].join("-");
  return value >= localToday;
}

function constantTimeStringEquals(first, second) {
  const firstHash = crypto.createHash("sha256").update(String(first || "")).digest();
  const secondHash = crypto.createHash("sha256").update(String(second || "")).digest();
  return crypto.timingSafeEqual(firstHash, secondHash);
}

function rejectBotSubmission(req, res, next) {
  const honeypot = req.body?.website;
  if (typeof honeypot === "string" && honeypot.trim()) {
    return res.status(400).json({ error: "Unable to process this submission." });
  }
  return next();
}

function calculateRequestTotal(goods) {
  if (!Array.isArray(goods)) {
    return 0;
  }

  return goods.reduce((total, item) => {
    const storedTotal = Number(item?.totalAmount);

    if (Number.isFinite(storedTotal)) {
      return total + storedTotal;
    }

    const quantity = Number(item?.quantity);
    const amount = Number(item?.amount);

    return Number.isFinite(quantity) && Number.isFinite(amount)
      ? total + quantity * amount
      : total;
  }, 0);
}

function requestPreferredDate(request) {
  if (typeof request?.preferredDate === "string") {
    return request.preferredDate;
  }

  // Keep old records readable after the pickup-time field was renamed.
  return typeof request?.preferredTime === "string"
    ? request.preferredTime
    : "";
}

function isValidDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const ACTIVE_PICKUP_DATE_STATUSES = ["Pending approval", "Approved"];

function isActivePickupDateRequest(request) {
  return Boolean(request?.active) && ACTIVE_PICKUP_DATE_STATUSES.includes(request.status);
}

function readCookie(req, name) {
  const cookies = req.headers.cookie || "";
  const prefix = `${name}=`;

  const value = cookies
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(prefix));

  if (!value) return null;

  try {
    return decodeURIComponent(value.slice(prefix.length));
  } catch {
    return null;
  }
}

function withoutMongoId(document) {
  if (!document) {
    return document;
  }

  const { _id, ...value } = document;

  return value;
}

async function readAccounts() {
  if (!accountsCollection) {
    throw new Error("MONGODB_URI is not configured.");
  }

  return (
    await accountsCollection.find({}).toArray()
  ).map(withoutMongoId);
}

async function getAccountByEmail(email) {
  if (!accountsCollection) throw new Error("MONGODB_URI is not configured.");
  return withoutMongoId(await accountsCollection.findOne({ email }));
}

async function saveAccounts(accounts) {
  if (!accountsCollection) {
    throw new Error("MONGODB_URI is not configured.");
  }

  await accountsCollection.deleteMany({});

  if (accounts.length) {
    await accountsCollection.insertMany(accounts);
  }
}

async function readPickupRequests() {
  if (!pickupRequestsCollection) {
    throw new Error("MONGODB_URI is not configured.");
  }

  return (
    await pickupRequestsCollection.find({}).toArray()
  ).map(withoutMongoId);
}

async function readPickupDateRequests() {
  if (!pickupDateRequestsCollection) {
    throw new Error("MONGODB_URI is not configured.");
  }

  return (
    await pickupDateRequestsCollection.find({}).toArray()
  ).map(withoutMongoId);
}

function agentGoodsSinceLastPickup(agentEmail, pickupRequests) {
  const agentRequests = (pickupRequests || []).filter(
    (request) => request.agentEmail === agentEmail && (request.requestType || "agent") === "agent"
  );
  const approvedRequests = agentRequests
    .filter((request) => request.status === "Approved")
    .sort((first, second) => new Date(second.approvedAt || second.createdAt) - new Date(first.approvedAt || first.createdAt));
  const lastPickup = approvedRequests[0] || null;
  const cutoffValue = lastPickup?.approvedAt || lastPickup?.createdAt;
  const cutoff = cutoffValue ? new Date(cutoffValue) : null;
  const requestsSinceLastPickup = cutoff && !Number.isNaN(cutoff.getTime())
    ? agentRequests.filter((request) => new Date(request.createdAt) > cutoff)
    : agentRequests;

  return {
    totalAmount: requestsSinceLastPickup.reduce((total, request) => total + calculateRequestTotal(request.goods), 0),
    totalQuantity: requestsSinceLastPickup.reduce((total, request) => total + (request.goods || []).reduce((sum, good) => sum + (Number(good.quantity) || 0), 0), 0),
    lastPickupDate: lastPickup ? requestPreferredDate(lastPickup) : "",
    lastPickupAt: cutoffValue || ""
  };
}

async function savePickupRequests(requests) {
  if (!pickupRequestsCollection) {
    throw new Error("MONGODB_URI is not configured.");
  }

  await pickupRequestsCollection.deleteMany({});

  if (requests.length) {
    await pickupRequestsCollection.insertMany(requests);
  }
}

async function migrateJsonData() {
  if (!database) {
    throw new Error("MONGODB_URI is not configured.");
  }

  const migrationCollection = database.collection("migrations");

  if (
    await migrationCollection.findOne({
      name: "json-to-mongodb-v1"
    })
  ) {
    return;
  }

  const files = [
    {
      file: path.join(
        __dirname,
        "data",
        "agent-accounts.json"
      ),
      collection: accountsCollection
    },
    {
      file: path.join(
        __dirname,
        "data",
        "pickup-requests.json"
      ),
      collection: pickupRequestsCollection
    }
  ];

  for (const item of files) {
    try {
      const records = JSON.parse(
        await fs.readFile(item.file, "utf8")
      );

      if (
        Array.isArray(records) &&
        records.length &&
        await item.collection.countDocuments() === 0
      ) {
        await item.collection.insertMany(records);
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  await migrationCollection.insertOne({
    name: "json-to-mongodb-v1",
    migratedAt: new Date()
  });
}

async function removeDuplicateAccounts() {
  const duplicateGroups = await accountsCollection.aggregate([
    { $match: { email: { $type: "string" } } },
    { $group: { _id: "$email", count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } }
  ]).toArray();

  for (const group of duplicateGroups) {
    const records = await accountsCollection.find({ email: group._id })
      .sort({ createdAt: 1, _id: 1 })
      .toArray();

    if (records.length > 1) {
      await accountsCollection.deleteMany({
        _id: { $in: records.slice(1).map((record) => record._id) }
      });
      console.warn(`Removed ${records.length - 1} duplicate account record(s) for ${group._id}.`);
    }
  }
}

async function ensureDatabase() {
  if (!mongoClient) {
    throw new Error("MONGODB_URI is required.");
  }

  if (process.env.NODE_ENV === "production" && !sessionSecret) {
    throw new Error("SESSION_SECRET is required in production.");
  }

  if (!databaseReady) {
    databaseReady = (async () => {
      await mongoClient.connect();

      await database.command({
        ping: 1
      });

      await migrateJsonData();
      await removeDuplicateAccounts();
      await Promise.all([
        accountsCollection.createIndex({ email: 1 }, { unique: true }),
        pickupRequestsCollection.createIndex({ id: 1 }, { unique: true }),
        pickupDateRequestsCollection.createIndex({ id: 1 }, { unique: true }),
        pickupDateRequestsCollection.createIndex(
          { agentEmail: 1, active: 1 },
          { unique: true, partialFilterExpression: { active: true } }
        ),
        passwordResetCollection.createIndex({ email: 1 }),
        passwordResetCollection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
        adminAccountsCollection.createIndex({ email: 1 }, { unique: true }),
        agentApplicationsCollection.createIndex({ id: 1 }, { unique: true }),
        agentApplicationsCollection.createIndex({ email: 1, status: 1, createdAt: -1 }),
        agentAccessInvitesCollection.createIndex({ id: 1 }, { unique: true }),
        agentAccessInvitesCollection.createIndex({ email: 1 }),
        agentAccessInvitesCollection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
      ]);
    })().catch((error) => {
      databaseReady = undefined;
      throw error;
    });
  }

  return databaseReady;
}

function createSignedSession(res, cookieName, payload) {
  if (!sessionSecret) throw new Error("SESSION_SECRET must be configured in production.");
  const body = Buffer.from(JSON.stringify({ ...payload, expiresAt: Date.now() + 1000 * 60 * 60 * 12 })).toString("base64url");
  const signature = crypto.createHmac("sha256", sessionSecret).update(body).digest("base64url");
  res.cookie(cookieName, `${body}.${signature}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 12,
    path: "/"
  });
}

function readSignedSession(req, cookieName) {
  if (!sessionSecret) return null;
  const token = readCookie(req, cookieName);
  if (!token) return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const expected = crypto.createHmac("sha256", sessionSecret).update(body).digest("base64url");
  const valid = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (valid.length !== expectedBuffer.length || !crypto.timingSafeEqual(valid, expectedBuffer)) return null;
  try {
    const session = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return session.expiresAt > Date.now() ? session : null;
  } catch { return null; }
}

function createSession(res, account) {
  res.clearCookie("field_employee_session", { path: "/" });
  createSignedSession(res, "agent_session", { email: account.email, role: "agent" });
}

function createFieldEmployeeSession(res, account) {
  res.clearCookie("agent_session", { path: "/" });
  createSignedSession(res, "field_employee_session", { email: account.email, role: "fieldEmployee" });
}

function createAdminSession(res) {
  createSignedSession(res, "admin_session", { admin: true });
}

function requireAdmin(req, res, next) {
  const session = readSignedSession(req, "admin_session");

  if (
    !session?.admin ||
    session.expiresAt < Date.now()
  ) {
    return res.status(401).json({
      error: "Please sign in as an administrator."
    });
  }

  return next();
}

async function getCurrentAgent(req) {
  const session = readSignedSession(req, "agent_session");

  if (
    !session ||
    session.role !== "agent" ||
    session.expiresAt < Date.now()
  ) {
    return null;
  }

  const account = await getAccountByEmail(session.email);
  // Older migrated agent records predate the role field. Anything that is
  // not explicitly a field employee remains an agent for compatibility.
  return account &&
    account.role !== "fieldEmployee" &&
    account.accessStatus !== "invited" &&
    account.accessStatus !== "disabled"
    ? account
    : null;
}

async function requireAgent(req, res, next) {
  try {
    const account = await getCurrentAgent(req);

    if (!account) {
      return res.status(401).json({
        error:
          "Please sign in to access the agent dashboard."
      });
    }

    req.agent = account;
    req.requestUserType = "agent";

    return next();
  } catch (error) {
    console.error(
      "Agent session check failed:",
      error.message
    );

    return res.status(500).json({
      error:
        "Unable to verify your session. Please try again."
    });
  }
}

async function getCurrentFieldEmployee(req) {
  const session = readSignedSession(req, "field_employee_session");

  if (
    !session ||
    session.role !== "fieldEmployee" ||
    session.expiresAt < Date.now()
  ) {
    return null;
  }

  const account = await getAccountByEmail(session.email);
  return account?.role === "fieldEmployee" ? account : null;
}

async function requireFieldEmployee(req, res, next) {
  try {
    const account = await getCurrentFieldEmployee(req);

    if (!account) {
      return res.status(401).json({
        error:
          "Please sign in as a field employee."
      });
    }

    req.agent = account;
    req.requestUserType = "fieldEmployee";

    return next();
  } catch (error) {
    console.error(
      "Field employee session check failed:",
      error.message
    );

    return res.status(500).json({
      error:
        "Unable to verify your session. Please try again."
    });
  }
}

async function requirePickupUser(req, res, next) {
  try {
    const requestedType = req.body?.requestType || req.query?.requestType;

    if (requestedType === "fieldEmployee") {
      return requireFieldEmployee(req, res, next);
    }

    if (requestedType === "agent" || requestedType === "agentPickup" || requestedType === "agentTicket") {
      return requireAgent(req, res, next);
    }

    const agent = await getCurrentAgent(req);

    const fieldEmployee = await getCurrentFieldEmployee(req);

    if (agent && !fieldEmployee) {
      req.agent = agent;
      req.requestUserType = "agent";
      return next();
    }

    if (fieldEmployee && !agent) {
      req.agent = fieldEmployee;
      req.requestUserType = "fieldEmployee";
      return next();
    }

    if (agent && fieldEmployee) {
      return res.status(400).json({
        error: "Please refresh the dashboard so your active account can be identified."
      });
    }

    return res.status(401).json({
      error:
        "Please sign in to submit pickup requests."
    });
  } catch (error) {
    console.error(
      "Pickup session check failed:",
      error.message
    );

    return res.status(500).json({
      error:
        "Unable to verify your session. Please try again."
    });
  }
}

app.post(
  "/api/agent-login",
  authLimiter,
  async (req, res) => {
    const { email, password } =
      req.body || {};

    if (
      typeof email !== "string" ||
      typeof password !== "string" ||
      !email.trim() ||
      !isValidPassword(password)
    ) {
      return res.status(400).json({
        error: "Email and password are required."
      });
    }

    try {
      const account = await getAccountByEmail(normalizeEmail(email));

      if (
        !account ||
        account.role === "fieldEmployee" ||
        !account.salt ||
        !account.passwordHash
      ) {
        return res.status(401).json({
          error:
            "Email or password is incorrect."
        });
      }

      const enteredHash = await scrypt(
        password,
        account.salt,
        64
      );

      const savedHash = Buffer.from(
        account.passwordHash,
        "hex"
      );

      if (
        savedHash.length !==
          enteredHash.length ||
        !crypto.timingSafeEqual(
          savedHash,
          enteredHash
        )
      ) {
        return res.status(401).json({
          error:
            "Email or password is incorrect."
        });
      }

      if (account.accessStatus && account.accessStatus !== "active") {
        return res.status(403).json({
          error: "Please use the account-access link sent after your application was approved."
        });
      }

      createSession(res, account);

      return res.json({
        agent: {
          fullName: account.fullName,
          phone: account.phone,
          email: account.email
        }
      });
    } catch (error) {
      console.error(
        "Agent login failed:",
        error.message
      );

      return res.status(500).json({
        error:
          "Unable to sign in. Please try again."
      });
    }
  }
);

app.get(
  "/api/agent-session",
  requireAgent,
  (req, res) => {
    res.json({
      agent: {
        fullName:
          req.agent.fullName,
        phone: req.agent.phone,
        email: req.agent.email
      }
    });
  }
);

app.post(
  "/api/agent-logout",
  (req, res) => {
    res.clearCookie(
      "agent_session",
      {
        path: "/"
      }
    );

    res.status(204).end();
  }
);

app.post(
  "/api/field-employee-login",
  authLimiter,
  async (req, res) => {
    const {
      email,
      password
    } = req.body || {};

    if (
      typeof email !== "string" ||
      typeof password !== "string" ||
      !email.trim() ||
      !isValidPassword(password)
    ) {
      return res.status(400).json({
        error:
          "Email and password are required."
      });
    }

    try {
      const account = (
        await readAccounts()
      ).find(
        (item) =>
          item.email ===
            normalizeEmail(email) &&
          item.role === "fieldEmployee"
      );

      if (!account) {
        return res.status(401).json({
          error:
            "Email or password is incorrect."
        });
      }

      const enteredHash =
        await scrypt(
          password,
          account.salt,
          64
        );

      const savedHash =
        Buffer.from(
          account.passwordHash,
          "hex"
        );

      if (
        savedHash.length !==
          enteredHash.length ||
        !crypto.timingSafeEqual(
          savedHash,
          enteredHash
        )
      ) {
        return res.status(401).json({
          error:
            "Email or password is incorrect."
        });
      }

      createFieldEmployeeSession(
        res,
        account
      );

      return res.json({
        employee: {
          fullName:
            account.fullName,
          phone:
            account.phone,
          email:
            account.email
        }
      });
    } catch (error) {
      console.error(
        "Field employee login failed:",
        error.message
      );

      return res.status(500).json({
        error:
          "Unable to sign in. Please try again."
      });
    }
  }
);

app.post(
  "/api/field-employee-signup",
  authLimiter,
  rejectBotSubmission,
  async (req, res) => {
    const {
      fullName,
      phone,
      email,
      password
    } = req.body || {};

    const fields = [
      fullName,
      phone,
      email,
      password
    ];

    if (
      fields.some(
        (value) =>
          typeof value !== "string" ||
          !value.trim()
      )
    ) {
      return res.status(400).json({
        error:
          "Full name, phone, email and password are required."
      });
    }

    const cleanFullName = applicationField(fullName, 160);
    const cleanPhone = applicationField(phone, 40);
    const normalizedEmail = applicationEmail(email);
    if (!cleanFullName || !cleanPhone || !normalizedEmail) {
      return res.status(400).json({ error: "Enter a valid name, phone number and email address." });
    }

    if (!isValidPassword(password)) {
      return res.status(400).json({
        error: "Password must be between 8 and 256 characters."
      });
    }

    try {
      const salt =
        crypto.randomBytes(16).toString("hex");

      const passwordHash = (
        await scrypt(
          password,
          salt,
          64
        )
      ).toString("hex");

      const account = {
        role: "fieldEmployee",
        fullName: cleanFullName,
        phone: cleanPhone,
        email: normalizedEmail,
        company: "",
        location: "",
        salt,
        passwordHash,
        createdAt:
          new Date().toISOString()
      };

      try {
        await accountsCollection.insertOne(account);
      } catch (error) {
        if (error?.code === 11000) {
          return res.status(409).json({
            error: "An account already exists for this email. Please sign in."
          });
        }

        throw error;
      }

      try {
        await transporter.sendMail({
          from:
            process.env.SMTP_FROM ||
            process.env.SMTP_USER,
          to: emailTo,
          replyTo: account.email,
          subject:
            `New field employee signup: ${account.fullName}`,
          text:
            `New Aihuishou field employee signup\n\n` +
            `Full name: ${account.fullName}\n` +
            `Phone: ${account.phone}\n` +
            `Email: ${account.email}`
        });
      } catch (mailError) {
        console.error(
          "Field employee signup email failed:",
          mailError.message
        );
      }

      createFieldEmployeeSession(
        res,
        account
      );

      return res.status(201).json({
        employee: {
          fullName:
            account.fullName,
          phone:
            account.phone,
          email:
            account.email
        }
      });
    } catch (error) {
      console.error(
        "Field employee signup failed:",
        error.message
      );

      return res.status(500).json({
        error:
          "Unable to create your field employee account. Please try again."
      });
    }
  }
);

app.get(
  "/api/field-employee-session",
  requireFieldEmployee,
  (req, res) => {
    res.json({
      employee: {
        fullName:
          req.agent.fullName,
        phone:
          req.agent.phone,
        email:
          req.agent.email
      }
    });
  }
);

app.post(
  "/api/field-employee-logout",
  (req, res) => {
    res.clearCookie(
      "field_employee_session",
      {
        path: "/"
      }
    );

    res.status(204).end();
  }
);

app.post(
  "/api/admin-login",
  authLimiter,
  async (req, res) => {
    const {
      email,
      password
    } = req.body || {};

    if (!adminEmail || !process.env.ADMIN_PASSWORD) {
      return res.status(503).json({
        error:
          "Admin access has not been configured."
      });
    }

    if (!isValidPassword(password) || normalizeConfiguredEmail(email) !== adminEmail) {
      return res.status(401).json({
        error:
          "Email or password is incorrect."
      });
    }

    const configuredPassword = process.env.ADMIN_PASSWORD;
    const storedAdmin = withoutMongoId(await adminAccountsCollection.findOne({ email: adminEmail }));
    let passwordMatches = constantTimeStringEquals(password, configuredPassword);
    if (storedAdmin?.passwordHash && storedAdmin?.salt) {
      const enteredHash = await scrypt(password, storedAdmin.salt, 64);
      const savedHash = Buffer.from(storedAdmin.passwordHash, "hex");
      passwordMatches = savedHash.length === enteredHash.length && crypto.timingSafeEqual(savedHash, enteredHash);
    }
    if (!passwordMatches) return res.status(401).json({ error: "Email or password is incorrect." });

    createAdminSession(res);

    return res.json({
      message: "Admin signed in."
    });
  }
);

app.get(
  "/api/admin-session",
  requireAdmin,
  (req, res) => {
    res.json({
      admin: true
    });
  }
);

app.post(
  "/api/admin-logout",
  (req, res) => {
    res.clearCookie(
      "admin_session",
      {
        path: "/"
      }
    );

    res.status(204).end();
  }
);

app.post("/api/password-reset/request", authLimiter, async (req, res) => {
  const email = typeof req.body?.email === "string" ? normalizeEmail(req.body.email) : "";
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: "Please provide a valid email address." });
  }

  try {
    const account = await getAccountByEmail(email);
    const isAdmin = email === adminEmail;

    // Always return the same response so this endpoint cannot disclose registered emails.
    if (account || isAdmin) {
      const token = crypto.randomBytes(32).toString("hex");
      await passwordResetCollection.deleteMany({ email });
      await passwordResetCollection.insertOne({
        email,
        tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        createdAt: new Date()
      });
      const baseUrl = process.env.APP_URL || `${req.protocol}://${req.get("host")}`;

      try {
        await transporter.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: email,
          subject: "Reset your Aihuishou password",
          text: `Use this link within one hour to reset your password:\n${baseUrl}/password-reset.html?token=${token}&email=${encodeURIComponent(email)}\n\nIf you cannot find this email, please check your spam or junk folder.`
        });
      } catch (error) {
        console.error("Password reset email failed:", error.message);
      }
    }

    return res.json({ message: "If an account exists for that email, a password-reset link has been sent. Check your inbox and spam folder." });
  } catch (error) {
    console.error("Password reset request failed:", error.message);
    return res.status(500).json({ error: "Unable to process the password reset request." });
  }
});

app.post("/api/password-reset/confirm", authLimiter, async (req, res) => {
  const { email, token, password } = req.body || {};
  const normalizedEmail = typeof email === "string" ? normalizeEmail(email) : "";
  if (!normalizedEmail || typeof token !== "string" || !isValidPassword(password)) {
    return res.status(400).json({ error: "Enter a valid reset link and a password between 8 and 256 characters." });
  }

  try {
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const reset = await passwordResetCollection.findOne({ email: normalizedEmail, tokenHash, expiresAt: { $gt: new Date() } });
    if (!reset) return res.status(400).json({ error: "This reset link is invalid or has expired." });

    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = (await scrypt(password, salt, 64)).toString("hex");
    if (normalizedEmail === adminEmail) {
      await adminAccountsCollection.updateOne({ email: normalizedEmail }, { $set: { email: normalizedEmail, salt, passwordHash, updatedAt: new Date() } }, { upsert: true });
    } else {
      const result = await accountsCollection.updateOne({ email: normalizedEmail }, { $set: { salt, passwordHash, updatedAt: new Date().toISOString() } });
      if (!result.matchedCount) return res.status(400).json({ error: "This account no longer exists." });
    }

    await passwordResetCollection.deleteMany({ email: normalizedEmail });
    return res.json({ message: "Password updated. You can now sign in." });
  } catch (error) {
    console.error("Password reset confirmation failed:", error.message);
    return res.status(500).json({ error: "Unable to update the password right now." });
  }
});

function applicationField(value, maximumLength) {
  if (typeof value !== "string") return "";
  const cleaned = value.trim();
  return cleaned && cleaned.length <= maximumLength && !/[<>]/.test(cleaned)
    ? cleaned
    : "";
}

function applicationEmail(value) {
  const email = applicationField(value, 254).toLowerCase();
  return /^\S+@\S+\.\S+$/.test(email) ? email : "";
}

function publicBaseUrl(req) {
  return (process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
}

async function sendApplicationNotification(application) {
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: emailTo,
      replyTo: application.email,
      subject: `New agent application: ${application.fullName}`,
      text: [
        "New Aihuishou agent application",
        "",
        `Name: ${application.fullName}`,
        `Email: ${application.email}`,
        `Phone: ${application.phone}`,
        `Business name: ${application.businessName}`,
        `Location: ${application.location}`
      ].join("\n")
    });
  } catch (error) {
    // The application is retained in the admin dashboard even when email is
    // unavailable, so a temporary SMTP failure cannot lose an applicant.
    console.error("Agent application notification failed:", error.message);
  }
}

async function createAgentAccessInvite(req, application) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = new Date();
  const invite = {
    id: crypto.randomUUID(),
    applicationId: application.id,
    email: application.email,
    tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
    createdAt: now,
    expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
  };

  await agentAccessInvitesCollection.deleteMany({ email: application.email });
  await agentAccessInvitesCollection.insertOne(invite);

  return `${publicBaseUrl(req)}/agent-login.html?invite=${encodeURIComponent(token)}&email=${encodeURIComponent(application.email)}`;
}

async function sendApprovedAgentEmail(application, accessUrl) {
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: application.email,
    subject: "Your Aihuishou agent application has been approved",
    text: [
      `Hello ${application.firstName},`,
      "",
      "We are pleased to let you know that your Aihuishou agent application has been approved.",
      "Use the secure link below within seven days to set your password and access the Agent login screen:",
      accessUrl,
      "",
      "If you do not see this message in your inbox, please check your spam or junk folder.",
      "",
      "If you did not apply, you can safely ignore this email.",
      "",
      "Aihuishou Electricals"
    ].join("\n")
  });
}

async function sendRejectedAgentEmail(application) {
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: application.email,
    subject: "Update on your Aihuishou agent application",
    text: [
      `Hello ${application.firstName},`,
      "",
      "Thank you for your interest in becoming an Aihuishou agent and for taking the time to apply.",
      "At the moment, we are not recruiting agents in your region. We will keep your details on file and reach out if this changes.",
      "",
      "If you do not see future messages from us in your inbox, please check your spam or junk folder.",
      "",
      "We appreciate your interest in working with us.",
      "",
      "Aihuishou Electricals"
    ].join("\n")
  });
}

app.post("/api/agent-applications", requestLimiter, rejectBotSubmission, async (req, res) => {
  const firstName = applicationField(req.body?.firstName, 80);
  const lastName = applicationField(req.body?.lastName, 80);
  const phone = applicationField(req.body?.phone, 40);
  const email = applicationEmail(req.body?.email);
  const businessName = applicationField(req.body?.businessName, 160);
  const location = applicationField(req.body?.location, 160);

  if (!firstName || !lastName || !phone || !email || !businessName || !location) {
    return res.status(400).json({
      error: "First name, last name, email, phone number, business name and location are required."
    });
  }

  try {
    const [account, pendingApplication] = await Promise.all([
      getAccountByEmail(email),
      agentApplicationsCollection.findOne({ email, status: "Pending" })
    ]);

    if (account || pendingApplication) {
      return res.status(409).json({
        error: pendingApplication
          ? "An application from this email is already awaiting review."
          : "An agent account already exists for this email."
      });
    }

    const application = {
      id: crypto.randomUUID(),
      firstName,
      lastName,
      fullName: `${firstName} ${lastName}`,
      email,
      phone,
      businessName,
      location,
      status: "Pending",
      createdAt: new Date().toISOString()
    };

    await agentApplicationsCollection.insertOne(application);
    await sendApplicationNotification(application);

    return res.status(201).json({
      message: "Your application has been received. We will email you after the vetting process is complete; please check your spam folder too."
    });
  } catch (error) {
    console.error("Agent application creation failed:", error.message);
    return res.status(500).json({ error: "Unable to submit your application. Please try again." });
  }
});

app.post("/api/agent-invitation/confirm", authLimiter, async (req, res) => {
  const email = applicationEmail(req.body?.email);
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";

  if (!email || !token || !isValidPassword(password)) {
    return res.status(400).json({ error: "Use a valid access link and a password between 8 and 256 characters." });
  }

  try {
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const invite = await agentAccessInvitesCollection.findOne({
      email,
      tokenHash,
      expiresAt: { $gt: new Date() }
    });
    if (!invite) return res.status(400).json({ error: "This account-access link is invalid or has expired." });

    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = (await scrypt(password, salt, 64)).toString("hex");
    const result = await accountsCollection.updateOne(
      { email, role: "agent", accessStatus: "invited" },
      { $set: { salt, passwordHash, accessStatus: "active", activatedAt: new Date().toISOString() } }
    );
    if (!result.matchedCount) return res.status(400).json({ error: "This account is no longer waiting for activation." });

    await agentAccessInvitesCollection.deleteMany({ email });
    await agentApplicationsCollection.updateOne(
      { id: invite.applicationId },
      { $set: { accessActivatedAt: new Date().toISOString() } }
    );
    const account = await getAccountByEmail(email);
    createSession(res, account);
    return res.json({
      message: "Your password is set. Welcome to the agent portal.",
      agent: { fullName: account.fullName, phone: account.phone, email: account.email }
    });
  } catch (error) {
    console.error("Agent invitation confirmation failed:", error.message);
    return res.status(500).json({ error: "Unable to activate your account right now." });
  }
});

app.get(
  "/api/pickup-requests",
  requirePickupUser,
  async (req, res) => {
    try {
      const requests =
        await readPickupRequests();

      const requestedType = typeof req.query?.requestType === "string" ? req.query.requestType : "";
      const requestTypeMatches = (request) => {
        const type = request.requestType || "agent";
        if (req.requestUserType === "fieldEmployee") return type === "fieldEmployee";
        if (requestedType === "agentPickup") return type === "agentPickup" || type === "agent";
        if (requestedType === "agentTicket") return type === "agentTicket";
        return type === "agent" || type === "agentPickup" || type === "agentTicket";
      };

      const agentRequests =
        requests
          .filter(
            (request) =>
              request.agentEmail ===
              req.agent.email &&
              requestTypeMatches(request)
          )
          .sort(
            (first, second) =>
              new Date(
                second.createdAt
              ) -
              new Date(
                first.createdAt
              )
          )
          .map(
            ({
              agentEmail,
              ...request
            }) => request
          );

      return res.json({
        requests:
          agentRequests
      });
    } catch (error) {
      console.error(
        "Pickup history lookup failed:",
        error.message
      );

      return res.status(500).json({
        error:
          "Unable to load pickup history. Please try again."
      });
    }
  }
);

app.get(
  "/api/pickup-date-requests",
  requireAgent,
  async (req, res) => {
    try {
      const [dateRequests, pickupRequests] = await Promise.all([
        readPickupDateRequests(),
        readPickupRequests()
      ]);
      const agentRequests = dateRequests
        .filter((request) => request.agentEmail === req.agent.email)
        .sort((first, second) => new Date(second.createdAt) - new Date(first.createdAt));
      const latest = agentRequests[0] || null;

      return res.json({
        approval: latest,
        locked: isActivePickupDateRequest(latest),
        ...agentGoodsSinceLastPickup(req.agent.email, pickupRequests)
      });
    } catch (error) {
      console.error("Pickup date approval lookup failed:", error.message);
      return res.status(500).json({ error: "Unable to load pickup date approval status." });
    }
  }
);

app.post(
  "/api/pickup-date-requests",
  requestLimiter,
  requireAgent,
  async (req, res) => {
    const requestedDate = typeof req.body?.requestedDate === "string"
      ? req.body.requestedDate.trim()
      : "";

    if (!isValidDateOnly(requestedDate)) {
      return res.status(400).json({ error: "Choose a valid pickup date." });
    }

    try {
      const active = await pickupDateRequestsCollection.findOne({
        agentEmail: req.agent.email,
        active: true,
        status: { $in: ACTIVE_PICKUP_DATE_STATUSES }
      });

      if (active) {
        return res.status(409).json({
          error: active.status === "Approved"
            ? "Your pickup date is already approved. It must be rejected before you can choose another date."
            : "A pickup date is already pending approval. Wait for the admin decision before choosing another date."
        });
      }

      const approval = {
        id: crypto.randomUUID(),
        agentEmail: req.agent.email,
        requestedDate,
        status: "Pending approval",
        active: true,
        createdAt: new Date().toISOString()
      };

      try {
        await pickupDateRequestsCollection.insertOne(approval);
      } catch (error) {
        if (error?.code === 11000) {
          return res.status(409).json({ error: "A pickup date is already pending approval." });
        }
        throw error;
      }

      return res.status(201).json({
        message: "Pickup date sent for admin approval.",
        approval: withoutMongoId(approval)
      });
    } catch (error) {
      console.error("Pickup date approval creation failed:", error.message);
      return res.status(500).json({ error: "Unable to submit the pickup date for approval." });
    }
  }
);

app.get(
  "/api/admin/pickup-date-requests",
  requireAdmin,
  async (req, res) => {
    try {
      const [dateRequests, pickupRequests, accounts] = await Promise.all([
        readPickupDateRequests(),
        readPickupRequests(),
        readAccounts()
      ]);
      const accountByEmail = new Map(accounts.map((account) => [account.email, account]));
      const adminRequests = dateRequests
        .sort((first, second) => {
          const statusOrder = { "Pending approval": 0, Approved: 1, Rejected: 2 };
          return (statusOrder[first.status] ?? 3) - (statusOrder[second.status] ?? 3)
            || new Date(second.createdAt) - new Date(first.createdAt);
        })
        .map((request) => {
          const agent = accountByEmail.get(request.agentEmail);
          const totals = agentGoodsSinceLastPickup(request.agentEmail, pickupRequests);
          return {
            ...request,
            agent: agent
              ? {
                  fullName: agent.fullName,
                  phone: agent.phone,
                  email: agent.email,
                  company: agent.company,
                  location: agent.location
                }
              : null,
            totalAmountSinceLastPickup: totals.totalAmount,
            totalQuantitySinceLastPickup: totals.totalQuantity,
            lastPickupDate: totals.lastPickupDate,
            lastPickupAt: totals.lastPickupAt
          };
        });

      return res.json({ requests: adminRequests });
    } catch (error) {
      console.error("Admin pickup date approval lookup failed:", error.message);
      return res.status(500).json({ error: "Unable to load pickup date approvals." });
    }
  }
);

app.post(
  "/api/admin/pickup-date-requests/:id/approve",
  requireAdmin,
  async (req, res) => {
    try {
      const result = await pickupDateRequestsCollection.updateOne(
        { id: req.params.id, status: "Pending approval", active: true },
        {
          $set: {
            status: "Approved",
            reviewedAt: new Date().toISOString(),
            reviewedBy: adminEmail
          }
        }
      );
      if (!result.matchedCount) {
        return res.status(409).json({ error: "This pickup date is no longer pending approval." });
      }
      return res.json({ message: "Pickup date approved." });
    } catch (error) {
      console.error("Pickup date approval failed:", error.message);
      if (error?.code === 11000) {
        return res.status(409).json({ error: "This agent already has another approved pickup date." });
      }
      return res.status(500).json({ error: "Unable to approve this pickup date." });
    }
  }
);

app.post(
  "/api/admin/pickup-date-requests/:id/reject",
  requireAdmin,
  async (req, res) => {
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 500) : "";
    try {
      const result = await pickupDateRequestsCollection.updateOne(
        { id: req.params.id, status: { $in: ["Pending approval", "Approved"] } },
        {
          $set: {
            status: "Rejected",
            active: false,
            reviewedAt: new Date().toISOString(),
            reviewedBy: adminEmail,
            rejectionReason: reason
          }
        }
      );
      if (!result.matchedCount) {
        return res.status(409).json({ error: "This pickup date has already been rejected." });
      }
      return res.json({ message: "Pickup date rejected." });
    } catch (error) {
      console.error("Pickup date rejection failed:", error.message);
      return res.status(500).json({ error: "Unable to reject this pickup date." });
    }
  }
);

app.get(
  "/api/admin/pickup-requests",
  requireAdmin,
  async (req, res) => {
    try {
      const requests =
        await readPickupRequests();

      const accounts =
        await readAccounts();

      const accountByEmail =
        new Map(
          accounts.map(
            (account) => [
              account.email,
              account
            ]
          )
        );

      const adminRequests =
        requests
          .sort(
            (first, second) =>
              new Date(
                second.createdAt
              ) -
              new Date(
                first.createdAt
              )
          )
          .map((request) => {
            const agent =
              accountByEmail.get(
                request.agentEmail
              );

            return {
              ...request,
              totalAmount: calculateRequestTotal(request.goods),
              preferredDate: requestPreferredDate(request),
              agent: agent
                ? {
                    fullName:
                      agent.fullName,
                    phone:
                      agent.phone,
                    email:
                      agent.email,
                    company:
                      agent.company,
                    location:
                      agent.location
                  }
                : null
            };
          });

      return res.json({
        requests:
          adminRequests
      });
    } catch (error) {
      console.error(
        "Admin pickup history lookup failed:",
        error.message
      );

      return res.status(500).json({
        error:
          "Unable to load pickup requests."
      });
    }
  }
);

app.get("/api/admin/agent-applications", requireAdmin, async (req, res) => {
  try {
    const applications = await agentApplicationsCollection.find(
      {},
      { projection: { _id: 0 } }
    ).sort({ createdAt: -1 }).toArray();
    res.json({ applications });
  } catch (error) {
    console.error("Admin agent application lookup failed:", error.message);
    res.status(500).json({ error: "Unable to load agent applications." });
  }
});

app.post("/api/admin/agent-applications/:id/approve", requireAdmin, async (req, res) => {
  try {
    const application = withoutMongoId(await agentApplicationsCollection.findOne({ id: req.params.id }));
    if (!application) return res.status(404).json({ error: "Application not found." });
    if (application.status !== "Pending") {
      return res.status(409).json({ error: "This application has already been reviewed." });
    }

    const existingAccount = await getAccountByEmail(application.email);
    if (existingAccount) {
      return res.status(409).json({ error: "An account already exists for this applicant." });
    }

    const now = new Date().toISOString();
    const account = {
      role: "agent",
      accessStatus: "invited",
      fullName: application.fullName,
      phone: application.phone,
      email: application.email,
      company: application.businessName,
      businessName: application.businessName,
      location: application.location,
      applicationId: application.id,
      createdAt: now,
      approvedAt: now
    };

    try {
      await accountsCollection.insertOne(account);
    } catch (error) {
      if (error?.code === 11000) return res.status(409).json({ error: "An account already exists for this applicant." });
      throw error;
    }

    let accessUrl;
    try {
      accessUrl = await createAgentAccessInvite(req, application);
    } catch (error) {
      await accountsCollection.deleteOne({ email: application.email, applicationId: application.id });
      throw error;
    }
    let accessEmailStatus = "Sent";
    let accessEmailError = "";
    try {
      await sendApprovedAgentEmail(application, accessUrl);
    } catch (error) {
      accessEmailStatus = "Failed";
      accessEmailError = error.message;
      console.error("Approved agent email failed:", error.message);
    }

    await agentApplicationsCollection.updateOne(
      { id: application.id, status: "Pending" },
      {
        $set: {
          status: "Approved",
          reviewedAt: now,
          reviewedBy: adminEmail,
          accessEmailStatus,
          accessEmailError,
          accessEmailSentAt: accessEmailStatus === "Sent" ? now : ""
        }
      }
    );

    return res.json({
      message: accessEmailStatus === "Sent"
        ? "Application approved and account-access email sent."
        : "Application approved, but the account-access email could not be sent. Use Resend access link after checking SMTP settings.",
      emailSent: accessEmailStatus === "Sent"
    });
  } catch (error) {
    console.error("Agent application approval failed:", error.message);
    return res.status(500).json({ error: "Unable to approve this application." });
  }
});

app.post("/api/admin/agent-applications/:id/resend-access", requireAdmin, async (req, res) => {
  try {
    const application = withoutMongoId(await agentApplicationsCollection.findOne({ id: req.params.id, status: "Approved" }));
    if (!application) return res.status(404).json({ error: "Approved application not found." });
    const account = await getAccountByEmail(application.email);
    if (!account || account.role !== "agent") return res.status(409).json({ error: "This approved agent account is no longer available." });
    if (account.accessStatus !== "invited") return res.status(409).json({ error: "This agent has already activated their account." });

    const accessUrl = await createAgentAccessInvite(req, application);
    try {
      await sendApprovedAgentEmail(application, accessUrl);
    } catch (error) {
      await agentApplicationsCollection.updateOne(
        { id: application.id },
        { $set: { accessEmailStatus: "Failed", accessEmailError: error.message } }
      );
      console.error("Agent access email resend failed:", error.message);
      return res.status(502).json({ error: "The account-access email could not be sent. Check SMTP settings and try again." });
    }

    await agentApplicationsCollection.updateOne(
      { id: application.id },
      { $set: { accessEmailStatus: "Sent", accessEmailError: "", accessEmailSentAt: new Date().toISOString() } }
    );
    return res.json({ message: "A new account-access link has been emailed to the approved agent." });
  } catch (error) {
    console.error("Agent access email resend failed:", error.message);
    return res.status(500).json({ error: "Unable to resend the account-access email." });
  }
});

app.post("/api/admin/agent-applications/:id/reject", requireAdmin, async (req, res) => {
  try {
    const application = withoutMongoId(await agentApplicationsCollection.findOne({ id: req.params.id }));
    if (!application) return res.status(404).json({ error: "Application not found." });
    if (application.status !== "Pending") {
      return res.status(409).json({ error: "This application has already been reviewed." });
    }

    const now = new Date().toISOString();
    let rejectionEmailStatus = "Sent";
    let rejectionEmailError = "";
    try {
      await sendRejectedAgentEmail(application);
    } catch (error) {
      rejectionEmailStatus = "Failed";
      rejectionEmailError = error.message;
      console.error("Rejected agent email failed:", error.message);
    }

    await agentApplicationsCollection.updateOne(
      { id: application.id, status: "Pending" },
      {
        $set: {
          status: "Rejected",
          reviewedAt: now,
          reviewedBy: adminEmail,
          rejectionEmailStatus,
          rejectionEmailError,
          rejectionEmailSentAt: rejectionEmailStatus === "Sent" ? now : ""
        }
      }
    );
    return res.json({
      message: rejectionEmailStatus === "Sent"
        ? "Application rejected and applicant email sent."
        : "Application rejected, but the applicant email could not be sent.",
      emailSent: rejectionEmailStatus === "Sent"
    });
  } catch (error) {
    console.error("Agent application rejection failed:", error.message);
    return res.status(500).json({ error: "Unable to reject this application." });
  }
});

app.get("/api/admin/accounts", requireAdmin, async (req, res) => {
  try {
    const accounts = await accountsCollection.find(
      {},
      { projection: { _id: 0, passwordHash: 0, salt: 0 } }
    ).sort({ fullName: 1 }).toArray();
    // The current dashboard was built with a static HTML template for this
    // list. Preserve safety for records created before input validation.
    res.json({
      accounts: accounts.map((account) => ({
        ...account,
        fullName: String(account.fullName || "").replace(/[<>]/g, "")
      }))
    });
  } catch (error) {
    console.error("Admin account lookup failed:", error.message);
    res.status(500).json({ error: "Unable to load accounts." });
  }
});

app.delete("/api/admin/accounts/:email", requireAdmin, async (req, res) => {
  try {
    const email = normalizeEmail(req.params.email);
    const result = await accountsCollection.deleteOne({ email });
    if (!result.deletedCount) return res.status(404).json({ error: "Account not found." });
    await passwordResetCollection.deleteMany({ email });
    await agentAccessInvitesCollection.deleteMany({ email });
    res.status(204).end();
  } catch (error) {
    console.error("Account deletion failed:", error.message);
    res.status(500).json({ error: "Unable to delete account." });
  }
});

app.post(
  "/api/pickup-requests",
  requestLimiter,
  requirePickupUser,
  async (req, res) => {
    const {
      requestType,
      goods,
      preferredDate,
      preferredTime,
      location,
      notes
    } = req.body || {};

    const submittedRequestType = typeof requestType === "string" && requestType.trim()
      ? requestType.trim()
      : (req.requestUserType || "agent");
    const isFieldEmployee = submittedRequestType === "fieldEmployee";
    const isAgentPickup = submittedRequestType === "agentPickup" || submittedRequestType === "agent";
    const isAgentTicket = submittedRequestType === "agentTicket";

    const validGoods =
      Array.isArray(goods) &&
      goods.length > 0 &&
      goods.every(
        (item) =>
          item &&
          typeof item.name ===
            "string" &&
          GOODS_OPTIONS.has(item.name.trim()) &&
          (
            typeof item.quantity ===
              "number" ||
            typeof item.quantity ===
              "string"
          ) &&
          String(
            item.quantity
          ).trim() &&
          Number.isSafeInteger(Number(item.quantity)) &&
          Number(item.quantity) >= 1 &&
          (
            isAgentPickup ||
            (
              (typeof item.amount === "number" || typeof item.amount === "string") &&
              String(item.amount).trim() &&
              Number.isFinite(Number(item.amount)) &&
              Number(item.amount) >= 0
            )
          )
      );

    const cleanLocation = applicationField(location, 160);
    const cleanNotes = applicationField(notes || "", 1000);
    const invalidNotes = typeof notes !== "undefined" && typeof notes !== "string" || (typeof notes === "string" && notes.trim() && !cleanNotes);
    const fields = isAgentPickup ? [cleanLocation] : [];

    const missingFields = fields.some(
      (value) => typeof value !== "string" || !value.trim()
    );

    if (
      (isFieldEmployee && req.requestUserType !== "fieldEmployee") ||
      ((isAgentPickup || isAgentTicket) && req.requestUserType !== "agent") ||
      (!isFieldEmployee && !isAgentPickup && !isAgentTicket)
    ) {
      return res.status(400).json({
        error: "This dashboard session cannot submit that request type. Refresh and sign in again."
      });
    }

    if (!validGoods) {
      return res.status(400).json({
        error: isAgentPickup
          ? "Add at least one good with a category and whole-number quantity."
          : "Add at least one good with a category, whole-number quantity, and valid amount per item."
      });
    }

    if (missingFields) {
      return res.status(400).json({
        error: "Complete the pickup location."
      });
    }

    if (invalidNotes) {
      return res.status(400).json({ error: "Notes must be plain text and no longer than 1,000 characters." });
    }

    // `preferredTime` is accepted but ignored for one release so older cached
    // dashboards can still create tickets while clients migrate to dates.
    const cleanPreferredDate = typeof preferredDate === "string" ? preferredDate.trim() : "";
    if (submittedRequestType === "agentPickup" && !cleanPreferredDate) {
      return res.status(400).json({ error: "Choose a pickup date." });
    }
    if (cleanPreferredDate && !(submittedRequestType === "agentPickup" ? isValidDateNotInPast(cleanPreferredDate) : isValidDateOnly(cleanPreferredDate))) {
      return res.status(400).json({ error: submittedRequestType === "agentPickup" ? "Choose a valid pickup date that is not in the past." : "Choose a valid pickup date." });
    }
    const cleanedGoods =
      goods.map((item) => ({
        name: item.name.trim(),
        quantity:
          Number(item.quantity),
        amount: isAgentPickup ? 0 : Number(item.amount),
        totalAmount: isAgentPickup ? 0 : Number(item.amount) * Number(item.quantity)
      }));

    const goodsText =
      cleanedGoods
        .map(
          (item) =>
            isAgentPickup
              ? `${item.name}: ${item.quantity}`
              : `${item.name}: ${item.quantity} @ ${item.amount} = ${item.totalAmount}`
        )
        .join(", ");

    const pickupRequest = [
      `New ${isFieldEmployee ? "field employee ticket" : isAgentPickup ? "pickup request" : "agent ticket"}`,
      "",
      `${isFieldEmployee ? "Field employee" : "Agent"}: ${req.agent.fullName}`,
      `Phone: ${req.agent.phone}`,
      `Goods: ${goodsText}`,
      `Preferred pickup date: ${cleanPreferredDate || "Not provided"}`,
      `Pickup location: ${isAgentPickup ? cleanLocation : "Not provided"}`,
      `Collection notes: ${
        cleanNotes
          ? cleanNotes
          : "None"
      }`
    ].join("\n");

    const savedRequest = {
      id: crypto.randomUUID(),
      agentEmail:
        req.agent.email,
      requestType: submittedRequestType,
      goods: cleanedGoods,
      totalAmount: calculateRequestTotal(cleanedGoods),
      preferredDate: cleanPreferredDate,
      location: isAgentPickup ? cleanLocation : "",
      notes: cleanNotes,
      status:
        "Pending approval",
      createdAt:
        new Date().toISOString()
    };

    try {
      await pickupRequestsCollection.insertOne(savedRequest);
    } catch (error) {
      console.error(
        "Pickup request storage failed:",
        error.message
      );

      return res.status(500).json({
        error:
          "We could not save your ticket. Please try again later."
      });
    }

    let emailSent = true;

    try {
      await transporter.sendMail({
        from:
          process.env.SMTP_FROM ||
          process.env.SMTP_USER,
        to: emailTo,
        replyTo:
          req.agent.email,
        subject: `${
          isFieldEmployee
            ? "Field ticket"
            : isAgentPickup
              ? "Pickup request"
              : "Agent ticket"
        }: ${cleanedGoods
          .map(
            (item) => item.name
          )
          .join(", ")} — ${
          req.agent.fullName
        }`,
        text: pickupRequest
      });
    } catch (error) {
      emailSent = false;

      console.error(
        "Pickup request email failed; request remains available in admin dashboard:",
        error.message
      );
    }

    const {
      agentEmail,
      ...responseRequest
    } = savedRequest;

    return res.status(201).json({
      message:
        isAgentPickup
          ? "Pickup request created and sent for admin approval."
          : "Ticket created and sent for admin approval.",
      emailSent,
      request:
        responseRequest
    });
  }
);

app.post(
  "/api/admin/pickup-requests/:id/approve",
  requireAdmin,
  async (req, res) => {
    try {
      const request = withoutMongoId(await pickupRequestsCollection.findOne({ id: req.params.id }));

      if (!request) {
        return res.status(404).json({
          error:
            "Pickup request not found."
        });
      }

      if (
        request.status !==
        "Approved"
      ) {
        request.status = "Approved";
        request.approvedAt = new Date().toISOString();
        await pickupRequestsCollection.updateOne({ id: request.id }, { $set: { status: request.status, approvedAt: request.approvedAt } });
      }

      return res.json({
        message:
          "Pickup request approved.",
        request
      });
    } catch (error) {
      console.error(
        "Pickup request approval failed:",
        error.message
      );

      return res.status(500).json({
        error:
          "Unable to approve pickup request."
      });
    }
  }
);

app.use("/api", (req, res) => {
  res.status(404).json({ error: "API endpoint not found." });
});

app.use((error, req, res, next) => {
  console.error("Unhandled request error:", error.message);

  if (res.headersSent) {
    return next(error);
  }

  return res.status(500).json({
    error: "An unexpected server error occurred. Please try again."
  });
});

// Run as a normal local Express server when executed directly.
// Vercel imports the app instead, so it will not start a second listener.
const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

// Export Express app for Vercel
module.exports = app;
