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

// POST /api/chat
// body: { history: [{ role: "user"|"model", text: string }, ...] }
app.post("/api/chat", async (req, res) => {
  try {
    const { history } = req.body;

    if (!Array.isArray(history) || history.length === 0) {
      return res.status(400).json({ error: "history array is required" });
    }

    // Convert our simple {role, text} format into Gemini's `contents` shape
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
            parts: [{ text: "You are a helpful, concise assistant." }],
          },
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Gemini API error:", data);
      return res.status(response.status).json({ error: data });
    }

    const replyText =
      data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ??
      "(no response)";

    res.json({ reply: replyText });
  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ error: "Something went wrong on the server." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Chatbot running at http://localhost:${PORT}`);
});
