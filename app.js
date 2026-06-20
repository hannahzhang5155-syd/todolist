const STORAGE_KEY = "tomorrow-list:v1";
const BACKUP_KEY = "tomorrow-list:backup";
const TOKEN_KEY = "tomorrow-list:access-token";
const DEFAULT_STATE = {
  tasks: {},
  settings: {
    eveningTime: "22:00",
    morningTime: "07:30",
  },
  notificationLog: {},
};

const state = loadState();
const initialUrl = new URL(window.location.href);
const urlToken = initialUrl.searchParams.get("token");
if (urlToken) {
  localStorage.setItem(TOKEN_KEY, urlToken);
  initialUrl.searchParams.delete("token");
  history.replaceState({}, "", `${initialUrl.pathname}${initialUrl.search}${initialUrl.hash}`);
}
const accessToken = localStorage.getItem(TOKEN_KEY) || "";
let activeView = initialUrl.searchParams.get("view") === "today" ? "today" : "tomorrow";
let deferredInstallPrompt = null;
let toastTimer = null;
let reminderTimer = null;
let syncTimer = null;
let cloudReady = false;

const elements = {
  currentDate: document.querySelector("#currentDate"),
  todayLabel: document.querySelector("#todayLabel"),
  tomorrowLabel: document.querySelector("#tomorrowLabel"),
  todayTab: document.querySelector("#todayTab"),
  tomorrowTab: document.querySelector("#tomorrowTab"),
  panelKicker: document.querySelector("#panelKicker"),
  panelTitle: document.querySelector("#panelTitle"),
  taskInput: document.querySelector("#taskInput"),
  addForm: document.querySelector("#addForm"),
  taskList: document.querySelector("#taskList"),
  taskTemplate: document.querySelector("#taskTemplate"),
  emptyState: document.querySelector("#emptyState"),
  emptyTitle: document.querySelector("#emptyTitle"),
  emptyCopy: document.querySelector("#emptyCopy"),
  progressRing: document.querySelector("#progressRing"),
  progressText: document.querySelector("#progressText"),
  clearCompletedButton: document.querySelector("#clearCompletedButton"),
  saveStatus: document.querySelector("#saveStatus"),
  settingsButton: document.querySelector("#settingsButton"),
  closeSettingsButton: document.querySelector("#closeSettingsButton"),
  settingsDialog: document.querySelector("#settingsDialog"),
  settingsForm: document.querySelector("#settingsForm"),
  eveningTime: document.querySelector("#eveningTime"),
  morningTime: document.querySelector("#morningTime"),
  eveningTimeDisplay: document.querySelector("#eveningTimeDisplay"),
  morningTimeDisplay: document.querySelector("#morningTimeDisplay"),
  notificationButton: document.querySelector("#notificationButton"),
  notificationStatus: document.querySelector("#notificationStatus"),
  installButton: document.querySelector("#installButton"),
  toast: document.querySelector("#toast"),
};

function loadState() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return {
      ...structuredClone(DEFAULT_STATE),
      ...stored,
      settings: { ...DEFAULT_STATE.settings, ...stored?.settings },
      tasks: stored?.tasks || {},
      notificationLog: stored?.notificationLog || {},
    };
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (cloudReady) scheduleCloudSync();
}

function apiHeaders() {
  return {
    "Content-Type": "application/json",
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };
}

function scheduleCloudSync() {
  clearTimeout(syncTimer);
  elements.saveStatus.textContent = "正在同步…";
  syncTimer = setTimeout(syncCloudState, 450);
}

async function syncCloudState() {
  try {
    const response = await fetch("./api/state", {
      method: "PUT",
      headers: apiHeaders(),
      body: JSON.stringify({ tasks: state.tasks, settings: state.settings }),
    });
    if (!response.ok) throw new Error(`Sync failed: ${response.status}`);
    elements.saveStatus.textContent = "已保存到云端";
  } catch {
    elements.saveStatus.textContent = "已保存在本机，云端暂时不可用";
  }
}

async function loadCloudState() {
  try {
    const response = await fetch("./api/state", { headers: apiHeaders() });
    if (response.status === 401) {
      elements.saveStatus.textContent = "私密链接无效，请使用邮件中的链接";
      return;
    }
    if (!response.ok) throw new Error(`Load failed: ${response.status}`);
    const remote = await response.json();
    const localTasks = state.tasks || {};
    const remoteTasks = remote.tasks || {};
    localStorage.setItem(
      BACKUP_KEY,
      JSON.stringify({ savedAt: new Date().toISOString(), tasks: localTasks }),
    );
    state.tasks = mergeTaskCollections(localTasks, remoteTasks);
    state.settings = { ...DEFAULT_STATE.settings, ...remote.settings };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    elements.notificationStatus.textContent = `${remote.recipient} · ${remote.timeZone}`;
    cloudReady = true;
    elements.saveStatus.textContent = "已连接云端，清单会自动同步";
    if (JSON.stringify(state.tasks) !== JSON.stringify(remoteTasks)) {
      scheduleCloudSync();
    }
    renderSettings();
    render();
  } catch {
    elements.saveStatus.textContent = "离线模式：清单保存在这台设备上";
  }
}

function mergeTaskCollections(localTasks, remoteTasks) {
  const dates = new Set([...Object.keys(localTasks || {}), ...Object.keys(remoteTasks || {})]);
  return Object.fromEntries(
    [...dates].map((date) => {
      const merged = new Map();
      for (const task of remoteTasks?.[date] || []) merged.set(task.id, task);
      for (const task of localTasks?.[date] || []) {
        if (!merged.has(task.id)) merged.set(task.id, task);
      }
      return [date, [...merged.values()]];
    }),
  );
}

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getDateForView(view) {
  const date = new Date();
  if (view === "tomorrow") date.setDate(date.getDate() + 1);
  return date;
}

function formatDate(date, options) {
  return new Intl.DateTimeFormat("zh-CN", options).format(date);
}

function getTasks(view = activeView) {
  return state.tasks[dateKey(getDateForView(view))] || [];
}

function setTasks(tasks, view = activeView) {
  state.tasks[dateKey(getDateForView(view))] = tasks;
  saveState();
}

function uid() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function updateDates() {
  const today = getDateForView("today");
  const tomorrow = getDateForView("tomorrow");
  elements.currentDate.textContent = formatDate(today, {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });
  elements.todayLabel.textContent = formatDate(today, { month: "short", day: "numeric" });
  elements.tomorrowLabel.textContent = formatDate(tomorrow, { month: "short", day: "numeric" });
}

function render() {
  const isToday = activeView === "today";
  const tasks = getTasks();
  const completed = tasks.filter((task) => task.completed).length;

  elements.todayTab.classList.toggle("active", isToday);
  elements.tomorrowTab.classList.toggle("active", !isToday);
  elements.todayTab.setAttribute("aria-selected", String(isToday));
  elements.tomorrowTab.setAttribute("aria-selected", String(!isToday));
  elements.panelKicker.textContent = isToday ? "今日执行" : "明日计划";
  elements.panelTitle.textContent = isToday ? "今天要完成这些事" : "明天想完成什么？";
  elements.taskInput.placeholder = isToday
    ? "临时加一件今天要做的事"
    : "例如：上午完成项目提案";
  elements.emptyTitle.textContent = isToday ? "今天没有安排" : "明天还是一张白纸";
  elements.emptyCopy.textContent = isToday
    ? "可以休息，也可以现在加一件事。"
    : "从一件最重要的事开始。";

  elements.taskList.replaceChildren();
  tasks.forEach((task) => {
    const row = elements.taskTemplate.content.firstElementChild.cloneNode(true);
    const checkbox = row.querySelector("input");
    const taskText = row.querySelector(".task-text");
    const deleteButton = row.querySelector(".delete-button");

    checkbox.checked = task.completed;
    checkbox.setAttribute("aria-label", `标记“${task.text}”为${task.completed ? "未完成" : "已完成"}`);
    taskText.textContent = task.text;

    checkbox.addEventListener("change", () => {
      const nextTasks = getTasks().map((item) =>
        item.id === task.id ? { ...item, completed: checkbox.checked } : item,
      );
      setTasks(nextTasks);
      render();
    });

    deleteButton.addEventListener("click", () => {
      setTasks(getTasks().filter((item) => item.id !== task.id));
      render();
      showToast("已删除");
    });

    elements.taskList.append(row);
  });

  elements.emptyState.hidden = tasks.length > 0;
  elements.progressText.textContent = `${completed}/${tasks.length}`;
  const progress = tasks.length ? Math.round((completed / tasks.length) * 360) : 0;
  elements.progressRing.style.setProperty("--progress", `${progress}deg`);
  elements.progressRing.setAttribute(
    "aria-label",
    tasks.length ? `已完成 ${completed} 项，共 ${tasks.length} 项` : "暂无待办",
  );
  elements.clearCompletedButton.hidden = completed === 0;
}

function switchView(view) {
  activeView = view;
  render();
  elements.taskInput.focus();
}

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 2200);
}

function renderSettings() {
  elements.eveningTime.value = state.settings.eveningTime;
  elements.morningTime.value = state.settings.morningTime;
  elements.eveningTimeDisplay.textContent = state.settings.eveningTime;
  elements.morningTimeDisplay.textContent = state.settings.morningTime;

  elements.notificationButton.disabled = !cloudReady;
}

async function sendTestEmail() {
  elements.notificationButton.disabled = true;
  elements.notificationButton.textContent = "发送中…";
  try {
    const response = await fetch("./api/test-email", {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ type: "evening" }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to send");
    showToast(result.preview ? "邮件服务尚未配置，已生成预览" : "测试邮件已发送");
  } catch {
    showToast("测试邮件发送失败，请检查服务器配置");
  } finally {
    elements.notificationButton.disabled = !cloudReady;
    elements.notificationButton.textContent = "发送测试";
  }
}

function notificationBody(type) {
  if (type === "evening") return "花一分钟写下明天最重要的几件事。";
  const tasks = getTasks("today").filter((task) => !task.completed);
  if (!tasks.length) return "今天还没有待办，打开清单安排一下吧。";
  const summary = tasks
    .slice(0, 3)
    .map((task) => task.text)
    .join(" · ");
  return tasks.length > 3 ? `${summary} 等 ${tasks.length} 件事` : summary;
}

async function sendReminder(type) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const title = type === "evening" ? "明天想完成什么？" : "早上好，这是你今天的清单";
  const body = notificationBody(type);

  try {
    const registration = await navigator.serviceWorker?.ready;
    if (registration) {
      await registration.showNotification(title, {
        body,
        icon: "./icon.svg",
        badge: "./icon.svg",
        tag: `tomorrow-list-${type}`,
      });
    } else {
      new Notification(title, { body, icon: "./icon.svg" });
    }
  } catch {
    new Notification(title, { body, icon: "./icon.svg" });
  }
}

function nextReminder() {
  const now = new Date();
  const reminders = [
    { type: "morning", time: state.settings.morningTime },
    { type: "evening", time: state.settings.eveningTime },
  ].map((reminder) => {
    const [hours, minutes] = reminder.time.split(":").map(Number);
    const at = new Date(now);
    at.setHours(hours, minutes, 0, 0);
    if (at <= now) at.setDate(at.getDate() + 1);
    return { ...reminder, at };
  });

  return reminders.sort((a, b) => a.at - b.at)[0];
}

function scheduleNextReminder() {
  clearTimeout(reminderTimer);
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const reminder = nextReminder();
  const delay = Math.min(reminder.at.getTime() - Date.now(), 2_147_000_000);
  reminderTimer = setTimeout(async () => {
    await sendReminder(reminder.type);
    scheduleNextReminder();
  }, delay);
}

function maybeShowEveningPrompt() {
  const [hours, minutes] = state.settings.eveningTime.split(":").map(Number);
  const now = new Date();
  const promptTime = new Date(now);
  promptTime.setHours(hours, minutes, 0, 0);
  const promptKey = `prompt:${dateKey(now)}`;

  if (
    now >= promptTime &&
    !state.notificationLog[promptKey] &&
    getTasks("tomorrow").length === 0
  ) {
    state.notificationLog[promptKey] = true;
    saveState();
    activeView = "tomorrow";
    render();
    setTimeout(() => {
      elements.taskInput.focus();
      showToast("晚间整理：写下明天要做的事");
    }, 350);
  }
}

elements.todayTab.addEventListener("click", () => switchView("today"));
elements.tomorrowTab.addEventListener("click", () => switchView("tomorrow"));

elements.addForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = elements.taskInput.value.trim();
  if (!text) return;
  setTasks([...getTasks(), { id: uid(), text, completed: false }]);
  elements.taskInput.value = "";
  render();
  showToast(activeView === "today" ? "已加入今天" : "已加入明天");
});

elements.clearCompletedButton.addEventListener("click", () => {
  setTasks(getTasks().filter((task) => !task.completed));
  render();
  showToast("已清除完成事项");
});

elements.settingsButton.addEventListener("click", () => {
  renderSettings();
  elements.settingsDialog.showModal();
});

elements.closeSettingsButton.addEventListener("click", () => {
  elements.settingsDialog.close();
});

elements.settingsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  state.settings.eveningTime = elements.eveningTime.value || DEFAULT_STATE.settings.eveningTime;
  state.settings.morningTime = elements.morningTime.value || DEFAULT_STATE.settings.morningTime;
  saveState();
  renderSettings();
  scheduleNextReminder();
  elements.settingsDialog.close();
  showToast("提醒时间已保存");
});

elements.notificationButton.addEventListener("click", sendTestEmail);

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  elements.installButton.hidden = false;
});

elements.installButton.addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  elements.installButton.hidden = true;
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  elements.installButton.hidden = true;
  showToast("应用已安装");
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js"));
}

updateDates();
renderSettings();
render();
scheduleNextReminder();
maybeShowEveningPrompt();
setInterval(maybeShowEveningPrompt, 60_000);
loadCloudState();
