import assert from "node:assert/strict";
import test from "node:test";
import { SCOPES } from "../src/config.js";
import { escapeDriveQueryLiteral, parseDriveFileId } from "../src/tools/drive.js";

test("OAuth requests read-only Google Drive access", () => {
  assert.ok(SCOPES.includes("https://www.googleapis.com/auth/drive.readonly"));
  assert.ok(!SCOPES.includes("https://www.googleapis.com/auth/drive"));
});

test("parseDriveFileId accepts IDs and common Google Drive URLs", () => {
  assert.equal(parseDriveFileId("abc_123-Z"), "abc_123-Z");
  assert.equal(parseDriveFileId("root"), "root");
  assert.equal(
    parseDriveFileId("https://drive.google.com/drive/u/0/folders/folder_123-Z"),
    "folder_123-Z",
  );
  assert.equal(
    parseDriveFileId("https://drive.google.com/file/d/file_123-Z/view?usp=sharing"),
    "file_123-Z",
  );
  assert.equal(
    parseDriveFileId("https://docs.google.com/spreadsheets/d/sheet_123-Z/edit#gid=0"),
    "sheet_123-Z",
  );
  assert.equal(
    parseDriveFileId("https://drive.google.com/open?id=opened_123-Z"),
    "opened_123-Z",
  );
  assert.throws(() => parseDriveFileId("not a Drive URL"), /file\/folder ID/);
});

test("escapeDriveQueryLiteral escapes Drive query string delimiters", () => {
  assert.equal(escapeDriveQueryLiteral("Project's \\ archive"), "Project\\'s \\\\ archive");
});
