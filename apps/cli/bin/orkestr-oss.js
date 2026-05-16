#!/usr/bin/env node
import { runCli } from "../src/commands.js";

process.exitCode = await runCli(process.argv.slice(2));
