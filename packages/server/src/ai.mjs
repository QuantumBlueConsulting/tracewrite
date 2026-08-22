// tracewrite's AI review step. Reacts to a tester's live comment with the
// recent activity context that led up to it, and separately classifies the
// tester's own next reply as confirming or declining a previously-proposed
// action. Both are short, structured, low-stakes calls (a handful of recent
// events plus one note in, a small validated object out) — claude-haiku-4-5
// is the deliberate choice here, not a larger model: well under 1,000 input
// tokens, under 150 output tokens per call.
// Failures (missing key, rate limit, network) must never block a tester's
// comment from saving — callers wrap these in try/catch and treat a thrown
// TestSessionAiError as "no AI reply this time," not a request failure.
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-haiku-4-5";

export class TestSessionAiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // "not_configured" | "request_failed"
  }
}

// Lazy-singleton-plus-test-override shape — constructed once, from env, on
// first use, with an explicit hook tests use to inject a fake client instead
// of hitting the real Anthropic API.
let client;
let clientOverride;

export function setTestSessionAiClientForTesting(fakeClient) {
  clientOverride = fakeClient;
}

function getClient() {
  if (clientOverride) return clientOverride;
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new TestSessionAiError("not_configured", "ANTHROPIC_API_KEY is not set.");
    }
    client = new Anthropic();
  }
  return client;
}

const REPLY_SCHEMA = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: ["clarifying_question", "proposed_action", "acknowledgement"],
      description:
        "clarifying_question when the comment is ambiguous and more detail is needed; " +
        "proposed_action when the comment describes a concrete, fixable problem or improvement; " +
        "acknowledgement when neither applies and a brief acknowledgement is all that fits.",
    },
    message: {
      type: "string",
      description: "One or two short sentences. The question to ask, the action to propose, or the acknowledgement.",
    },
  },
  required: ["kind", "message"],
  additionalProperties: false,
};

const REPLY_SYSTEM_PROMPT = `You are reviewing a human tester's live commentary while they use a software \
product, alongside the last few pages/fields they interacted with. Given their most recent comment and \
that recent activity, respond in one of three ways: ask ONE short clarifying question if the comment is \
ambiguous; propose ONE specific, concrete follow-up action if the comment describes a real problem or \
improvement; or give a brief acknowledgement if neither applies. Keep it to one or two sentences. Never \
invent detail the tester didn't give you.`;

const CONFIRMATION_SCHEMA = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["confirmed", "declined", "unclear"],
      description:
        "confirmed if the reply affirms the proposed action should happen; declined if it rejects or " +
        "dismisses it; unclear if the reply doesn't address the proposed action at all.",
    },
  },
  required: ["verdict"],
  additionalProperties: false,
};

const CONFIRMATION_SYSTEM_PROMPT = `You are given a follow-up action that was just proposed to a software \
tester, and the tester's very next reply. Classify whether that reply confirms the action should happen, \
declines it, or is unrelated/unclear.`;

function extractJson(response) {
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock) {
    throw new TestSessionAiError("request_failed", "AI response returned no content to parse.");
  }
  return JSON.parse(textBlock.text);
}

/**
 * recentEvents: array of { eventType, pagePath, fieldLabel, note } — the
 * last few timeline events, oldest first. comment: the new comment text.
 * Returns { kind, message }.
 */
export async function proposeReply({ recentEvents, comment }) {
  try {
    const contextLines = recentEvents
      .map((e) => {
        if (e.eventType === "navigation") return `- navigated to ${e.pagePath}`;
        if (e.eventType === "focus") return `- focused "${e.fieldLabel}" on ${e.pagePath}`;
        if (e.eventType === "comment") return `- tester commented: "${e.note}"`;
        return `- AI replied: "${e.note}"`;
      })
      .join("\n");

    const response = await getClient().messages.create({
      model: MODEL,
      max_tokens: 300,
      system: REPLY_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Recent activity (oldest first):\n${contextLines || "(none yet)"}\n\nTester's new comment: "${comment}"`,
        },
      ],
      output_config: { format: { type: "json_schema", schema: REPLY_SCHEMA } },
    });
    return extractJson(response);
  } catch (err) {
    if (err instanceof TestSessionAiError) throw err;
    throw new TestSessionAiError("request_failed", err.message ?? "AI request failed.");
  }
}

/** actionDescription: the pending action's text. replyText: the tester's new comment. */
export async function classifyConfirmation({ actionDescription, replyText }) {
  try {
    const response = await getClient().messages.create({
      model: MODEL,
      max_tokens: 50,
      system: CONFIRMATION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Proposed action: "${actionDescription}"\n\nTester's reply: "${replyText}"`,
        },
      ],
      output_config: { format: { type: "json_schema", schema: CONFIRMATION_SCHEMA } },
    });
    return extractJson(response);
  } catch (err) {
    if (err instanceof TestSessionAiError) throw err;
    throw new TestSessionAiError("request_failed", err.message ?? "AI request failed.");
  }
}
