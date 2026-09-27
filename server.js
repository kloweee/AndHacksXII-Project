import express from "express";
import dotenv from "dotenv";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

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
// 0. IN-MEMORY ROADMAP STORE (TODO: replace with database)
// ==========================================
let roadmapStore = {
    student: {
        name: "Sophie Lin",
        year: "Sophomore",
        graduation: "Spring 2029",
        programs: ["Data Science", "Finance"]
    },
    courses: [
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
        { code: "FIN 341", title: "Financial Modeling", credits: 3, semester: "", status: "unassigned", requirements: ["Finance"], prerequisites: ["FIN 301"] }
    ],
    requirementTotals: {
        "Data Science": 11,
        "Finance": 8,
        "COLL": 6,
        "Electives": 8
    }
};

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
        const replyText = data.candidates?.[0]?.content?.parts?.map(p => p.text).join("") ?? "(no response)";
        
        // Optional: parse the reply to extract course suggestions or structured recommendations
        // For now, we'll return a basic structure that can be extended
        const suggestions = extractSuggestions(replyText);
        
        res.json({ 
            reply: replyText,
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

/**
 * GET /api/roadmap
 * Returns the full roadmap: student info, courses, and requirement totals
 */
app.get("/api/roadmap", (req, res) => {
    try {
        res.json(roadmapStore);
    } catch (err) {
        console.error("❌ Error fetching roadmap:", err);
        res.status(500).json({ error: "Failed to fetch roadmap" });
    }
});

/**
 * PUT /api/roadmap
 * Updates the full roadmap (replace entire structure)
 */
app.put("/api/roadmap", (req, res) => {
    try {
        const { student, courses, requirementTotals } = req.body;
        
        if (!student || !courses || !requirementTotals) {
            return res.status(400).json({ error: "Missing required fields: student, courses, requirementTotals" });
        }
        
        roadmapStore = { student, courses, requirementTotals };
        console.log("✅ Roadmap updated");
        res.json({ success: true, roadmap: roadmapStore });
        
    } catch (err) {
        console.error("❌ Error updating roadmap:", err);
        res.status(500).json({ error: "Failed to update roadmap" });
    }
});

/**
 * PATCH /api/roadmap/courses/:code
 * Updates a single course by code
 */
app.patch("/api/roadmap/courses/:code", (req, res) => {
    try {
        const { code } = req.params;
        const updates = req.body;
        
        const course = roadmapStore.courses.find(c => c.code === code);
        if (!course) {
            return res.status(404).json({ error: `Course ${code} not found` });
        }
        
        // Only allow updating specific fields
        const allowedFields = ["semester", "status", "title", "credits", "requirements", "prerequisites"];
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
 * Adds a new course to the roadmap
 */
app.post("/api/roadmap/courses", (req, res) => {
    try {
        const courseData = req.body;
        
        if (!courseData.code || !courseData.title) {
            return res.status(400).json({ error: "Missing required fields: code, title" });
        }
        
        // Check if course already exists
        if (roadmapStore.courses.find(c => c.code === courseData.code)) {
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
        
        roadmapStore.courses.push(newCourse);
        console.log(`✅ Course ${courseData.code} added`);
        res.status(201).json({ success: true, course: newCourse });
        
    } catch (err) {
        console.error("❌ Error adding course:", err);
        res.status(500).json({ error: "Failed to add course" });
    }
});

/**
 * DELETE /api/roadmap/courses/:code
 * Removes a course from the roadmap
 */
app.delete("/api/roadmap/courses/:code", (req, res) => {
    try {
        const { code } = req.params;
        const index = roadmapStore.courses.findIndex(c => c.code === code);
        
        if (index === -1) {
            return res.status(404).json({ error: `Course ${code} not found` });
        }
        
        const removed = roadmapStore.courses.splice(index, 1);
        console.log(`✅ Course ${code} removed`);
        res.json({ success: true, course: removed[0] });
        
    } catch (err) {
        console.error("❌ Error deleting course:", err);
        res.status(500).json({ error: "Failed to delete course" });
    }
});

// ==========================================
// 5. HELPER: Extract suggestions from AI reply
// ==========================================
function extractSuggestions(replyText) {
    // Simple heuristic: look for bullet points or numbered items in the reply
    // This is a placeholder; you could implement more sophisticated NLP here
    const lines = replyText.split('\n');
    const suggestions = [];
    
    for (const line of lines) {
        // Match lines starting with -, •, *, or numbers followed by . or )
        if (/^\s*[-•*]\s+|^\s*\d+[\.)]\s+/.test(line)) {
            const text = line.replace(/^\s*[-•*]\s+|^\s*\d+[\.)]\s+/, '').trim();
            if (text && text.length > 10 && text.length < 150) {
                suggestions.push(text);
            }
        }
    }
    
    // Return up to 3 suggestions
    return suggestions.slice(0, 3);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 TribeAdvisor (Direct Injection Mode) running at http://localhost:${PORT}`);
});