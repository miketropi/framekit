import type { Command } from "commander";
import { MAX_CHARACTER_PAGE_SIZE } from "../../config/defaults";
import { executeAction, requireToolkit, type CliRuntime } from "../runtime";
import { positiveInteger } from "../parsers";
import type { CommandResult } from "../output";

interface CreateOptions {
  name: string;
  reference: string[];
  json?: boolean;
}

interface ListOptions {
  page?: number;
  pageSize?: number;
  json?: boolean;
}

export function registerCharactersCommand(program: Command, runtime: CliRuntime): void {
  const characters = program
    .command("characters")
    .description("Manage optional custom character references (Soul ids).");

  characters
    .command("create")
    .description("Create a character reference from 1-4 local images or URLs.")
    .requiredOption("--name <name>", "character name")
    .requiredOption(
      "--reference <path|url>",
      "reference image; repeat the flag for multiple images",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option("--json", "write one JSON document to stdout")
    .action(async (options: CreateOptions) => {
      await executeAction(runtime, async () => {
        runtime.output.progress("creating character reference");
        const toolkit = await requireToolkit(runtime);
        const character = await toolkit.characters.create(options.name, options.reference ?? []);
        const result: CommandResult = {
          envelope: {
            ok: true,
            operation: "character-reference",
            provider: toolkit.config.provider,
            status: character.status,
            details: { character },
          },
          human: [
            `character-reference: ${character.status}`,
            `  id: ${character.id}`,
            `  name: ${character.name}`,
          ],
        };
        return result;
      });
    });

  characters
    .command("list")
    .description("List character references.")
    .option("--page <n>", "page number", positiveInteger("--page", 10_000))
    .option(
      "--page-size <n>",
      `page size (1-${MAX_CHARACTER_PAGE_SIZE})`,
      positiveInteger("--page-size", MAX_CHARACTER_PAGE_SIZE),
    )
    .option("--json", "write one JSON document to stdout")
    .action(async (options: ListOptions) => {
      await executeAction(runtime, async () => {
        const toolkit = await requireToolkit(runtime);
        const page = await toolkit.characters.list(options.page, options.pageSize);
        return {
          envelope: {
            ok: true,
            operation: "characters-list",
            provider: toolkit.config.provider,
            status: "completed",
            details: {
              total: page.total,
              page: page.page,
              pageSize: page.pageSize,
              totalPages: page.totalPages,
              characters: page.items,
            },
          },
          human: [
            `characters: ${page.items.length} of ${page.total} (page ${page.page}/${page.totalPages})`,
            ...page.items.map((item) => `  ${item.id}  ${item.name}  ${item.status}`),
          ],
        };
      });
    });
}
