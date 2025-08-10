// mcp-server.js
import express from "express";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
export function calculateProfileData(input) {
  return { message: "Placeholder profile data", input };
}


dotenv.config();

const app = express();
app.use(express.json());

// Allow Vercel/CORS friendly headers (Puch makes server-to-server calls but we add safe headers)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  next();
});

const MCP_TOKEN = process.env.MCP_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const OWNER_NUMBER = process.env.MY_NUMBER || "";

// Basic auth middleware: expects "Authorization: Bearer <MCP_TOKEN>"
function checkAuth(req, res) {
  const authHeader = req.headers["authorization"] || req.headers["Authorization"] || "";
  if (!authHeader.startsWith("Bearer ")) return false;
  const token = authHeader.slice("Bearer ".length).trim();
  return token === MCP_TOKEN;
}

// Tool metadata sent during handshake (Puch uses this to list tools)
const availableTools = [
  {
    tool_name: "profile",
    description: "Generates a deep, personal cosmic profile based on a user's birthdate.",
    parameters: {
      type: "object",
      properties: {
        dob: { type: "string", description: "Birthdate in dd-mm-yyyy" }
      },
      required: ["dob"]
    }
  },
  {
    tool_name: "validate",
    description: "Validation tool used by the hackathon to verify server ownership.",
    parameters: {
      type: "object",
      properties: {
        token: { type: "string", description: "Bearer token to validate" }
      },
      required: ["token"]
    }
  },
  {
    tool_name: "explore",
    description: "Detailed exploration for a given topic from the user's profile (career supported).",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string" },
        subject: { type: "string" },
        dob: { type: "string" }
      },
      required: ["topic", "subject", "dob"]
    }
  },
  {
    tool_name: "compare",
    description: "Compatibility report between two birthdates.",
    parameters: {
      type: "object",
      properties: {
        dob1: { type: "string" },
        dob2: { type: "string" }
      },
      required: ["dob1", "dob2"]
    }
  },
  {
    tool_name: "daily",
    description: "Short daily cosmic focus for a user.",
    parameters: {
      type: "object",
      properties: {
        dob: { type: "string" }
      },
      required: ["dob"]
    }
  },
  {
    tool_name: "lifepath",
    description: "Detailed breakdown of the user's numerology life path number.",
    parameters: {
      type: "object",
      properties: {
        dob: { type: "string" }
      },
      required: ["dob"]
    }
  }
];

// --- Prompt templates (kept concise here; feel free to expand) ---
const masterPrompt = (profileData) => `
You are 'The AI Oracle', a wise, empathetic, and modern cosmic guide. Use Markdown.
- Zodiac: ${profileData.zodiacSign}
- Ruling Planet: ${profileData.rulingPlanet}
- Element: ${profileData.element}
- Life Path: ${profileData.lifePathNumber}
- Day: ${profileData.dayOfWeek}

Generate sections: core identity, strengths & challenges (3 bullets each), career (3-5 suggestions), 6-12 month outlook (2 opp, 2 challenges), cosmic guidance (final advice + mantra), playful serendipity.
`;

const exploreCareerPrompt = (profileData, careerPath) => `
You are 'The AI Oracle'. Provide a detailed exploration for the career: ${careerPath}.
Include: alignment (2-3 bullets), top strengths (2-3 bullets), one "key to unlock" challenge, and a short vision statement.
`;

const comparePrompt = (p1, p2) => `
You are 'The AI Oracle'. Create a compatibility report.
Person A: ${p1.zodiacSign}, ${p1.element}, LifePath ${p1.lifePathNumber}
Person B: ${p2.zodiacSign}, ${p2.element}, LifePath ${p2.lifePathNumber}
Sections: dynamic summary (1-2 sentences), strengths as a pair (2 bullets), friction points (2 bullets), combined life path theme (reduce to one digit).
`;

const dailyReadingPrompt = (profileData) => `
You are 'The AI Oracle'. Give a short 2-3 sentence actionable cosmic focus for today referencing ${profileData.zodiacSign} and life path ${profileData.lifePathNumber}.
`;

const lifePathPrompt = (profileData) => `
You are 'The AI Oracle'. Explain Life Path ${profileData.lifePathNumber}: core meaning, 2-3 strengths, and the central lesson.
`;

// --- Helper: call Gemini (returns text) ---
async function callGemini(prompt) {
  if (!GEMINI_KEY) {
    throw new Error("GEMINI_API_KEY not set in env.");
  }
  const genAI = new GoogleGenerativeAI(GEMINI_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
  const result = await model.generateContent(prompt);
  // previous usage pattern in your code: await result.response).text()
  // handle if response is an object
  const text = (await result.response).text ? (await result.response).text() : String(await result);
  return text;
}

// --- POST /mcp --- MCP handshake and tool execution
// Expected request body: { tool_calls?: [ { tool_name, call_id, parameters } ] }
// - If tool_calls missing or empty -> return { tools: availableTools } (handshake)
// - Else -> process calls and return { tool_results: [ { call_id, tool_name, payload } ] }
app.post("/mcp", async (req, res) => {
  // Auth
  if (!checkAuth(req)) {
    return res.status(401).json({ error: "Unauthorized: missing or invalid Bearer token" });
  }

  const body = req.body || {};
  const tool_calls = Array.isArray(body.tool_calls) ? body.tool_calls : [];

  // Handshake: return available tools if no calls provided
  if (tool_calls.length === 0) {
    return res.json({ tools: availableTools });
  }

  const results = [];

  for (const call of tool_calls) {
    const { tool_name, call_id, parameters = {} } = call;
    console.log(`[mcp] processing tool: ${tool_name} call_id: ${call_id}`);
    let payload = null;

    try {
      if (tool_name === "validate") {
        const provided = parameters.token;
        if (provided && provided === MCP_TOKEN) {
          payload = { phone_number: OWNER_NUMBER };
        } else {
          payload = { error: "Invalid validation token" };
        }
      } else if (tool_name === "profile") {
        if (!parameters.dob) throw new Error("Missing parameter: dob");
        const profileData = calculateProfileData(parameters.dob);
        const prompt = masterPrompt(profileData);
        const content = await callGemini(prompt);
        payload = { content };
      } else if (tool_name === "explore") {
        if (!parameters.topic || !parameters.subject || !parameters.dob) {
          payload = { error: "Missing parameters. Required: topic, subject, dob" };
        } else if (parameters.topic.toLowerCase() !== "career") {
          payload = { content: "Sorry, this server currently supports 'career' only for explore." };
        } else {
          const profileData = calculateProfileData(parameters.dob);
          const prompt = exploreCareerPrompt(profileData, parameters.subject);
          const content = await callGemini(prompt);
          payload = { content };
        }
      } else if (tool_name === "compare") {
        if (!parameters.dob1 || !parameters.dob2) {
          payload = { error: "Missing dob1 or dob2" };
        } else {
          const p1 = calculateProfileData(parameters.dob1);
          const p2 = calculateProfileData(parameters.dob2);
          const prompt = comparePrompt(p1, p2);
          const content = await callGemini(prompt);
          payload = { content };
        }
      } else if (tool_name === "daily") {
        if (!parameters.dob) {
          payload = { error: "Missing dob" };
        } else {
          const profileData = calculateProfileData(parameters.dob);
          const prompt = dailyReadingPrompt(profileData);
          const content = await callGemini(prompt);
          payload = { content };
        }
      } else if (tool_name === "lifepath") {
        if (!parameters.dob) {
          payload = { error: "Missing dob" };
        } else {
          const profileData = calculateProfileData(parameters.dob);
          const prompt = lifePathPrompt(profileData);
          const content = await callGemini(prompt);
          payload = { content };
        }
      } else {
        payload = { error: `Tool "${tool_name}" not implemented on this server.` };
      }
    } catch (err) {
      console.error(`[mcp] error for ${tool_name}:`, err.message || err);
      payload = { error: String(err.message || err) };
    }

    results.push({ call_id, tool_name, payload });
  }

  // Return all results in one response (serverless-friendly)
  return res.json({ tool_results: results });
});

// Basic GET health route (handy to verify deployment)
app.get("/", (req, res) => {
  res.json({
    server: "FuturePalz MCP",
    version: "1.0.0",
    tools_count: availableTools.length,
    note: "POST /mcp with Authorization: Bearer <MCP_TOKEN> to handshake and call tools."
  });
});

// Export for Vercel serverless function
export default app;

app.get('/mcp', (req, res) => {
  res.json({ message: 'MCP server is running!' });
});
