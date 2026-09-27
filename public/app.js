/* ==========================================================================
   W&M CS Schedule Advisor — app.js
   ==========================================================================
   The student's roadmap (parsed from their own DegreeWorks audit) lives
   only in this browser's localStorage — there is no server-side account or
   session. The server's /api/roadmap/import-degreeworks endpoint parses an
   uploaded PDF and hands the result straight back in its response; saving
   it here is what makes it "local to this computer" rather than a shared
   record. Every /api/chat call sends this same locally-stored roadmap
   along in its request body so the AI can see it, without the server ever
   persisting it between requests.
   ========================================================================== */

const ROADMAP_STORAGE_KEY = "wm-cs-advisor-roadmap";

// Decorative cursor trail across the page; the normal cursor stays visible.
(function cursorFireflies() {
  const layer = document.querySelector(".cursor-fireflies");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const hover = window.matchMedia("(hover: hover)");
  let lastSpawn = -Infinity;

  function clearTrail() {
    layer.replaceChildren();
    lastSpawn = -Infinity;
  }

  document.addEventListener("pointermove", (event) => {
    if (event.pointerType !== "mouse" || reducedMotion.matches || !hover.matches) return;
    const now = performance.now();
    // Limit both emission rate and active particles during rapid movement.
    if (now - lastSpawn < 35 || layer.childElementCount >= 30) return;
    lastSpawn = now;

    const fleck = document.createElement("span");
    fleck.className = "cursor-firefly";
    fleck.style.left = `${event.clientX + (Math.random() - 0.5) * 16}px`;
    fleck.style.top = `${event.clientY + (Math.random() - 0.5) * 16}px`;
    fleck.style.setProperty("--size", `${2 + Math.random() * 3}px`);
    fleck.style.setProperty("--hue", 58 + Math.random() * 28);
    fleck.style.setProperty("--leaf-hue", Math.random() * 32);
    fleck.style.setProperty("--drift-x", `${(Math.random() - 0.5) * 40}px`);
    fleck.style.setProperty("--drift-y", `${-12 - Math.random() * 28}px`);
    fleck.addEventListener("animationend", () => fleck.remove(), { once: true });
    layer.appendChild(fleck);
  }, { passive: true });

  document.documentElement.addEventListener("pointerleave", clearTrail);
  window.addEventListener("blur", clearTrail);
  document.addEventListener("visibilitychange", clearTrail);
  reducedMotion.addEventListener("change", clearTrail);
  hover.addEventListener("change", clearTrail);
})();

/* ==========================================================================
   SECTION 0 — roadmap persistence (localStorage) + onboarding state
   ========================================================================== */
let student = null;
let courses = [];
let requirementTotals = {};

function loadRoadmapFromStorage() {
  try {
    const raw = localStorage.getItem(ROADMAP_STORAGE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    student = data.student;
    courses = data.courses;
    requirementTotals = data.requirementTotals;
    return true;
  } catch (err) {
    console.error("Failed to read saved roadmap from localStorage:", err);
    return false;
  }
}

function saveRoadmapToStorage() {
  try {
    localStorage.setItem(ROADMAP_STORAGE_KEY, JSON.stringify({ student, courses, requirementTotals }));
  } catch (err) {
    console.error("Failed to save roadmap to localStorage:", err);
  }
}

function hasRoadmap() {
  return !!student;
}

/**
 * Toggles the advisor page between the onboarding upload prompt and the
 * normal chat interface, based on whether a roadmap is currently saved.
 * Called on load and again right after a successful upload.
 */
function applyOnboardingState() {
  document.getElementById("advisor-main").classList.toggle("onboarding-mode", !hasRoadmap());
}

/* ==========================================================================
   SECTION 1 — chat
   ========================================================================== */
(function chatModule() {
  const chatEl = document.getElementById("chat");
  const formEl = document.getElementById("chat-form");
  const inputEl = document.getElementById("input");
  const sendBtn = document.getElementById("send-btn");
  const advisorMain = document.getElementById("advisor-main");

  // Full conversation history, sent to the server on every request
  let history = [];

  function markHasChat() {
    advisorMain.classList.add("has-chat");
  }

  function addMessage(role, text) {
    const wrap = document.createElement("div");
    wrap.className = `msg ${role}`;
    wrap.innerHTML = `<span class="bubble"></span>`;
    wrap.querySelector(".bubble").textContent = text;
    chatEl.appendChild(wrap);
    chatEl.scrollTop = chatEl.scrollHeight;
    markHasChat();
  }

  function addSuggestions(suggestions) {
    if (!suggestions || suggestions.length === 0) return;
    const wrap = document.createElement("div");
    wrap.className = "suggestions";
    suggestions.forEach((s) => {
      const btn = document.createElement("button");
      btn.className = "suggestion-btn";
      btn.type = "button";
      btn.textContent = s;
      btn.addEventListener("click", () => sendMessage(s));
      wrap.appendChild(btn);
    });
    chatEl.appendChild(wrap);
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  async function sendMessage(text) {
    if (!text) return;

    addMessage("user", text);
    history.push({ role: "user", text });
    sendBtn.disabled = true;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The roadmap travels with every message since the server keeps no
        // memory of it between requests — see the note at the top of this file.
        body: JSON.stringify({ history, roadmap: hasRoadmap() ? { student, courses, requirementTotals } : null }),
      });
      const data = await res.json();

      if (!res.ok) {
        addMessage("model", "Error: " + JSON.stringify(data.error));
        return;
      }

      addMessage("model", data.reply);
      history.push({ role: "model", text: data.reply });
      addSuggestions(data.suggestions);
    } catch (err) {
      addMessage("model", "Network error — is the server running?");
    } finally {
      sendBtn.disabled = false;
      inputEl.focus();
    }
  }

  formEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = "";
    await sendMessage(text);
  });

  // Quick-action icons feed the same sendMessage pipeline as a normal turn.
  document.querySelectorAll(".quick-action").forEach((btn) => {
    btn.addEventListener("click", () => sendMessage(btn.dataset.prompt));
  });

  // Exposed for the roadmap module's "Ask AI About This" hooks.
  window.__advisorSendMessage = sendMessage;
})();

/* ==========================================================================
   SECTION 2 — theme toggle
   ========================================================================== */
(function themeModule() {
  const root = document.body;
  const toggle = document.getElementById("theme-toggle");
  const stored = localStorage.getItem("wm-theme");
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const initial = stored || (prefersDark ? "dark" : "light");
  root.setAttribute("data-theme", initial);

  toggle.addEventListener("click", () => {
    const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    localStorage.setItem("wm-theme", next);
  });
})();

/* ==========================================================================
   SECTION 3 — tab navigation
   ========================================================================== */
(function navModule() {
  const navButtons = document.querySelectorAll(".nav-item");
  const pages = { advisor: document.getElementById("page-advisor"), roadmap: document.getElementById("page-roadmap") };

  navButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      navButtons.forEach((b) => b.removeAttribute("aria-current"));
      btn.setAttribute("aria-current", "page");
      Object.entries(pages).forEach(([key, el]) => el.classList.toggle("active", key === btn.dataset.page));
    });
  });
})();

/* ==========================================================================
   SECTION 4 — academic snapshot collapse
   ========================================================================== */
(function snapshotModule() {
  const panel = document.getElementById("academic-snapshot");
  const collapseBtn = document.getElementById("snapshot-collapse");
  const reopenBtn = document.getElementById("snapshot-reopen");

  collapseBtn.addEventListener("click", () => {
    panel.classList.add("collapsed");
    reopenBtn.classList.add("visible");
  });
  reopenBtn.addEventListener("click", () => {
    panel.classList.remove("collapsed");
    reopenBtn.classList.remove("visible");
  });
})();

/**
 * Renders the student's name/programs into the bits of static HTML that
 * describe them. Falls back to neutral placeholder text when no roadmap
 * has been uploaded yet, rather than showing stale or fake data.
 */
function renderStudentIdentity() {
  if (!hasRoadmap()) {
    document.getElementById("student-avatar").textContent = "?";
    document.getElementById("student-name-mini").textContent = "No audit uploaded";
    document.getElementById("student-role-mini").textContent = "Upload to get started";
    document.getElementById("advisor-greeting").textContent = "Good afternoon.";
    document.querySelector(".snap-student .name").textContent = "No audit uploaded";
    document.querySelector(".snap-student .role").textContent = "";
    document.querySelector(".snap-student .programs").textContent = "";
    document.getElementById("roadmap-meta").textContent = "Upload your DegreeWorks audit to see your roadmap.";
    return;
  }

  const initials = student.name.split(" ").map((n) => n[0] || "").join("").slice(0, 2).toUpperCase();
  const firstName = student.name.split(" ")[0];
  const programLabel = student.programs.join(" + ");
  const yearLabel = student.gpa ? `${student.year} · GPA ${student.gpa.toFixed(2)}` : student.year;

  document.getElementById("student-avatar").textContent = initials;
  document.getElementById("student-name-mini").textContent = student.name;
  document.getElementById("student-role-mini").textContent = programLabel;
  document.getElementById("advisor-greeting").innerHTML = `Good afternoon, <span class="name-accent">${firstName}</span>.`;
  document.querySelector(".snap-student .name").textContent = student.name;
  document.querySelector(".snap-student .role").textContent = yearLabel;
  document.querySelector(".snap-student .programs").textContent = programLabel;
  document.getElementById("roadmap-meta").textContent = student.graduation
    ? `${programLabel} · Expected Graduation: ${student.graduation}`
    : programLabel;
}

/* ==========================================================================
   SECTION 5 — shared helpers
   ========================================================================== */
const STATUS_ICON = { completed: "i-check-circle", current: "i-dot", planned: "i-circle", unassigned: "i-warning", problem: "i-warning" };
const STATUS_CLASS = { completed: "completed", current: "current", planned: "planned", unassigned: "problem", problem: "problem" };

function statusIconHTML(status) {
  return `<span class="status-icon ${STATUS_CLASS[status] || "planned"}"><svg class="icon" style="width:14px;height:14px"><use href="#${STATUS_ICON[status] || "i-circle"}"/></svg></span>`;
}

function semesterSort(a, b) {
  const order = { Winter: 0, Spring: 1, Summer: 2, Fall: 3 };
  const [sa, ya] = a.split(" ");
  const [sb, yb] = b.split(" ");
  if (ya !== yb) return Number(ya) - Number(yb);
  return order[sa] - order[sb];
}

/**
 * Progress is credit-based, not course-count-based — this matches how
 * DegreeWorks (and W&M's actual degree requirements) speak in credits. A
 * course counts toward its requirement once it's completed or currently in
 * progress — the same definition DegreeWorks itself uses for "Credits
 * applied" (its own disclaimer explicitly includes in-progress and
 * pre-registered credits).
 */
function totalCredits() {
  const earned = courses
    .filter((c) => c.status === "completed" || c.status === "current")
    .reduce((s, c) => s + c.credits, 0);
  return { earned, target: 120 };
}

function overallProgress() {
  const { earned, target } = totalCredits();
  return Math.min(100, Math.round((earned / target) * 100));
}

function requirementProgress(reqName) {
  const need = requirementTotals[reqName] || 1;
  const have = courses
    .filter((c) => c.requirements.includes(reqName) && (c.status === "completed" || c.status === "current"))
    .reduce((s, c) => s + c.credits, 0);
  return { pct: Math.min(100, Math.round((have / need) * 100)), have, need };
}

/**
 * Whether `prereqCode` is satisfied as a prerequisite for a course being
 * placed in `destSemester`: either it's actually completed, or it's
 * scheduled in a semester strictly before the destination (the sequencing
 * works out even if neither course has "happened" yet in real life).
 */
function prereqSatisfied(prereqCode, destSemester) {
  const pc = courses.find((c) => c.code === prereqCode);
  if (!pc) return false;
  if (pc.status === "completed") return true;
  if (!pc.semester || !destSemester) return false; // unassigned prereq can't come "before" anything
  return semesterSort(pc.semester, destSemester) < 0;
}

let editing = false;

/* ==========================================================================
   SECTION 6 — snapshot rendering (advisor page)
   ========================================================================== */
const RING_RADIUS = 52;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function renderSnapshotBars() {
  const el = document.getElementById("snap-bars");
  const names = Object.keys(requirementTotals);
  el.innerHTML = names
    .map((n) => {
      const { pct } = requirementProgress(n);
      return `<div class="bar-row"><span class="bar-name">${n}</span><span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span><span class="bar-pct">${pct}%</span></div>`;
    })
    .join("");

  const overall = overallProgress();
  document.getElementById("snap-overall-pct").textContent = overall + "%";

  const ring = document.getElementById("snap-ring-progress");
  ring.style.strokeDasharray = RING_CIRCUMFERENCE;
  ring.style.strokeDashoffset = RING_CIRCUMFERENCE * (1 - overall / 100);
}

/* ==========================================================================
   SECTION 7 — semester view rendering
   ========================================================================== */
function groupBySemester() {
  const groups = {};
  courses.forEach((c) => {
    if (!c.semester) return;
    (groups[c.semester] = groups[c.semester] || []).push(c);
  });
  return Object.keys(groups).sort(semesterSort).map((sem) => ({ semester: sem, list: groups[sem] }));
}

function courseCardHTML(c) {
  // NOTE: this is a <div role="button">, not a <button>, because it contains
  // its own nested remove <button> — real <button> elements cannot legally
  // contain another <button>; browsers silently split such markup, which
  // used to produce stray empty boxes in edit mode.
  const removable = editing ? `<button type="button" class="remove-course-x" data-remove="${c.code}" aria-label="Remove course">×</button>` : "";
  return `
    <div class="course-card" data-code="${c.code}" role="button" tabindex="0" ${editing && c.status !== "completed" ? 'draggable="true"' : ""}>
      ${removable}
      <div class="cc-top">${statusIconHTML(c.status)}<span class="cc-code">${c.code}</span></div>
      <div class="cc-title">${c.title}</div>
      <span class="tag cc-tag">${c.requirements[0] || "Elective"}</span>
    </div>`;
}

function renderSemesterView() {
  const wrap = document.getElementById("semester-scroll");
  const groups = groupBySemester();
  wrap.className = "semester-scroll" + (editing ? " editing" : "");
  wrap.innerHTML = groups
    .map(
      (g) => `
      <div class="semester-col" data-semester="${g.semester}">
        <div class="semester-col-head"><h3>${g.semester}</h3><span class="credits">${g.list.reduce((s, c) => s + c.credits, 0)} credits</span></div>
        <div class="semester-cards" data-drop="${g.semester}">
          ${g.list.map(courseCardHTML).join("")}
        </div>
      </div>`
    )
    .join("");

  // Degree progress summary
  const overall = overallProgress();
  const { earned, target } = totalCredits();
  document.getElementById("dp-pct").textContent = overall + "%";
  document.getElementById("dp-frac").textContent = `${earned} / ${target} credits`;
  document.getElementById("dp-grad-date").textContent = hasRoadmap() ? (student.graduation || "—") : "—";
  document.getElementById("dp-bars").innerHTML = Object.keys(requirementTotals)
    .map((n) => {
      const { pct } = requirementProgress(n);
      return `<div class="bar-row"><span class="bar-name">${n}</span><span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span><span class="bar-pct">${pct}%</span></div>`;
    })
    .join("");

  const roadmapRing = document.getElementById("roadmap-ring-progress");
  roadmapRing.style.strokeDasharray = RING_CIRCUMFERENCE;
  roadmapRing.style.strokeDashoffset = RING_CIRCUMFERENCE * (1 - overall / 100);

  attachCourseCardHandlers();
  if (editing) attachDragHandlers();
}

/* ==========================================================================
   SECTION 8 — requirement view rendering
   ========================================================================== */
function renderRequirementView() {
  const grid = document.getElementById("requirement-grid");
  const names = Object.keys(requirementTotals);
  grid.innerHTML = names
    .map((n) => {
      const list = courses.filter((c) => c.requirements.includes(n));
      const { pct, have, need } = requirementProgress(n);
      return `
      <div class="requirement-col">
        <div class="requirement-col-head">
          <h3>${n}</h3>
          <div class="req-pct">${pct}% · ${have} / ${need}</div>
        </div>
        <div>${list.map(courseCardHTML).join("")}</div>
      </div>`;
    })
    .join("");
  attachCourseCardHandlers();
}

/* ==========================================================================
   SECTION 9 — view toggle (semester / requirement)
   ========================================================================== */
(function viewToggleModule() {
  const semBtn = document.getElementById("view-semester");
  const reqBtn = document.getElementById("view-requirement");
  const semView = document.getElementById("semester-view");
  const reqView = document.getElementById("requirement-view");

  function setView(v) {
    semBtn.classList.toggle("active", v === "semester");
    reqBtn.classList.toggle("active", v === "requirement");
    semView.style.display = v === "semester" ? "flex" : "none";
    reqView.classList.toggle("active", v === "requirement");
    if (v === "requirement") renderRequirementView();
    else renderSemesterView();
  }
  semBtn.addEventListener("click", () => setView("semester"));
  reqBtn.addEventListener("click", () => setView("requirement"));
  window.__setRoadmapView = setView;
})();

/* ==========================================================================
   SECTION 10 — course details drawer
   ========================================================================== */
function openDrawer(course) {
  if (!course) return;
  const backdrop = document.getElementById("drawer-backdrop");
  const drawer = document.getElementById("course-drawer");
  const content = document.getElementById("drawer-content");

  const prereqRows = course.prerequisites.length
    ? course.prerequisites
        .map((p) => {
          const satisfied = prereqSatisfied(p, course.semester);
          return `<div class="drawer-prereq-row">${statusIconHTML(satisfied ? "completed" : "planned")} ${p}</div>`;
        })
        .join("")
    : `<div class="drawer-prereq-row">None</div>`;

  const missingPrereq = course.prerequisites.find((p) => !prereqSatisfied(p, course.semester));

  content.innerHTML = `
    <h2>${course.code}</h2>
    <div class="drawer-title">${course.title}</div>
    <div class="drawer-credits">${course.credits} credits</div>

    <div class="drawer-section-label">Satisfies</div>
    ${course.requirements.map((r) => `<div class="drawer-req-row">${statusIconHTML("completed")} ${r}</div>`).join("")}

    <div class="drawer-section-label">Prerequisites</div>
    ${prereqRows}

    <div class="drawer-section-label">Planned</div>
    <div class="drawer-planned">${course.semester || "Not scheduled"}</div>

    ${
      missingPrereq && (course.status === "planned" || course.status === "unassigned")
        ? `<div class="drawer-warning"><svg class="icon" style="width:15px;height:15px;flex-shrink:0"><use href="#i-warning"/></svg><span>Missing prerequisite: ${missingPrereq} must be completed before ${course.code}.</span></div>`
        : ""
    }

    <div class="drawer-actions">
      <button class="btn" id="drawer-ask">Ask AI About This</button>
      <button class="btn" id="drawer-move" ${course.status === "completed" ? "disabled" : ""}>Move Course</button>
    </div>
  `;

  content.querySelector("#drawer-ask").addEventListener("click", () => {
    closeDrawer();
    document.querySelector('.nav-item[data-page="advisor"]').click();
    window.__advisorSendMessage(`Tell me more about ${course.code}.`);
  });
  content.querySelector("#drawer-move").addEventListener("click", () => {
    if (!editing) document.getElementById("edit-plan-btn").click();
    closeDrawer();
  });

  backdrop.classList.add("open");
  drawer.classList.add("open");
}

function closeDrawer() {
  document.getElementById("drawer-backdrop").classList.remove("open");
  document.getElementById("course-drawer").classList.remove("open");
}

document.getElementById("drawer-close").addEventListener("click", closeDrawer);
document.getElementById("drawer-backdrop").addEventListener("click", closeDrawer);

function attachCourseCardHandlers() {
  document.querySelectorAll(".course-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest(".remove-course-x")) return; // handled separately
      openDrawer(courses.find((c) => c.code === card.dataset.code));
    });
    // Card is a div[role="button"] (see courseCardHTML), so keyboard
    // activation isn't free the way it is on a real <button> — add it back.
    card.addEventListener("keydown", (e) => {
      if (e.target.closest(".remove-course-x")) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openDrawer(courses.find((c) => c.code === card.dataset.code));
      }
    });
  });
  document.querySelectorAll(".remove-course-x").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const c = courses.find((c) => c.code === btn.dataset.remove);
      if (c) {
        c.semester = "";
        c.status = "unassigned";
        saveRoadmapToStorage();
      }
      renderSemesterView();
    });
  });
}

/* ==========================================================================
   SECTION 11 — DegreeWorks audit upload (shared by onboarding + roadmap page)
   ==========================================================================
   Parsing happens server-side (lib/degreeworksParser.js), but nothing is
   kept there afterward — the parsed roadmap comes back in the response and
   is saved straight to this browser's localStorage. Two entry points (the
   onboarding prompt and the Roadmap page's own button) share this same
   upload/parse/save logic.
   ========================================================================== */

/**
 * Cycles a status message through a short sequence while a promise is
 * in flight, e.g. during the PDF upload/parse round trip. Returns the
 * promise's result; always stops the cycle (even on error).
 */
async function withProgressCycle(el, phrases, workPromise) {
  let i = 0;
  el.textContent = phrases[0];
  el.classList.add("visible");
  const interval = setInterval(() => {
    i = (i + 1) % phrases.length;
    el.textContent = phrases[i];
  }, 1300);

  try {
    return await workPromise;
  } finally {
    clearInterval(interval);
    el.classList.remove("visible");
    el.textContent = "";
  }
}

async function uploadDegreeWorksFile(file) {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch("/api/roadmap/import-degreeworks", { method: "POST", body: formData });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Couldn't import that PDF.");
  return data.roadmap;
}

function applyImportedRoadmap(roadmap) {
  student = roadmap.student;
  courses = roadmap.courses;
  requirementTotals = roadmap.requirementTotals;
  saveRoadmapToStorage();
  editing = false; // fresh import — don't stay in a stale edit session

  applyOnboardingState();
  renderStudentIdentity();
  renderSnapshotBars();
  renderSemesterView();
  if (document.getElementById("requirement-view").classList.contains("active")) renderRequirementView();
}

const PROGRESS_PHRASES = ["Configuring settings…", "Adding your information…", "Analyzing your current degree progress…"];

// --- Onboarding upload button (advisor page, shown only pre-upload) ---
(function onboardingUploadModule() {
  const btn = document.getElementById("onboarding-upload-btn");
  const input = document.getElementById("onboarding-file-input");
  const statusEl = document.getElementById("onboarding-status");

  btn.addEventListener("click", () => input.click());

  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    btn.disabled = true;
    try {
      const roadmap = await withProgressCycle(statusEl, PROGRESS_PHRASES, uploadDegreeWorksFile(file));
      applyImportedRoadmap(roadmap);
    } catch (err) {
      console.error("DegreeWorks import failed:", err);
      window.alert(err.message || "Something went wrong uploading that file. Please try again.");
    } finally {
      btn.disabled = false;
      input.value = "";
    }
  });
})();

// --- Roadmap-page upload button (re-import / update an existing roadmap) ---
(function roadmapPageUploadModule() {
  const btn = document.getElementById("upload-degreeworks-btn");
  const input = document.getElementById("degreeworks-file-input");

  btn.addEventListener("click", () => input.click());

  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    const originalLabel = btn.textContent;
    btn.disabled = true;
    try {
      let i = 0;
      const cycle = setInterval(() => { btn.textContent = PROGRESS_PHRASES[i = (i + 1) % PROGRESS_PHRASES.length]; }, 1300);
      btn.textContent = PROGRESS_PHRASES[0];
      let roadmap;
      try {
        roadmap = await uploadDegreeWorksFile(file);
      } finally {
        clearInterval(cycle);
      }
      applyImportedRoadmap(roadmap);
    } catch (err) {
      console.error("DegreeWorks import failed:", err);
      window.alert(err.message || "Something went wrong uploading that file. Please try again.");
    } finally {
      btn.textContent = originalLabel;
      btn.disabled = false;
      input.value = "";
    }
  });
})();

/* ==========================================================================
   SECTION 12 — "How to download your DegreeWorks audit" instructions popup
   ========================================================================== */
(function howtoModule() {
  const backdrop = document.getElementById("howto-backdrop");
  const modal = document.getElementById("howto-modal");
  const openBtn = document.getElementById("howto-open-btn");
  const closeBtn = document.getElementById("howto-close");
  const nextBtn = document.getElementById("howto-next");
  const doneBtn = document.getElementById("howto-done");
  const steps = Array.from(modal.querySelectorAll(".howto-step"));
  let current = 0;

  function showStep(index) {
    current = index;
    steps.forEach((s, i) => s.classList.toggle("active", i === index));
    const isLast = index === steps.length - 1;
    nextBtn.style.display = isLast ? "none" : "";
    doneBtn.style.display = isLast ? "" : "none";
  }

  function open() {
    showStep(0);
    backdrop.classList.add("open");
    modal.classList.add("open");
  }
  function close() {
    backdrop.classList.remove("open");
    modal.classList.remove("open");
  }

  openBtn.addEventListener("click", open);
  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("click", close);
  nextBtn.addEventListener("click", () => showStep(Math.min(current + 1, steps.length - 1)));
  doneBtn.addEventListener("click", close);
})();

/* ==========================================================================
   SECTION 13 — edit mode + drag and drop
   ========================================================================== */
document.getElementById("edit-plan-btn").addEventListener("click", function () {
  editing = !editing;
  this.textContent = editing ? "Save Plan" : "Edit Plan";
  this.classList.toggle("editing", editing);
  renderSemesterView();
  if (document.getElementById("requirement-view").classList.contains("active")) renderRequirementView();
});

let draggedCode = null;

function attachDragHandlers() {
  document.querySelectorAll('.course-card[draggable="true"]').forEach((card) => {
    card.addEventListener("dragstart", () => {
      draggedCode = card.dataset.code;
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
  });

  document.querySelectorAll(".semester-col").forEach((col) => {
    col.addEventListener("dragover", (e) => {
      e.preventDefault();
      col.classList.add("drop-hover");
    });
    col.addEventListener("dragleave", () => col.classList.remove("drop-hover"));
    col.addEventListener("drop", (e) => {
      e.preventDefault();
      col.classList.remove("drop-hover");
      if (!draggedCode) return;
      const course = courses.find((c) => c.code === draggedCode);
      const destSemester = col.dataset.semester;
      if (!course || course.status === "completed") return;

      const blocking = course.prerequisites.find((p) => !prereqSatisfied(p, destSemester));
      if (blocking) {
        // Pass a copy with the attempted semester so the drawer's own
        // missing-prerequisite check (which reads course.semester) explains
        // the block in terms of where the student just tried to drop it,
        // not wherever it happened to be sitting before the drag.
        openDrawer({ ...course, semester: destSemester });
        draggedCode = null;
        return;
      }

      course.semester = destSemester;
      if (course.status === "unassigned") course.status = "planned";
      saveRoadmapToStorage();
      draggedCode = null;
      renderSemesterView(); // credits, progress, and status recompute from the single source of truth
    });
  });
}

/* ==========================================================================
   SECTION 14 — initial render
   ========================================================================== */
loadRoadmapFromStorage();
applyOnboardingState();
renderStudentIdentity();
renderSnapshotBars();
renderSemesterView();
