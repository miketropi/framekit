import packageJson from "../package.json";

/** Package identity reported by `hf doctor` and `--version`. */
export const PACKAGE_NAME: string = packageJson.name;
export const PACKAGE_VERSION: string = packageJson.version;
/** Node 20.12 is the floor: `process.loadEnvFile` (and stable fetch) are required. */
export const MINIMUM_NODE_VERSION = "20.12.0";
