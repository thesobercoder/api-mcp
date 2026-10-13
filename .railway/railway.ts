import { defineRailway, preserve, project, service } from "railway/iac";

// This repository manages only its own resources in the environment. Other
// repositories export their own partial name.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = "api-mcp";

export default defineRailway(() => {
  const api_mcp = service("api-mcp", {
    start: "bun src/server.mjs",
    healthcheck: "/health",
    healthcheckTimeout: 60,
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    deploy: {
      // Railway stores its default ON_FAILURE policy as null.
      restartPolicyType: null,
      restartPolicyMaxRetries: 3,
      drainingSeconds: 25,
      overlapSeconds: 10,
    },
    // No public domains or TCP proxies. Private DNS uses the service name.
    env: {
      API_CONFIG: preserve(),
      TRAKT_CLIENT_ID: preserve(),
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
