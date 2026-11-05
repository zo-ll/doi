Implement the design "{{design}}" of the doi project "{{name}}" in this repository.

doi is a local design tool. It gives the design to you through its MCP server:

- URL: {{url}}
- Transport: Streamable HTTP, no authentication.
- Project id: `{{project}}`. Design id: `{{design}}`.

Before you start, make sure that you have the doi tools (`list_designs`, `get_design`, `get_design_system`, `get_comments`, `get_element`, `export_png`). If you do not have them, stop. Ask the user to add an MCP server with the name "doi" and the URL above to your agent, and then to start the task again. Do not guess the design.

Do these steps:

1. Call `get_design` for the design. Read all pages and stylesheets. The `requests` show what the user asked for.
2. Call `get_design_system` for the project. Use the existing theme and tokens of this repository where they agree with it. Add only the tokens that this repository does not have.
3. Call `get_comments` for the design. Each open comment is a change that the user still wants. A comment with `detached: true` refers to an element that is not in the design now. Call `get_element` with the `element` of each open comment: it gives that element as the browser renders it (box, styles, CSS rules, ancestors, children).
4. Call `export_png` for each page in each frame. The pictures show the result that you must match.
{{architecture}}
5. Read this repository: the framework, the components, the styles and the conventions. Build the design with them, and use the existing components where you can.
6. The design is a reference in plain HTML and CSS. Do not copy it as it is. Do not copy the `data-oid` attributes into the product code.
7. Make each page work at the frame sizes from `get_design`.
8. Run the build, the linter and the tests of this repository.

At the end, tell the user which files you changed, what you could not match, and which questions are open.
