// How the assistant panel keeps a project's chats apart: which threads are its chats, in what order, and how a chat is
// named from its first message.
import assert from "node:assert/strict";
import { test } from "node:test";
import { assistantChats, chatName, titleFromMessage, unnamed } from "../src/domain/chats.ts";

test("a project's chats are the assistant's threads in that project, without tasks, the most recently used first", () => {
  const threads = [
    { id: "old", projectId: "p", title: "Research assistant", updatedAt: "2026-11-01T00:00:00Z" },
    { id: "task", projectId: "p", title: "Task: rerun the eval", updatedAt: "2026-11-08T00:00:00Z" },
    { id: "other", projectId: "q", title: "New chat", updatedAt: "2026-11-08T00:00:00Z" },
    { id: "new", projectId: "p", title: "Why did step 400 regress?", updatedAt: "2026-11-07T00:00:00Z" },
  ];
  assert.deepEqual(assistantChats(threads, "p").map((thread) => thread.id), ["new", "old"]);
});

test("a chat keeps the name it was made with until its first message names it", () => {
  for (const title of ["New chat", "Research assistant", "New Chat", "Conversation", " "]) assert.ok(unnamed(title), title);
  assert.equal(unnamed("Why did step 400 regress?"), false);
  assert.equal(chatName({ title: "Research assistant" }), "New chat");
  assert.equal(chatName({ title: "Probe the name heads" }), "Probe the name heads");
});

test("a name from a message is its first line with words in it, cut on a word", () => {
  assert.equal(titleFromMessage("\n\n  Compare checkpoints 300 and 400  \nthen label"), "Compare checkpoints 300 and 400");
  const long = titleFromMessage("Find the samples that regressed between the SFT and the DPO checkpoint on the arithmetic split");
  assert.ok(long.length <= 61, long);
  assert.ok(long.endsWith("…"));
  assert.ok(!long.includes("  "));
  assert.equal(titleFromMessage(""), "");
});
