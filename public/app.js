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

// Bumped whenever the shape of the parsed roadmap changes, so the student
// re-uploads and gets corrected data: v2 stopped reading graduation/standing
// from the audit and started flagging transfer credit; v3 attaches real
// catalog prerequisites to each course (older saves have none).
const ROADMAP_STORAGE_KEY = "wm-cs-advisor-roadmap-v3";
const LEGACY_ROADMAP_STORAGE_KEYS = ["wm-cs-advisor-roadmap", "wm-cs-advisor-roadmap-v2"];
try {
  LEGACY_ROADMAP_STORAGE_KEYS.forEach((k) => localStorage.removeItem(k));
} catch (err) {
  /* storage unavailable — nothing to clean up */
}

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
// Semester columns the student added themselves (Add Semester) or that an
// advisor-generated roadmap introduced. Kept separately from `courses` so an
// empty semester still shows up as a column the student can drop courses into.
let plannedSemesters = [];

function loadRoadmapFromStorage() {
  try {
    const raw = localStorage.getItem(ROADMAP_STORAGE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    student = data.student;
    courses = data.courses;
    requirementTotals = data.requirementTotals;
    plannedSemesters = Array.isArray(data.plannedSemesters) ? data.plannedSemesters : [];
    return true;
  } catch (err) {
    console.error("Failed to read saved roadmap from localStorage:", err);
    return false;
  }
}

function saveRoadmapToStorage() {
  try {
    localStorage.setItem(ROADMAP_STORAGE_KEY, JSON.stringify({ student, courses, requirementTotals, plannedSemesters }));
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

  // Animated "..." bubble shown while waiting on /api/chat. Returns the
  // element so the caller can remove it on every exit path.
  function addTypingIndicator() {
    const wrap = document.createElement("div");
    wrap.className = "msg model typing";
    wrap.setAttribute("aria-label", "Advisor is typing");
    wrap.innerHTML = `<span class="bubble"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></span>`;
    chatEl.appendChild(wrap);
    chatEl.scrollTop = chatEl.scrollHeight;
    return wrap;
  }

  // Small confirmation under an advisor reply whose roadmap was synced to the
  // My Roadmap page, with a shortcut to go look at it.
  function addSyncNotice(summary) {
    const wrap = document.createElement("div");
    wrap.className = "sync-notice";
    const text = document.createElement("span");
    text.textContent = summary;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sync-notice-btn";
    btn.textContent = "View on My Roadmap";
    btn.addEventListener("click", () => document.querySelector('.nav-item[data-page="roadmap"]').click());
    wrap.append(text, btn);
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
    const typingEl = addTypingIndicator();
    const clearTyping = () => typingEl.remove();

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The roadmap travels with every message since the server keeps no
        // memory of it between requests — see the note at the top of this file.
        body: JSON.stringify({ history, roadmap: hasRoadmap() ? { student, courses, requirementTotals, plannedSemesters } : null }),
      });
      const data = await res.json();
      clearTyping();

      if (!res.ok) {
        addMessage("model", "Error: " + JSON.stringify(data.error));
        return;
      }

      addMessage("model", data.reply);
      history.push({ role: "model", text: data.reply });
      // A full multi-semester plan from the advisor comes back as structured
      // data alongside the reply; sync it straight to My Roadmap.
      if (data.roadmapPlan && hasRoadmap()) {
        const summary = applyAdvisorRoadmapPlan(data.roadmapPlan);
        if (summary) addSyncNotice(summary);
      }
      addSuggestions(data.suggestions);
    } catch (err) {
      clearTyping();
      addMessage("model", "Network error — is the server running?");
    } finally {
      clearTyping();
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
  // There is one toggle in the Academic Snapshot header and one in the
  // Roadmap header, so bind every .theme-toggle rather than a single ID.
  const toggles = document.querySelectorAll(".theme-toggle");
  const stored = localStorage.getItem("wm-theme");
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const initial = stored || (prefersDark ? "dark" : "light");
  root.setAttribute("data-theme", initial);

  toggles.forEach((toggle) => {
    toggle.addEventListener("click", () => {
      const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      localStorage.setItem("wm-theme", next);
    });
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
 * Class standing derived from the student's chosen graduation term (the
 * audit's own "Classification" is credit-based and unreliable — AP credit
 * can make a first-year look like a sophomore). Compares the academic year
 * the student graduates in against the current academic year (Aug–Jul).
 */
function deriveStanding(graduation) {
  if (!graduation) return "";
  const [term, yearStr] = graduation.split(" ");
  const gradYear = Number(yearStr);
  if (!term || !gradYear) return "";

  // Academic years are named by the calendar year they end in.
  const gradAcademicYearEnd = term === "Fall" ? gradYear + 1 : gradYear;
  const now = new Date();
  const currentAcademicYearEnd = now.getMonth() >= 7 ? now.getFullYear() + 1 : now.getFullYear();
  const yearsLeft = gradAcademicYearEnd - currentAcademicYearEnd;

  if (yearsLeft < 0) return "";
  if (yearsLeft === 0) return "Senior";
  if (yearsLeft === 1) return "Junior";
  if (yearsLeft === 2) return "Sophomore";
  return "First-Year";
}

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
    document.getElementById("student-grad-mini").textContent = "";
    document.getElementById("snap-grad").textContent = "";
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
  const standing = deriveStanding(student.graduation);
  const yearLabel = [standing, student.gpa ? `GPA ${student.gpa.toFixed(2)}` : ""].filter(Boolean).join(" · ");
  const gradLabel = student.graduation ? `Target graduation: ${student.graduation}` : "Target graduation: not set";
  document.getElementById("student-grad-mini").textContent = student.graduation ? `Grad ${student.graduation}` : "Graduation not set";
  document.getElementById("snap-grad").textContent = gradLabel;

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
 * Old catalog numbers that now refer to the same course (from the "formerly"
 * notes in the W&M catalog). A student who completed the old number has
 * satisfied a prerequisite that names the new one, and vice versa.
 */
const FORMER_NUMBERS = { "MATH 211": "MATH 109", "DATA 310": "DATA 301", "DATA 311": "DATA 302" };
function canonicalCode(code) {
  return FORMER_NUMBERS[code] || code;
}

/**
 * Whether a single course code is satisfied for a course being placed in
 * `destSemester`: it's completed (including transfer/AP credit), or it's
 * scheduled in a semester strictly before the destination. If the catalog
 * says it "may be taken concurrently", the same semester also counts.
 */
function courseSatisfies(code, destSemester, concurrentOk) {
  const want = canonicalCode(code);
  return courses.some((pc) => {
    if (canonicalCode(pc.code) !== want) return false;
    if (pc.status === "completed") return true;
    if (!pc.semester || !destSemester) return false; // unassigned prereq can't come "before" anything
    const cmp = semesterSort(pc.semester, destSemester);
    return cmp < 0 || (concurrentOk && cmp === 0);
  });
}

/**
 * Evaluates one catalog prerequisite entry, e.g. "CSCI 241",
 * "CSCI 243 or MATH 214", "CSCI 241 (may be taken concurrently)", or
 * "CSCI 415 or (CSCI 301 and CSCI 303 and CSCI 304)". "and" binds tighter
 * than "or", matching how data/build_catalog.py writes these. Entries with
 * no course codes at all (e.g. "To be determined by topic each term") can't
 * be checked, so they're treated as satisfied rather than blocking a move.
 */
function prereqSatisfied(entry, destSemester) {
  const tokens = entry.match(/\(may be taken concurrently\)|[A-Z]{2,4} \d{3}[A-Z]?|\(|\)|\band\b|\bor\b/g) || [];
  if (!tokens.some((t) => /^[A-Z]{2,4} \d{3}/.test(t))) return true;

  let pos = 0;
  const peek = () => tokens[pos];
  function primary() {
    const t = tokens[pos++];
    if (t === "(") {
      const v = orExpr();
      if (peek() === ")") pos++;
      return v;
    }
    let concurrentOk = false;
    if (peek() === "(may be taken concurrently)") {
      pos++;
      concurrentOk = true;
    }
    return courseSatisfies(t, destSemester, concurrentOk);
  }
  function andExpr() {
    let v = primary();
    while (peek() === "and") {
      pos++;
      v = primary() && v;
    }
    return v;
  }
  function orExpr() {
    let v = andExpr();
    while (peek() === "or") {
      pos++;
      v = andExpr() || v;
    }
    return v;
  }
  try {
    return orExpr();
  } catch (err) {
    console.warn("Couldn't evaluate prerequisite:", entry, err);
    return true;
  }
}

/* ==========================================================================
   SECTION 5b — terms, catalog, locking, and plan-editing helpers
   ========================================================================== */

/** Completed and in-progress courses are part of the student's record, not
 *  the plan — they can't be moved or removed. */
function isLocked(c) {
  return c.status === "completed" || c.status === "current";
}

function findCourse(code) {
  const want = canonicalCode(code);
  return courses.find((c) => canonicalCode(c.code) === want);
}

/** The regular term (Fall/Spring) that follows `term`. Summer and Winter
 *  sessions roll forward to the next regular term. */
function nextRegularTerm(term) {
  const [season, yearStr] = term.split(" ");
  const year = Number(yearStr);
  if (season === "Fall") return `Spring ${year + 1}`;
  if (season === "Winter") return `Spring ${year}`;
  return `Fall ${year}`; // Spring or Summer
}

/** The term in progress right now: the student's in-progress (IP) term if
 *  the audit has one, otherwise estimated from today's date. */
function currentTerm() {
  const inProgress = courses.filter((c) => c.status === "current" && c.semester).map((c) => c.semester).sort(semesterSort);
  if (inProgress.length) return inProgress[0];
  const now = new Date();
  const m = now.getMonth(); // 0 = Jan
  const y = now.getFullYear();
  if (m <= 4) return `Spring ${y}`;
  if (m <= 6) return `Summer ${y}`;
  return `Fall ${y}`;
}

/** First term that can still be planned (anything after the current one). */
function firstOpenTerm() {
  return nextRegularTerm(currentTerm());
}

/** A term can be planned if it comes after the current one. That includes
 *  the Winter/Summer session right after it (e.g. Winter 2027 when the
 *  current term is Fall 2026), not just the next regular term. */
function isOpenTerm(term) {
  return !!term && semesterSort(term, currentTerm()) > 0;
}

// --- Catalog (served by /api/catalog, the same data the advisor sees) ---
let catalog = [];
let catalogByCode = new Map();

async function loadCatalog() {
  try {
    const res = await fetch("/api/catalog");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    catalog = await res.json();
    catalogByCode = new Map(catalog.map((c) => [c.code, c]));
  } catch (err) {
    console.error("Couldn't load the course catalog:", err);
    catalog = [];
    catalogByCode = new Map();
  }
}

function catalogEntry(code) {
  return catalogByCode.get(code) || catalogByCode.get(canonicalCode(code)) || null;
}

/** Catalog credits can be a range like "1-3"; plan with the top of it. */
function creditsFromCatalog(entry) {
  if (typeof entry.credits === "number") return entry.credits;
  const nums = String(entry.credits || "").match(/\d+/g);
  return nums ? Number(nums[nums.length - 1]) : 3;
}

/** Which requirement bucket (a requirementTotals key) a new course lands in. */
function requirementBucketFor(entry) {
  const majorBucket = Object.keys(requirementTotals).find((k) => k !== "COLL" && k !== "Electives");
  const roles = (entry && entry.cs_major_roles) || [];
  const countsForMajor = roles.length > 0 && !roles.includes("does_not_count_toward_major");
  if (countsForMajor && majorBucket) return majorBucket;
  return requirementTotals.Electives !== undefined ? "Electives" : (majorBucket || "Electives");
}

function makePlannedCourse(entry, semester, source) {
  return {
    code: entry.code,
    title: entry.title,
    credits: creditsFromCatalog(entry),
    semester,
    status: "planned",
    transfer: false,
    requirements: [requirementBucketFor(entry)],
    prerequisites: [...(entry.prerequisites || [])],
    source,
  };
}

/**
 * Moves an unlocked course to `destSemester`. Returns the prerequisite entry
 * that blocks the move (and makes no change), or null on success.
 */
function moveCourse(course, destSemester) {
  if (!course || isLocked(course)) return null;
  const blocking = (course.prerequisites || []).find((p) => !prereqSatisfied(p, destSemester));
  if (blocking) return blocking;
  course.semester = destSemester;
  if (course.status === "unassigned") course.status = "planned";
  return null;
}

function removeCourseFromPlan(code) {
  const course = courses.find((c) => c.code === code);
  if (!course || isLocked(course)) return;
  courses = courses.filter((c) => c !== course);
}

/** Every semester column shown in the plan, oldest first. */
function allSemesters() {
  const set = new Set(plannedSemesters);
  courses.forEach((c) => {
    if (c.semester && !c.transfer) set.add(c.semester);
  });
  return Array.from(set).sort(semesterSort);
}

/** Semesters a course can be added or moved to: open (future) columns, or
 *  the first open term if the plan has none yet. */
function openSemesters() {
  const open = allSemesters().filter(isOpenTerm);
  return open.length ? open : [firstOpenTerm()];
}

function refreshAllRoadmapViews() {
  renderStudentIdentity();
  renderSnapshotBars();
  renderSemesterView();
  if (document.getElementById("requirement-view").classList.contains("active")) renderRequirementView();
}

// --- Earliest realistic graduation ---
const MAX_CREDITS_PER_TERM = 18;
const DEGREE_CREDITS = 120;
// Each group is one requirement; any option in it satisfies it.
const REQUIRED_COURSE_GROUPS = [
  ["CSCI 141"], ["CSCI 241"], ["CSCI 243", "MATH 214"], ["CSCI 301"], ["CSCI 303"],
  ["CSCI 304"], ["CSCI 312"], ["CSCI 423"],
  ["MATH 111", "MATH 131"], ["MATH 112", "MATH 132"], ["MATH 109"],
];

/**
 * Earliest term the student could realistically graduate: enough regular
 * (Fall/Spring) terms to cover the remaining credits at 18 per term, and
 * enough terms to work through the longest remaining prerequisite chain in
 * the CS core and math proficiency. Completed and in-progress courses count
 * as done. Summer sessions aren't counted, since graduation can't be in
 * Summer.
 */
function earliestGraduation() {
  const done = (code) => courses.some((c) => canonicalCode(c.code) === canonicalCode(code) && isLocked(c));
  const earned = courses.filter(isLocked).reduce((s, c) => s + c.credits, 0);
  const remainingCredits = Math.max(0, DEGREE_CREDITS - earned);
  const creditTerms = Math.ceil(remainingCredits / MAX_CREDITS_PER_TERM);

  // finishTerm(code): how many terms from now until `code` can be finished.
  const memo = new Map();
  function finishTerm(code, stack = new Set()) {
    if (done(code)) return 0;
    const key = canonicalCode(code);
    if (memo.has(key)) return memo.get(key);
    if (stack.has(key)) return 1; // guard against catalog cycles
    stack.add(key);
    const entry = catalogEntry(code);
    let before = 0;
    (entry ? entry.prerequisites : []).forEach((p) => {
      const opts = [...p.matchAll(/([A-Z]{2,4} \d{3}[A-Z]?)( \(may be taken concurrently\))?/g)];
      if (!opts.length) return;
      const best = Math.min(
        ...opts.map(([, optCode, concurrent]) => {
          const t = finishTerm(optCode, stack);
          return concurrent ? Math.max(0, t - 1) : t;
        })
      );
      before = Math.max(before, best);
    });
    stack.delete(key);
    memo.set(key, before + 1);
    return before + 1;
  }
  const chainTerms = catalog.length
    ? Math.max(0, ...REQUIRED_COURSE_GROUPS.map((g) => Math.min(...g.map((code) => finishTerm(code)))))
    : 0;

  const termsNeeded = Math.max(creditTerms, chainTerms);
  let term = currentTerm();
  if (term.startsWith("Summer") || term.startsWith("Winter")) term = nextRegularTerm(term);
  for (let i = 0; i < termsNeeded; i++) term = nextRegularTerm(term);
  return { term, remainingCredits, termsNeeded, chainTerms };
}

// --- Advisor roadmap sync ---
/**
 * Applies a full multi-semester plan the advisor produced in chat (see
 * extractRoadmapPlan in server.js) to My Roadmap. Courses from the previous
 * advisor sync are replaced; completed/in-progress courses are never touched;
 * a course the student already planned is moved to the advisor's term.
 * Returns a one-line summary, or null if nothing changed.
 */
function applyAdvisorRoadmapPlan(plan) {
  if (!plan || !Array.isArray(plan.semesters)) return null;
  courses = courses.filter((c) => c.source !== "advisor" || isLocked(c));

  let added = 0;
  let moved = 0;
  const terms = new Set();
  plan.semesters.forEach((sem) => {
    if (!isOpenTerm(sem.term)) return;
    (sem.courses || []).forEach((entry) => {
      const existing = findCourse(entry.code);
      if (existing) {
        if (isLocked(existing) || existing.semester === sem.term) return;
        existing.semester = sem.term;
        if (existing.status === "unassigned") existing.status = "planned";
        moved++;
      } else {
        courses.push(makePlannedCourse(entry, sem.term, "advisor"));
        added++;
      }
      terms.add(sem.term);
    });
  });

  saveRoadmapToStorage();
  refreshAllRoadmapViews();
  if (!added && !moved) return null;
  const parts = [];
  if (added) parts.push(`added ${added} course${added === 1 ? "" : "s"}`);
  if (moved) parts.push(`moved ${moved}`);
  return `Synced to My Roadmap: ${parts.join(", ")} across ${terms.size} semester${terms.size === 1 ? "" : "s"}.`;
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
  allSemesters().forEach((sem) => (groups[sem] = []));
  courses.forEach((c) => {
    if (!c.semester) return;
    if (c.transfer) return; // transfer/AP credit gets its own table — see renderTransferTable()
    groups[c.semester].push(c);
  });
  return Object.keys(groups).sort(semesterSort).map((sem) => ({ semester: sem, list: groups[sem] }));
}

function courseCardHTML(c) {
  // NOTE: this is a <div role="button">, not a <button>, because it contains
  // its own nested remove <button> — real <button> elements cannot legally
  // contain another <button>; browsers silently split such markup, which
  // used to produce stray empty boxes in edit mode.
  const locked = isLocked(c);
  const removable = editing && !locked ? `<button type="button" class="remove-course-x" data-remove="${c.code}" aria-label="Remove ${c.code} from plan">×</button>` : "";
  const lock = locked
    ? `<span class="cc-lock" title="${c.status === "completed" ? "Completed" : "In progress"} — locked"><svg class="icon"><use href="#i-lock"/></svg></span>`
    : "";
  return `
    <div class="course-card${locked ? " locked" : ""}" data-code="${c.code}" role="button" tabindex="0" ${editing && !locked ? 'draggable="true"' : ""}>
      ${removable}
      <div class="cc-top">${statusIconHTML(c.status)}<span class="cc-code">${c.code}</span>${lock}</div>
      <div class="cc-title">${c.title}</div>
      <span class="tag cc-tag">${c.requirements[0] || "Elective"}</span>
    </div>`;
}

/**
 * Transfer / AP credit (DegreeWorks grade "T") in its own table below the
 * semester columns, instead of being lumped into the first semester. These
 * still count toward credits and requirement progress like any completed
 * course; they're only displayed separately.
 */
function renderTransferTable() {
  const panel = document.getElementById("transfer-panel");
  const body = document.getElementById("transfer-table-body");
  const totalEl = document.getElementById("transfer-total");
  const transfers = courses.filter((c) => c.transfer).sort((a, b) => a.code.localeCompare(b.code));

  if (transfers.length === 0) {
    panel.hidden = true;
    body.innerHTML = "";
    totalEl.textContent = "";
    return;
  }

  panel.hidden = false;
  totalEl.textContent = `${transfers.reduce((s, c) => s + c.credits, 0)} credits`;
  body.innerHTML = transfers
    .map(
      (c) => `
      <tr class="transfer-row" data-code="${c.code}" tabindex="0">
        <td class="tt-code">${c.code}</td>
        <td class="tt-title">${c.title}</td>
        <td class="tt-credits">${c.credits}</td>
        <td class="tt-term">${c.semester || "—"}</td>
        <td class="tt-req">${c.requirements.join(", ") || "Elective"}</td>
      </tr>`
    )
    .join("");

  body.querySelectorAll(".transfer-row").forEach((row) => {
    const open = () => openDrawer(courses.find((c) => c.code === row.dataset.code));
    row.addEventListener("click", open);
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    });
  });
}

function renderSemesterView() {
  const wrap = document.getElementById("semester-scroll");
  const groups = groupBySemester();
  wrap.className = "semester-scroll" + (editing ? " editing" : "");
  wrap.innerHTML =
    groups
      .map((g, i) => {
        // Hover "+" between this column and the next one, when there's a
        // future term that belongs there (Winter/Summer session, or a
        // regular term that was deleted and left a gap).
        const next = groups[i + 1];
        const between = next ? termBetween(g.semester, next.semester) : null;
        const gapHTML =
          between && hasRoadmap()
            ? `<div class="semester-gap"><button type="button" class="semester-gap-add" data-insert-semester="${between}" aria-label="Add ${between}" title="Add ${between}"><svg class="icon"><use href="#i-plus"/></svg></button></div>`
            : "";
        const removeX = canRemoveSemester(g)
          ? `<button type="button" class="remove-semester-x" data-remove-semester="${g.semester}" aria-label="Remove ${g.semester}">×</button>`
          : "";
        return `
      <div class="semester-col${isOpenTerm(g.semester) ? "" : " past"}" data-semester="${g.semester}">
        <div class="semester-col-head">
          <h3>${g.semester}</h3>
          <span class="credits">${g.list.reduce((s, c) => s + c.credits, 0)} credits</span>
          ${removeX}
        </div>
        <div class="semester-cards" data-drop="${g.semester}">
          ${g.list.length ? g.list.map(courseCardHTML).join("") : `<div class="semester-empty">No courses yet — search the catalog above to add one.</div>`}
        </div>
      </div>${gapHTML}`;
      })
      .join("") +
    (hasRoadmap()
      ? `<button type="button" class="add-semester-col" id="add-semester-btn"><svg class="icon"><use href="#i-plus"/></svg><span>Add Semester</span></button>`
      : "");

  const addSemBtn = document.getElementById("add-semester-btn");
  if (addSemBtn) addSemBtn.addEventListener("click", addSemester);
  wrap.querySelectorAll(".remove-semester-x").forEach((btn) => {
    btn.addEventListener("click", () => removeSemester(btn.dataset.removeSemester));
  });
  wrap.querySelectorAll(".semester-gap-add").forEach((btn) => {
    btn.addEventListener("click", () => insertSemester(btn.dataset.insertSemester));
  });

  // Degree progress summary
  const overall = overallProgress();
  const { earned, target } = totalCredits();
  document.getElementById("dp-pct").textContent = overall + "%";
  document.getElementById("dp-frac").textContent = `${earned} / ${target} credits`;
  const gradBtn = document.getElementById("dp-grad-date");
  gradBtn.textContent = hasRoadmap() ? (student.graduation || "Set date") : "—";
  gradBtn.disabled = !hasRoadmap();
  document.getElementById("dp-bars").innerHTML = Object.keys(requirementTotals)
    .map((n) => {
      const { pct } = requirementProgress(n);
      return `<div class="bar-row"><span class="bar-name">${n}</span><span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span><span class="bar-pct">${pct}%</span></div>`;
    })
    .join("");

  const roadmapRing = document.getElementById("roadmap-ring-progress");
  roadmapRing.style.strokeDasharray = RING_CIRCUMFERENCE;
  roadmapRing.style.strokeDashoffset = RING_CIRCUMFERENCE * (1 - overall / 100);

  renderTransferTable();
  renderCatalogSemesterOptions();
  attachCourseCardHandlers();
  if (editing) attachDragHandlers();
}

/** Adds the next regular (Fall/Spring) term after the last one in the plan. */
function addSemester() {
  const all = allSemesters();
  const last = all.length ? all[all.length - 1] : currentTerm();
  let next = nextRegularTerm(last);
  if (!isOpenTerm(next)) next = firstOpenTerm();
  insertSemester(next);
}

/** Adds `term` as a (possibly empty) plan column and scrolls to it. Past
 *  and in-progress terms can't be added — they're part of the record. */
function insertSemester(term) {
  if (!term || !isOpenTerm(term)) return;
  if (!plannedSemesters.includes(term)) plannedSemesters.push(term);
  saveRoadmapToStorage();
  renderSemesterView();
  const col = document.querySelector(`.semester-col[data-semester="${term}"]`);
  if (col) col.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" });
}

/**
 * The term the "+" between two adjacent columns would add, or null if
 * nothing belongs there (or it wouldn't be a future term):
 *  - a gap (e.g. Fall 2026 → Fall 2027 after Spring 2027 was deleted)
 *    adds the missing regular term right after `left`
 *  - Fall → the next Spring adds the Winter session in between
 *  - Spring → the same year's Fall adds the Summer session in between
 */
function termBetween(left, right) {
  let candidate = null;
  const nextReg = nextRegularTerm(left);
  if (semesterSort(nextReg, right) < 0) {
    candidate = nextReg;
  } else {
    const [season, yearStr] = left.split(" ");
    const year = Number(yearStr);
    if (season === "Fall" && right === `Spring ${year + 1}`) candidate = `Winter ${year + 1}`;
    else if (season === "Spring" && right === `Fall ${year}`) candidate = `Summer ${year}`;
  }
  return candidate && isOpenTerm(candidate) ? candidate : null;
}

/** Future semesters can be removed: empty ones any time, ones with planned
 *  courses only in edit mode. Past/in-progress semesters never. */
function canRemoveSemester(group) {
  if (!hasRoadmap() || !isOpenTerm(group.semester)) return false;
  if (group.list.some(isLocked)) return false;
  return group.list.length === 0 || editing;
}

/** Deletes a future semester along with the planned courses in it. */
function removeSemester(term) {
  if (!isOpenTerm(term)) return;
  const inTerm = courses.filter((c) => c.semester === term && !c.transfer);
  if (inTerm.some(isLocked)) return;
  if (inTerm.length) {
    const list = inTerm.map((c) => c.code).join(", ");
    if (!confirm(`Remove ${term} and its ${inTerm.length} planned course${inTerm.length === 1 ? "" : "s"} (${list})?`)) return;
  }
  courses = courses.filter((c) => !(c.semester === term && !c.transfer));
  plannedSemesters = plannedSemesters.filter((t) => t !== term);
  saveRoadmapToStorage();
  refreshAllRoadmapViews();
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
/**
 * Opens the course details drawer. `options.preview` marks a course that
 * isn't in the plan (e.g. a catalog search result whose prerequisites block
 * adding it) — it gets no move/remove controls.
 */
function openDrawer(course, options = {}) {
  if (!course) return;
  const preview = !!options.preview;
  const locked = !preview && isLocked(course);
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

    <div class="drawer-section-label">${preview ? "Trying to add to" : locked ? (course.status === "completed" ? "Completed" : "In progress") : "Planned"}</div>
    <div class="drawer-planned">${course.semester || "Not scheduled"}</div>

    ${
      missingPrereq && (preview || course.status === "planned" || course.status === "unassigned")
        ? `<div class="drawer-warning"><svg class="icon" style="width:15px;height:15px;flex-shrink:0"><use href="#i-warning"/></svg><span>Missing prerequisite: ${missingPrereq} must be completed before ${course.code}${course.semester ? ` can be taken in ${course.semester}` : ""}.</span></div>`
        : ""
    }

    ${
      locked
        ? `<div class="drawer-locked"><svg class="icon" style="width:15px;height:15px;flex-shrink:0"><use href="#i-lock"/></svg><span>${course.status === "completed" ? "Completed" : "In-progress"} courses are part of your record, so they can't be moved or removed.</span></div>`
        : ""
    }

    <div class="drawer-actions">
      ${
        !preview && !locked
          ? `<div class="drawer-move-row">
              <select id="drawer-move-select" aria-label="Move to semester">
                ${openSemesters().map((t) => `<option value="${t}" ${t === course.semester ? "selected" : ""}>${t}</option>`).join("")}
              </select>
              <button class="btn" id="drawer-move">Move</button>
            </div>
            <div class="drawer-move-error" id="drawer-move-error" aria-live="polite"></div>`
          : ""
      }
      <button class="btn" id="drawer-ask">Ask AI About This</button>
      ${!preview && !locked ? `<button class="btn btn-danger" id="drawer-remove">Remove from Plan</button>` : ""}
    </div>
  `;

  content.querySelector("#drawer-ask").addEventListener("click", () => {
    closeDrawer();
    document.querySelector('.nav-item[data-page="advisor"]').click();
    window.__advisorSendMessage(`Tell me more about ${course.code}.`);
  });
  const moveBtn = content.querySelector("#drawer-move");
  if (moveBtn) {
    moveBtn.addEventListener("click", () => {
      const dest = content.querySelector("#drawer-move-select").value;
      if (dest === course.semester) return closeDrawer();
      const real = courses.find((c) => c.code === course.code);
      const blocking = moveCourse(real, dest);
      if (blocking) {
        content.querySelector("#drawer-move-error").textContent = `Can't move to ${dest}: ${blocking} must come first.`;
        return;
      }
      saveRoadmapToStorage();
      closeDrawer();
      refreshAllRoadmapViews();
    });
  }
  const removeBtn = content.querySelector("#drawer-remove");
  if (removeBtn) {
    removeBtn.addEventListener("click", () => {
      removeCourseFromPlan(course.code);
      saveRoadmapToStorage();
      closeDrawer();
      refreshAllRoadmapViews();
    });
  }

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
      removeCourseFromPlan(btn.dataset.remove); // no-op for locked courses
      saveRoadmapToStorage();
      refreshAllRoadmapViews();
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
  plannedSemesters = []; // a fresh audit starts a fresh plan
  saveRoadmapToStorage();
  editing = false; // fresh import — don't stay in a stale edit session

  applyOnboardingState();
  renderStudentIdentity();
  renderSnapshotBars();
  renderSemesterView();
  if (document.getElementById("requirement-view").classList.contains("active")) renderRequirementView();

  // The parser no longer guesses graduation from the audit — ask for it.
  if (!student.graduation) window.__openGradPrompt({ auto: true });
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
   SECTION 12b — target graduation term prompt
   ==========================================================================
   Shown right after an upload (the audit's own graduation field is
   unreliable, so the parser leaves it blank), on every subsequent page load
   while the roadmap still has no graduation term set, and whenever the
   student clicks the Expected Graduation date on the Roadmap page to
   change it.

   The two "no graduation set yet" cases (post-upload, page load) pass
   { auto: true } so each time the prompt is raised automatically it's
   also logged onto the saved roadmap record (gradPromptShownCount /
   gradPromptLastShown), not just held in memory for that one visit.
   ========================================================================== */
(function gradPromptModule() {
  const backdrop = document.getElementById("grad-backdrop");
  const modal = document.getElementById("grad-modal");
  const termSelect = document.getElementById("grad-term");
  const yearSelect = document.getElementById("grad-year");
  const saveBtn = document.getElementById("grad-save");
  const skipBtn = document.getElementById("grad-skip");
  const closeBtn = document.getElementById("grad-close");
  const editBtn = document.getElementById("dp-grad-date");
  const earliestEl = document.getElementById("grad-earliest");
  const errorEl = document.getElementById("grad-error");

  // Graduation happens in Spring or Fall only — no Summer graduation.
  const GRAD_TERMS = ["Spring", "Fall"];
  let earliest = null;

  const selected = () => `${termSelect.value} ${yearSelect.value}`;
  const isTooEarly = (term) => earliest && semesterSort(term, earliest.term) < 0;

  function fillYears(minYear, maxYear) {
    yearSelect.innerHTML = "";
    for (let y = minYear; y <= maxYear; y++) {
      const opt = document.createElement("option");
      opt.value = String(y);
      opt.textContent = String(y);
      yearSelect.appendChild(opt);
    }
  }

  // Disable term options that would land before the earliest realistic term.
  function syncTermOptions() {
    Array.from(termSelect.options).forEach((o) => {
      o.disabled = isTooEarly(`${o.value} ${yearSelect.value}`);
    });
    if (termSelect.selectedOptions[0] && termSelect.selectedOptions[0].disabled) {
      const firstOk = Array.from(termSelect.options).find((o) => !o.disabled);
      if (firstOk) termSelect.value = firstOk.value;
    }
    errorEl.textContent = "";
  }

  function open(options = {}) {
    if (!hasRoadmap()) return;
    // options.auto: true when this open() came from the "no graduation set"
    // check itself (post-upload or page load) rather than the student
    // clicking to edit an existing date. Record that on the saved roadmap
    // so it's part of the persisted record, not just an in-memory flag.
    if (options.auto) {
      student.gradPromptShownCount = (student.gradPromptShownCount || 0) + 1;
      student.gradPromptLastShown = new Date().toISOString();
      saveRoadmapToStorage();
    }
    earliest = earliestGraduation();
    const earliestYear = Number(earliest.term.split(" ")[1]);
    const thisYear = new Date().getFullYear();
    fillYears(Math.min(thisYear, earliestYear), Math.max(thisYear + 6, earliestYear + 4));
    Array.from(yearSelect.options).forEach((o) => {
      o.disabled = Number(o.value) < earliestYear;
    });

    const creditsNote = earliest.remainingCredits
      ? `${earliest.remainingCredits} credits left at up to ${MAX_CREDITS_PER_TERM} per semester`
      : "your credit total is covered";
    const chainNote = earliest.chainTerms ? `, and ${earliest.chainTerms} semester${earliest.chainTerms === 1 ? "" : "s"} of CS/math prerequisite chain still to go` : "";
    earliestEl.textContent = `Earliest realistic graduation: ${earliest.term} (${creditsNote}${chainNote}).`;

    const [term, year] = (student.graduation || "").split(" ");
    const current = GRAD_TERMS.includes(term) && year && !isTooEarly(student.graduation) ? student.graduation : earliest.term;
    const [cTerm, cYear] = current.split(" ");
    yearSelect.value = cYear;
    termSelect.value = cTerm;
    syncTermOptions();

    backdrop.classList.add("open");
    modal.classList.add("open");
    termSelect.focus();
  }

  function close() {
    backdrop.classList.remove("open");
    modal.classList.remove("open");
    errorEl.textContent = "";
  }

  yearSelect.addEventListener("change", syncTermOptions);
  termSelect.addEventListener("change", () => (errorEl.textContent = ""));

  saveBtn.addEventListener("click", () => {
    if (!hasRoadmap()) return close();
    const choice = selected();
    if (!GRAD_TERMS.includes(termSelect.value)) {
      errorEl.textContent = "Graduation must be in a Spring or Fall term.";
      return;
    }
    if (isTooEarly(choice)) {
      errorEl.textContent = `${choice} is earlier than your remaining requirements allow. The earliest realistic term is ${earliest.term}.`;
      return;
    }
    student.graduation = choice;
    // Keep student.year in sync so the AI sees the same standing the UI shows.
    student.year = deriveStanding(student.graduation);
    saveRoadmapToStorage();
    renderStudentIdentity();
    renderSemesterView();
    close();
  });
  skipBtn.addEventListener("click", close);
  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("click", close);
  editBtn.addEventListener("click", open);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.classList.contains("open")) close();
  });

  window.__openGradPrompt = open;
})();

/* ==========================================================================
   SECTION 12c — catalog search (add a course to a chosen semester)
   ========================================================================== */
function renderCatalogSemesterOptions() {
  const select = document.getElementById("catalog-search-semester");
  if (!select) return;
  const prev = select.value;
  const terms = openSemesters();
  select.innerHTML = terms.map((t) => `<option value="${t}">${t}</option>`).join("");
  select.value = terms.includes(prev) ? prev : terms[0];
  document.getElementById("catalog-search").hidden = !hasRoadmap();
}

(function catalogSearchModule() {
  const input = document.getElementById("catalog-search-input");
  const select = document.getElementById("catalog-search-semester");
  const results = document.getElementById("catalog-search-results");
  const statusEl = document.getElementById("catalog-search-status");
  const MAX_RESULTS = 8;

  const norm = (str) => str.toLowerCase().replace(/\s+/g, " ").trim();

  function search(query) {
    const q = norm(query);
    if (q.length < 2) return [];
    const compact = q.replace(/ /g, "");
    const words = q.split(" ");
    return catalog
      .filter((c) => creditsFromCatalog(c) > 0) // skip 0-credit labs / W sections
      .map((c) => {
        const code = c.code.toLowerCase();
        const title = c.title.toLowerCase();
        let score = 0;
        if (code === q || code.replace(" ", "") === compact) score = 100;
        else if (code.startsWith(q) || code.replace(" ", "").startsWith(compact)) score = 80;
        else if (words.every((w) => title.includes(w))) score = 50;
        else if (words.every((w) => `${code} ${title}`.includes(w))) score = 30;
        return { c, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.c.code.localeCompare(b.c.code))
      .slice(0, MAX_RESULTS)
      .map((r) => r.c);
  }

  function actionFor(entry) {
    const existing = findCourse(entry.code);
    if (!existing) return { label: "Add", disabled: false };
    if (existing.status === "completed") return { label: "Completed", disabled: true };
    if (existing.status === "current") return { label: "In progress", disabled: true };
    if (existing.semester === select.value) return { label: "In plan", disabled: true };
    return { label: `Move here`, disabled: false };
  }

  function render() {
    const list = search(input.value);
    if (!input.value.trim()) {
      results.innerHTML = "";
      return;
    }
    if (!catalog.length) {
      results.innerHTML = `<div class="cs-empty">The course catalog couldn't be loaded.</div>`;
      return;
    }
    if (!list.length) {
      results.innerHTML = `<div class="cs-empty">No catalog courses match “${input.value.trim()}”.</div>`;
      return;
    }
    results.innerHTML = list
      .map((c) => {
        const action = actionFor(c);
        const existing = findCourse(c.code);
        const where = existing && existing.semester && !isLocked(existing) ? `<span class="cs-where">Planned ${existing.semester}</span>` : "";
        return `
        <div class="cs-result">
          <div class="cs-info">
            <div class="cs-line"><span class="cs-code">${c.code}</span><span class="cs-title">${c.title}</span></div>
            <div class="cs-meta">${c.credits} credits${c.prerequisites.length ? ` · Prereqs: ${c.prerequisites.join("; ")}` : ""} ${where}</div>
          </div>
          <button type="button" class="btn cs-add" data-add="${c.code}" ${action.disabled ? "disabled" : ""}>${action.label}</button>
        </div>`;
      })
      .join("");
    results.querySelectorAll(".cs-add").forEach((btn) => btn.addEventListener("click", () => addFromCatalog(btn.dataset.add)));
  }

  function addFromCatalog(code) {
    const entry = catalogByCode.get(code);
    const dest = select.value;
    if (!entry || !dest) return;
    const existing = findCourse(code);
    if (existing && isLocked(existing)) return;

    let blocking;
    if (existing) {
      blocking = moveCourse(existing, dest);
    } else {
      const candidate = makePlannedCourse(entry, dest, "manual");
      blocking = candidate.prerequisites.find((p) => !prereqSatisfied(p, dest));
      if (!blocking) courses.push(candidate);
    }
    if (blocking) {
      statusEl.textContent = `Can't add ${code} to ${dest} yet: ${blocking} has to come first.`;
      openDrawer(existing ? { ...existing, semester: dest } : makePlannedCourse(entry, dest, "manual"), { preview: true });
      return;
    }
    if (!plannedSemesters.includes(dest) && !allSemesters().includes(dest)) plannedSemesters.push(dest);
    saveRoadmapToStorage();
    statusEl.textContent = `${existing ? "Moved" : "Added"} ${code} to ${dest}.`;
    refreshAllRoadmapViews();
    render();
  }

  input.addEventListener("input", () => {
    statusEl.textContent = "";
    render();
  });
  select.addEventListener("change", render);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      input.value = "";
      render();
    }
  });
  window.__renderCatalogSearch = render;
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
      draggedCode = null;
      if (!course || isLocked(course)) return; // completed / in-progress courses are locked
      if (!isOpenTerm(destSemester)) return; // can't plan into a term that's already underway or over

      const blocking = moveCourse(course, destSemester);
      if (blocking) {
        // Show the block in terms of where the student just tried to drop it,
        // not wherever the course happened to be sitting before the drag.
        openDrawer({ ...course, semester: destSemester }, { preview: true });
        return;
      }
      saveRoadmapToStorage();
      refreshAllRoadmapViews(); // credits, progress, and status recompute from the single source of truth
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
// The catalog powers search and the earliest-graduation estimate; re-render
// once it arrives so anything that depends on it is up to date.
loadCatalog().then(() => {
  renderSemesterView();
  window.__renderCatalogSearch();
  // Keep asking for a target graduation term on every visit — not just the
  // first time, right after an upload — until the student actually sets
  // one. Waiting for the catalog to load first keeps the "earliest
  // realistic graduation" estimate shown in the prompt accurate.
  if (hasRoadmap() && !student.graduation) window.__openGradPrompt({ auto: true });
});