#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { copyPackAssets } from "./build.mjs";

copyPackAssets(join(dirname(fileURLToPath(import.meta.url)), ".."));
