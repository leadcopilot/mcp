/**
 * OpenRouter AI Agent — LLM fallback
 * Used when Gemini and Groq hit rate limits, or as a completely free alternative.
 */

const { toGroqTools } = require('../mcp/tools');

const MAX_TURNS = 8;
// "openrouter/free" is not a routable model id. Default to a real free model;
// override with OPENROUTER_MODEL.
const MODEL = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free';

async function runOpenRouter(systemPrompt, userQuery, toolDefs, executeTool) {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY not set');
  }

  const toolsUsed = [];

  const messages = [
    {
      role: 'system',
      content: systemPrompt + '\n\nIMPORTANT: When a tool returns data, copy exact values from the result into subsequent tool calls. Never paraphrase IDs, names, or numbers returned by tools.',
    },
    { role: 'user', content: userQuery },
  ];

  const orTools = toolDefs.length > 0 ? toGroqTools(toolDefs) : undefined; // The format is identical to Groq/OpenAI

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    console.log(`[openrouter] turn ${turn + 1}/${MAX_TURNS}`);

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:3001',
        'X-Title': 'LeadPilot',
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        tools: orTools,
        tool_choice: orTools ? 'auto' : 'none',
        max_tokens: 4096,
      })
    });

    const completion = await res.json();
    
    if (completion.error) {
       // If the model hits a limit, fall back to another free model
       if (completion.error.message?.includes('rate limit') || completion.error.code === 429) {
           console.warn(`[openrouter] Rate limit hit on ${MODEL}. Falling back to gemini-2.5-flash:free...`);
           const fbRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
             method: 'POST',
             headers: {
               'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
               'Content-Type': 'application/json'
             },
             body: JSON.stringify({
               model: 'google/gemini-2.5-flash:free',
               messages,
               tools: orTools,
               tool_choice: orTools ? 'auto' : 'none',
               max_tokens: 4096,
             })
           });
           const fbComp = await fbRes.json();
           if (fbComp.error) throw new Error(fbComp.error.message || fbComp.error);
           Object.assign(completion, fbComp);
       } else {
           throw new Error(completion.error.message || completion.error);
       }
    }

    const choice = completion.choices[0];
    const message = choice.message;

    messages.push(message);

    if (choice.finish_reason === 'stop' || !message.tool_calls?.length) {
      const answer = message.content?.trim();
      if (!answer) throw new Error('OpenRouter returned no content');
      console.log(`[openrouter] final answer after ${turn + 1} turns`);
      return { answer, toolsUsed, model: completion.model || MODEL };
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

      console.log(`[openrouter] requested tool: ${name}(${JSON.stringify(args)})`);
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

  throw new Error(`OpenRouter exceeded ${MAX_TURNS} turns without a final answer`);
}

module.exports = { runOpenRouter };
