"use strict";

// src/github/action.ts
var CLAIM_API = "https://id.org.ai/api/claim";
var OIDC_AUDIENCE = "id.org.ai";
var MAX_RETRIES = 3;
var RETRY_DELAY_MS = 1e3;
async function requestOIDCToken(audience = OIDC_AUDIENCE) {
  const tokenUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!tokenUrl || !requestToken) {
    throw new Error(
      "OIDC token not available. Ensure your workflow has `permissions: { id-token: write }` and this action is running in a GitHub Actions environment."
    );
  }
  const url = new URL(tokenUrl);
  url.searchParams.set("audience", audience);
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${requestToken}`,
      Accept: "application/json"
    }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OIDC token request failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  if (!data.value) {
    throw new Error("OIDC token response missing value field");
  }
  return data.value;
}
async function verifyClaimFromAction(input) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(CLAIM_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${input.oidcToken}`
        },
        body: JSON.stringify({
          claimToken: input.tenant,
          githubUserId: input.actorId,
          githubUsername: input.actor,
          repo: input.repo,
          branch: input.branch
        })
      });
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        const error = await response.json();
        return { success: false, error: error.error };
      }
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }
        return { success: false, error: `claim_failed_after_retries: ${lastError}` };
      }
      const result = await response.json();
      if (!result.success) {
        return { success: false, error: result.error };
      }
      return {
        success: true,
        tenantId: result.identity?.id,
        level: result.identity?.level,
        claimed: true
      };
    } catch (err) {
      lastError = err.message;
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
        continue;
      }
    }
  }
  return { success: false, error: `claim_failed_after_retries: ${lastError}` };
}
function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const fs = require("fs");
    fs.appendFileSync(outputFile, `${name}=${value}
`);
  } else {
    console.log(`::set-output name=${name}::${value}`);
  }
}
function setError(message) {
  console.log(`::error::${message}`);
}
function setNotice(message) {
  console.log(`::notice::${message}`);
}
async function writeTenantConfig(output) {
  const fs = require("fs");
  const path = require("path");
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const configDir = path.join(workspace, ".headless.ly");
  const configFile = path.join(configDir, "tenant.json");
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  const config = {
    tenantId: output.tenantId,
    level: output.level,
    claimed: output.claimed,
    claimedAt: (/* @__PURE__ */ new Date()).toISOString(),
    repo: process.env.GITHUB_REPOSITORY,
    actor: process.env.GITHUB_ACTOR
  };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n");
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// action/src/index.ts
async function run() {
  const tenant = process.env.INPUT_TENANT;
  if (!tenant) {
    setError("Missing required input: tenant");
    process.exit(1);
  }
  if (!tenant.startsWith("clm_")) {
    setError("Invalid tenant format. Expected a claim token starting with clm_");
    process.exit(1);
  }
  let oidcToken;
  try {
    oidcToken = await requestOIDCToken();
  } catch (err) {
    setError(
      `Failed to request OIDC token: ${err.message}
Ensure your workflow includes:
  permissions:
    id-token: write`
    );
    process.exit(1);
  }
  const repo = process.env.GITHUB_REPOSITORY ?? "";
  const branch = (process.env.GITHUB_REF ?? "").replace("refs/heads/", "");
  const actor = process.env.GITHUB_ACTOR ?? "";
  const actorId = process.env.GITHUB_ACTOR_ID ?? "";
  console.log(`Claiming tenant for ${actor} (${actorId}) on ${repo}@${branch}`);
  const result = await verifyClaimFromAction({
    tenant,
    oidcToken,
    repo,
    branch,
    actor,
    actorId
  });
  if (!result.success) {
    setError(`Claim failed: ${result.error}`);
    process.exit(1);
  }
  setOutput("tenant-id", result.tenantId ?? "");
  setOutput("level", String(result.level ?? 0));
  setOutput("claimed", String(result.claimed ?? false));
  try {
    await writeTenantConfig(result);
    setNotice(`Tenant config written to .headless.ly/tenant.json`);
  } catch (err) {
    console.log(`::warning::Failed to write tenant config: ${err.message}`);
  }
  const syncKeys = (process.env.INPUT_SYNC_KEYS ?? "false").toLowerCase() === "true";
  if (syncKeys) {
    try {
      await syncAgentKeys(result.tenantId, oidcToken);
      setNotice("Agent public keys synced to .headless.ly/agents/");
    } catch (err) {
      console.log(`::warning::Failed to sync agent keys: ${err.message}`);
    }
  }
  console.log("");
  console.log("Tenant claimed successfully.");
  console.log(`  Tenant ID: ${result.tenantId}`);
  console.log(`  Level: ${result.level}`);
  console.log(`  Claimed: ${result.claimed}`);
  console.log("");
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    const fs = require("fs");
    const summary = [
      "## Tenant Claimed",
      "",
      "| Property | Value |",
      "| --- | --- |",
      `| Tenant ID | \`${result.tenantId}\` |`,
      `| Level | ${result.level} |`,
      `| Actor | @${actor} |`,
      `| Repository | ${repo} |`,
      `| Branch | ${branch} |`,
      "",
      "Your headless.ly tenant is now linked to this GitHub identity.",
      ""
    ].join("\n");
    fs.appendFileSync(summaryFile, summary);
  }
}
async function syncAgentKeys(tenantId, oidcToken) {
  const fs = require("fs");
  const path = require("path");
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const agentsDir = path.join(workspace, ".headless.ly", "agents");
  const res = await fetch(`https://id.org.ai/api/identity/${tenantId}/agents`, {
    headers: {
      Authorization: `Bearer ${oidcToken}`,
      Accept: "application/json"
    }
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch agent keys (${res.status})`);
  }
  const data = await res.json();
  if (!data.agents || data.agents.length === 0) {
    console.log("No agent keys to sync.");
    return;
  }
  if (!fs.existsSync(agentsDir)) {
    fs.mkdirSync(agentsDir, { recursive: true });
  }
  for (const agent of data.agents) {
    const filename = `${agent.name ?? agent.id}.pub`;
    const filepath = path.join(agentsDir, filename);
    fs.writeFileSync(filepath, agent.publicKey + "\n");
  }
  console.log(`Synced ${data.agents.length} agent key(s) to .headless.ly/agents/`);
}
run().catch((err) => {
  setError(`Unexpected error: ${err.message}`);
  process.exit(1);
});
