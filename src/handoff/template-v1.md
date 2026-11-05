# Handoff: {{design}}

This folder has a design from doi, a local design tool. Implement the design in this repo.

Edit this file before you start the run. The agent reads it as its instructions.

## Goal

Implement the design "{{design}}" of the doi project "{{project}}" in this repo.

<!-- Say what the design is for and what the result must do. -->

The user asked for the design with these requests, oldest first:

{{requests}}

## Target framework

Use the framework, the components and the conventions that this repo uses now.

<!-- Name the framework, for example "Next.js with Tailwind CSS", if the repo has none or more than one. -->

## Files to change

<!-- List the files or folders that the agent must change. If this list is empty, the agent finds them. -->

- Find the files that this design changes. Change only those files and the files that they need.

## Design files

All paths are relative to this file.

- `design/`: the design as plain HTML and CSS. The pages are:
{{pages}}
- `screenshots/`: one PNG of the whole page for each page and frame:
{{screenshots}}
- {{tokens}}

The `data-oid` attributes in `design/` are ids for doi. The comments below refer to them. Do not copy them into the code.

{{architecture}}## Open comments

{{comments}}

## Rules

1. Make the result look like the screenshots at each frame width.
2. Use the components, the tokens and the styles that the repo has. Add new ones only when the repo has none that fit.
3. Do not copy the HTML of `design/` as it is. Write it in the form that the repo uses.
4. Do not change the files in this folder.
5. When you stop, list the files that you changed and the open questions.
