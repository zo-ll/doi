import { describe, expect, test } from "bun:test";
import { SYSTEM_PROMPT } from "../src/generation/prompts.ts";
import { parseSearchReplace } from "../src/providers/search-replace.ts";
import { askAnswerText, parseAsk } from "../src/web/ask.ts";

const BLOCK = '```ask\n{"questions":[{"question":"How much?","options":["One screen","All"]}]}\n```';
const QUESTIONS = [{ question: "How much?", options: ["One screen", "All"] }];

describe("parseAsk", () => {
  test("finds the block and removes it from the text", () => {
    expect(parseAsk(`I need one answer.\n\n${BLOCK}`, false)).toEqual({ text: "I need one answer.", questions: QUESTIONS });
    expect(parseAsk(BLOCK, false)).toEqual({ text: "", questions: QUESTIONS });
    expect(parseAsk(BLOCK.replaceAll("\n", "\r\n"), false).questions).toEqual(QUESTIONS);
  });

  test("an answer without a block stays as it is", () => {
    const text = "I made three screens.\n```css\na { color: red }\n```";
    expect(parseAsk(text, false)).toEqual({ text, questions: null });
    expect(parseAsk("Write ```ask in the text", false).questions).toBeNull();
  });

  test("hides an open block while it streams, at each split of the text", () => {
    const full = `Before.\n${BLOCK}`;
    for (let n = "Before.\n```ask\n".length; n < full.length; n++) {
      expect(parseAsk(full.slice(0, n), true)).toEqual({ text: "Before.", questions: null });
    }
    expect(parseAsk(full, true).questions).toEqual(QUESTIONS);
  });

  test("a broken block keeps the model's words when the answer ends", () => {
    for (const body of ["not json", '{"questions":[]}', '{"questions":"x"}', '{"questions":[{"options":[]}]}', '{"questions":[{"question":"q","options":[7]}]}', "null", `{"questions":${JSON.stringify(Array(4).fill({ question: "q" }))}}`, `{"questions":[{"question":"${"x".repeat(301)}"}]}`]) {
      const text = `\`\`\`ask\n${body}\n\`\`\``;
      expect(parseAsk(text, false)).toEqual({ text, questions: null });
    }
    // The stream ended before the block closed.
    const open = "```ask\n{";
    expect(parseAsk(open, false)).toEqual({ text: open, questions: null });
  });

  test("a repeated option counts once", () => {
    expect(parseAsk('```ask\n{"questions":[{"question":"Which?","options":["Same"," Same ","Other"]}]}\n```', false).questions).toEqual([{ question: "Which?", options: ["Same", "Other"] }]);
  });

  test("a question can have no options", () => {
    expect(parseAsk('```ask\n{"questions":[{"question":"Why?"}]}\n```', false).questions).toEqual([{ question: "Why?", options: [] }]);
  });

  test("the block passes through the parser for models without tools", () => {
    const text = `${BLOCK}\n`;
    const events = parseSearchReplace(text);
    const out = events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("");
    expect(events.every((e) => e.type === "text")).toBe(true);
    expect(parseAsk(out, false).questions).toEqual(QUESTIONS);
  });
});

test("the answer names each question, and an open one leaves the choice to the model", () => {
  const questions = [...QUESTIONS, { question: "For whom?", options: [] }];
  expect(askAnswerText(questions, ["All", " "])).toBe("How much?\nAll\n\nFor whom?\nYou choose.");
  expect(askAnswerText(QUESTIONS, [])).toBe("How much?\nYou choose.");
});

describe("system prompt v3", () => {
  const { text, version } = SYSTEM_PROMPT;
  test("has the scope rule and the flow rule", () => {
    expect(version).toBe("v3");
    for (const rule of ["not less and not more", "A request for one thing stays one thing", "Do not ask again", "02-signup.html", "at most 12 pages", "names each screen", "Write your reply first", "must have its own tool call", "plain `<a href>`", "A slide deck stays one"]) {
      expect(text).toContain(rule);
    }
  });

  test("each ask example is one that doi can parse", () => {
    const blocks = [...text.matchAll(/^```ask\n[\s\S]*?^```$/gm)].map((m) => m[0]);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const block of blocks) expect(parseAsk(block, false).questions?.length).toBeGreaterThan(0);
  });
});
