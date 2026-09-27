import express from "express";
import dotenv from "dotenv";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import multer from "multer";
import { extractPdfText, parseDegreeWorksAudit } from "./lib/degreeworksParser.js";

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

// Kept in memory only for the length of one request — a DegreeWorks audit
// PDF is parsed and its result returned directly in the response; the
// server never stores it anywhere afterward. Persistence is the client's
// job (localStorage) — see the note above the chat endpoint below for why.
const degreeworksUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB is generous for a multi-page text PDF
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
    baseSystemInstruction = "You are a helpful W&M Computer Science course advisor.";
}

// ==========================================
// 2. LOAD THE STATIC COURSE DATA (CS catalog + CS major requirements only)
// ==========================================
// This app now focuses exclusively on Computer Science course planning, so
// there's a single major file and a catalog built only from real,
// hand-verified CS (and CS-prerequisite) course data — no more
// current-semester section scrape, since this app doesn't track when
// classes meet or who teaches them anymore.
const courseCatalog = JSON.parse(readFileSync('./data/catalog.json', 'utf-8'));

function buildStaticDataContext() {
    try {
        const majorsDir = './data/majors';
        const majorFiles = readdirSync(majorsDir).filter(f => f.endsWith('.json'));
        const majorsData = majorFiles.map(file => JSON.parse(readFileSync(join(majorsDir, file), 'utf-8')));

        // No indent: 2 here on purpose — pretty-printing this much JSON adds
        // a large amount of pure whitespace to something that's re-sent on
        // every single chat message. Minifying it is a direct, verifiable
        // cut to the per-message payload size.
        return `
---
INJECTED W&M DATA (USE ONLY THIS DATA, DO NOT INVENT OUTSIDE OF IT):

COURSE CATALOG:
${JSON.stringify(courseCatalog)}

MAJOR REQUIREMENTS:
${JSON.stringify(majorsData)}
`;
    } catch (err) {
        console.error("❌ Failed to read static course data:", err.message);
        return "\n\n[ERROR: Could not load course data]";
    }
}

const staticDataContext = buildStaticDataContext();
console.log("✅ Loaded static course data.");

// ==========================================
// 2b. PER-REQUEST STUDENT ROADMAP CONTEXT
// ==========================================
/**
 * There is no server-side student data store: the student's roadmap lives
 * only in their own browser's localStorage (populated by parsing their
 * DegreeWorks audit — see the import endpoint below), and the client sends
 * it along with each chat request. This keeps the server from ever holding
 * a persistent, cross-request copy of any student's personal academic
 * record — it only ever sees it for the duration of handling one request.
 */
function buildStudentRoadmapContext(roadmap) {
    if (!roadmap) {
        return `
---
STUDENT ROADMAP: none provided yet. Follow the ONBOARDING & CONTEXT
GATHERING rule above — tell the student to upload their DegreeWorks audit.
`;
    }
    return `
---
STUDENT ROADMAP (this is the student you are currently advising — see the
ONBOARDING & CONTEXT GATHERING rule above: use this instead of asking
onboarding questions it already answers):
${JSON.stringify(roadmap)}
`;
}

// ==========================================
// 3. THE CHAT ENDPOINT
// ==========================================
app.post("/api/chat", async (req, res) => {
    try {
        const { history, roadmap } = req.body;

        // Format frontend history into Gemini's expected structure
        const contents = history.map(turn => ({
            role: turn.role,
            parts: [{ text: turn.text }]
        }));

        // Built per-request from whatever roadmap the client sent (its own
        // localStorage copy) — see buildStudentRoadmapContext above.
        const systemInstructionText =
            baseSystemInstruction +
            buildStudentRoadmapContext(roadmap) +
            staticDataContext;

        // Single API call (No tools, no agent loop)
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
            body: JSON.stringify({
                contents,
                systemInstruction: { parts: [{ text: systemInstructionText }] },
                // Gemini 3.5 Flash defaults to "medium" internal reasoning
                // depth if this is left unset, which is paid for in both
                // latency and output tokens on every single message. This
                // advisor's job is mostly "read the injected context and
                // format a reply, occasionally sequence a prerequisite
                // chain" — not multi-step reasoning — so "low" is a direct,
                // real cut to per-message latency and cost. Bump to
                // "medium" if answers start looking shallow; drop to
                // "minimal" for max speed if "low" still looks solid.
                generationConfig: {
                    thinkingConfig: { thinkingLevel: "low" }
                }
            })
        });

        const data = await response.json();

        if (!response.ok) {
            console.error("Gemini API error:", data);
            return res.status(response.status).json({ error: data });
        }

        // Extract final text response
        const rawReply = data.candidates?.[0]?.content?.parts?.map(p => p.text).join("") ?? "(no response)";

        // model_spec.txt requires every reply to end with a numbered 3-4
        // item follow-up list. We split that list out of the reply text
        // here and send it back as its own `suggestions` array, which the
        // frontend renders as clickable pills — see splitReplyAndSuggestions
        // below. Without this split, the numbered list would show up both
        // inside the chat bubble AND as pills underneath it.
        const { cleanReply, suggestions } = splitReplyAndSuggestions(rawReply);

        res.json({
            reply: cleanReply,
            suggestions: suggestions,
        });

    } catch (err) {
        console.error("❌ Server error:", err);
        res.status(500).json({ error: "Something went wrong on the server." });
    }
});

// ==========================================
// 4. DEGREEWORKS IMPORT (stateless — parses and returns, stores nothing)
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
    if (course.transfer !== undefined && typeof course.transfer !== "boolean") errors.push(`${label}.transfer must be a boolean if present`);
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
        // year and graduation are allowed to be empty: the parser no longer
        // reads them from the audit, and the student sets their target
        // graduation term in the browser after upload.
        if (typeof student.year !== "string") errors.push("student.year must be a string (can be empty)");
        if (typeof student.graduation !== "string") errors.push("student.graduation must be a string (can be empty)");
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
 * POST /api/roadmap/import-degreeworks
 * Parses an uploaded DegreeWorks audit PDF and returns the resulting
 * roadmap directly in the response — see lib/degreeworksParser.js. The
 * server does not store this anywhere: the client is responsible for
 * saving the returned roadmap to its own localStorage, which is what makes
 * this "local to the student's computer" rather than a shared server-side
 * record.
 */
app.post("/api/roadmap/import-degreeworks", degreeworksUpload.single("file"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "No file uploaded — expected a PDF under the 'file' field." });
        }
        const isPdf = req.file.mimetype === "application/pdf" || req.file.originalname.toLowerCase().endsWith(".pdf");
        if (!isPdf) {
            return res.status(400).json({ error: "Please upload your DegreeWorks audit as a PDF." });
        }

        const text = await extractPdfText(req.file.buffer);
        const parsed = parseDegreeWorksAudit(text, courseCatalog);

        const errors = validateRoadmapPayload(parsed);
        if (errors.length) {
            console.error("Parsed DegreeWorks audit failed schema validation:", errors);
            return res.status(422).json({
                error: "Couldn't fully read this audit — it may be in an unexpected format.",
                details: errors,
            });
        }
        if (parsed.courses.length === 0) {
            return res.status(422).json({
                error: "No courses were found in this PDF. Please upload an unmodified DegreeWorks audit export.",
            });
        }

        console.log(`✅ Parsed DegreeWorks audit for ${parsed.student.name}: ${parsed.courses.length} courses`);
        res.json({ success: true, roadmap: parsed });

    } catch (err) {
        console.error("❌ Error importing DegreeWorks PDF:", err);
        res.status(500).json({ error: "Failed to parse the uploaded PDF. Please make sure it's an unmodified DegreeWorks audit export." });
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
    console.log(`🚀 TribeAdvisor (CS Schedule Advisor) running at http://localhost:${PORT}`);
});