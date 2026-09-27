import express from "express";
import dotenv from "dotenv";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

dotenv.config();
const app = express();
app.use(express.json());
app.use(express.static("public"));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-3.5-flash"; // Current Gemini flash model, supports generateContent

if (!GEMINI_API_KEY) {
    console.error("❌ Missing GEMINI_API_KEY in .env");
    process.exit(1);
}

// ==========================================
// 0. PER-SESSION ROADMAP STORE (TODO: replace with a real database)
// ==========================================
// Each browser gets its own roadmap, keyed by an anonymous session cookie,
// instead of everyone sharing one global object — so two people using the
// demo at the same time (e.g. two hackathon judges) don't overwrite each
// other's edits. This is still in-memory (a server restart wipes every
// session), which is an acceptable trade-off for a demo; swap the Map
// below for a real datastore, keyed the same way, when this goes further.

const SESSION_COOKIE = "wm_advisor_sid";
const roadmapStores = new Map(); // sessionId -> { student, courses, requirementTotals }

// The starting roadmap every new session gets is fictional demo data for
// "Sophie Lin" — see data/mock/sophie-lin-roadmap.json. That file (and this
// one require line) can be deleted once real student data is wired up.
const mockRoadmapSeed = JSON.parse(readFileSync("./data/mock/sophie-lin-roadmap.json", "utf-8"));

function cloneSeedRoadmap() {
    // Every session needs its own independent copy — mutating one
    // session's courses array must never leak into another's.
    return {
        student: structuredClone(mockRoadmapSeed.student),
        courses: structuredClone(mockRoadmapSeed.courses),
        requirementTotals: structuredClone(mockRoadmapSeed.requirementTotals),
    };
}

function parseCookies(header) {
    const out = {};
    if (!header) return out;
    header.split(";").forEach((pair) => {
        const idx = pair.indexOf("=");
        if (idx === -1) return;
        const key = pair.slice(0, idx).trim();
        const val = pair.slice(idx + 1).trim();
        if (key) out[key] = decodeURIComponent(val);
    });
    return out;
}

// Assigns/reads an anonymous session id on every request and exposes the
// matching roadmap as req.roadmap (get returns it, set replaces it). Every
// route below relies on this middleware having already run.
app.use((req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    let sid = cookies[SESSION_COOKIE];

    if (!sid || !roadmapStores.has(sid)) {
        sid = randomUUID();
        roadmapStores.set(sid, cloneSeedRoadmap());
        res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${sid}; HttpOnly; Path=/; SameSite=Lax`);
    }

    req.sessionId = sid;
    Object.defineProperty(req, "roadmap", {
        get() {
            return roadmapStores.get(sid);
        },
        set(value) {
            roadmapStores.set(sid, value);
        },
    });
    next();
});

// ==========================================
// 1. LOAD THE BEHAVIORAL PROMPTS
// ==========================================
const promptsDir = "./prompts";
let baseSystemInstruction = "";

try {
    baseSystemInstruction = readdirSync(promptsDir)
        .filter(f => f.endsWith(".txt"))
        .sort()
        .map(f => readFileSync(join(promptsDir, f), "utf-8"))
        .join("\n\n---\n\n");
    console.log("✅ Loaded behavioral prompts from /prompts folder.");
} catch (err) {
    console.warn("⚠️ Could not load prompts folder. Using fallback.");
    baseSystemInstruction = "You are a helpful W&M academic advisor.";
}

// ==========================================
// 2. LOAD & INJECT THE MOCK DATA
// ==========================================
function buildFinalSystemInstruction() {
    try {
        // Read the JSON files directly from the data/ folder
        const catalog = JSON.parse(readFileSync('./data/catalog.json', 'utf-8'));
        const sections = JSON.parse(readFileSync('./data/sections.json', 'utf-8'));
        
        // Read all major requirement files
        const majorsDir = './data/majors';
        const majorFiles = readdirSync(majorsDir).filter(f => f.endsWith('.json'));
        let majorsData = [];
        for (const file of majorFiles) {
            majorsData.push(JSON.parse(readFileSync(join(majorsDir, file), 'utf-8')));
        }

        // Format the data into a readable string for the AI
        const dataContext = `
---
INJECTED W&M DATA (USE ONLY THIS DATA, DO NOT INVENT OUTSIDE OF IT):

COURSE CATALOG:
${JSON.stringify(catalog, null, 2)}

CURRENT SEMESTER SECTIONS:
${JSON.stringify(sections, null, 2)}

MAJOR REQUIREMENTS:
${JSON.stringify(majorsData, null, 2)}
`;
        // Combine the behavioral rules with the raw data
        return baseSystemInstruction + dataContext;

    } catch (err) {
        console.error("❌ Failed to read mock data:", err.message);
        return baseSystemInstruction + "\n\n[ERROR: Could not load course data]";
    }
}

// Build the instruction once at startup (or you could move this inside the route if you want it to reload on every message)
const finalSystemInstruction = buildFinalSystemInstruction();
console.log("✅ Injected mock data into system instruction.");

// ==========================================
// 3. THE CHAT ENDPOINT (Enhanced)
// ==========================================
app.post("/api/chat", async (req, res) => {
    try {
        const { history } = req.body;
        
        // Format frontend history into Gemini's expected structure
        const contents = history.map(turn => ({
            role: turn.role,
            parts: [{ text: turn.text }]
        }));

        // Single API call (No tools, no agent loop)
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
            body: JSON.stringify({
                contents,
                systemInstruction: { parts: [{ text: finalSystemInstruction }] }
            })
        });

        const data = await response.json();
        
        if (!response.ok) {
            console.error("Gemini API error:", data);
            return res.status(response.status).json({ error: data });
        }

        // Extract final text response
        const rawReply = data.candidates?.[0]?.content?.parts?.map(p => p.text).join("") ?? "(no response)";

        // model_spec.txt requires every model reply to end with a numbered
        // 3-4 item follow-up list. We split that list out of the reply text
        // here and send it back as its own `suggestions` array, which the
        // frontend renders as clickable pills — see splitReplyAndSuggestions
        // below. Without this split, the numbered list would show up both
        // inside the chat bubble AND as pills underneath it.
        const { cleanReply, suggestions } = splitReplyAndSuggestions(rawReply);

        res.json({ 
            reply: cleanReply,
            suggestions: suggestions,
            courses: [] // TODO: extract course recommendations from reply if needed
        });

    } catch (err) {
        console.error("❌ Server error:", err);
        res.status(500).json({ error: "Something went wrong on the server." });
    }
});

// ==========================================
// 4. ROADMAP ENDPOINTS
// ==========================================

const VALID_STATUSES = ["completed", "current", "planned", "unassigned", "problem"];

function isNonEmptyString(v) {
    return typeof v === "string" && v.trim().length > 0;
}

function isStringArray(v) {
    return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Validates a single course object. Returns an array of human-readable
 * error strings (empty array = valid).
 */
function validateCourse(course, index) {
    const label = `courses[${index}]`;
    if (typeof course !== "object" || course === null || Array.isArray(course)) {
        return [`${label} must be an object`];
    }
    const errors = [];
    if (!isNonEmptyString(course.code)) errors.push(`${label}.code must be a non-empty string`);
    if (!isNonEmptyString(course.title)) errors.push(`${label}.title must be a non-empty string`);
    if (typeof course.credits !== "number" || course.credits <= 0) errors.push(`${label}.credits must be a positive number`);
    if (typeof course.semester !== "string") errors.push(`${label}.semester must be a string (can be empty)`);
    if (!VALID_STATUSES.includes(course.status)) errors.push(`${label}.status must be one of: ${VALID_STATUSES.join(", ")}`);
    if (!isStringArray(course.requirements)) errors.push(`${label}.requirements must be an array of strings`);
    if (!isStringArray(course.prerequisites)) errors.push(`${label}.prerequisites must be an array of strings`);
    return errors;
}

/**
 * Validates a full roadmap payload (student, courses, requirementTotals).
 * Returns an array of human-readable error strings (empty array = valid).
 */
function validateRoadmapPayload(body) {
    const errors = [];
    const { student, courses, requirementTotals } = body || {};

    if (typeof student !== "object" || student === null || Array.isArray(student)) {
        errors.push("student must be an object");
    } else {
        if (!isNonEmptyString(student.name)) errors.push("student.name must be a non-empty string");
        if (!isNonEmptyString(student.year)) errors.push("student.year must be a non-empty string");
        if (!isNonEmptyString(student.graduation)) errors.push("student.graduation must be a non-empty string");
        if (!isStringArray(student.programs)) errors.push("student.programs must be an array of strings");
    }

    if (!Array.isArray(courses)) {
        errors.push("courses must be an array");
    } else {
        const seenCodes = new Set();
        courses.forEach((course, i) => {
            errors.push(...validateCourse(course, i));
            if (course && typeof course.code === "string") {
                if (seenCodes.has(course.code)) errors.push(`courses[${i}].code "${course.code}" is a duplicate`);
                seenCodes.add(course.code);
            }
        });
    }

    if (typeof requirementTotals !== "object" || requirementTotals === null || Array.isArray(requirementTotals)) {
        errors.push("requirementTotals must be an object");
    } else {
        Object.entries(requirementTotals).forEach(([key, value]) => {
            if (typeof value !== "number" || value <= 0) errors.push(`requirementTotals.${key} must be a positive number`);
        });
    }

    return errors;
}

/**
 * GET /api/roadmap
 * Returns the full roadmap for this session: student info, courses, and
 * requirement totals.
 */
app.get("/api/roadmap", (req, res) => {
    try {
        res.json(req.roadmap);
    } catch (err) {
        console.error("❌ Error fetching roadmap:", err);
        res.status(500).json({ error: "Failed to fetch roadmap" });
    }
});

/**
 * PUT /api/roadmap
 * Replaces this session's entire roadmap. Every field is validated —
 * courses in particular must be a well-formed array, not just "truthy" —
 * so a malformed request can't corrupt the stored roadmap.
 */
app.put("/api/roadmap", (req, res) => {
    try {
        const errors = validateRoadmapPayload(req.body);
        if (errors.length) {
            return res.status(400).json({ error: "Invalid roadmap payload", details: errors });
        }

        const { student, courses, requirementTotals } = req.body;
        req.roadmap = { student, courses, requirementTotals };
        console.log(`✅ Roadmap updated (session ${req.sessionId.slice(0, 8)}…)`);
        res.json({ success: true, roadmap: req.roadmap });
        
    } catch (err) {
        console.error("❌ Error updating roadmap:", err);
        res.status(500).json({ error: "Failed to update roadmap" });
    }
});

/**
 * PATCH /api/roadmap/courses/:code
 * Updates a single course by code, in this session's roadmap.
 */
app.patch("/api/roadmap/courses/:code", (req, res) => {
    try {
        const { code } = req.params;
        const updates = req.body || {};

        const course = req.roadmap.courses.find(c => c.code === code);
        if (!course) {
            return res.status(404).json({ error: `Course ${code} not found` });
        }

        // Only allow updating specific fields, and validate each one that's present
        const allowedFields = ["semester", "status", "title", "credits", "requirements", "prerequisites"];
        const errors = [];
        if ("semester" in updates && typeof updates.semester !== "string") errors.push("semester must be a string (can be empty)");
        if ("status" in updates && !VALID_STATUSES.includes(updates.status)) errors.push(`status must be one of: ${VALID_STATUSES.join(", ")}`);
        if ("title" in updates && !isNonEmptyString(updates.title)) errors.push("title must be a non-empty string");
        if ("credits" in updates && (typeof updates.credits !== "number" || updates.credits <= 0)) errors.push("credits must be a positive number");
        if ("requirements" in updates && !isStringArray(updates.requirements)) errors.push("requirements must be an array of strings");
        if ("prerequisites" in updates && !isStringArray(updates.prerequisites)) errors.push("prerequisites must be an array of strings");
        if (errors.length) {
            return res.status(400).json({ error: "Invalid course update", details: errors });
        }

        allowedFields.forEach(field => {
            if (field in updates) {
                course[field] = updates[field];
            }
        });
        
        console.log(`✅ Course ${code} updated`);
        res.json({ success: true, course });
        
    } catch (err) {
        console.error("❌ Error updating course:", err);
        res.status(500).json({ error: "Failed to update course" });
    }
});

/**
 * POST /api/roadmap/courses
 * Adds a new course to this session's roadmap.
 */
app.post("/api/roadmap/courses", (req, res) => {
    try {
        const courseData = req.body || {};

        if (!isNonEmptyString(courseData.code) || !isNonEmptyString(courseData.title)) {
            return res.status(400).json({ error: "Missing required fields: code, title" });
        }
        if ("credits" in courseData && (typeof courseData.credits !== "number" || courseData.credits <= 0)) {
            return res.status(400).json({ error: "credits must be a positive number" });
        }
        if ("requirements" in courseData && !isStringArray(courseData.requirements)) {
            return res.status(400).json({ error: "requirements must be an array of strings" });
        }
        if ("prerequisites" in courseData && !isStringArray(courseData.prerequisites)) {
            return res.status(400).json({ error: "prerequisites must be an array of strings" });
        }
        if ("status" in courseData && !VALID_STATUSES.includes(courseData.status)) {
            return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` });
        }

        // Check if course already exists
        if (req.roadmap.courses.find(c => c.code === courseData.code)) {
            return res.status(409).json({ error: `Course ${courseData.code} already exists` });
        }
        
        const newCourse = {
            code: courseData.code,
            title: courseData.title,
            credits: courseData.credits || 3,
            semester: courseData.semester || "",
            status: courseData.status || "unassigned",
            requirements: courseData.requirements || [],
            prerequisites: courseData.prerequisites || []
        };
        
        req.roadmap.courses.push(newCourse);
        console.log(`✅ Course ${courseData.code} added`);
        res.status(201).json({ success: true, course: newCourse });
        
    } catch (err) {
        console.error("❌ Error adding course:", err);
        res.status(500).json({ error: "Failed to add course" });
    }
});

/**
 * DELETE /api/roadmap/courses/:code
 * Removes a course from this session's roadmap.
 */
app.delete("/api/roadmap/courses/:code", (req, res) => {
    try {
        const { code } = req.params;
        const index = req.roadmap.courses.findIndex(c => c.code === code);
        
        if (index === -1) {
            return res.status(404).json({ error: `Course ${code} not found` });
        }
        
        const removed = req.roadmap.courses.splice(index, 1);
        console.log(`✅ Course ${code} removed`);
        res.json({ success: true, course: removed[0] });
        
    } catch (err) {
        console.error("❌ Error deleting course:", err);
        res.status(500).json({ error: "Failed to delete course" });
    }
});

// ==========================================
// 5. HELPER: Split the model's reply from its trailing suggestion list
// ==========================================
/**
 * model_spec.txt requires every reply to end with a numbered 3-4 item
 * follow-up list. This walks the reply backwards from the last line,
 * collecting a contiguous trailing block of numbered lines (blank lines
 * inside/around that block are tolerated), and returns the reply with that
 * block removed plus the block's items as a separate suggestions array.
 * That way the frontend can render the list once, as clickable pills,
 * instead of it appearing both in the chat bubble and as pills below it.
 */
function splitReplyAndSuggestions(replyText) {
    const numberedPattern = /^\s*\d+[.)]\s+/;
    const lines = replyText.split("\n");

    let splitIndex = lines.length;
    let foundNumbered = false;

    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (line.trim() === "") continue; // tolerate blank lines around/within the block
        if (numberedPattern.test(line)) {
            foundNumbered = true;
            splitIndex = i;
            continue;
        }
        break; // hit real content that isn't part of the numbered list — stop
    }

    if (!foundNumbered) {
        return { cleanReply: replyText.trim(), suggestions: [] };
    }

    const cleanReply = lines.slice(0, splitIndex).join("\n").trim();
    const suggestions = lines
        .slice(splitIndex)
        .filter(line => numberedPattern.test(line))
        .map(line => line.replace(numberedPattern, "").trim())
        .filter(Boolean)
        .slice(0, 4); // spec allows 3 or 4 follow-ups

    return { cleanReply, suggestions };
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 TribeAdvisor (Direct Injection Mode) running at http://localhost:${PORT}`);
});
