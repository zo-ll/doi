// SEARCH/REPLACE text blocks (#58): the change format for models without tool use
// (`toolUse: false`). The model writes blocks in its reply; the parser turns them into the
// same `edit` and `write` events that the tools give, and passes the other text through.
import prompt from "./search-replace.md" with { type: "text" };
import type { GenerateEvent } from "./types.ts";

/** The system part that asks for blocks. It goes right after the system prompt. */
export const SEARCH_REPLACE_PROMPT = { version: "v0", text: prompt } as const;

export class SearchReplaceError extends Error {
  override name = "SearchReplaceError";
}

type Change = Extract<GenerateEvent, { type: "edit" | "write" }>;
export type ParsedEvent = Extract<GenerateEvent, { type: "text" }> | Change;

const SEARCH = /^\s*<{5,9} ?SEARCH\s*$/;
const DIVIDER = /^\s*={5,9}\s*$/;
const REPLACE = /^\s*>{5,9} ?REPLACE\s*$/;
const FENCE = /^\s*(```|~~~)/;
/** A fence without info: the line that closes a code fence. */
const BARE_FENCE = /^\s*(```|~~~)\s*$/;
/** A design file path: letters, digits, `.`, `_`, `-` and `/`, with an extension. */
const PATH = /^[\w.-]+(\/[\w.-]+)*\.[A-Za-z0-9]+$/;

/**
 * The file name on a header line: `styles.css`, `**styles.css**`, `` `styles.css` ``,
 * `### styles.css`, `File: styles.css`, `styles.css:`, or the info of a fence (```` ```styles.css ````).
 * Null when the line is not a file name.
 */
export function fileName(line: string): string | null {
  let s = line.trim();
  const fence = s.match(/^(```|~~~)\s*(\S*)\s*$/);
  if (fence) s = fence[2] ?? "";
  s = s.replace(/^#+\s*/, "").replace(/^(file|path)\s*:\s*/i, "");
  s = s.replace(/^[*`'"]+|[*`'"]+$/g, "").replace(/:$/, "").replace(/^\.\//, "");
  return PATH.test(s) ? s : null;
}

interface Held {
  line: string;
  /** False only for the last line of the reply when it has no newline. */
  newline: boolean;
}

const blank = (line: string) => !line.trim();
/** A line between the file name and the SEARCH line: empty, or a fence without a file name. */
const between = (line: string) => blank(line) || (FENCE.test(line) && !fileName(line));

/**
 * A streaming parser. `push()` takes text as it arrives and returns the events that are
 * complete; `end()` returns the rest. Text outside blocks passes through line by line, without
 * the file name line and the code fence of a block. A broken block throws SearchReplaceError:
 * a change is never dropped without an error.
 */
export class SearchReplaceParser {
  private partial = "";
  /** Text lines that can still turn out to be the header of a block. */
  private held: Held[] = [];
  private state: "text" | "search" | "replace" = "text";
  private file = "";
  private lastFile: string | null = null;
  private search: string[] = [];
  private replace: string[] = [];
  /** Right after a block: a fence on the next line closes the fence around the block. */
  private afterBlock = false;

  push(chunk: string): ParsedEvent[] {
    const out: ParsedEvent[] = [];
    const lines = (this.partial + chunk).split("\n");
    this.partial = lines.pop() ?? "";
    for (const line of lines) this.line(line.endsWith("\r") ? line.slice(0, -1) : line, true, out);
    return out;
  }

  end(): ParsedEvent[] {
    const out: ParsedEvent[] = [];
    if (this.partial) this.line(this.partial, false, out);
    this.partial = "";
    if (this.state === "search") throw this.broken("has no ======= line");
    if (this.state === "replace") throw this.broken("has no >>>>>>> REPLACE line");
    this.flush(out, this.held.length);
    return out;
  }

  private line(line: string, newline: boolean, out: ParsedEvent[]) {
    if (this.state === "search") {
      if (DIVIDER.test(line)) this.state = "replace";
      else if (SEARCH.test(line) || REPLACE.test(line)) throw this.broken("has no ======= line");
      else this.search.push(line);
      return;
    }
    if (this.state === "replace") {
      if (REPLACE.test(line)) this.close(out);
      else if (SEARCH.test(line) || DIVIDER.test(line)) throw this.broken("has no >>>>>>> REPLACE line");
      else this.replace.push(line);
      return;
    }
    if (SEARCH.test(line)) return this.open(out);
    if (REPLACE.test(line)) throw new SearchReplaceError("A >>>>>>> REPLACE line has no SEARCH block before it.");
    if (this.afterBlock) {
      this.afterBlock = false;
      // Only a bare fence closes the fence around the block. A fence with a file name opens the
      // next block, and a fence with a language opens a code sample in the text.
      if (BARE_FENCE.test(line)) return;
    }
    this.held.push({ line, newline });
    this.flush(out, this.header().start);
  }

  /**
   * The held lines that can still be the header of a block: the last line that is not empty
   * and not a bare fence, the lines after it, and a fence before it. `name` is its file name.
   */
  private header(): { start: number; name: string | null } {
    let start = this.held.length;
    while (start > 0 && between(this.held[start - 1]!.line)) start--;
    if (start === 0) return { start, name: null };
    start--;
    const name = fileName(this.held[start]!.line);
    if (start > 0 && FENCE.test(this.held[start - 1]!.line)) start--;
    return { start, name };
  }

  /** Sends the first `n` held lines as text. */
  private flush(out: ParsedEvent[], n: number) {
    if (n <= 0) return;
    for (const h of this.held.splice(0, n)) out.push({ type: "text", delta: h.newline ? `${h.line}\n` : h.line });
  }

  /**
   * A SEARCH line: the header is the last held line with a file name, with only fences and
   * empty lines after it, and a fence before it. Without a file name, the block is for the
   * file of the block before.
   */
  private open(out: ParsedEvent[]) {
    const header = this.header();
    const name = header.name;
    // Without a file name, the last held line is text; only the empty lines and fences after it go.
    let start = header.start;
    if (!name) {
      start = this.held.length;
      while (start > 0 && between(this.held[start - 1]!.line)) start--;
    }
    this.flush(out, start);
    this.held = [];
    const file = name ?? this.lastFile;
    if (!file) throw new SearchReplaceError("A SEARCH/REPLACE block has no file name on the line before it.");
    this.file = file;
    this.state = "search";
    this.search = [];
    this.replace = [];
  }

  private close(out: ParsedEvent[]) {
    const oldText = this.search.join("\n");
    const newText = this.replace.join("\n");
    if (oldText.trim()) out.push({ type: "edit", file: this.file, oldText, newText });
    else out.push({ type: "write", file: this.file, content: newText && !newText.endsWith("\n") ? `${newText}\n` : newText });
    this.lastFile = this.file;
    this.state = "text";
    this.afterBlock = true;
  }

  private broken(why: string): SearchReplaceError {
    return new SearchReplaceError(`The SEARCH/REPLACE block for "${this.file}" ${why}.`);
  }
}

/** Parses a whole reply. */
export function parseSearchReplace(text: string): ParsedEvent[] {
  const p = new SearchReplaceParser();
  return [...p.push(text), ...p.end()];
}
