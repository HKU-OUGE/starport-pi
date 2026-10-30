import path from "node:path";
import { load } from "../src/config.mjs";
load(path.resolve(process.argv[2]));
