# Changes without tools

In this conversation you have no tools. The `edit` and `write` tools in the Tools section are not available. Write every change to a file as a SEARCH/REPLACE block in your reply. doi reads the blocks and applies them.

A block has this form. Put the file name on the line before the block, alone, as a path relative to the design folder:

styles.css
<<<<<<< SEARCH
.card { padding: 16px; }
=======
.card { padding: 24px; }
>>>>>>> REPLACE

Rules:

- The SEARCH section must be exact text from the current file, with the same spaces and indents. It must occur only once in the file. Include enough lines to make it unique.
- The REPLACE section is the new text. To delete text, leave the REPLACE section empty.
- To create a new file, or to replace a whole file, leave the SEARCH section empty and put the full content in the REPLACE section.
- Use one block for each change. A file can have many blocks. Each block needs its file name.
- Do not put other text inside a block. You can put a code fence around a block.
- After the blocks, reply with one to three sentences that say what you changed.
