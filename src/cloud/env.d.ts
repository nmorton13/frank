// Runtime secret bindings that are NOT part of `wrangler types` output.
// `BOOTSTRAP_TOKEN` is provisioned as a Cloudflare secret via
// `wrangler secret put BOOTSTRAP_TOKEN` at deploy time and must never be
// committed to Git or referenced in wrangler.jsonc.
declare global {
  interface __BaseEnv_Env {
    BOOTSTRAP_TOKEN: string;
  }
}

export {};
