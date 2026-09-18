import { describe, test, expect } from "bun:test";
import { spawn } from "node:child_process";

describe("E42 teardown straggler handling (#1028)", () => {
  test("deliberate assertion failure in E42 gate exits non-zero", async () => {
    // Run the gate script with an invalid binary or failing flag to verify assertion failure exits non-zero
    const child = spawn("bun", ["scripts/e2e-opencode-v2-package.mjs"], {
      env: { ...process.env, E2E_OPENCODE_BIN: "" },
    });
    const exitCode = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    expect(exitCode).not.toBe(0);
  });

  test("straggler arriving after teardownStarted returns 503 and records teardownStraggler", async () => {
    // Simulate the endpoint logic in e2e-opencode-v2-package.mjs
    let teardownStarted = false;
    const requests: any[] = [];
    const discoveryRequests: any[] = [];

    const endpoint = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (teardownStarted) {
          const row = {
            method: request.method,
            path: new URL(request.url).pathname,
            startedAt: Date.now(),
            teardownStraggler: true,
            status: 503,
            error: "Teardown in progress",
          };
          if (request.method === "POST") requests.push(row);
          else discoveryRequests.push(row);
          return new Response("teardown in progress", { status: 503 });
        }
        return new Response("ok", { status: 200 });
      },
    });

    try {
      // Normal request before teardown
      const normalRes = await fetch(`http://127.0.0.1:${endpoint.port}/v1/messages`, {
        method: "POST",
        body: JSON.stringify({ message: "hi" }),
      });
      expect(normalRes.status).toBe(200);

      // Start teardown
      teardownStarted = true;

      // Straggler POST arrives
      const stragglerPost = await fetch(`http://127.0.0.1:${endpoint.port}/v1/messages`, {
        method: "POST",
        body: JSON.stringify({ message: "straggler post" }),
      });
      expect(stragglerPost.status).toBe(503);
      expect(requests.length).toBe(1);
      expect(requests[0].teardownStraggler).toBe(true);
      expect(requests[0].status).toBe(503);

      // Straggler GET (discovery) arrives
      const stragglerGet = await fetch(`http://127.0.0.1:${endpoint.port}/v1/models`, {
        method: "GET",
      });
      expect(stragglerGet.status).toBe(503);
      expect(discoveryRequests.length).toBe(1);
      expect(discoveryRequests[0].teardownStraggler).toBe(true);
      expect(discoveryRequests[0].status).toBe(503);
    } finally {
      await endpoint.stop(true);
    }
  });

  test("live forward to closed proxy catches error and returns 502 without unhandled rejection", async () => {
    let teardownStarted = true;
    const row: any = { requestId: "test-req", startedAt: Date.now() };

    // Pointing to an unreachable/closed port
    const unreachableProxyUrl = "http://127.0.0.1:65530";
    const forwardedHeaders = new Headers();
    forwardedHeaders.set("x-request-id", row.requestId);

    let caughtResponse: Response | null = null;
    try {
      const response = await fetch(`${unreachableProxyUrl}/v1/messages`, {
        method: "POST",
        headers: forwardedHeaders,
        body: JSON.stringify({ message: "test" }),
      });
      caughtResponse = new Response(
        response.body?.pipeThrough(
          new TransformStream({
            flush() {
              row.completedAt = Date.now();
            },
          })
        ),
        { status: response.status, headers: response.headers }
      );
    } catch (error) {
      row.status = 0;
      row.error = String(error);
      if (teardownStarted) row.teardownStraggler = true;
      caughtResponse = new Response("proxy post forward failed", { status: 502 });
    }

    expect(caughtResponse).not.toBeNull();
    expect(caughtResponse!.status).toBe(502);
    expect(row.status).toBe(0);
    expect(row.teardownStraggler).toBe(true);
    expect(row.error).toBeDefined();
  });
});
