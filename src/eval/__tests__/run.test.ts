import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJsonlTasks, detectSubmissionMarker } from "../run.js";

const VALID_TASK = {
  instance_id: "django__django-12345",
  problem_statement: "Bug in X.",
  base_commit: "abc123",
  repo: "https://github.com/django/django",
};

test("parseJsonlTasks: parses one valid task", () => {
  const text = JSON.stringify(VALID_TASK);
  const tasks = parseJsonlTasks(text);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].instance_id, "django__django-12345");
});

test("parseJsonlTasks: parses multiple tasks", () => {
  const text = [VALID_TASK, { ...VALID_TASK, instance_id: "x__x-1" }]
    .map((t) => JSON.stringify(t))
    .join("\n");
  const tasks = parseJsonlTasks(text);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[1].instance_id, "x__x-1");
});

test("parseJsonlTasks: tolerates trailing newline and blank lines", () => {
  const text =
    JSON.stringify(VALID_TASK) + "\n\n" + JSON.stringify(VALID_TASK) + "\n";
  const tasks = parseJsonlTasks(text);
  assert.equal(tasks.length, 2);
});

test("parseJsonlTasks: throws on malformed JSON", () => {
  assert.throws(
    () => parseJsonlTasks("{not json}"),
    /Malformed JSONL at line 1/,
  );
});

test("parseJsonlTasks: throws when required field missing", () => {
  const bad = { ...VALID_TASK };
  delete (bad as Partial<typeof bad>).repo;
  assert.throws(
    () => parseJsonlTasks(JSON.stringify(bad)),
    /missing required fields/,
  );
});

test("parseJsonlTasks: preserves optional repo_dir_name", () => {
  const t = { ...VALID_TASK, repo_dir_name: "django-fork" };
  const tasks = parseJsonlTasks(JSON.stringify(t));
  assert.equal(tasks[0].repo_dir_name, "django-fork");
});

test("detectSubmissionMarker: TASK_COMPLETE on its own line", () => {
  const text = "Here is the patch.\n```diff\n...\n```\nTASK_COMPLETE\n";
  assert.deepEqual(detectSubmissionMarker(text), { kind: "complete" });
});

test("detectSubmissionMarker: TASK_COMPLETE alone is also valid", () => {
  assert.deepEqual(detectSubmissionMarker("TASK_COMPLETE"), {
    kind: "complete",
  });
});

test("detectSubmissionMarker: TASK_ABORT with reason", () => {
  const text = "I cannot fix this without more info.\nTASK_ABORT: missing repro";
  assert.deepEqual(detectSubmissionMarker(text), {
    kind: "abort",
    reason: "missing repro",
  });
});

test("detectSubmissionMarker: no marker → none", () => {
  const text = "I changed the function but did not call a tool last.\nDone.";
  assert.deepEqual(detectSubmissionMarker(text), { kind: "none" });
});

test("detectSubmissionMarker: TASK_ABORT requires reason (otherwise none)", () => {
  // Bare "TASK_ABORT" with no colon is not a valid abort — model must explain.
  assert.deepEqual(detectSubmissionMarker("TASK_ABORT"), { kind: "none" });
});

test("detectSubmissionMarker: does not false-positive on the word 'TASK_COMPLETE' embedded in prose", () => {
  // The regex is anchored to a full line, so an inline mention should not trigger.
  const text = "I will output TASK_COMPLETE later.";
  assert.deepEqual(detectSubmissionMarker(text), { kind: "none" });
});
