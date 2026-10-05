#!/usr/bin/env node
/**
 * Install this repository's Skills into an OMP skills root.
 *
 *   pnpm skills:install                 # user-global: ~/.omp/agent/skills (OMP native, priority 100)
 *   pnpm skills:install -- --project .  # project-local: <dir>/.omp/skills
 *
 * Skills are linked by default, so edits in this repository are picked up on the next
 * OMP start; `--copy` writes real directories instead (for machines that cannot follow
 * symlinks). Existing entries are reported, never silently overwritten without --force.
 */
import { access, copyFile, mkdir, readFile, readlink, rm, symlink } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS = [
  "higgsfield-image-generation",
  "higgsfield-video-generation",
  "higgsfield-media-workflow",
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = {
    scope: "user",
    projectDir: process.cwd(),
    copy: false,
    force: false,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--project" || arg === "--project-dir" || arg === "-p") {
      options.scope = "project";
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("-")) {
        options.projectDir = path.resolve(next);
        index += 1;
      }
    } else if (arg === "--user" || arg === "--global" || arg === "-g") {
      options.scope = "user";
    } else if (arg === "--copy") {
      options.copy = true;
    } else if (arg === "--force" || arg === "-f") {
      options.force = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

async function exists(target) {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Frontmatter sanity check: OMP needs a meaningful description, and name/dir agreement. */
async function inspectSkill(directory) {
  const entry = path.join(directory, "SKILL.md");
  const text = await readFile(entry, "utf8");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  const name = /^name:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim();
  const description = /^description:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim();
  const problems = [];
  if (name === undefined) problems.push("missing frontmatter `name`");
  if (description === undefined || description.length < 20) {
    problems.push("missing or too-short frontmatter `description`");
  }
  if (name !== undefined && name !== path.basename(directory)) {
    problems.push(
      `frontmatter name "${name}" does not match directory "${path.basename(directory)}"`,
    );
  }
  return { entry, problems };
}

async function install(skill, targetRoot, options) {
  const source = path.join(repoRoot, "skills", skill);
  const target = path.join(targetRoot, skill);
  const { problems } = await inspectSkill(source);
  if (problems.length > 0) {
    return { skill, status: "invalid", detail: problems.join("; ") };
  }

  if (await exists(target)) {
    let current;
    try {
      current = await readlink(target);
    } catch {
      current = undefined;
    }
    const linkedHere =
      current !== undefined && path.resolve(path.dirname(target), current) === source;
    if (linkedHere && !options.force) {
      return { skill, status: "already-linked", detail: target };
    }
    if (!options.force) {
      return {
        skill,
        status: "skipped",
        detail: `${target} already exists (use --force to replace)`,
      };
    }
    if (!options.dryRun) await rm(target, { recursive: true, force: true });
  }

  if (options.dryRun) {
    return { skill, status: options.copy ? "would-copy" : "would-link", detail: target };
  }

  await mkdir(targetRoot, { recursive: true });
  if (options.copy) {
    await mkdir(target, { recursive: true });
    await copyFile(path.join(source, "SKILL.md"), path.join(target, "SKILL.md"));
    return { skill, status: "copied", detail: target };
  }

  await symlink(source, target, "dir");
  return { skill, status: "linked", detail: target };
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(
    [
      "Install this repository's Skills into an OMP skills root.",
      "",
      "  --user, -g            user-global root: ~/.omp/agent/skills (default)",
      "  --project, -p [dir]   project root: <dir>/.omp/skills (default: cwd)",
      "  --copy                copy files instead of symlinking",
      "  --force, -f           replace existing entries",
      "  --dry-run             report what would happen",
    ].join("\n"),
  );
  process.exit(0);
}

const targetRoot =
  options.scope === "user"
    ? path.join(homedir(), ".omp", "agent", "skills")
    : path.join(options.projectDir, ".omp", "skills");

console.log(`source: ${path.join(repoRoot, "skills")}`);
console.log(`target: ${targetRoot}${options.copy ? " (copy)" : " (symlink)"}`);
console.log("");

const results = [];
for (const skill of SKILLS) results.push(await install(skill, targetRoot, options));

for (const result of results)
  console.log(`  ${result.status.padEnd(14)} ${result.skill} → ${result.detail}`);

const failures = results.filter(
  (result) => result.status === "invalid" || result.status === "skipped",
);
console.log("");
console.log(
  failures.length === 0
    ? `installed ${results.length} skills; OMP picks them up on its next start (read via skill://<name>)`
    : `${failures.length} skill(s) need attention`,
);
process.exit(failures.length === 0 ? 0 : 1);
