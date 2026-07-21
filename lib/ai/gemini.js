/**
 * Gemini AI Agent
 * Primary AI for LeadPilot pipeline.
 * Free tier: 1500 requests/day (gemini-2.5-flash)
 * Handles multi-turn tool calling until a final answer is produced.
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { toGeminiTools } = require('../mcp/tools');

const MAX_TURNS = 8; // prevent infinite tool-calling loops

function getGemini() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not set in .env');
  }
  return new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
}

/**
 * Run the Gemini tool-calling loop.
 *
 * @param {string} systemPrompt - Organisation context for AI
 * @param {string} userQuery    - What the user asked
 * @param {Array}  toolDefs     - Tool definitions to expose to AI
 * @param {Function} executeTool - async (toolName, args) => string result
 * @returns {Promise<{answer: string, toolsUsed: string[]}>}
 */
async function runGemini(systemPrompt, userQuery, toolDefs, executeTool) {
  const genAI = getGemini();
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: systemPrompt,
    tools: toolDefs.length > 0 ? [{ functionDeclarations: toGeminiTools(toolDefs) }] : undefined,
  });

  const chat = model.startChat({ history: [] });
  const toolsUsed = [];
  let currentMessage = userQuery;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    console.log(`[gemini] turn ${turn + 1}/${MAX_TURNS} — sending message`);

    const result = await chat.sendMessage(currentMessage);
    const response = result.response;
    const candidates = response.candidates || [];
    const parts = candidates[0]?.content?.parts || [];

    // Check if Gemini wants to call a tool
    const functionCalls = parts.filter(p => p.functionCall);

    if (functionCalls.length === 0) {
      // No more tool calls — extract final text answer
      const textParts = parts.filter(p => p.text);
      const answer = textParts.map(p => p.text).join('').trim();

      if (!answer) {
        throw new Error('Gemini returned no text and no function calls');
      }

      console.log(`[gemini] final answer produced after ${turn + 1} turns`);
      return { answer, toolsUsed };
    }

    // Execute each tool call Gemini requested
    const functionResponses = [];

    for (const part of functionCalls) {
      const { name, args } = part.functionCall;
      console.log(`[gemini] requested tool: ${name}(${JSON.stringify(args)})`);
      toolsUsed.push(name);

      let toolResult;
      try {
        toolResult = await executeTool(name, args);
      } catch (err) {
        toolResult = `Error executing ${name}: ${err.message}`;
      }

      const resultStr = typeof toolResult === 'string'
        ? toolResult
        : JSON.stringify(toolResult);

      functionResponses.push({
        functionResponse: {
          name,
          response: { content: resultStr },
        },
      });
    }

    // Send tool results back to Gemini
    currentMessage = functionResponses;
  }

  throw new Error(`Gemini exceeded ${MAX_TURNS} turns without producing a final answer`);
}

module.exports = { runGemini };
