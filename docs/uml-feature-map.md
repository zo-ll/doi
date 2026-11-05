# Optional UML editor

## Scope

UML is an optional architecture area for each project. The right panel supplies its entry point beside Comments and History. Users can continue with ordinary UI designs without UML.

The editor supports free-form diagrams, not mandatory UML categories or a compiler. Optional class compartments and relationship presets help technical users. The editor does not require them.

The reference uses doi's dark theme. The implementation must use the existing theme tokens, not a separate theme preference. Existing HTML designs keep their own colours.

**These are requirements, not completed application features.** A wireframe control does not prove that its action works.

## Feature contract

| Id | Feature | Required acceptance check |
| --- | --- | --- |
| U01 | Optional project scope | A new project needs no diagram. Selecting UML alone creates no files. Hide the area without deletion. Restore diagrams when the user enables UML again. |
| U02 | Diagram lifecycle | Create, select, rename, duplicate and delete diagrams within one project. Confirm destructive actions. |
| U03 | Basic shapes | Create boxes, rounded boxes, ellipses, diamonds, notes, text, actors and containers. |
| U04 | Class compartments | Edit a name, optional stereotype, attributes and operations as text. No formal schema is required. |
| U05 | Text and styles | Edit labels and multiline content. Change fill, border, text size and contrast. |
| U06 | Move and resize | Move and resize shapes with the pointer and keyboard. Preserve their ids and connections. |
| U07 | Connect and reconnect | Connect handles, reconnect endpoints and preserve attachment after a move or resize. |
| U08 | Connector geometry | Choose straight, elbow or curved routes. Adjust attachment points and bend points. |
| U09 | Relationship presets | Support association, directed association, dependency, generalization, realization, aggregation and composition. |
| U10 | Free connector styles | Edit solid/dashed lines and each endpoint: none, arrow, hollow triangle, hollow diamond or filled diamond. Reverse direction. |
| U11 | Connector labels | Edit centre, start and end labels, including multiplicity such as `1` and `0..*`. |
| U12 | Selection and clipboard | Select one or many items. Use a selection rectangle, copy, paste, duplicate and delete. New copies receive new ids. |
| U13 | Groups and layers | Group, ungroup, lock, unlock and change draw order without broken connections. |
| U14 | Precise layout | Align and distribute a selection. Support a grid, snap, guides and keyboard nudges. |
| U15 | Canvas navigation | Zoom, pan, fit all and fit selection. Preserve readable text instead of automatic tiny labels. |
| U16 | Undo and redo | Undo and redo every graph edit. Do not capture keys from text fields or unrelated app controls. |
| U17 | Workspace persistence | Save a versioned graph with stable ids. Reload without lost geometry, text, styles or bindings. |
| U18 | Save failures and conflicts | Show failures. Preserve unsaved edits. Reject stale writes instead of silently replacing another change. |
| U19 | Comments and history | Attach comments to stable item ids. Preserve them after moves and renames. Restore previous graph versions. |
| U20 | UI references | Link an item to a design, page or node in the same project. Open either artifact from the other. |
| U21 | Editable import/export | Validate a versioned JSON artifact. Preserve ids, geometry, connections and UI references through a round trip. Reject or remap conflicting ids without broken bindings. |
| U22 | Image and document export | Export SVG, PNG and PDF, with whole-diagram/selection scope and background choice. |
| U23 | Agent access | MCP reads the graph and its rendered image. MCP updates use the same validation and revision checks as the UI. |
| U24 | Shared instance | Human edits reach the agent on its next read. Agent edits reach the visible canvas without a manual reload. |
| U25 | Handoff | Include the graph, images, comments and UI references through the existing agent-neutral handoff. |
| U26 | Access and regressions | Check keyboard access, focus and errors. Existing pages, mobile apps and slides must still work. |

## Reference and checks

The local design is `doi UML / home`, with MCP ids `doi-uml/home`. The visible browser uses the existing doi instance at `http://127.0.0.1:4317/`.

The initial reference has `index.html`, `canvas.html` and `linked-ui.html`. The dark revision adds focused connector, multi-selection and output states. Read the actual MCP result before implementation; do not infer controls from this plan.

Evidence: `/tmp/doi-uml-wireframe.15gqXJ/`. The wireframe pass checks real links, rendered pages, exports and comments. The application pass must drive each feature in the table and verify its saved result after reload.

## Canvas library evaluation

Metadata and upstream documents were checked on 2026-11-05. No new runtime dependency is installed yet.

| Candidate | Licence and compatibility | Fit and cost |
| --- | --- | --- |
| `@xyflow/react` 12.12.1 | MIT; React and React DOM >=17 | Best initial fit for the approved node/connector UI. Custom nodes and controlled edges can use doi's inspector. Domain history, persistence and exports remain doi's responsibility. |
| `@excalidraw/excalidraw` 0.18.1 | MIT; React 17, 18 or 19 | Supplies shapes, arrow bindings, undo and image export. Its whiteboard UI and scene format need more adaptation for the approved inspector and domain graph. |
| `tldraw` 5.6.0 | Its own licence; React 18.2 or 19.2.1 | The default licence excludes production use. Do not add a new licence or licence service requirement to doi for this feature. |

Primary sources:

- [React Flow source and example](https://github.com/xyflow/xyflow), [licence](https://github.com/xyflow/xyflow/blob/main/LICENSE), [package metadata](https://registry.npmjs.org/@xyflow/react/latest).
- [Excalidraw package features](https://github.com/excalidraw/excalidraw#features), [package metadata](https://registry.npmjs.org/@excalidraw/excalidraw/latest).
- [tldraw licence](https://github.com/tldraw/tldraw/blob/main/LICENSE.md), [package metadata](https://registry.npmjs.org/tldraw/latest).

Use React Flow as the initial candidate. Check its Bun build and binary bundle before adoption. Keep the graph schema independent of renderer types. A library demo does not prove the complete feature contract.

## Small implementation units

1. Define and test the versioned graph schema and invalid-input limits.
2. Add atomic workspace operations, revision checks and conflict tests.
3. Add the project-level optional entry and diagram lifecycle.
4. Add the canvas, shapes, text and persistent connections.
5. Add UML relationships, connector labels and their inspector.
6. Add selection, clipboard, groups, alignment, layers and undo.
7. Add persistence, comments, history and UI references.
8. Add graph/image exports and the existing handoff path.
9. Add MCP graph operations and shared-instance refresh.
10. Drive the complete feature contract before review and merge.

Each unit needs its own checks and focused commits. Keep issue #145 open until its complete acceptance path passes.
