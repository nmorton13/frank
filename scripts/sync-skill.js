#!/usr/bin/env node
// Single-source mechanism for the hosted skill copy.
//
// The repository copy (skills/frank-cloud/) is the source of truth. The hosted
// copy under public/skills/frank-cloud/ is what the Worker serves at
// /skills/frank-cloud/*. This script keeps them in sync:
//
//   node scripts/sync-skill.js check   # exit non-zero on drift (used by tests)
//   node scripts/sync-skill.js sync    # overwrite the hosted copy
"use strict";

const { copyFileSync, mkdirSync, readFileSync, statSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");

const ROOT = resolve(__dirname, "..");
const SRC = join(ROOT, "skills", "frank-cloud");
const DST = join(ROOT, "public", "skills", "frank-cloud");

// Files in the repo skill that must be mirrored exactly.
const FILES = [
  ["SKILL.md", "SKILL.md"],
  ["scripts/frank-cloud-post.sh", "frank-cloud-post.sh"],
];

function bytesEqual(a, b) {
  const left = readFileSync(a);
  let right;
  try {
    right = readFileSync(b);
  } catch {
    return false;
  }
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function sync() {
  for (const [srcRel, dstRel] of FILES) {
    const srcPath = join(SRC, srcRel);
    const dstPath = join(DST, dstRel);
    mkdirSync(dirname(dstPath), { recursive: true });
    copyFileSync(srcPath, dstPath);
  }
}

function check() {
  const drift = [];
  for (const [srcRel, dstRel] of FILES) {
    const srcPath = join(SRC, srcRel);
    const dstPath = join(DST, dstRel);
    if (!statSync(srcPath, { throwIfNoEntry: false }) || !statSync(dstPath, { throwIfNoEntry: false })) {
      drift.push(`${srcRel} -> ${dstRel} (missing)`);
    } else if (!bytesEqual(srcPath, dstPath)) {
      drift.push(`${srcRel} -> ${dstRel} (content differs)`);
    }
  }
  return drift;
}

const mode = process.argv[2] || "check";
if (mode === "sync") {
  sync();
  console.log("Hosted skill copy synced from repository.");
} else if (mode === "check") {
  const drift = check();
  if (drift.length) {
    console.error("Skill copy drift detected:\n  " + drift.join("\n  "));
    console.error("Run `node scripts/sync-skill.js sync` to sync, or edit the repository copy.");
    process.exit(1);
  }
  console.log("Skill copy parity OK.");
} else {
  console.error(`Unknown mode: ${mode} (expected "check" or "sync")`);
  process.exit(2);
}
