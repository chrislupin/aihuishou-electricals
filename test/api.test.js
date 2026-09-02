const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const test = require("node:test");

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = "mongodb://test.invalid";
process.env.MONGODB_DB = "aihuishou-test";
process.env.SESSION_SECRET = "test-session-secret";
process.env.ADMIN_EMAIL = "admin@example.com";
process.env.ADMIN_PASSWORD = "admin-password";

const clone = (value) => structuredClone(value);
const matches = (document, query = {}) => Object.entries(query).every(([key, expected]) => {
  const actual = document[key];
  if (expected instanceof RegExp) return expected.test(actual || "");
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if ("$in" in expected) return expected.$in.includes(actual);
    if ("$ne" in expected) return actual !== expected.$ne;
    if ("$regex" in expected) return expected.$regex.test(actual || "");
    if ("$type" in expected) return expected.$type === "array" ? Array.isArray(actual) : typeof actual === expected.$type;
    if ("$gt" in expected) return actual > expected.$gt;
  }
  return actual === expected;
});

class Cursor {
  constructor(records, projection) { this.records = records; this.projection = projection; }
  sort(specification) {
    const [[key, direction]] = Object.entries(specification);
    this.records.sort((left, right) => (left[key] > right[key] ? 1 : left[key] < right[key] ? -1 : 0) * direction);
    return this;
  }
  async toArray() {
    return this.records.map((record) => {
      const result = clone(record);
      const projection = this.projection?.projection || this.projection;
      if (projection) Object.entries(projection).filter(([, value]) => value === 0).forEach(([key]) => delete result[key]);
      return result;
    });
  }
}

class Collection {
  constructor() { this.records = []; }
  find(query = {}, options = {}) { return new Cursor(this.records.filter((record) => matches(record, query)), options); }
  async findOne(query = {}) { const record = this.records.find((item) => matches(item, query)); return record ? clone(record) : null; }
  async insertOne(record) { this.records.push(clone(record)); return { insertedId: record.id || crypto.randomUUID() }; }
  async insertMany(records) { records.forEach((record) => this.records.push(clone(record))); return { insertedCount: records.length }; }
  async countDocuments(query = {}) { return this.records.filter((record) => matches(record, query)).length; }
  async createIndex() { return "index"; }
  aggregate() { return new Cursor([]); }
  async updateOne(query, update) {
    const record = this.records.find((item) => matches(item, query));
    if (!record) return { matchedCount: 0, modifiedCount: 0 };
    Object.assign(record, clone(update.$set || {}));
    Object.keys(update.$unset || {}).forEach((key) => delete record[key]);
    Object.entries(update.$inc || {}).forEach(([key, value]) => { record[key] = Number(record[key] || 0) + value; });
    Object.entries(update.$push || {}).forEach(([key, value]) => { record[key] = [...(record[key] || []), clone(value)]; });
    return { matchedCount: 1, modifiedCount: 1 };
  }
  async deleteOne(query) { const index = this.records.findIndex((item) => matches(item, query)); if (index < 0) return { deletedCount: 0 }; this.records.splice(index, 1); return { deletedCount: 1 }; }
  async deleteMany(query = {}) { const before = this.records.length; this.records = this.records.filter((item) => !matches(item, query)); return { deletedCount: before - this.records.length }; }
}

const collections = new Map();
const collection = (name) => {
  if (!collections.has(name)) collections.set(name, new Collection());
  return collections.get(name);
};
collection("migrations").records.push({ name: "json-to-mongodb-v1" }, { name: "ticket-revisions-v1" });

const nodemailer = require("nodemailer");
nodemailer.createTransport = () => ({ sendMail: async () => ({ messageId: "test" }) });
const { MongoClient } = require("mongodb");
MongoClient.prototype.connect = async function connect() { return this; };
MongoClient.prototype.db = () => ({ collection, command: async () => ({ ok: 1 }) });

const app = require("../server");
const server = http.createServer(app);

function businessDateKey(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function passwordAccount(email, password, extra = {}) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { email, fullName: email, role: "agent", accessStatus: "active", salt, passwordHash: crypto.scryptSync(password, salt, 64).toString("hex"), ...extra };
}

async function request(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, options);
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : {} };
}

function cookie(response, name) {
  const value = response.headers.get("set-cookie") || "";
  const match = value.match(new RegExp(`${name}=([^;]+)`));
  assert.ok(match, `Expected ${name} cookie`);
  return `${name}=${match[1]}`;
}

async function login(path, email, password, cookieName) {
  const { response } = await request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  assert.equal(response.status, 200);
  return cookie(response, cookieName);
}

test.before(async () => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)));
test.after(async () => new Promise((resolve) => server.close(resolve)));

test("admin approval and rejection update applications", async () => {
  const adminCookie = await login("/api/admin-login", "admin@example.com", "admin-password", "admin_session");
  collection("agent_applications").records.push(
    { id: "approve-me", email: "approve@example.com", fullName: "Approve Me", firstName: "Approve", phone: "1", businessName: "A", location: "Nairobi", status: "Pending" },
    { id: "reject-me", email: "reject@example.com", fullName: "Reject Me", firstName: "Reject", phone: "2", businessName: "B", location: "Nairobi", status: "Pending" }
  );
  let result = await request("/api/admin/agent-applications/approve-me/approve", { method: "POST", headers: { cookie: adminCookie } });
  assert.equal(result.response.status, 200);
  assert.equal((await collection("agent_applications").findOne({ id: "approve-me" })).status, "Approved");
  assert.equal((await collection("agent_accounts").findOne({ email: "approve@example.com" })).accessStatus, "invited");
  result = await request("/api/admin/agent-applications/reject-me/reject", { method: "POST", headers: { cookie: adminCookie } });
  assert.equal(result.response.status, 200);
  assert.equal((await collection("agent_applications").findOne({ id: "reject-me" })).status, "Rejected");
});

test("only the ticket owner can resubmit and the prior version is audited", async () => {
  const owner = passwordAccount("owner@example.com", "owner-password");
  collection("agent_accounts").records.push(owner);
  collection("pickup_requests").records.push({ id: "owner-ticket", agentEmail: owner.email, requestType: "agentTicket", status: "Rejected", goods: [{ name: "LCDs", quantity: 1, amount: 10, totalAmount: 10 }], notes: "old", createdAt: new Date().toISOString() });
  collection("pickup_requests").records.push({ id: "other-ticket", agentEmail: "other@example.com", requestType: "agentTicket", status: "Rejected", goods: [{ name: "LCDs", quantity: 1, amount: 10 }], createdAt: new Date().toISOString() });
  const ownerCookie = await login("/api/agent-login", owner.email, "owner-password", "agent_session");
  const payload = JSON.stringify({ goods: [{ name: "Custom Sensor Board", quantity: 2, amount: 15 }], notes: "corrected" });
  let result = await request("/api/pickup-requests/other-ticket/resubmit", { method: "PUT", headers: { cookie: ownerCookie, "content-type": "application/json" }, body: payload });
  assert.equal(result.response.status, 409);
  result = await request("/api/pickup-requests/owner-ticket/resubmit", { method: "PUT", headers: { cookie: ownerCookie, "content-type": "application/json" }, body: payload });
  assert.equal(result.response.status, 200);
  const resubmitted = await collection("pickup_requests").findOne({ id: "owner-ticket" });
  assert.equal(resubmitted.status, "Pending approval");
  assert.equal(resubmitted.goods[0].name, "Custom Sensor Board");
  assert.equal((await collection("ticket_revisions").findOne({ ticketId: "owner-ticket" })).notes, "old");
});

test("agent and field-employee sessions remain role-specific", async () => {
  const agent = passwordAccount("session-agent@example.com", "agent-password");
  const field = passwordAccount("field@example.com", "field-password", { role: "fieldEmployee", fullName: "Field Employee" });
  collection("agent_accounts").records.push(agent, field);
  const agentCookie = await login("/api/agent-login", agent.email, "agent-password", "agent_session");
  let result = await request("/api/agent-session", { headers: { cookie: agentCookie } });
  assert.equal(result.response.status, 200);
  const fieldCookie = await login("/api/field-employee-login", field.email, "field-password", "field_employee_session");
  result = await request("/api/field-employee-session", { headers: { cookie: fieldCookie } });
  assert.equal(result.response.status, 200);
});

test("admin creates accountant accounts but only accountants can approve tickets and pickup dates", async () => {
  const adminCookie = await login("/api/admin-login", "admin@example.com", "admin-password", "admin_session");
  let result = await request("/api/admin/accounts", {
    method: "POST",
    headers: { cookie: adminCookie, "content-type": "application/json" },
    body: JSON.stringify({ role: "accountant", fullName: "A. Accountant", email: "accountant@example.com", password: "accountant-password" })
  });
  assert.equal(result.response.status, 201);
  const accountantCookie = await login("/api/accountant-login", "accountant@example.com", "accountant-password", "accountant_session");
  result = await request("/api/agent-login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "accountant@example.com", password: "accountant-password" }) });
  assert.equal(result.response.status, 401);
  collection("pickup_requests").records.push({ id: "accountant-ticket", agentEmail: "owner@example.com", requestType: "agentTicket", status: "Pending approval", goods: [{ name: "LCDs", quantity: 1, amount: 10 }], createdAt: new Date().toISOString() });
  result = await request("/api/admin/pickup-requests/accountant-ticket/approve", { method: "POST", headers: { cookie: adminCookie } });
  assert.equal(result.response.status, 401);
  result = await request("/api/admin/pickup-requests/accountant-ticket/approve", { method: "POST", headers: { cookie: accountantCookie } });
  assert.equal(result.response.status, 200);
  assert.equal((await collection("pickup_requests").findOne({ id: "accountant-ticket" })).approvedBy, "accountant@example.com");
  collection("pickup_date_requests").records.push({ id: "accountant-date", agentEmail: "owner@example.com", requestedDate: businessDateKey(), status: "Pending approval", active: true, createdAt: new Date().toISOString() });
  result = await request("/api/admin/pickup-date-requests/accountant-date/approve", { method: "POST", headers: { cookie: accountantCookie } });
  assert.equal(result.response.status, 200);
  assert.equal((await collection("pickup_date_requests").findOne({ id: "accountant-date" })).reviewedBy, "accountant@example.com");
});

test("ticket history keeps older rejected tickets actionable and report filters use Nairobi dates", async () => {
  const agent = passwordAccount("history@example.com", "history-password");
  const today = businessDateKey();
  collection("agent_accounts").records.push(agent);
  collection("pickup_requests").records.push(
    { id: "old-rejected", agentEmail: agent.email, requestType: "agentTicket", status: "Rejected", goods: [{ name: "LCDs", quantity: 1, amount: 1 }], createdAt: "2020-01-01T10:00:00.000Z" },
    { id: "today-ticket", agentEmail: agent.email, requestType: "agentTicket", status: "Approved", goods: [{ name: "LCDs", quantity: 1, amount: 1 }], createdAt: new Date().toISOString() }
  );
  const agentCookie = await login("/api/agent-login", agent.email, "history-password", "agent_session");
  let result = await request("/api/pickup-requests?requestType=agentTicket", { headers: { cookie: agentCookie } });
  assert.deepEqual(result.body.requests.map((item) => item.id), ["today-ticket"]);
  assert.deepEqual(result.body.olderRejectedTickets.map((item) => item.id), ["old-rejected"]);

  const adminCookie = await login("/api/admin-login", "admin@example.com", "admin-password", "admin_session");
  result = await request(`/api/admin/pickup-requests?reportType=tickets&status=Approved&range=daily&from=${today}&to=${today}&person=${encodeURIComponent(agent.email)}`, { headers: { cookie: adminCookie } });
  assert.deepEqual(result.body.requests.map((item) => item.id), ["today-ticket"]);
});
