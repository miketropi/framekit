import packageJson from "../package.json";

/** Package identity reported by `hf doctor` and `--version`. */
export const PACKAGE_NAME: string = packageJson.name;
export const PACKAGE_VERSION: string = packageJson.version;
export const MINIMUM_NODE_MAJOR = 20;
