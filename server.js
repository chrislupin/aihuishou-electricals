const path = require("node:path");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { promisify } = require("node:util");

const dotenv = require("dotenv");

dotenv.config();

// Keep optional local Atlas credentials outside the repository. Environment
// variables set by a hosting provider take precedence over this file.
if (process.env.MONGODB_CREDENTIALS_FILE) {
  const result = dotenv.config({ path: process.env.MONGODB_CREDENTIALS_FILE });
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
const passwordResetCollection = database?.collection("password_resets");
const adminAccountsCollection = database?.collection("admin_accounts");

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
    contentSecurityPolicy: false
  })
);

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
  return email.trim().toLowerCase();
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
        passwordResetCollection.createIndex({ email: 1 }),
        passwordResetCollection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
        adminAccountsCollection.createIndex({ email: 1 }, { unique: true })
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
  return account && account.role !== "fieldEmployee" ? account : null;
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

    if (requestedType === "agent") {
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
  "/api/agent-signup",
  authLimiter,
  async (req, res) => {
    const {
      fullName,
      phone,
      email,
      company,
      location,
      password
    } = req.body || {};

    const fields = [
      fullName,
      phone,
      email,
      location,
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
          "Full name, phone, email, location and password are required."
      });
    }

    if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
      return res.status(400).json({
        error: "Please provide a valid email address."
      });
    }

    if (/[<>]/.test(fullName)) {
      return res.status(400).json({
        error: "Full name cannot contain angle brackets."
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        error:
          "Password must be at least 8 characters."
      });
    }

    try {
      const normalizedEmail =
        normalizeEmail(email);

      const salt =
        crypto.randomBytes(16).toString("hex");

      const passwordHash = (
        await scrypt(password, salt, 64)
      ).toString("hex");

      const account = {
        role: "agent",
        fullName: fullName.trim(),
        phone: phone.trim(),
        email: normalizedEmail,
        company:
          typeof company === "string"
            ? company.trim()
            : "",
        location: location.trim(),
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

      const application = [
        "New Aihuishou agent signup",
        "",
        `Full name: ${account.fullName}`,
        `Phone: ${account.phone}`,
        `Email: ${account.email}`,
        `Business/Company: ${
          account.company || "Not provided"
        }`,
        `Location: ${account.location}`
      ].join("\n");

      try {
        await transporter.sendMail({
          from:
            process.env.SMTP_FROM ||
            process.env.SMTP_USER,
          to: emailTo,
          replyTo: account.email,
          subject:
            `New agent signup: ${account.fullName}`,
          text: application
        });
      } catch (mailError) {
        console.error(
          "Agent signup email failed:",
          mailError.message
        );
      }

      createSession(res, account);

      return res.status(201).json({
        message: "Account created.",
        agent: {
          fullName: account.fullName,
          phone: account.phone,
          email: account.email
        }
      });
    } catch (error) {
      console.error(
        "Agent signup failed:",
        error.message
      );

      return res.status(500).json({
        error:
          "Unable to create your agent account. Please try again."
      });
    }
  }
);

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
      !password
    ) {
      return res.status(400).json({
        error: "Email and password are required."
      });
    }

    try {
      const account = (
        await readAccounts()
      ).find(
        (item) =>
          item.email ===
            normalizeEmail(email) &&
          item.role !== "fieldEmployee"
      );

      if (!account) {
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
      !password
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

    if (
      !/^\S+@\S+\.\S+$/.test(
        email.trim()
      )
    ) {
      return res.status(400).json({
        error:
          "Please provide a valid email address."
      });
    }

    if (/[<>]/.test(fullName)) {
      return res.status(400).json({
        error: "Full name cannot contain angle brackets."
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        error:
          "Password must be at least 8 characters."
      });
    }

    try {
      const normalizedEmail =
        normalizeEmail(email);

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
        fullName: fullName.trim(),
        phone: phone.trim(),
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

    if (
      !adminEmail ||
      !process.env.ADMIN_PASSWORD
    ) {
      return res.status(503).json({
        error:
          "Admin access has not been configured."
      });
    }

    if (normalizeConfiguredEmail(email) !== adminEmail) {
      return res.status(401).json({
        error:
          "Email or password is incorrect."
      });
    }

    const configuredPassword = process.env.ADMIN_PASSWORD;
    const storedAdmin = withoutMongoId(await adminAccountsCollection.findOne({ email: adminEmail }));
    let passwordMatches = password === configuredPassword;
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
          text: `Use this link within one hour to reset your password:\n${baseUrl}/password-reset.html?token=${token}&email=${encodeURIComponent(email)}`
        });
      } catch (error) {
        console.error("Password reset email failed:", error.message);
      }
    }

    return res.json({ message: "If an account exists for that email, a password-reset link has been sent." });
  } catch (error) {
    console.error("Password reset request failed:", error.message);
    return res.status(500).json({ error: "Unable to process the password reset request." });
  }
});

app.post("/api/password-reset/confirm", authLimiter, async (req, res) => {
  const { email, token, password } = req.body || {};
  const normalizedEmail = typeof email === "string" ? normalizeEmail(email) : "";
  if (!normalizedEmail || typeof token !== "string" || typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "Enter a valid reset link and a password of at least 8 characters." });
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

app.post(
  "/api/agent-applications",
  requestLimiter,
  async (req, res) => {
    const {
      fullName,
      phone,
      email,
      company,
      location
    } = req.body || {};

    const fields = [
      fullName,
      phone,
      email,
      location
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
          "Full name, phone, email and location are required."
      });
    }

    if (
      !/^\S+@\S+\.\S+$/.test(
        email.trim()
      )
    ) {
      return res.status(400).json({
        error:
          "Please provide a valid email address."
      });
    }

    const application = [
      "New Aihuishou agent application",
      "",
      `Full name: ${fullName.trim()}`,
      `Phone: ${phone.trim()}`,
      `Email: ${email.trim()}`,
      `Business/Company: ${
        company?.trim() ||
        "Not provided"
      }`,
      `Location: ${location.trim()}`
    ].join("\n");

    try {
      await transporter.sendMail({
        from:
          process.env.SMTP_FROM ||
          process.env.SMTP_USER,
        to: emailTo,
        replyTo: email.trim(),
        subject:
          `Agent application: ${fullName.trim()}`,
        text: application
      });

      return res.status(201).json({
        message:
          "Application received."
      });
    } catch (error) {
      console.error(
        "Agent application email failed:",
        error.message
      );

      return res.status(500).json({
        error:
          "We could not send your application. Please try again later."
      });
    }
  }
);

app.get(
  "/api/pickup-requests",
  requirePickupUser,
  async (req, res) => {
    try {
      const requests =
        await readPickupRequests();

      const agentRequests =
        requests
          .filter(
            (request) =>
              request.agentEmail ===
              req.agent.email &&
              (request.requestType || "agent") ===
              req.requestUserType
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

    const validGoods =
      Array.isArray(goods) &&
      goods.length > 0 &&
      goods.every(
        (item) =>
          item &&
          typeof item.name ===
            "string" &&
          item.name.trim() &&
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
          (typeof item.amount === "number" || typeof item.amount === "string") &&
          String(item.amount).trim() &&
          Number.isFinite(Number(item.amount)) &&
          Number(item.amount) >= 0
      );

    const fields = isFieldEmployee ? [] : [location];

    const missingFields = fields.some(
      (value) => typeof value !== "string" || !value.trim()
    );

    if (submittedRequestType !== req.requestUserType) {
      return res.status(400).json({
        error: "This dashboard session cannot submit that request type. Refresh and sign in again."
      });
    }

    if (!validGoods) {
      return res.status(400).json({
        error: "Add at least one good with a category, whole-number quantity, and valid amount per item."
      });
    }

    if (missingFields) {
      return res.status(400).json({
        error: "Complete the pickup location."
      });
    }

    // `preferredTime` is accepted but ignored for one release so older cached
    // dashboards can still create tickets while clients migrate to dates.
    const cleanPreferredDate = typeof preferredDate === "string" ? preferredDate.trim() : "";
    if (cleanPreferredDate && !isValidDateOnly(cleanPreferredDate)) {
      return res.status(400).json({ error: "Choose a valid pickup date." });
    }
    const cleanedGoods =
      goods.map((item) => ({
        name: item.name.trim(),
        quantity:
          Number(item.quantity),
        amount: Number(item.amount),
        totalAmount: Number(item.amount) * Number(item.quantity)
      }));

    const goodsText =
      cleanedGoods
        .map(
          (item) =>
            `${item.name}: ${item.quantity} @ ${item.amount} = ${item.totalAmount}`
        )
        .join(", ");

    const pickupRequest = [
      `New ${isFieldEmployee ? "field employee" : "agent"} ticket`,
      "",
      `${isFieldEmployee ? "Field employee" : "Agent"}: ${req.agent.fullName}`,
      `Phone: ${req.agent.phone}`,
      `Goods: ${goodsText}`,
      `Preferred pickup date: ${cleanPreferredDate || "Not provided"}`,
      `Pickup location: ${
        isFieldEmployee
          ? "Not provided (field employee)"
          : location.trim()
      }`,
      `Collection notes: ${
        typeof notes === "string" &&
        notes.trim()
          ? notes.trim()
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
      location:
        isFieldEmployee
          ? ""
          : location.trim(),
      notes:
        typeof notes === "string"
          ? notes.trim()
          : "",
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
            : "Pickup ticket"
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
        "Ticket created and sent for admin approval.",
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
