import express from "express";
import dotenv from "dotenv";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

// Note: We still import the skills, but we won't use them if the toggle is ON
import * as catalogTools from "./skills/catalog_tools.js";
import * as majorTools from "./skills/major_tools.js";

dotenv.config();
const app = express();
app.use(express.json());
app.use(express.static("public"));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-1.5-flash";

if (!GEMINI_API_KEY) {
    console.error("❌ Missing GEMINI_API_KEY in .env");
    process.exit(1);
}

// ==========================================
// 🚦 THE TOGGLE: Set to true to test without skills!
// ==========================================
// When TRUE: Reads data/ folder directly and stuffs it into the prompt.
// When FALSE: Uses the partner's skills/ folder via Gemini Function Calling.
const BYPASS_SKILLS_FOR_TESTING = true; 

// ==========================================
// 1. THE TRUST ANCHOR (System Instruction)
// ==========================================
const promptsDir = "./prompts";
let baseSystemInstruction = "";

try {
    baseSystemInstruction = readdirSync(promptsDir)
        .filter(f => f.endsWith(".txt"))
        .sort()
        .map(f => readFileSync(join(promptsDir, f), "utf-8"))
        .join("\n\n---\n\n");
    console.log("✅ Loaded system prompts from /prompts folder.");
} catch (err) {
    console.warn("⚠️ Could not load prompts folder. Using fallback.");
    baseSystemInstruction = "You are a helpful W&M academic advisor.";
}

// ==========================================
// 2. THE BYPASS MECHANISM (Direct Data Injection)
// ==========================================
let finalSystemInstruction = baseSystemInstruction;
let toolDefinitions = null; // Will stay null if bypassing

if (BYPASS_SKILLS_FOR_TESTING) {
    console.log("⚠️ BYPASSING SKILLS: Injecting mock data directly into prompt for testing.");
    
    try {
        // Read data directly from the data/ folder
        const catalog = JSON.parse(readFileSync('./data/catalog.json', 'utf-8'));
        const sections = JSON.parse(readFileSync('./data/sections.json', 'utf-8'));
        
        // Read all major files
        const majorsDir = './data/majors';
        const majorFiles = readdirSync(majorsDir).filter(f => f.endsWith('.json'));
        let majorsText = "";
        for (const file of majorFiles) {
            const majorData = JSON.parse(readFileSync(join(majorsDir, file), 'utf-8'));
            majorsText += `\n- ${majorData.major_name} requires: ${majorData.required_core.join(", ")}`;
        }

        // Append the raw JSON data directly to the system prompt
        finalSystemInstruction += `\n\n---\nINJECTED MOCK DATA FOR TESTING (DO NOT INVENT OUTSIDE THIS DATA):\n`;
        finalSystemInstruction += `COURSE CATALOG: ${JSON.stringify(catalog)}\n`;
        finalSystemInstruction += `CURRENT SECTIONS: ${JSON.stringify(sections)}\n`;
        finalSystemInstruction += `MAJOR REQUIREMENTS: ${majorsText}\n`;
        
    } catch (err) {
        console.error("❌ Failed to read mock data for bypass:", err.message);
    }
} else {
    // If NOT bypassing, load the Tool Definitions for the partner's skills
    console.log("🛠️ USING SKILLS: Function calling is active.");
    toolDefinitions = {
        functionDeclarations: [
            {
                name: "search_courses",
                description: "Searches the W&M course catalog by department, COLL attribute, or keyword.",
                parameters: { type: "OBJECT", properties: { department: { type: "STRING" }, attribute: { type: "STRING" }, keyword: { type: "STRING" } } }
            },
            {
                name: "get_course_details",
                description: "Gets full details and prerequisites for a specific course code.",
                parameters: { type: "OBJECT", properties: { course_code: { type: "STRING" } }, required: ["course_code"] }
            },
            {
                name: "get_major_requirements",
                description: "Gets the required core courses for a specific major track.",
                parameters: { type: "OBJECT", properties: { major_name: { type: "STRING" } }, required: ["major_name"] }
            }
        ]
    };
}

const availableSkills = {
    search_courses: catalogTools.search_courses,
    get_course_details: catalogTools.get_course_details,
    get_major_requirements: majorTools.get_major_requirements
};

// ==========================================
// 3. THE AGENT LOOP (Chat Endpoint)
// ==========================================
app.post("/api/chat", async (req, res) => {
    try {
        const { history } = req.body;
        
        let contents = history.map(turn => ({
            role: turn.role,
            parts: [{ text: turn.text }]
        }));

        // Build the base API request body
        let requestBody = {
            contents,
            systemInstruction: { parts: [{ text: finalSystemInstruction }] }
        };

        // Only add tools if we are NOT bypassing
        if (toolDefinitions) {
            requestBody.tools = [toolDefinitions];
        }

        // --- STEP 1: Initial API Call ---
        let response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
            body: JSON.stringify(requestBody)
        });

        let data = await response.json();
        let parts = data.candidates?.[0]?.content?.parts;

        // --- STEP 2: Check for Function Calls (Only runs if BYPASS is FALSE) ---
        if (!BYPASS_SKILLS_FOR_TESTING && parts && parts.some(p => p.functionCall)) {
            console.log("🤖 AI is invoking a skill...");
            
            for (const part of parts) {
                if (part.functionCall) {
                    const { name, args } = part.functionCall;
                    console.log(`   ↳ Executing: ${name} with args:`, args);
                    
                    const skillResult = availableSkills[name](args);
                    
                    contents.push({ role: "model", parts: [{ functionCall: part.functionCall }] });
                    contents.push({ role: "function", parts: [{ functionResponse: { name: name, response: { result: skillResult } } }] });
                }
            }

            // --- STEP 3: Second API Call with Tool Results ---
            response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
                body: JSON.stringify(requestBody) // Re-use the body which now has updated contents
            });
            data = await response.json();
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
    console.log(`🚀 TribeAdvisor running at http://localhost:${PORT}`);
});