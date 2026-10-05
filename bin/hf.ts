#!/usr/bin/env node
import { runCli } from "../src/index";

process.exitCode = await runCli(process.argv, process);
