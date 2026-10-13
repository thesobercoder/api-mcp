import { defineRailway, github, preserve, project, service } from "railway/iac";

// This repository manages only its own resources in the environment.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = "api-mcp";

export default defineRailway(() => {
  const api_mcp = service("api-mcp", {
    // Railway builds the Dockerfile and deploys on every push to main.
    source: github("thesobercoder/api-mcp", { branch: "main" }),
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    healthcheck: "/health",
    healthcheckTimeout: 60,
    deploy: {
      // Railway stores its default ON_FAILURE policy as null.
      restartPolicyType: null,
      restartPolicyMaxRetries: 3,
      drainingSeconds: 25,
      overlapSeconds: 10,
    },
    // No public domains or TCP proxies. Private DNS uses the service name.
    // All API definitions come from these variables at runtime; nothing is baked into the image.
    env: {
      OPENAPI_SPECS: "trakt=https://developer.trakt.tv/openapi.json,whoop=https://api.prod.whoop.com/developer/doc/openapi.json",
      TRAKT_CLIENT_ID: preserve(),
      API_TRAKT_HEADERS: '{"trakt-api-key":"${TRAKT_CLIENT_ID}","trakt-api-version":"2"}',
      API_TRAKT_READ_ONLY: "true",
      API_TRAKT_OPTIONAL_TRAILING_PATH_PARAMS: "true",
      API_WHOOP_READ_ONLY: "true",
      API_WHOOP_EXCLUDE: "tag:Partner* path:/v2/partner/*",
      SPEC_REFRESH_SECONDS: "3600",
      NODE_ENV: "production",
      HOST: "::",
      PORT: "8080",
      LOG_LEVEL: "info",
      MAX_REQUEST_BYTES: "1048576",
      MAX_RESPONSE_BYTES: "1048576",
      UPSTREAM_TIMEOUT_MS: "20000",
    },
  });
  return project("bifrost", {
    resources: [api_mcp],
  });
});
