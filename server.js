const path = require("node:path");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
require("dotenv").config({
  path: [
    path.join(__dirname, ".env"),
    process.env.MONGODB_CREDENTIALS_FILE || path.join(process.env.USERPROFILE || "", "Downloads", "atlas-credentials.env")
  ]
});
const express = require("express");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const { MongoClient } = require("mongodb");
const nodemailer = require("nodemailer");

const app = express();
const port = Number(process.env.PORT) || 3000;
const emailTo = "aihuishoulimited@gmail.com";
const sessions = new Map();
const scrypt = promisify(crypto.scrypt);
const mongoClient = process.env.MONGODB_URI ? new MongoClient(process.env.MONGODB_URI) : null;
const database = mongoClient?.db(process.env.MONGODB_DB || "aihuishou");
const accountsCollection = database?.collection("agent_accounts");
const pickupRequestsCollection = database?.collection("pickup_requests");
const adminEmail = normalizeConfiguredEmail(process.env.ADMIN_EMAIL);
let databaseReady;

function normalizeConfiguredEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
  console.warn("SMTP_HOST, SMTP_USER and SMTP_PASS must be set before applications can be sent.");
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
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "32kb" }));
app.use("/data", (req, res) => res.status(404).end());
app.use(express.static(path.join(__dirname)));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false });
const requestLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false });

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.use("/api", async (req, res, next) => {
  try {
    await ensureDatabase();
    return next();
  } catch (error) {
    console.error("Database connection failed:", error.message);
    return res.status(503).json({ error: "Database is temporarily unavailable." });
  }
});

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

function readCookie(req, name) {
  const cookies = req.headers.cookie || "";
  const prefix = `${name}=`;
  const value = cookies.split(";").map((item) => item.trim()).find((item) => item.startsWith(prefix));
  return value ? decodeURIComponent(value.slice(prefix.length)) : null;
}

function withoutMongoId(document) {
  if (!document) return document;
  const { _id, ...value } = document;
  return value;
}

async function readAccounts() {
  if (!accountsCollection) throw new Error("MONGODB_URI is not configured.");
  return (await accountsCollection.find({}).toArray()).map(withoutMongoId);
}

async function saveAccounts(accounts) {
  if (!accountsCollection) throw new Error("MONGODB_URI is not configured.");
  await accountsCollection.deleteMany({});
  if (accounts.length) await accountsCollection.insertMany(accounts);
}

async function readPickupRequests() {
  if (!pickupRequestsCollection) throw new Error("MONGODB_URI is not configured.");
  return (await pickupRequestsCollection.find({}).toArray()).map(withoutMongoId);
}

async function savePickupRequests(requests) {
  if (!pickupRequestsCollection) throw new Error("MONGODB_URI is not configured.");
  await pickupRequestsCollection.deleteMany({});
  if (requests.length) await pickupRequestsCollection.insertMany(requests);
}

async function migrateJsonData() {
  if (!database) throw new Error("MONGODB_URI is not configured.");
  const migrationCollection = database.collection("migrations");
  if (await migrationCollection.findOne({ name: "json-to-mongodb-v1" })) return;

  const files = [
    { file: path.join(__dirname, "data", "agent-accounts.json"), collection: accountsCollection },
    { file: path.join(__dirname, "data", "pickup-requests.json"), collection: pickupRequestsCollection }
  ];
  for (const item of files) {
    try {
      const records = JSON.parse(await fs.readFile(item.file, "utf8"));
      if (Array.isArray(records) && records.length && await item.collection.countDocuments() === 0) {
        await item.collection.insertMany(records);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  await migrationCollection.insertOne({ name: "json-to-mongodb-v1", migratedAt: new Date() });
}

async function ensureDatabase() {
  if (!mongoClient) throw new Error("MONGODB_URI is required.");
  if (!databaseReady) {
    databaseReady = (async () => {
      await mongoClient.connect();
      await database.command({ ping: 1 });
      await migrateJsonData();
    })().catch((error) => {
      databaseReady = undefined;
      throw error;
    });
  }
  return databaseReady;
}

function createSession(res, account) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { email: account.email, expiresAt: Date.now() + 1000 * 60 * 60 * 12 });
  res.cookie("agent_session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 12,
    path: "/"
  });
}

function createFieldEmployeeSession(res, account) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { email: account.email, role: "fieldEmployee", expiresAt: Date.now() + 1000 * 60 * 60 * 12 });
  res.cookie("field_employee_session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 12,
    path: "/"
  });
}

function createAdminSession(res) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { admin: true, expiresAt: Date.now() + 1000 * 60 * 60 * 12 });
  res.cookie("admin_session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 12,
    path: "/"
  });
}

function requireAdmin(req, res, next) {
  const token = readCookie(req, "admin_session");
  const session = token && sessions.get(token);
  if (!session?.admin || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return res.status(401).json({ error: "Please sign in as an administrator." });
  }
  return next();
}

async function getCurrentAgent(req) {
  const token = readCookie(req, "agent_session");
  const session = token && sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }

  const accounts = await readAccounts();
  return accounts.find((account) => account.email === session.email) || null;
}

async function requireAgent(req, res, next) {
  try {
    const account = await getCurrentAgent(req);
    if (!account) return res.status(401).json({ error: "Please sign in to access the agent dashboard." });
    req.agent = account;
    return next();
  } catch (error) {
    console.error("Agent session check failed:", error.message);
    return res.status(500).json({ error: "Unable to verify your session. Please try again." });
  }
}

async function getCurrentFieldEmployee(req) {
  const token = readCookie(req, "field_employee_session");
  const session = token && sessions.get(token);
  if (!session || session.role !== "fieldEmployee" || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }

  const accounts = await readAccounts();
  return accounts.find((account) => account.email === session.email) || null;
}

async function requireFieldEmployee(req, res, next) {
  try {
    const account = await getCurrentFieldEmployee(req);
    if (!account) return res.status(401).json({ error: "Please sign in as a field employee." });
    req.agent = account;
    return next();
  } catch (error) {
    console.error("Field employee session check failed:", error.message);
    return res.status(500).json({ error: "Unable to verify your session. Please try again." });
  }
}

async function requirePickupUser(req, res, next) {
  try {
    const agent = await getCurrentAgent(req);
    if (agent) {
      req.agent = agent;
      req.requestUserType = "agent";
      return next();
    }
    const fieldEmployee = await getCurrentFieldEmployee(req);
    if (fieldEmployee) {
      req.agent = fieldEmployee;
      req.requestUserType = "fieldEmployee";
      return next();
    }
    return res.status(401).json({ error: "Please sign in to submit pickup requests." });
  } catch (error) {
    console.error("Pickup session check failed:", error.message);
    return res.status(500).json({ error: "Unable to verify your session. Please try again." });
  }
}

app.post("/api/agent-signup", authLimiter, async (req, res) => {
  const { fullName, phone, email, company, location, password } = req.body || {};
  const fields = [fullName, phone, email, location, password];

  if (fields.some((value) => typeof value !== "string" || !value.trim())) {
    return res.status(400).json({ error: "Full name, phone, email, location and password are required." });
  }
  if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
    return res.status(400).json({ error: "Please provide a valid email address." });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }

  try {
    const normalizedEmail = normalizeEmail(email);
    const accounts = await readAccounts();
    if (accounts.some((account) => account.email === normalizedEmail)) {
      return res.status(409).json({ error: "An agent account already exists for this email. Please sign in." });
    }

    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = (await scrypt(password, salt, 64)).toString("hex");
    const account = {
      role: "agent",
      fullName: fullName.trim(),
      phone: phone.trim(),
      email: normalizedEmail,
      company: typeof company === "string" ? company.trim() : "",
      location: location.trim(),
      salt,
      passwordHash,
      createdAt: new Date().toISOString()
    };
    accounts.push(account);
    await saveAccounts(accounts);

    const application = [
      "New Aihuishou agent signup",
      "",
      `Full name: ${account.fullName}`,
      `Phone: ${account.phone}`,
      `Email: ${account.email}`,
      `Business/Company: ${account.company || "Not provided"}`,
      `Location: ${account.location}`
    ].join("\n");

    try {
      await transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: emailTo,
        replyTo: account.email,
        subject: `New agent signup: ${account.fullName}`,
        text: application
      });
    } catch (mailError) {
      console.error("Agent signup email failed:", mailError.message);
    }

    createSession(res, account);
    return res.status(201).json({
      message: "Account created.",
      agent: { fullName: account.fullName, phone: account.phone, email: account.email }
    });
  } catch (error) {
    console.error("Agent signup failed:", error.message);
    return res.status(500).json({ error: "Unable to create your agent account. Please try again." });
  }
});

app.post("/api/agent-login", authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== "string" || typeof password !== "string" || !email.trim() || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  try {
    const account = (await readAccounts()).find((item) => item.email === normalizeEmail(email) && item.role !== "fieldEmployee");
    if (!account) return res.status(401).json({ error: "Email or password is incorrect." });

    const enteredHash = await scrypt(password, account.salt, 64);
    const savedHash = Buffer.from(account.passwordHash, "hex");
    if (savedHash.length !== enteredHash.length || !crypto.timingSafeEqual(savedHash, enteredHash)) {
      return res.status(401).json({ error: "Email or password is incorrect." });
    }

    createSession(res, account);
    return res.json({ agent: { fullName: account.fullName, phone: account.phone, email: account.email } });
  } catch (error) {
    console.error("Agent login failed:", error.message);
    return res.status(500).json({ error: "Unable to sign in. Please try again." });
  }
});

app.get("/api/agent-session", requireAgent, (req, res) => {
  res.json({ agent: { fullName: req.agent.fullName, phone: req.agent.phone, email: req.agent.email } });
});

app.post("/api/agent-logout", (req, res) => {
  const token = readCookie(req, "agent_session");
  if (token) sessions.delete(token);
  res.clearCookie("agent_session", { path: "/" });
  res.status(204).end();
});

app.post("/api/field-employee-login", authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== "string" || typeof password !== "string" || !email.trim() || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  try {
    const account = (await readAccounts()).find((item) => item.email === normalizeEmail(email) && item.role === "fieldEmployee");
    if (!account) return res.status(401).json({ error: "Email or password is incorrect." });
    const enteredHash = await scrypt(password, account.salt, 64);
    const savedHash = Buffer.from(account.passwordHash, "hex");
    if (savedHash.length !== enteredHash.length || !crypto.timingSafeEqual(savedHash, enteredHash)) {
      return res.status(401).json({ error: "Email or password is incorrect." });
    }
    createFieldEmployeeSession(res, account);
    return res.json({ employee: { fullName: account.fullName, phone: account.phone, email: account.email } });
  } catch (error) {
    console.error("Field employee login failed:", error.message);
    return res.status(500).json({ error: "Unable to sign in. Please try again." });
  }
});

app.post("/api/field-employee-signup", authLimiter, async (req, res) => {
  const { fullName, phone, email, password } = req.body || {};
  const fields = [fullName, phone, email, password];
  if (fields.some((value) => typeof value !== "string" || !value.trim())) {
    return res.status(400).json({ error: "Full name, phone, email and password are required." });
  }
  if (!/^\S+@\S+\.\S+$/.test(email.trim())) return res.status(400).json({ error: "Please provide a valid email address." });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });

  try {
    const normalizedEmail = normalizeEmail(email);
    const accounts = await readAccounts();
    if (accounts.some((account) => account.email === normalizedEmail)) return res.status(409).json({ error: "An account already exists for this email. Please sign in." });
    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = (await scrypt(password, salt, 64)).toString("hex");
    const account = { role: "fieldEmployee", fullName: fullName.trim(), phone: phone.trim(), email: normalizedEmail, company: "", location: "", salt, passwordHash, createdAt: new Date().toISOString() };
    accounts.push(account);
    await saveAccounts(accounts);
    try {
      await transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: emailTo, replyTo: account.email, subject: `New field employee signup: ${account.fullName}`, text: `New Aihuishou field employee signup\n\nFull name: ${account.fullName}\nPhone: ${account.phone}\nEmail: ${account.email}` });
    } catch (mailError) { console.error("Field employee signup email failed:", mailError.message); }
    createFieldEmployeeSession(res, account);
    return res.status(201).json({ employee: { fullName: account.fullName, phone: account.phone, email: account.email } });
  } catch (error) {
    console.error("Field employee signup failed:", error.message);
    return res.status(500).json({ error: "Unable to create your field employee account. Please try again." });
  }
});

app.get("/api/field-employee-session", requireFieldEmployee, (req, res) => {
  res.json({ employee: { fullName: req.agent.fullName, phone: req.agent.phone, email: req.agent.email } });
});

app.post("/api/field-employee-logout", (req, res) => {
  const token = readCookie(req, "field_employee_session");
  if (token) sessions.delete(token);
  res.clearCookie("field_employee_session", { path: "/" });
  res.status(204).end();
});

app.post("/api/admin-login", authLimiter, (req, res) => {
  const { email, password } = req.body || {};
  if (!adminEmail || !process.env.ADMIN_PASSWORD) {
    return res.status(503).json({ error: "Admin access has not been configured." });
  }
  if (normalizeConfiguredEmail(email) !== adminEmail || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Email or password is incorrect." });
  }
  createAdminSession(res);
  return res.json({ message: "Admin signed in." });
});

app.get("/api/admin-session", requireAdmin, (req, res) => {
  res.json({ admin: true });
});

app.post("/api/admin-logout", (req, res) => {
  const token = readCookie(req, "admin_session");
  if (token) sessions.delete(token);
  res.clearCookie("admin_session", { path: "/" });
  res.status(204).end();
});

app.post("/api/agent-applications", async (req, res) => {
  const { fullName, phone, email, company, location } = req.body || {};
  const fields = [fullName, phone, email, location];

  if (fields.some((value) => typeof value !== "string" || !value.trim())) {
    return res.status(400).json({ error: "Full name, phone, email and location are required." });
  }

  if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
    return res.status(400).json({ error: "Please provide a valid email address." });
  }

  const application = [
    "New Aihuishou agent application",
    "",
    `Full name: ${fullName.trim()}`,
    `Phone: ${phone.trim()}`,
    `Email: ${email.trim()}`,
    `Business/Company: ${company?.trim() || "Not provided"}`,
    `Location: ${location.trim()}`
  ].join("\n");

  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: emailTo,
      replyTo: email.trim(),
      subject: `Agent application: ${fullName.trim()}`,
      text: application
    });

    return res.status(201).json({ message: "Application received." });
  } catch (error) {
    console.error("Agent application email failed:", error.message);
    return res.status(500).json({ error: "We could not send your application. Please try again later." });
  }
});

app.get("/api/pickup-requests", requirePickupUser, async (req, res) => {
  try {
    const requests = await readPickupRequests();
    const agentRequests = requests
      .filter((request) => request.agentEmail === req.agent.email)
      .sort((first, second) => new Date(second.createdAt) - new Date(first.createdAt))
      .map(({ agentEmail, ...request }) => request);
    return res.json({ requests: agentRequests });
  } catch (error) {
    console.error("Pickup history lookup failed:", error.message);
    return res.status(500).json({ error: "Unable to load pickup history. Please try again." });
  }
});

app.get("/api/admin/pickup-requests", requireAdmin, async (req, res) => {
  try {
    const requests = await readPickupRequests();
    const accounts = await readAccounts();
    const accountByEmail = new Map(accounts.map((account) => [account.email, account]));
    const adminRequests = requests
      .sort((first, second) => new Date(second.createdAt) - new Date(first.createdAt))
      .map((request) => {
        const agent = accountByEmail.get(request.agentEmail);
        return {
          ...request,
          agent: agent ? { fullName: agent.fullName, phone: agent.phone, email: agent.email, company: agent.company, location: agent.location } : null
        };
      });
    return res.json({ requests: adminRequests });
  } catch (error) {
    console.error("Admin pickup history lookup failed:", error.message);
    return res.status(500).json({ error: "Unable to load pickup requests." });
  }
});

app.post("/api/pickup-requests", requestLimiter, requirePickupUser, async (req, res) => {
  const { requestType = "agent", goods, preferredTime, location, notes } = req.body || {};
  const isFieldEmployee = requestType === "fieldEmployee";
  const validGoods = Array.isArray(goods) && goods.length > 0 && goods.every((item) => (
    item && typeof item.name === "string" && item.name.trim() &&
    (typeof item.quantity === "number" || typeof item.quantity === "string") &&
    String(item.quantity).trim() && Number(item.quantity) >= 1
  ));
  const fields = isFieldEmployee ? [preferredTime] : [preferredTime, location];

  if (requestType !== req.requestUserType || !validGoods || fields.some((value) => typeof value !== "string" || !value.trim())) {
    return res.status(400).json({ error: "Please add at least one good with a valid quantity and complete the request details." });
  }

  const cleanedGoods = goods.map((item) => ({ name: item.name.trim(), quantity: Number(item.quantity) }));
  const goodsText = cleanedGoods.map((item) => `${item.name}: ${item.quantity}`).join(", ");

  const pickupRequest = [
    "New agent pickup request",
    "",
    `Agent: ${req.agent.fullName}`,
    `Phone: ${req.agent.phone}`,
    `Goods: ${goodsText}`,
    `Preferred pickup time: ${preferredTime.trim()}`,
    `Pickup location: ${isFieldEmployee ? "Not provided (field employee)" : location.trim()}`,
    `Collection notes: ${typeof notes === "string" && notes.trim() ? notes.trim() : "None"}`
  ].join("\n");

  const savedRequest = {
    id: crypto.randomUUID(),
    agentEmail: req.agent.email,
    requestType,
    goods: cleanedGoods,
    preferredTime: preferredTime.trim(),
    location: isFieldEmployee ? "" : location.trim(),
    notes: typeof notes === "string" ? notes.trim() : "",
    status: "Pending approval",
    createdAt: new Date().toISOString()
  };

  try {
    const requests = await readPickupRequests();
    requests.push(savedRequest);
    await savePickupRequests(requests);
  } catch (error) {
    console.error("Pickup request storage failed:", error.message);
    return res.status(500).json({ error: "We could not save your pickup request. Please try again later." });
  }

  let emailSent = true;
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: emailTo,
      replyTo: req.agent.email,
      subject: `${isFieldEmployee ? "Field report" : "Pickup request"}: ${cleanedGoods.map((item) => item.name).join(", ")} — ${req.agent.fullName}`,
      text: pickupRequest
    });

  } catch (error) {
    emailSent = false;
    console.error("Pickup request email failed; request remains available in admin dashboard:", error.message);
  }

  const { agentEmail, ...responseRequest } = savedRequest;
  return res.status(201).json({ message: "Pickup request received.", emailSent, request: responseRequest });
});

app.post("/api/admin/pickup-requests/:id/approve", requireAdmin, async (req, res) => {
  try {
    const requests = await readPickupRequests();
    const request = requests.find((item) => item.id === req.params.id);
    if (!request) return res.status(404).json({ error: "Pickup request not found." });

    if (request.status !== "Approved") {
      request.status = "Approved";
      request.approvedAt = new Date().toISOString();
      await savePickupRequests(requests);
    }

    return res.json({ message: "Pickup request approved.", request });
  } catch (error) {
    console.error("Pickup request approval failed:", error.message);
    return res.status(500).json({ error: "Unable to approve pickup request." });
  }
});

app.use("/api", (req, res) => {
  res.status(404).json({ error: "API endpoint not found." });
});

async function initializeDatabase() {
  if (!mongoClient) {
    throw new Error("MONGODB_URI is required to start the application.");
  }

  await mongoClient.connect();
  await database.command({ ping: 1 });

  await migrateJsonData();

  console.log("MongoDB connected successfully.");
}

// Initialize the database when the serverless function starts
const startupPromise = initializeDatabase().catch((error) => {
  console.error("Server startup failed:", error.message);
  throw error;
});

// Wait for database initialization before handling requests
app.use(async (req, res, next) => {
  try {
    await startupPromise;
    next();
  } catch (error) {
    next(error);
  }
});

// Export Express app for Vercel
module.exports = app;