import { expect, test } from "bun:test";
import { editorLink } from "../src/web/components/DesignSystemDialog.tsx";

test("the editor link puts the absolute path into the template", () => {
  expect(editorLink("vscode://file{path}", "/home/me/ws/design-systems/acme", "tokens.css")).toBe(
    "vscode://file/home/me/ws/design-systems/acme/tokens.css",
  );
  expect(editorLink("cursor://file{path}", "/a b/ds/", "fonts/My Font.woff2")).toBe("cursor://file/a%20b/ds/fonts/My%20Font.woff2");
});

test("type samples use the token as a font, a size, a weight or a line height", async () => {
  const { typeStyle } = await import("../src/web/components/DesignSystemDialog.tsx");
  expect(typeStyle({ name: "--acme-font", resolved: 'Georgia, "Times New Roman", serif' })).toEqual({ fontFamily: 'Georgia, "Times New Roman", serif' });
  expect(typeStyle({ name: "--font-sans", resolved: "Inter, sans-serif" })).toEqual({ fontFamily: "Inter, sans-serif" });
  expect(typeStyle({ name: "--text-lg", resolved: "1.125rem" })).toEqual({ fontSize: "1.125rem" });
  expect(typeStyle({ name: "--text-fluid", resolved: "clamp(1rem, 2vw, 2rem)" })).toEqual({ fontSize: "clamp(1rem, 2vw, 2rem)" });
  expect(typeStyle({ name: "--weight-bold", resolved: "700" })).toEqual({ fontWeight: "700" });
  expect(typeStyle({ name: "--leading", resolved: "1.5" })).toEqual({ lineHeight: "1.5" });
  expect(typeStyle({ name: "--tracking-wide", resolved: "0.02em" })).toEqual({ letterSpacing: "0.02em" });
});
