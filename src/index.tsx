import "dotenv/config";
import { startCLI } from "./cli/index.js";

startCLI().catch(console.error);
