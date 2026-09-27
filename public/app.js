/* ==========================================================================
   W&M AI Academic Advisor — app.js
   ==========================================================================
   SECTION 1 preserves the original chat wiring byte-for-byte in behavior:
   same #chat / #chat-form / #input / #send-btn IDs, same .msg/.user/.model/
   .bubble/.suggestions/.suggestion-btn classes, same history array shape,
   same POST /api/chat contract, same disabled/focus/scroll/error handling.
   Only additive, backward-compatible hooks were introduced (landing-state
   class toggling, optional course-card rendering if the backend ever starts
   returning a `courses` array — harmless if it doesn't).
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
    // Additive: swap landing hero/quick-actions for the docked chat layout.
    // Does not touch chat/history logic.
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

  // Optional enhancement: if a future backend response includes a
  // `courses` array (see sendMessage below), render compact course-rec
  // cards under the model's bubble. Purely additive — INTEGRATION POINT,
  // no such field exists in the current /api/chat response yet.
  function addCourseCards(courses) {
    if (!courses || !courses.length) return;
    const wrap = document.createElement("div");
    wrap.className = "msg model";
    const list = document.createElement("div");
    list.style.display = "flex";
    list.style.flexDirection = "column";
    list.style.gap = "8px";
    courses.forEach((c) => {
      const card = document.createElement("div");
      card.className = "course-rec";
      card.innerHTML = `
        <div class="code"></div>
        <div class="title"></div>
        <div class="meta">
          <span class="tag credits"></span>
          <span class="tag"></span>
        </div>
        <button class="view-btn" type="button">View Course</button>
      `;
      card.querySelector(".code").textContent = c.code || "";
      card.querySelector(".title").textContent = c.title || "";
      card.querySelector(".tag.credits").textContent = `${c.credits ?? "?"} credits`;
      card.querySelector(".tag:last-of-type").textContent = (c.requirements && c.requirements[0]) || "Elective";
      list.appendChild(card);
    });
    wrap.appendChild(list);
    chatEl.appendChild(wrap);
    chatEl.scrollTop = chatEl.scrollHeight;
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
        body: JSON.stringify({ history }),
      });
      const data = await res.json();

      if (!res.ok) {
        addMessage("model", "Error: " + JSON.stringify(data.error));
        return;
      }

      addMessage("model", data.reply);
      history.push({ role: "model", text: data.reply });
      addCourseCards(data.courses); // no-op unless backend adds this field
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

/* ==========================================================================
   SECTION 5 — roadmap data model
   ==========================================================================
   INTEGRATION POINT: this is mock data standing in for a real backend.
   There is currently no /api/roadmap (or similar) endpoint — only /api/chat
   exists server-side. When that endpoint exists, replace `student` and
   `courses` below with a fetch() call that returns the same shapes, and
   everything downstream (grouping, rendering, progress math) keeps working
   unchanged, since Semester View and Requirement View both derive from this
   one array, per spec §24.
   ========================================================================== */
const student = {
  name: "Sophie Lin",
  year: "Sophomore",
  graduation: "Spring 2029",
  programs: ["Data Science", "Finance"],
};

const courses = [
  { code: "CSCI 141", title: "Computer Science I", credits: 4, semester: "Fall 2025", status: "completed", requirements: ["Data Science"], prerequisites: [] },
  { code: "MATH 111", title: "Calculus I", credits: 4, semester: "Fall 2025", status: "completed", requirements: ["Electives"], prerequisites: [] },
  { code: "COLL 100", title: "Community, Change & Choice", credits: 3, semester: "Fall 2025", status: "completed", requirements: ["COLL"], prerequisites: [] },
  { code: "ECON 101", title: "Principles of Microeconomics", credits: 3, semester: "Fall 2025", status: "completed", requirements: ["Finance"], prerequisites: [] },

  { code: "CSCI 241", title: "Data Structures", credits: 4, semester: "Spring 2026", status: "completed", requirements: ["Data Science"], prerequisites: ["CSCI 141"] },
  { code: "DATA 201", title: "Intro to Data Science", credits: 3, semester: "Spring 2026", status: "completed", requirements: ["Data Science"], prerequisites: [] },
  { code: "COLL 200 NQR", title: "Numeracy, Quantitative & Computational Reasoning", credits: 3, semester: "Spring 2026", status: "completed", requirements: ["COLL"], prerequisites: [] },
  { code: "MATH 301", title: "Linear Algebra", credits: 3, semester: "Spring 2026", status: "completed", requirements: ["Electives"], prerequisites: ["MATH 111"] },

  { code: "DATA 301", title: "Data Management", credits: 3, semester: "Fall 2026", status: "current", requirements: ["Data Science"], prerequisites: ["DATA 201"] },
  { code: "BUAD 327", title: "Corporate Finance", credits: 3, semester: "Fall 2026", status: "current", requirements: ["Finance"], prerequisites: ["ECON 101"] },
  { code: "BIOL 203", title: "Genetics", credits: 4, semester: "Fall 2026", status: "completed", requirements: ["Electives"], prerequisites: [] },

  { code: "DATA 325", title: "Statistical Learning", credits: 3, semester: "Spring 2027", status: "planned", requirements: ["Data Science"], prerequisites: ["DATA 301"] },
  { code: "FIN 301", title: "Investments", credits: 3, semester: "Spring 2027", status: "planned", requirements: ["Finance"], prerequisites: ["BUAD 327"] },
  { code: "COLL 300", title: "Vision, Voice & Vocation", credits: 3, semester: "", status: "unassigned", requirements: ["COLL"], prerequisites: [] },

  { code: "DATA 440", title: "Machine Learning", credits: 3, semester: "", status: "unassigned", requirements: ["Data Science"], prerequisites: ["DATA 325"] },
  { code: "FIN 341", title: "Financial Modeling", credits: 3, semester: "", status: "unassigned", requirements: ["Finance"], prerequisites: ["FIN 301"] },
];

const requirementTotals = {
  "Data Science": 11,
  "Finance": 8,
  "COLL": 6,
  "Electives": 8,
};

/* ==========================================================================
   SECTION 6 — shared helpers
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

function overallProgress() {
  const totalNeeded = Object.values(requirementTotals).reduce((a, b) => a + b, 0);
  const totalDone = courses.filter((c) => c.status === "completed" || c.status === "current").length;
  return Math.round((totalDone / totalNeeded) * 100);
}

function requirementProgress(reqName) {
  const need = requirementTotals[reqName] || 1;
  const have = courses.filter((c) => c.requirements.includes(reqName) && (c.status === "completed" || c.status === "current")).length;
  return { pct: Math.min(100, Math.round((have / need) * 100)), have, need };
}

function totalCredits() {
  const earned = courses.filter((c) => c.status === "completed").reduce((s, c) => s + c.credits, 0);
  return { earned, target: 120 };
}

let editing = false;

/* ==========================================================================
   SECTION 7 — snapshot rendering (advisor page)
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

  // Circular progress ring — kept in sync with the same overallProgress()
  // figure the text label and the Roadmap page's degree-progress bars use,
  // so all three never drift apart.
  const ring = document.getElementById("snap-ring-progress");
  ring.style.strokeDasharray = RING_CIRCUMFERENCE;
  ring.style.strokeDashoffset = RING_CIRCUMFERENCE * (1 - overall / 100);
}

/* ==========================================================================
   SECTION 8 — semester view rendering
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
  wrap.innerHTML =
    groups
      .map(
        (g) => `
      <div class="semester-col" data-semester="${g.semester}">
        <div class="semester-col-head"><h3>${g.semester}</h3><span class="credits">${g.list.reduce((s, c) => s + c.credits, 0)} credits</span></div>
        <div class="semester-cards" data-drop="${g.semester}">
          ${g.list.map(courseCardHTML).join("")}
        </div>
        <button class="add-course-btn" data-add-to="${g.semester}">+ Add Course</button>
      </div>`
      )
      .join("") + `<button class="add-semester-col">+ Add Semester</button>`;

  // Degree progress summary
  const overall = overallProgress();
  const { earned, target } = totalCredits();
  document.getElementById("dp-pct").textContent = overall + "%";
  document.getElementById("dp-frac").textContent = `${earned} / ${target} credits`;
  document.getElementById("dp-grad-date").textContent = student.graduation;
  document.getElementById("dp-bars").innerHTML = Object.keys(requirementTotals)
    .map((n) => {
      const { pct } = requirementProgress(n);
      return `<div class="bar-row"><span class="bar-name">${n}</span><span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span><span class="bar-pct">${pct}%</span></div>`;
    })
    .join("");

  const roadmapRing = document.getElementById("roadmap-ring-progress");
  roadmapRing.style.strokeDasharray = RING_CIRCUMFERENCE;
  roadmapRing.style.strokeDashoffset = RING_CIRCUMFERENCE * (1 - overall / 100);

  renderStillNeedsHome();
  attachCourseCardHandlers();
  if (editing) attachDragHandlers();
}

function renderStillNeedsHome() {
  const list = document.getElementById("snh-list");
  const unassigned = courses.filter((c) => c.status === "unassigned");
  if (!unassigned.length) {
    list.innerHTML = `<div class="snh-item"><span>Nothing outstanding — every requirement has a plan.</span></div>`;
    return;
  }
  list.innerHTML = unassigned
    .map(
      (c) => `
    <div class="snh-item">
      <span>${statusIconHTML("unassigned")} ${c.code} — ${c.title} <span style="color:var(--text-secondary)">(not scheduled)</span></span>
      <span class="snh-actions">
        <button data-find="${c.code}">Find Course</button>
        <button data-ask="${c.code}">Ask Advisor</button>
      </span>
    </div>`
    )
    .join("");

  list.querySelectorAll("[data-ask]").forEach((btn) =>
    btn.addEventListener("click", () => {
      document.querySelector('.nav-item[data-page="advisor"]').click();
      window.__advisorSendMessage(`Help me plan when to take ${btn.dataset.ask}.`);
    })
  );
  list.querySelectorAll("[data-find]").forEach((btn) =>
    btn.addEventListener("click", () => openDrawer(courses.find((c) => c.code === btn.dataset.find)))
  );
}

/* ==========================================================================
   SECTION 9 — requirement view rendering
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
   SECTION 10 — view toggle (semester / requirement)
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
   SECTION 11 — course details drawer
   ========================================================================== */
function openDrawer(course) {
  if (!course) return;
  const backdrop = document.getElementById("drawer-backdrop");
  const drawer = document.getElementById("course-drawer");
  const content = document.getElementById("drawer-content");

  const prereqRows = course.prerequisites.length
    ? course.prerequisites
        .map((p) => {
          const pc = courses.find((c) => c.code === p);
          const done = pc && pc.status === "completed";
          return `<div class="drawer-prereq-row">${statusIconHTML(done ? "completed" : "planned")} ${p}</div>`;
        })
        .join("")
    : `<div class="drawer-prereq-row">None</div>`;

  const missingPrereq = course.prerequisites.find((p) => {
    const pc = courses.find((c) => c.code === p);
    return !pc || pc.status !== "completed";
  });

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
      }
      renderSemesterView();
    });
  });
  document.querySelectorAll(".add-course-btn").forEach((btn) => {
    btn.addEventListener("click", () => openCourseSearch(btn.dataset.addTo));
  });
}

/* ==========================================================================
   SECTION 11b — add-course search
   ==========================================================================
   INTEGRATION POINT: courseCatalog below is mock data standing in for a
   real "search the course catalog" backend call (the spec calls for this
   to eventually be sourced from W&M's course catalog). There is no such
   endpoint yet — only /api/chat exists server-side. When one exists
   (e.g. GET /api/courses?q=...), swap the filter in renderSearchResults()
   for a fetch() call; openCourseSearch/selectCatalogCourse and the modal
   markup don't need to change.
   ========================================================================== */
const courseCatalog = [
  { code: "DATA 325", title: "Statistical Learning", credits: 3, requirements: ["Data Science"] },
  { code: "DATA 350", title: "Data Visualization", credits: 3, requirements: ["Data Science"] },
  { code: "DATA 440", title: "Machine Learning", credits: 3, requirements: ["Data Science"] },
  { code: "DATA 450", title: "Big Data Systems", credits: 3, requirements: ["Data Science"] },
  { code: "CSCI 315", title: "Database Systems", credits: 3, requirements: ["Data Science"] },
  { code: "CSCI 411", title: "Artificial Intelligence", credits: 3, requirements: ["Data Science"] },
  { code: "STAT 302", title: "Probability", credits: 3, requirements: ["Data Science"] },
  { code: "FIN 301", title: "Investments", credits: 3, requirements: ["Finance"] },
  { code: "FIN 341", title: "Financial Modeling", credits: 3, requirements: ["Finance"] },
  { code: "FIN 401", title: "Derivatives Markets", credits: 3, requirements: ["Finance"] },
  { code: "BUAD 310", title: "Marketing Management", credits: 3, requirements: ["Finance"] },
  { code: "BUAD 350", title: "Financial Accounting", credits: 3, requirements: ["Finance"] },
  { code: "ECON 303", title: "Money and Banking", credits: 3, requirements: ["Finance"] },
  { code: "COLL 300", title: "Vision, Voice & Vocation", credits: 3, requirements: ["COLL"] },
  { code: "COLL 350", title: "COLL Capstone Seminar", credits: 3, requirements: ["COLL"] },
  { code: "PHIL 201", title: "Ethics", credits: 3, requirements: ["COLL"] },
  { code: "HIST 150", title: "Global History Survey", credits: 3, requirements: ["COLL"] },
  { code: "ARTH 150", title: "Introduction to Art History", credits: 3, requirements: ["Electives"] },
  { code: "PSYC 101", title: "Introduction to Psychology", credits: 3, requirements: ["Electives"] },
  { code: "ENGL 201", title: "Creative Writing", credits: 3, requirements: ["Electives"] },
  { code: "MUS 105", title: "Music Theory I", credits: 3, requirements: ["Electives"] },
  { code: "KINE 201", title: "Introduction to Exercise Science", credits: 3, requirements: ["Electives"] },
];

let csTargetSemester = null;

function openCourseSearch(targetSemester) {
  csTargetSemester = targetSemester;
  document.getElementById("cs-target-label").textContent = `Adding to ${targetSemester}`;
  const input = document.getElementById("cs-search-input");
  input.value = "";
  renderSearchResults("");
  document.getElementById("course-search-backdrop").classList.add("open");
  document.getElementById("course-search-modal").classList.add("open");
  input.focus();
}

function closeCourseSearch() {
  document.getElementById("course-search-backdrop").classList.remove("open");
  document.getElementById("course-search-modal").classList.remove("open");
  csTargetSemester = null;
}

function renderSearchResults(query) {
  const list = document.getElementById("cs-results");
  const q = query.trim().toLowerCase();
  const matches = courseCatalog.filter(
    (c) => !q || c.code.toLowerCase().includes(q) || c.title.toLowerCase().includes(q)
  );

  if (!matches.length) {
    list.innerHTML = `<div class="cs-empty">No matching courses found.</div>`;
    return;
  }

  list.innerHTML = matches
    .map(
      (c) => `
      <button type="button" class="cs-result" data-code="${c.code}">
        <div class="cs-code">${c.code}</div>
        <div class="cs-course-title">${c.title}</div>
        <span class="tag">${c.requirements[0]}</span>
        <span class="tag credits">${c.credits} credits</span>
      </button>`
    )
    .join("");

  list.querySelectorAll(".cs-result").forEach((btn) => {
    btn.addEventListener("click", () => selectCatalogCourse(btn.dataset.code));
  });
}

function selectCatalogCourse(code) {
  if (!csTargetSemester) return;
  const entry = courseCatalog.find((c) => c.code === code);
  if (!entry) return;

  // If this course already exists on the roadmap (e.g. it was sitting in
  // "Still Needs a Home"), just reassign it rather than creating a
  // duplicate. Otherwise add it as a new planned course.
  let course = courses.find((c) => c.code === code);
  if (course) {
    course.semester = csTargetSemester;
    course.status = "planned";
  } else {
    courses.push({
      code: entry.code,
      title: entry.title,
      credits: entry.credits,
      semester: csTargetSemester,
      status: "planned",
      requirements: entry.requirements,
      prerequisites: [],
    });
  }

  closeCourseSearch();
  renderSemesterView();
  if (document.getElementById("requirement-view").classList.contains("active")) renderRequirementView();
}

document.getElementById("cs-search-input").addEventListener("input", (e) => renderSearchResults(e.target.value));
document.getElementById("course-search-close").addEventListener("click", closeCourseSearch);
document.getElementById("course-search-backdrop").addEventListener("click", closeCourseSearch);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.getElementById("course-search-modal").classList.contains("open")) closeCourseSearch();
});

/* ==========================================================================
   SECTION 12 — edit mode + drag and drop
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

      const blocking = course.prerequisites.find((p) => {
        const pc = courses.find((c) => c.code === p);
        return !pc || pc.status !== "completed";
      });
      if (blocking) {
        openDrawer(course); // surfaces the same "Missing prerequisite" explanation, never silently blocks
        draggedCode = null;
        return;
      }

      course.semester = destSemester;
      if (course.status === "unassigned") course.status = "planned";
      draggedCode = null;
      renderSemesterView(); // credits, progress, and status recompute from the single source of truth
    });
  });
}

/* ==========================================================================
   SECTION 13 — initial render
   ========================================================================== */
renderSnapshotBars();
renderSemesterView();
