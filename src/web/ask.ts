/** One question of an `ask` block: the model asks the user for the right scope of a request. */
export interface AskQuestion {
  question: string;
  options: string[];
}

export interface ParsedAsk {
  /** The answer text without the block. */
  text: string;
  questions: AskQuestion[] | null;
}

const LIMITS = { questions: 3, options: 6, length: 300 } as const;
const BLOCK = /^```ask[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/m;
const OPENING = /^```ask[ \t]*(\r?\n|$)/m;

const short = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= LIMITS.length;

function parseQuestions(json: string): AskQuestion[] | null {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  const list = (data as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(list) || list.length < 1 || list.length > LIMITS.questions) return null;
  const out: AskQuestion[] = [];
  for (const item of list) {
    const { question, options = [] } = (item ?? {}) as { question?: unknown; options?: unknown };
    if (!short(question) || !Array.isArray(options) || options.length > LIMITS.options || !options.every(short)) return null;
    // A repeated option is one choice, and each button needs its own name.
    out.push({ question: question.trim(), options: [...new Set((options as string[]).map((o) => o.trim()))] });
  }
  return out;
}

/**
 * Finds the `ask` block in an answer. While the answer streams, an open block is hidden until it
 * is complete. A finished answer with a broken block keeps its text, so the user sees what the
 * model wrote and no words are lost.
 */
export function parseAsk(answer: string, streaming: boolean): ParsedAsk {
  const block = BLOCK.exec(answer);
  if (block) {
    const questions = parseQuestions(block[1]!);
    if (questions) return { text: (answer.slice(0, block.index) + answer.slice(block.index + block[0].length)).trim(), questions };
    return { text: answer, questions: null };
  }
  const open = streaming ? OPENING.exec(answer) : null;
  return open ? { text: answer.slice(0, open.index).trim(), questions: null } : { text: answer, questions: null };
}

/** The message that answers the questions. A question without an answer leaves the choice to the model. */
export function askAnswerText(questions: AskQuestion[], answers: readonly string[]): string {
  return questions.map((q, i) => `${q.question}\n${answers[i]?.trim() || "You choose."}`).join("\n\n");
}
