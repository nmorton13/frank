import path from "node:path";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(
        path.join(import.meta.dirname, "migrations"),
      );

      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            BOOTSTRAP_TOKEN: "test-bootstrap-token-for-tests-only",
            BOOTSTRAP_QUOTA_PER_HOUR: "1000",
            BOOTSTRAP_PUBLIC_QUOTA_PER_HOUR: "1000",
            BOOTSTRAP_TOTAL_CEILING: "100000",
            BOOTSTRAP_CLIENT_CEILING: "100000",
            BOOTSTRAP_PUBLIC_TOTAL_CEILING: "100000",
            LOGIN_CLIENT_CEILING: "100000",
            LOGIN_GLOBAL_CEILING: "100000",
            CLAIM_CLIENT_CEILING: "100000",
            CLAIM_GLOBAL_CEILING: "100000",
            EMAIL_RECIPIENT_CEILING: "100000",
            EMAIL_GLOBAL_CEILING: "100000",
            AGENT_CREDENTIAL_MINUTE_CEILING: "100000",
            HUMAN_SESSION_MINUTE_CEILING: "100000",
            WORKSPACE_MINUTE_CEILING: "100000",
            WORKSPACE_WRITE_HOUR_CEILING: "100000",
            USER_WORKSPACE_CEILING: "100000",
            WORKSPACE_ENTRY_CEILING: "20",
            WORKSPACE_PROJECT_CEILING: "20",
            WORKSPACE_ALIAS_CEILING: "25",
            WORKSPACE_PROJECT_EVENT_CEILING: "5",
            SUMMARY_ENTRY_CEILING: "200",
            COLLECTION_RESPONSE_BYTE_CEILING: "524288",
            SUMMARY_OUTPUT_BYTE_CEILING: "1048576",
            SUMMARY_RESPONSE_BYTE_CEILING: "262144",
            EXPORT_ENTRY_CEILING: "100",
            EXPORT_RESPONSE_BYTE_CEILING: "1048576",
            CLEANUP_BATCH_SIZE: "100",
            DELETED_WORKSPACE_RETENTION_DAYS: "30",
            EMAIL_ENABLED: "true",
            EMAIL_FROM: "no-reply@frank.asterio.io",
            APP_ORIGIN: "https://frank.test",
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./tests/cloud/apply-migrations.ts"],
    include: ["tests/cloud/**/*.test.ts"],
  },
});
