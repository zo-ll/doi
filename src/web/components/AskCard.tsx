import { useState } from "react";
import { askAnswerText, type AskQuestion } from "../ask.ts";

/**
 * The questions of an `ask` block. `onAnswer` is absent when the card cannot send: a later message
 * answered it, or a turn runs. The card then only shows the questions.
 */
export function AskCard({ questions, onAnswer }: { questions: AskQuestion[]; onAnswer?: (text: string) => void }) {
  // One answer per question: an option or the user's own words, so a typed word is never an option.
  const [answers, setAnswers] = useState<{ option: string; own: string }[]>(() => questions.map(() => ({ option: "", own: "" })));
  const set = (i: number, value: { option: string; own: string }) => setAnswers((list) => list.map((a, n) => (n === i ? value : a)));
  const texts = answers.map((a) => a.own.trim() || a.option);
  const send = () => onAnswer?.(askAnswerText(questions, texts));
  const hasAnswer = texts.some(Boolean);
  return (
    <div
      className="ask-card"
      role="group"
      aria-label="Questions from the model"
      onKeyDown={(e) => {
        if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey) || !onAnswer || !hasAnswer) return;
        e.preventDefault();
        e.stopPropagation();
        send();
      }}
    >
      {questions.map((q, i) => (
        <div key={i} className="ask-question" role="group" aria-label={q.question}>
          <p className="ask-text">{q.question}</p>
          {onAnswer && (
            <>
              {q.options.length > 0 && (
                <div className="ask-options">
                  {q.options.map((option, n) => (
                    <button key={n} type="button" className="btn btn-secondary btn-sm ask-option" aria-pressed={answers[i]!.option === option} onClick={() => set(i, { option: answers[i]!.option === option ? "" : option, own: "" })}>
                      {option}
                    </button>
                  ))}
                </div>
              )}
              <input className="input" value={answers[i]!.own} onChange={(e) => set(i, { option: "", own: e.target.value })} placeholder="Or write your own answer" aria-label={`Your answer: ${q.question}`} />
            </>
          )}
          {!onAnswer && q.options.length > 0 && <p className="ask-given">{q.options.join(" · ")}</p>}
        </div>
      ))}
      {onAnswer && (
        <div className="ask-actions">
          <button type="button" className="btn btn-primary btn-md" disabled={!hasAnswer} onClick={send}>
            Send answer
          </button>
          <button type="button" className="btn btn-ghost btn-md" onClick={send} title="The model makes the choices and says what it chose">
            You choose
          </button>
        </div>
      )}
    </div>
  );
}
