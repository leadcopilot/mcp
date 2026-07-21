/**
 * Groq AI Agent — LLM fallback
 * Used when Gemini hits rate limits or is unavailable.
 * Free tier: generous limits on llama-3.3-70b-versatile
 */

const Groq = require('groq-sdk');
const { toGroqTools } = require('../mcp/tools');

const MAX_TURNS = 8;
const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

function getGroq() {
  if (!process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY not set — Groq fallback unavailable');
  }
  return new Groq({ apiKey: process.env.GROQ_API_KEY });
}

async function runGroq(systemPrompt, userQuery, toolDefs, executeTool) {
  const groq = getGroq();
  const toolsUsed = [];

  const messages = [
    {
      role: 'system',
      // Extra instruction for Groq: it sometimes paraphrases tool results
      // instead of using exact values. This instruction reduces that.
      content: systemPrompt + '\n\nIMPORTANT: When a tool returns data, copy exact values from the result into subsequent tool calls. Never paraphrase IDs, names, or numbers returned by tools.',
    },
    { role: 'user', content: userQuery },
  ];

  const groqTools = toolDefs.length > 0 ? toGroqTools(toolDefs) : undefined;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    console.log(`[groq] turn ${turn + 1}/${MAX_TURNS}`);

    let completion;
    try {
      completion = await groq.chat.completions.create({
        model: MODEL,
        messages,
        tools: groqTools,
        tool_choice: groqTools ? 'auto' : 'none',
        max_tokens: 4096,
      });
    } catch (err) {
      if (err.message.includes('rate_limit') || err.status === 429 || err.message.includes('tokens per minute')) {
        console.warn(`[groq] Rate limit hit on ${MODEL}. Falling back to llama-3.1-8b-instant...`);
        completion = await groq.chat.completions.create({
          model: 'llama-3.1-8b-instant',
          messages,
          tools: groqTools,
          tool_choice: groqTools ? 'auto' : 'none',
          max_tokens: 4096,
        });
      } else {
        throw err;
      }
    }

    const choice = completion.choices[0];
    const message = choice.message;

    messages.push(message);

    if (choice.finish_reason === 'stop' || !message.tool_calls?.length) {
      const answer = message.content?.trim();
      if (!answer) throw new Error('Groq returned no content');
      console.log(`[groq] final answer after ${turn + 1} turns`);
      return { answer, toolsUsed };
    }

    // Execute tool calls
    for (const toolCall of message.tool_calls) {
      const name = toolCall.function.name;
      let args;
      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch {
        args = {};
      }

      console.log(`[groq] requested tool: ${name}(${JSON.stringify(args)})`);
      toolsUsed.push(name);

      let toolResult;
      try {
        toolResult = await executeTool(name, args);
      } catch (err) {
        toolResult = `Error: ${err.message}`;
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
      });
    }
  }

  throw new Error(`Groq exceeded ${MAX_TURNS} turns without a final answer`);
}

module.exports = { runGroq };
