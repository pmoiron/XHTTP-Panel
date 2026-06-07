import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DENO_API = "https://api.deno.com/v2";

// ── REST API helper ────────────────────────────────────────────────────────────

async function denoApi<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const resp = await fetch(`${DENO_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({})) as { message?: string; error?: string };
    throw new Error(err.message || err.error || `Deno API HTTP ${resp.status}`);
  }
  const text = await resp.text();
  return text ? JSON.parse(text) : ({} as T);
}

// ── Wait for deployment to finish ─────────────────────────────────────────────

async function waitForRevision(
  token: string,
  revisionId: string,
  timeoutMs = 120_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rev = await denoApi<{ status: string; error?: string }>(
      token, "GET", `/revisions/${revisionId}/progress`
    );
    if (rev.status === "succeeded") return;
    if (rev.status === "failed") throw new Error(`Deno deploy failed: ${rev.error || "unknown error"}`);
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error("Deno deploy timed out after 2 minutes");
}

// ── Params ─────────────────────────────────────────────────────────────────────

export interface DenoDeployParams {
  apiToken: string;
  orgName?: string;
  projectName: string;
  targetDomain: string;
  relayPath: string;
  publicPath: string;
}

// ── Main deploy function ───────────────────────────────────────────────────────

export async function deployToDeno(
  params: DenoDeployParams
): Promise<{ url: string; projectId: string }> {
  const slug = params.projectName.toLowerCase().replace(/[^a-z0-9-]/g, "-");

  // ── Step 1: Read relay source code ──────────────────────────────────────────
  const srcPath = resolve(__dirname, "../resources/deno-main.ts");
  const mainCode = readFileSync(srcPath, "utf8");

  const token = params.apiToken;

  // ── Step 2: Create app (ignore if already exists) ───────────────────────────
  try {
    await denoApi(token, "POST", "/apps", {
      slug,
    });
  } catch (err: any) {
    const msg = String(err).toLowerCase();
    const alreadyExists =
      msg.includes("already") || msg.includes("conflict") ||
      msg.includes("taken") || msg.includes("exists") || msg.includes("409");
    if (!alreadyExists) throw err;
    // App exists — continue to redeploy
  }

  // ── Step 3: Deploy code via REST API (no CLI needed) ─────────────────────────
  const revision = await denoApi<{ id: string }>(
    token, "POST", `/apps/${slug}/deploy`,
    {
      assets: {
        "main.ts": {
          kind: "file",
          encoding: "utf-8",
          content: mainCode,
        },
      },
      config: {
        runtime: {
          type: "dynamic",
          entrypoint: "main.ts",
        },
      },
      env_vars: [
        {
          key: "TARGET_DOMAIN",
          value: `https://${params.targetDomain.includes(":") ? params.targetDomain : params.targetDomain + ":443"}`,
        },
        { key: "RELAY_PATH",        value: params.relayPath },
        { key: "PUBLIC_RELAY_PATH", value: params.publicPath },
      ],
      production: true,
    }
  );

  // ── Step 4: Wait for deployment to succeed ───────────────────────────────────
  await waitForRevision(token, revision.id);

  // ── Step 5: Resolve org name for URL ─────────────────────────────────────────
  let orgName = params.orgName?.trim() || "";
  if (!orgName) {
    try {
      const orgs = await denoApi<Array<{ name: string }>>(token, "GET", "/organizations");
      if (orgs.length > 0) orgName = orgs[0].name;
    } catch {
      // Non-fatal
    }
  }

  const url = orgName
    ? `https://${slug}.${orgName}.deno.net`
    : `https://${slug}.deno.dev`;

  return { url, projectId: slug };
}

// ── Delete ─────────────────────────────────────────────────────────────────────

export async function deleteDenoProject(
  apiToken: string,
  projectId: string
): Promise<void> {
  const slug = projectId.includes("/") ? projectId.split("/")[1] : projectId;
  try {
    await denoApi(apiToken, "DELETE", `/apps/${slug}`);
  } catch {
    // Ignore — app may already be deleted
  }
}

// ── Token test ─────────────────────────────────────────────────────────────────

export async function testDenoToken(
  apiToken: string,
  orgName?: string
): Promise<{ valid: boolean; detail: string }> {
  if (!apiToken || !apiToken.startsWith("ddo_")) {
    return {
      valid: false,
      detail: 'Invalid token format — Deno Deploy tokens must start with "ddo_"',
    };
  }

  try {
    const orgsResp = await fetch("https://api.deno.com/v2/organizations", {
      headers: { Authorization: `Bearer ${apiToken}` },
    });

    if (orgsResp.ok) {
      const orgs = (await orgsResp.json()) as Array<{ id: string; name: string }>;
      const orgNames = orgs.map((o) => o.name).join(", ") || "personal";
      return { valid: true, detail: `Deno token valid — org(s): ${orgNames}` };
    }

    // Fallback: try /apps
    const appsResp = await fetch("https://api.deno.com/v2/apps", {
      headers: { Authorization: `Bearer ${apiToken}` },
    });

    if (appsResp.ok) {
      const apps = (await appsResp.json()) as Array<{ slug?: string }>;
      const detail = orgName
        ? `Deno token valid — org: ${orgName}, ${apps.length} app(s)`
        : `Deno token valid — ${apps.length} app(s) found`;
      return { valid: true, detail };
    }

    const errBody = await orgsResp.json().catch(() => ({})) as { message?: string };
    return { valid: false, detail: errBody.message || `HTTP ${orgsResp.status}` };
  } catch (err: any) {
    return { valid: false, detail: String(err).slice(0, 200) };
  }
}
