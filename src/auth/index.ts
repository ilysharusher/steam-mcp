import app from "./app";

export { allowlist } from "./allowlist";

/** The OAuthProvider `defaultHandler` slot wants an ExportedHandler shape. */
export const authHandler = app;
