import express from "express";
import dotenv from "dotenv";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

dotenv.config();
const app = express();
app.use(express.json());
app.use(express.static("public"));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-1.5-flash"; // Fast and handles large context well

if (!GEMINI_API_KEY) {
    console.error("❌ Missing GEMINI_API_KEY in .env");
    process.exit(1);
}

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
// 3. THE CHAT ENDPOINT (Simplified)
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
        res.json({ reply: replyText });

    } catch (err) {
        console.error("❌ Server error:", err);
        res.status(500).json({ error: "Something went wrong on the server." });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 TribeAdvisor (Direct Injection Mode) running at http://localhost:${PORT}`);
});