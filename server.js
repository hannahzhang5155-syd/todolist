import { createServer } from "node:http";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, timingSafeEqual } from "node:crypto";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
await loadEnvironmentFile();

const PORT = Number(process.env.PORT || 4173);
const DATA_DIR = resolve(process.env.DATA_DIR || join(ROOT, "data"));
const DATA_FILE = join(DATA_DIR, "state.json");
const TIME_ZONE = process.env.TIME_ZONE || "Australia/Sydney";
const RECIPIENT_EMAIL = process.env.RECIPIENT_EMAIL || "hannahzhang5155@gmail.com";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const EMAIL_FROM = process.env.EMAIL_FROM || "明日清单 <onboarding@resend.dev>";
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const APP_TOKEN = process.env.APP_TOKEN || "";
const ENABLE_SCHEDULER = process.env.ENABLE_SCHEDULER !== "false";

const DEFAULT_STATE = {
  tasks: {},
  settings: {
    eveningTime: "22:00",
    morningTime: "07:30",
  },
  emailLog: {},
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
};

let state = structuredClone(DEFAULT_STATE);
let writeQueue = Promise.resolve();
let schedulerBusy = false;

await loadState();

async function loadEnvironmentFile() {
  try {
    const contents = await readFile(join(ROOT, ".env"), "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator === -1) continue;
      const key = trimmed.slice(0, separator).trim();
      let value = trimmed.slice(separator + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Unable to load .env:", error);
  }
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isAuthorized(request) {
  if (!APP_TOKEN) return true;
  const authorization = request.headers.authorization || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  return safeEqual(token, APP_TOKEN);
}

async function loadState() {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    const stored = JSON.parse(await readFile(DATA_FILE, "utf8"));
    state = {
      ...structuredClone(DEFAULT_STATE),
      ...stored,
      settings: { ...DEFAULT_STATE.settings, ...stored.settings },
      tasks: stored.tasks || {},
      emailLog: stored.emailLog || {},
    };
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Unable to read state:", error);
    await persistState();
  }
}

function persistState() {
  writeQueue = writeQueue
    .then(() => writeFile(DATA_FILE, `${JSON.stringify(state, null, 2)}\n`))
    .catch((error) => console.error("Unable to save state:", error));
  return writeQueue;
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("Request body is too large");
  }
  return JSON.parse(body || "{}");
}

function sanitizeTasks(tasks) {
  if (!tasks || typeof tasks !== "object" || Array.isArray(tasks)) return {};
  return Object.fromEntries(
    Object.entries(tasks)
      .filter(([key, value]) => /^\d{4}-\d{2}-\d{2}$/.test(key) && Array.isArray(value))
      .map(([key, value]) => [
        key,
        value.slice(0, 100).map((task) => ({
          id: String(task.id || randomUUID()),
          text: String(task.text || "").trim().slice(0, 120),
          completed: Boolean(task.completed),
        })).filter((task) => task.text),
      ]),
  );
}

function sanitizeTime(value, fallback) {
  return /^\d{2}:\d{2}$/.test(value || "") ? value : fallback;
}

function zonedParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const result = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${result.year}-${result.month}-${result.day}`,
    time: `${result.hour}:${result.minute}`,
  };
}

function tomorrowDateKey() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const now = new Date();
  for (let hours = 20; hours <= 30; hours += 2) {
    const candidate = new Date(now.getTime() + hours * 60 * 60 * 1000);
    const key = formatter.format(candidate);
    if (key !== zonedParts(now).date) return key;
  }
  throw new Error("Unable to calculate tomorrow");
}

function appLink(view = "tomorrow") {
  const url = new URL(APP_URL);
  url.searchParams.set("view", view);
  if (APP_TOKEN) url.searchParams.set("token", APP_TOKEN);
  return url.toString();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function emailLayout({ eyebrow, title, content, buttonLabel, buttonUrl }) {
  return `<!doctype html>
<html lang="zh-CN">
  <body style="margin:0;background:#f5f1e8;color:#1d2926;font-family:Arial,'PingFang SC',sans-serif">
    <div style="max-width:600px;margin:0 auto;padding:42px 18px">
      <div style="background:#fffdf8;border:1px solid #e1dacc;border-radius:18px;padding:34px">
        <div style="color:#d6674e;font-size:12px;font-weight:700;letter-spacing:2px">${eyebrow}</div>
        <h1 style="margin:14px 0 20px;font-family:Georgia,'Songti SC',serif;font-size:30px;line-height:1.35">${title}</h1>
        ${content}
        <a href="${escapeHtml(buttonUrl)}" style="display:inline-block;margin-top:26px;padding:13px 20px;border-radius:10px;background:#285e50;color:#fff;text-decoration:none;font-weight:700">${buttonLabel}</a>
      </div>
      <p style="margin:16px 0 0;color:#7b837e;font-size:12px;text-align:center">明日清单 · ${escapeHtml(TIME_ZONE)}</p>
    </div>
  </body>
</html>`;
}

function eveningEmail() {
  return {
    subject: "今晚 10 点：明天想完成什么？",
    html: emailLayout({
      eyebrow: "晚间整理",
      title: "花一分钟，把明天轻轻安排好。",
      content:
        '<p style="margin:0;color:#65706b;font-size:16px;line-height:1.75">写下明天最重要的几件事。早上 7:30，我会把完整清单发回给你。</p>',
      buttonLabel: "填写明日待办",
      buttonUrl: appLink("tomorrow"),
    }),
  };
}

function morningEmail(dateKey) {
  const tasks = (state.tasks[dateKey] || []).filter((task) => !task.completed);
  const content = tasks.length
    ? `<ol style="margin:0;padding-left:24px;color:#1d2926;font-size:16px;line-height:1.8">${tasks
        .map((task) => `<li style="padding:5px 0">${escapeHtml(task.text)}</li>`)
        .join("")}</ol>`
    : '<p style="margin:0;color:#65706b;font-size:16px;line-height:1.75">今天还没有安排。可以留白，也可以现在添加一件最重要的事。</p>';

  return {
    subject: tasks.length ? `今日 To-do List：${tasks.length} 件事` : "今日 To-do List：今天还没有安排",
    html: emailLayout({
      eyebrow: "晨间清单",
      title: "早上好，这是你今天的清单。",
      content,
      buttonLabel: tasks.length ? "打开并完成清单" : "安排今天",
      buttonUrl: appLink("today"),
    }),
  };
}

async function sendEmail(message) {
  if (!RESEND_API_KEY) {
    console.log(`[email preview] To: ${RECIPIENT_EMAIL} | ${message.subject}`);
    return { preview: true };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [RECIPIENT_EMAIL],
      subject: message.subject,
      html: message.html,
    }),
  });

  const result = await response.json();
  if (!response.ok) throw new Error(`Resend error ${response.status}: ${JSON.stringify(result)}`);
  return result;
}

async function runScheduler(now = new Date()) {
  if (schedulerBusy) return;
  schedulerBusy = true;
  try {
    const local = zonedParts(now);
    const events = [
      {
        type: "evening",
        time: state.settings.eveningTime,
        message: () => eveningEmail(),
      },
      {
        type: "morning",
        time: state.settings.morningTime,
        message: () => morningEmail(local.date),
      },
    ];

    for (const event of events) {
      const logKey = `${event.type}:${local.date}`;
      const [currentHours, currentMinutes] = local.time.split(":").map(Number);
      const [eventHours, eventMinutes] = event.time.split(":").map(Number);
      const currentTotal = currentHours * 60 + currentMinutes;
      const eventTotal = eventHours * 60 + eventMinutes;
      const isDue = currentTotal >= eventTotal && currentTotal < eventTotal + 15;
      if (isDue && !state.emailLog[logKey]) {
        const result = await sendEmail(event.message());
        state.emailLog[logKey] = {
          sentAt: now.toISOString(),
          id: result.id || "preview",
        };
        await persistState();
        console.log(`Sent ${event.type} email to ${RECIPIENT_EMAIL}`);
      }
    }
  } catch (error) {
    console.error("Scheduler error:", error);
  } finally {
    schedulerBusy = false;
  }
}

async function serveStatic(request, response, pathname) {
  const requestedPath = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = resolve(ROOT, requestedPath);
  if (!filePath.startsWith(ROOT) || filePath.startsWith(DATA_DIR)) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw Object.assign(new Error("Not a file"), { code: "ENOENT" });
    const content = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[extname(filePath)] || "application/octet-stream",
      "Cache-Control": extname(filePath) === ".html" ? "no-cache" : "public, max-age=300",
    });
    response.end(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendJson(response, 404, { error: "Not found" });
      return;
    }
    throw error;
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, APP_URL);

    if (url.pathname === "/api/health") {
      sendJson(response, 200, {
        ok: true,
        timeZone: TIME_ZONE,
        emailConfigured: Boolean(RESEND_API_KEY),
      });
      return;
    }

    if (url.pathname === "/api/state") {
      if (!isAuthorized(request)) {
        sendJson(response, 401, { error: "Unauthorized" });
        return;
      }

      if (request.method === "GET") {
        sendJson(response, 200, {
          tasks: state.tasks,
          settings: state.settings,
          recipient: RECIPIENT_EMAIL.replace(/^(.{2}).*(@.*)$/, "$1••••$2"),
          timeZone: TIME_ZONE,
        });
        return;
      }

      if (request.method === "PUT") {
        const input = await readJson(request);
        state.tasks = sanitizeTasks(input.tasks);
        state.settings = {
          eveningTime: sanitizeTime(input.settings?.eveningTime, state.settings.eveningTime),
          morningTime: sanitizeTime(input.settings?.morningTime, state.settings.morningTime),
        };
        await persistState();
        sendJson(response, 200, { ok: true });
        return;
      }
    }

    if (url.pathname === "/api/test-email" && request.method === "POST") {
      if (!isAuthorized(request)) {
        sendJson(response, 401, { error: "Unauthorized" });
        return;
      }
      const input = await readJson(request);
      const type = input.type === "morning" ? "morning" : "evening";
      const result = await sendEmail(
        type === "morning" ? morningEmail(zonedParts().date) : eveningEmail(),
      );
      sendJson(response, 200, { ok: true, preview: Boolean(result.preview), id: result.id });
      return;
    }

    if (request.method === "GET" || request.method === "HEAD") {
      await serveStatic(request, response, url.pathname);
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: "Internal server error" });
  }
});

if (process.env.ENABLE_LISTEN !== "false") {
  server.listen(PORT, () => {
    console.log(`Tomorrow List is running at ${APP_URL}`);
    console.log(`Email recipient: ${RECIPIENT_EMAIL}`);
    console.log(
      `Schedule: ${state.settings.eveningTime} and ${state.settings.morningTime} (${TIME_ZONE})`,
    );
    if (!RESEND_API_KEY) {
      console.log("RESEND_API_KEY is missing; email sends will run in preview mode.");
    }
    if (!APP_TOKEN) console.log("APP_TOKEN is missing; API access is not protected.");
  });
}

if (ENABLE_SCHEDULER) {
  runScheduler();
  setInterval(runScheduler, 30_000);
}

export { runScheduler, zonedParts, eveningEmail, morningEmail, sanitizeTasks, sanitizeTime };
