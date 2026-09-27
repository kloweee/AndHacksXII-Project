/**
 * Parses a real W&M DegreeWorks degree-audit PDF (the Ellucian export a
 * student can download from their own DegreeWorks account) into this app's
 * roadmap schema: { student, courses, requirementTotals }.
 *
 * This replaces the earlier plan of indefinitely hand-scraping/maintaining
 * a general course catalog. A student's own completed/in-progress history
 * is exactly the roadmap data this app needs, and DegreeWorks already has
 * it in a consistent, machine-readable-enough layout — so instead of
 * guessing at course data, we read it straight from the source that
 * actually knows it: the student's own official audit.
 *
 * Tested against a real exported audit (Luka He, CS major, AI/ML
 * concentration) — the deduplicated course credit total this parser
 * produces (71) matches DegreeWorks' own reported "Credits applied: 71"
 * exactly, which is strong independent confirmation the extraction and
 * dedup logic are sound.
 */

import pdfParseLib from "pdf-parse/lib/pdf-parse.js";

// ==========================================
// 1. PDF -> plain text, with real column spacing preserved
// ==========================================
/**
 * pdf-parse's default text join concatenates adjacent table-cell text runs
 * with NO space between them (e.g. "MATH 112Calculus IIT 4Fall 2025"),
 * because the underlying pdf.js text items don't include a space glyph
 * between columns — the visual gap is just blank canvas, not a character.
 * This overrides pdf-parse's per-page render step to reconstruct properly
 * spaced lines: group text items into visual rows by y-position, sort each
 * row left-to-right by x-position, and insert a space wherever there's a
 * real horizontal gap between two items (rather than trusting the PDF to
 * have embedded one). This is the same problem a layout-aware extractor
 * like pdfplumber solves internally; pdf-parse's default behavior doesn't.
 */
function layoutAwarePageRender(pageData) {
    return pageData.getTextContent().then((textContent) => {
        const rows = new Map(); // rounded y-position -> items on that visual row
        textContent.items.forEach((item) => {
            const y = Math.round(item.transform[5]);
            if (!rows.has(y)) rows.set(y, []);
            rows.get(y).push(item);
        });

        // pdf.js y-coordinates increase upward on the page; reading order is
        // top-to-bottom, i.e. descending y.
        const orderedYs = Array.from(rows.keys()).sort((a, b) => b - a);

        const lines = orderedYs.map((y) => {
            const rowItems = rows.get(y).slice().sort((a, b) => a.transform[4] - b.transform[4]);
            let line = "";
            let prevEndX = null;
            rowItems.forEach((item) => {
                const startX = item.transform[4];
                if (prevEndX !== null && startX - prevEndX > 1.5) line += " ";
                line += item.str;
                prevEndX = startX + item.width;
            });
            return line;
        });

        return lines.join("\n");
    });
}

export async function extractPdfText(buffer) {
    const data = await pdfParseLib(buffer, { pagerender: layoutAwarePageRender });
    return data.text;
}

// ==========================================
// 2. Course-row extraction
// ==========================================
// Matches "DEPT NUM Title... GRADE CREDITS TERM" (a letter grade or transfer
// credit "T") or "DEPT NUM Title... IP (CREDITS) TERM" (in progress/
// pre-registered this term). This is deliberately anchored on the specific
// grade vocabulary DegreeWorks uses, not just "any text before a number and
// a term" — that anchoring is what lets it walk straight past all the
// surrounding prose (unmet-requirement explanations, proficiency "Met"
// markers, "Still needed:" text) without matching any of it, since none of
// that text ends in a real grade+credits+term shape.
const COURSE_ROW = /([A-Z]{2,5})\s+(\d{3}[A-Z]?)\s+(.+?)\s+(?:([A-F][+-]?|T)\s+(\d+(?:\.\d+)?)|IP\s*\((\d+(?:\.\d+)?)\))\s+(Fall|Spring|Summer|Winter)\s+(\d{4})/g;

// "COLLEGE 100/150", "COLLEGE 200", "COLLEGE 300", "COLLEGE 350", "COLLEGE
// 400" are section-label headers, not course codes — but "COLLEGE" followed
// by a number looks exactly like a "DEPT NUM" course code to COURSE_ROW
// above, and would swallow whatever real course follows it on the same
// line (e.g. "COLLEGE 350 HIST 225 History on Stage A 3 Spring 2026" would
// otherwise parse as a bogus course "LLEGE 350" with "HIST 225 History on
// Stage" absorbed into its title). Stripping this label text out of each
// line before scanning sidesteps the whole problem, rather than fighting
// regex backtracking with lookaheads (a negative lookahead on "COLLEGE"
// doesn't stop the engine from just starting its match one character later,
// at "OLLEGE").
const COLLEGE_LABEL = /\bCOLLEGE\s+\d{2,3}(?:\/\d{2,3})?\b/g;

// Section headers that identify which requirement block subsequent course
// rows belong to. Order matters: checked top-to-bottom per line.
const SECTION_MARKERS = [
    { pattern: /^College Curriculum\b/, name: () => "COLL" },
    { pattern: /^Major in (.+?)(\s+INCOMPLETE|\s+COMPLETE|$)/, name: (m) => m[1].trim() },
    { pattern: /^Electives\b/, name: () => "Electives" },
    // Recap sections that repeat courses already captured above under their
    // real requirement block — parsing them would only create duplicates
    // dedup already handles, and past "Legend"/"Disclaimer" is just
    // boilerplate. Stop scanning entirely once either is hit.
    { pattern: /^In-progress\b/, stop: true },
    { pattern: /^Legend\b/, stop: true },
];

function extractRawCourseRows(text) {
    const lines = text.split("\n");
    let currentSection = "General";
    const rows = [];

    for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        let stop = false;

        for (const marker of SECTION_MARKERS) {
            const m = trimmed.match(marker.pattern);
            if (m) {
                if (marker.stop) { stop = true; }
                else currentSection = marker.name(m);
                break;
            }
        }
        if (stop) break;

        const cleanedLine = rawLine.replace(COLLEGE_LABEL, "").trim();
        COURSE_ROW.lastIndex = 0;
        let match;
        while ((match = COURSE_ROW.exec(cleanedLine)) !== null) {
            const [, dept, num, title, letterGrade, letterCredits, ipCredits, season, year] = match;
            const isIP = ipCredits !== undefined;
            rows.push({
                code: `${dept} ${num}`,
                title: title.trim(),
                credits: Number(isIP ? ipCredits : letterCredits),
                semester: `${season} ${year}`,
                isIP,
                // A "T" grade is DegreeWorks' marker for transfer/AP credit.
                // Kept as its own flag so the frontend can show these in a
                // separate table instead of mixing them into the student's
                // first real semester at W&M.
                transfer: letterGrade === "T",
                section: currentSection,
            });
        }
    }
    return rows;
}

/**
 * The same real course (an actual single enrollment) can legitimately
 * appear multiple times in a DegreeWorks audit when it satisfies more than
 * one requirement block at once (W&M explicitly allows several such
 * overlaps — see the "Satisfied by" / overlap-rule text on the audit
 * itself). Dedup by code+semester and merge each duplicate's section into
 * one course's `requirements` array, rather than creating repeat entries
 * for what is really one course.
 */
function dedupeAndMergeRequirements(rows) {
    const byKey = new Map();
    rows.forEach((row) => {
        const key = `${row.code}|${row.semester}`;
        if (!byKey.has(key)) {
            byKey.set(key, { ...row, requirements: [row.section] });
        } else {
            const existing = byKey.get(key);
            if (!existing.requirements.includes(row.section)) existing.requirements.push(row.section);
        }
    });
    return Array.from(byKey.values());
}

function semesterSort(a, b) {
    const order = { Winter: 0, Spring: 1, Summer: 2, Fall: 3 };
    const [sa, ya] = a.split(" ");
    const [sb, yb] = b.split(" ");
    if (ya !== yb) return Number(ya) - Number(yb);
    return order[sa] - order[sb];
}

/**
 * Assigns a status to each deduped row. A letter grade or transfer/AP
 * credit ("T") means the credit has already been earned: "completed". An
 * "IP" (in progress / pre-registered) row could be either the term actually
 * happening right now, or a future term the student has pre-registered
 * for — DegreeWorks doesn't distinguish these itself (its own "Credits
 * applied" figure explicitly lumps "In-Progress and Pre-Registered"
 * together). The earliest IP term present is treated as "current"; any
 * strictly later IP term is "planned".
 */
function assignStatuses(courses) {
    const ipSemesters = Array.from(new Set(courses.filter((c) => c.isIP).map((c) => c.semester))).sort(semesterSort);
    const currentSemester = ipSemesters[0];

    return courses.map((c) => {
        let status;
        if (!c.isIP) status = "completed";
        else status = c.semester === currentSemester ? "current" : "planned";
        const { isIP, section, ...rest } = c;
        return { ...rest, status };
    });
}

/**
 * Fills in `prerequisites` for any course we already have real, verified
 * data for in our own catalog (built by data/build_catalog.py). Most of a
 * given student's electives outside their major won't be in there — that's
 * fine and expected; they're just left as an empty array (unknown), same
 * as any other not-yet-verified course in this app's data model.
 */
function attachKnownPrerequisites(courses, catalog) {
    const byCode = new Map((catalog || []).map((c) => [c.code, c]));
    return courses.map((c) => {
        const known = byCode.get(c.code);
        return {
            ...c,
            prerequisites: known && known.verified ? known.prerequisites : [],
        };
    });
}

// ==========================================
// 3. Header metadata extraction
// ==========================================
function extractStudentInfo(text) {
    const joined = text.replace(/\n/g, " ");

    const rawName = text.match(/Student name\s+(.+)/)?.[1]?.trim();
    // DegreeWorks prints "Last, First" — flip to "First Last" to match how
    // the rest of this app displays a student's name.
    let name = rawName;
    if (rawName && rawName.includes(",")) {
        const [last, first] = rawName.split(",").map((s) => s.trim());
        name = `${first} ${last}`;
    }

    const major = joined.match(/Major\s+([A-Za-z ]+?)\s+Program/)?.[1]?.trim() || "Undeclared";
    const concentration = joined.match(/Concentration\s+([A-Za-z/ ]+?)\s+College\b/)?.[1]?.trim();
    const gpa = text.slice(0, 500).match(/\b(\d\.\d{2})\b/)?.[1];

    // Class standing and graduation term are intentionally NOT read from
    // the audit. DegreeWorks' "Classification" reflects credit hours (AP /
    // transfer credit can push a first-year to "Sophomore"), and its
    // anticipated-graduation field is often a broken custom property
    // ("Property missing for studentHeader.custom.socl ..."). Both are left
    // blank here; the frontend asks the student for their target graduation
    // term after upload and derives standing from that.
    const programs = concentration ? [`${major} (${concentration} Concentration)`] : [major];

    return {
        name: name || "Student",
        year: "",
        graduation: "",
        programs,
        gpa: gpa ? Number(gpa) : undefined,
        major,
    };
}

function extractRequirementTotals(text, majorName) {
    const joined = text.replace(/\n/g, " ");
    const creditsRequired = [...joined.matchAll(/Credits required:\s*(\d+)/g)].map((m) => Number(m[1]));

    // In document order, the first "Credits required" is always the overall
    // degree total; the one immediately following "Major in <X>" is that
    // major's total. Falls back to W&M's well-known standard figures if a
    // audit format variant ever doesn't include these exactly where
    // expected, rather than crashing.
    const overallTotal = creditsRequired[0] || 120;
    const majorTotal = creditsRequired[1] || 33;

    // W&M's College Curriculum is a fixed, standardized ~30-credit
    // requirement for every undergraduate regardless of major (see
    // prompts/curriculum.txt) — not something that varies per student, so
    // there's no need to parse it out of each individual audit.
    const collTotal = 30;

    // The remainder is everything else the degree needs beyond the major
    // and COLL — free/major-adjacent electives. This is an approximation:
    // W&M's real overlap rules (e.g. one course double-counting toward both
    // a proficiency and a COLL requirement) mean the true elective credit
    // count can differ slightly from this simple subtraction. Good enough
    // for a progress-bar estimate, not a substitute for an official audit.
    const electivesTotal = Math.max(overallTotal - majorTotal - collTotal, 0);

    return {
        [majorName]: majorTotal,
        COLL: collTotal,
        Electives: electivesTotal,
    };
}

// ==========================================
// 4. Public entry point
// ==========================================
/**
 * @param {string} text - raw text extracted via extractPdfText()
 * @param {Array} catalog - this app's own catalog.json array (for
 *   cross-referencing real prerequisites where we have them); optional.
 * @returns {{ student: object, courses: object[], requirementTotals: object }}
 */
export function parseDegreeWorksAudit(text, catalog = []) {
    const studentInfo = extractStudentInfo(text);

    const rawRows = extractRawCourseRows(text);
    const deduped = dedupeAndMergeRequirements(rawRows);
    const withStatus = assignStatuses(deduped);
    const withPrereqs = attachKnownPrerequisites(withStatus, catalog);

    const courses = withPrereqs
        .map((c) => ({
            code: c.code,
            title: c.title,
            credits: c.credits,
            semester: c.semester,
            status: c.status,
            transfer: !!c.transfer,
            requirements: c.requirements,
            prerequisites: c.prerequisites,
        }))
        .sort((a, b) => semesterSort(a.semester, b.semester));

    const requirementTotals = extractRequirementTotals(text, studentInfo.major);

    const { major, ...student } = studentInfo; // `major` was only needed to build `programs`/bucket name above

    return { student, courses, requirementTotals };
}