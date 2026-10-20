import assert from "node:assert/strict";
import test from "node:test";
import { parseDocumentId, structuralElementsText } from "../src/tools/docs.js";

test("parseDocumentId accepts IDs and common Google Docs URLs", () => {
  assert.equal(parseDocumentId("abc_123-Z"), "abc_123-Z");
  assert.equal(
    parseDocumentId("https://docs.google.com/document/d/abc_123-Z/edit?tab=t.0"),
    "abc_123-Z",
  );
  assert.equal(
    parseDocumentId("https://docs.google.com/document/u/0/d/another-id/view"),
    "another-id",
  );
  assert.throws(() => parseDocumentId("not a document URL"), /document ID/);
});

test("structuralElementsText renders paragraphs, lists, and tables", () => {
  const text = structuralElementsText([
    {
      paragraph: {
        elements: [{ textRun: { content: "Heading\n" } }],
      },
    },
    {
      paragraph: {
        bullet: { nestingLevel: 1 },
        elements: [{ textRun: { content: "Nested item\n" } }],
      },
    },
    {
      table: {
        tableRows: [
          {
            tableCells: [
              { content: [{ paragraph: { elements: [{ textRun: { content: "A\n" } }] } }] },
              { content: [{ paragraph: { elements: [{ textRun: { content: "B\n" } }] } }] },
            ],
          },
        ],
      },
    },
  ]);

  assert.equal(text, "Heading\n  • Nested item\nA\tB\n");
});

test("structuralElementsText keeps readable labels for non-text elements", () => {
  const text = structuralElementsText([
    {
      paragraph: {
        elements: [
          { person: { personProperties: { name: "Ada" } } },
          { textRun: { content: " linked " } },
          { richLink: { richLinkProperties: { title: "Project plan" } } },
          { footnoteReference: { footnoteNumber: "1" } },
          { inlineObjectElement: { inlineObjectId: "image-id" } },
        ],
      },
    },
  ]);

  assert.equal(text, "Ada linked Project plan[1][image]");
});
