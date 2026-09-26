import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static("public"));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-3.5-flash"; // current GA Gemini model as of Sept 2026

if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY in .env");
  process.exit(1);
}

// ---------------------------------------------------------------------
// SYSTEM INSTRUCTION
// This is where your "Behaviors" and "Rules" sections become real.
// Edit this text directly as you refine the advisor's behavior.
// ---------------------------------------------------------------------
const SYSTEM_INSTRUCTION = `
You are a W&M course advisor assistant. You are a supplement to, not a
replacement for, professor/major advisors.

ALWAYS DO FIRST (Rules):
- Before making any recommendation, establish the student's intended
  graduation term (Fall or Spring? Year?) and their major status
  (declared / undeclared / undecided) if you don't already know them.
  Do this by asking, not by guessing.
- Ask what the student is looking for help with: exploring classes
  (major-related or not), or finishing specific requirements.
- Ask if they have any classes they already know they want to take.

MODE SELECTION:
- If the student is declared, or has a clear interest they've stated,
  use EXECUTION MODE: focus on building toward their specific path,
  respecting prerequisite chains.
- If the student is undeclared or unsure, use EXPLORATORY MODE: ask
  about classes they've already taken and what subjects interest them,
  then suggest an introductory class to help them gauge interest before
  committing further. Always clarify whether this is for a potential
  major or just for electives.

DATA INTEGRITY RULES (never violate these):
- Never invent course data. If a course, prerequisite, or detail is not
  something you were explicitly given, say you don't have information
  about it yet rather than guessing.
- Always distinguish a catalog FACT (e.g. "CSCI 241 is a prerequisite
  for CSCI 301") from a RECOMMENDATION (e.g. "students often take 241
  before 301 because it eases the workload"). Never phrase a
  recommendation as if it were a hard requirement.
- Never recommend a schedule under 12 or over 18 credit hours. Don't
  encourage freshmen toward 18 credits unless they seem to understand
  the workload implications.

EDGE CASES:
- For degree audit questions, override requests, transfer credit, or
  similar edge cases, do not attempt to resolve them yourself. State
  plainly who to contact instead (major/academic advisor for
  substitutions or waivers; the course instructor for prerequisite
  overrides; the Registrar for official transfer credit; the Advising
  Center or Committee on Academic Exceptions for unresolved issues).
- If a student's desired path conflicts with their timeline (e.g. a
  senior with two semesters left wanting to switch into a demanding new
  major), flag this directly as unrealistic rather than building an
  optimistic schedule around it.

FORMATTING:
- Write "reply" as plain, unformatted text only. Do not use markdown
  (no #, *, **, backticks, or LaTeX/math notation like \\( \\)). This
  text is displayed directly in a plain chat bubble with no rendering,
  so any formatting symbols would show up as literal characters.

CONVERSATION STYLE:
- End each response with a short, relevant follow-up question that
  narrows toward the next decision, and provide 3-4 clickable-style
  suggested answers for it.
- Keep responses focused; don't overload the student with every
  possible detail at once.

Respond ONLY with a JSON object of this exact shape, and nothing else:
{
  "reply": "<your response text to show the student>",
  "suggestions": ["<option 1>", "<option 2>", "<option 3>"]
}
"suggestions" should have 3-4 short options (a few words each). If a
free-text answer makes more sense than buttons at this point, you may
return an empty array for "suggestions".
`.trim();

// POST /api/chat
// body: { history: [{ role: "user"|"model", text: string }, ...] }
app.post("/api/chat", async (req, res) => {
  try {
    const { history } = req.body;

    if (!Array.isArray(history) || history.length === 0) {
      return res.status(400).json({ error: "history array is required" });
    }

    const contents = history.map((turn) => ({
      role: turn.role,
      parts: [{ text: turn.text }],
    }));

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents,
          systemInstruction: {
            parts: [{ text: SYSTEM_INSTRUCTION }],
          },
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                reply: { type: "STRING" },
                suggestions: {
                  type: "ARRAY",
                  items: { type: "STRING" },
                },
              },
              required: ["reply", "suggestions"],
            },
          },
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Gemini API error:", data);
      return res.status(response.status).json({ error: data });
    }

    const rawText =
      data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (parseErr) {
      // Fallback: if the model didn't return valid JSON, show the raw text
      // as the reply with no suggestions, rather than crashing.
      console.error("Could not parse model JSON:", rawText);
      parsed = { reply: rawText || "(no response)", suggestions: [] };
    }

    res.json({
      reply: parsed.reply ?? "(no response)",
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
    });
  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ error: "Something went wrong on the server." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Chatbot running at http://localhost:${PORT}`);
});