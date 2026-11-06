/** A project name from the first words of a prompt. The user can rename the project in the drawer. */
export function projectNameFrom(prompt: string): string {
  const words = prompt.trim().split(/\s+/).slice(0, 6).join(" ").slice(0, 60);
  return words.replace(/[\s.,;:!?-]+$/, "") || "New project";
}

export type StartKind = "page" | "app" | "slides";

export const START_KINDS: { id: StartKind; title: string; sub: string; placeholder: string }[] = [
  { id: "page", title: "Web", sub: "A site, a page or a one-pager. Desktop and Mobile frames, or one frame per page.", placeholder: "A task app with sign in, task list and settings" },
  { id: "app", title: "Mobile app", sub: "One phone frame for each screen.", placeholder: "A habit tracker with onboarding, a today view and stats" },
  { id: "slides", title: "Slide deck", sub: "16:9 slides, and a PDF with one page per slide.", placeholder: "Ten slides that explain our product to new customers" },
];
