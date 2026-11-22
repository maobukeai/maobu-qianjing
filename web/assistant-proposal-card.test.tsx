import { afterEach, describe, expect, test } from "bun:test";
import type { HTMLInputElement } from "happy-dom";
import * as React from "react";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createWebDomHarness } from "../test-fixtures/web-dom.ts";
import { AssistantProposalCard } from "./assistant-proposal-card.tsx";
import { I18nProvider } from "./i18n.tsx";
import type { CompiledProposalView, ProposalExecutionSnapshot, ProposalStreamEvent } from "./local-assistant-api.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function makeProposal(overrides: Partial<CompiledProposalView> = {}): CompiledProposalView {
  return {
    proposalId: "prop_0123456789abcdef",
    planHash: "a".repeat(64),
    workspaceId: "ws-1",
    createdAt: 1_700_000_000_000,
    expiresAt: 1_700_000_600_000,
    title: "Move 2 profiles to Ops",
    summary: "Reassign selected profiles into the Ops group.",
    actionType: "batch_move_group",
    action: {
      type: "batch_move_group",
      profileIds: ["p1", "p2", "p3"],
      targetGroup: "Ops",
      allowCreateGroup: true,
    },
    risk: "low",
    requiresSecondaryConfirm: false,
    mutatesWorkspace: true,
    warnings: [],
    counts: { total: 3, actionable: 2, skipped: 1 },
    items: [
      {
        profileId: "p1",
        profileName: "Account One",
        group: "Inbox",
        running: false,
        executable: true,
        defaultSelected: true,
        beforeSummary: "Inbox",
        afterSummary: "Ops",
      },
      {
        profileId: "p2",
        profileName: "Account Two",
        group: "Inbox",
        running: false,
        executable: true,
        defaultSelected: true,
        beforeSummary: "Inbox",
        afterSummary: "Ops",
      },
      {
        profileId: "p3",
        profileName: "Account Three",
        group: "Ops",
        running: false,
        executable: false,
        defaultSelected: false,
        beforeSummary: "Ops",
        afterSummary: "Ops",
        skipReason: "no_change",
        skipDetail: "Profile is already in the target group.",
      },
    ],
    ...overrides,
  };
}

function ndjsonResponse(events: ProposalStreamEvent[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
  });
}

describe("AssistantProposalCard static rendering", () => {
  test("renders risk badge, warnings, per-item diff rows, and never starts network requests", () => {
    const highRisk = makeProposal({
      actionType: "batch_replace_failed_proxies",
      action: {
        type: "batch_replace_failed_proxies",
        profileIds: ["p1"],
        source: "proxy_vault_healthy",
        skipRunning: true,
      },
      risk: "high",
      requiresSecondaryConfirm: true,
      warnings: [{ code: "vault_unavailable", message: "Proxy Vault has no healthy proxies." }],
    });
    const html = renderToStaticMarkup(
      <I18nProvider>
        <AssistantProposalCard proposal={highRisk} />
      </I18nProvider>,
    );
    expect(html).toContain('data-risk="high"');
    expect(html).toContain("High risk");
    expect(html).toContain("Proxy Vault has no healthy proxies.");
    expect(html).toContain("High-risk confirmation");
    expect(html).toContain("Confirm &amp; execute (2)");
    expect(html).toContain("Discard");
  });

  test("renders fingerprint summary grid when initialExecution contains fingerprintSummary", () => {
    const fpProposal = makeProposal({
      actionType: "generate_fingerprint_summary",
      action: { type: "generate_fingerprint_summary", profileIds: ["p1"] },
      risk: "read-only",
      mutatesWorkspace: false,
    });
    const execution: ProposalExecutionSnapshot = {
      proposalId: fpProposal.proposalId,
      planHash: fpProposal.planHash,
      status: "completed",
      startedAt: 100,
      finishedAt: 200,
      selectedProfileIds: ["p1"],
      total: 1,
      completed: 1,
      succeeded: 1,
      skipped: 0,
      failed: 0,
      aborted: 0,
      items: [{ profileId: "p1", profileName: "Account One", status: "succeeded", detail: "consistent" }],
      fingerprintSummary: {
        total: 4,
        consistent: 2,
        review: 1,
        issues: 1,
        unmeasured: 0,
        topChecks: [{ id: "proxy_config", label: "Network route configuration", failCount: 1, warnCount: 0 }],
      },
    };
    const html = renderToStaticMarkup(
      <I18nProvider>
        <AssistantProposalCard proposal={fpProposal} initialExecution={execution} />
      </I18nProvider>,
    );
    expect(html).toContain("Consistent");
    expect(html).toContain("Network route configuration");
    expect(html).toContain("1 failed, 0 warnings");
  });
});

describe("AssistantProposalCard interactive flows", () => {
  test("unchecking a target sends only selectedProfileIds, streams NDJSON receipts, and invokes onLocateProfiles", async () => {
    const proposal = makeProposal();
    const calls: Array<{ url: string; method: string; body: any; headers: Headers }> = [];
    const fetchMock = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url === "/ui/api/shell-language") return Response.json({ ok: true, language: "en-US" });
        const headers = new Headers(init?.headers);
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url, method: init?.method ?? "GET", body, headers });

        const finalSnapshot: ProposalExecutionSnapshot = {
          proposalId: proposal.proposalId,
          planHash: proposal.planHash,
          status: "completed",
          startedAt: 1000,
          finishedAt: 1100,
          selectedProfileIds: ["p1"],
          total: 1,
          completed: 1,
          succeeded: 1,
          skipped: 0,
          failed: 0,
          aborted: 0,
          items: [{ profileId: "p1", profileName: "Account One", status: "succeeded", detail: "Moved to Ops" }],
        };
        return ndjsonResponse([
          {
            type: "start",
            proposalId: proposal.proposalId,
            actionType: "batch_move_group",
            risk: "low",
            total: 1,
            selectedProfileIds: ["p1"],
            startedAt: 1000,
          },
          {
            type: "item",
            proposalId: proposal.proposalId,
            index: 0,
            total: 1,
            completed: 1,
            item: finalSnapshot.items[0]!,
          },
          { type: "summary", proposalId: proposal.proposalId, snapshot: finalSnapshot },
        ]);
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    const dom = await createWebDomHarness({ fetch: fetchMock });
    cleanups.push(() => dom.cleanup());

    const located: string[][] = [];
    await dom.render(
      <I18nProvider>
        <AssistantProposalCard proposal={proposal} onLocateProfiles={(ids) => located.push(ids)} />
      </I18nProvider>,
    );

    const checkboxes = [...dom.container.querySelectorAll<HTMLInputElement>('tbody input[type="checkbox"]')];
    expect(checkboxes).toHaveLength(3);
    expect(checkboxes[0]!.checked).toBe(true);
    expect(checkboxes[1]!.checked).toBe(true);
    expect(checkboxes[2]!.disabled).toBe(true);

    // Uncheck p2
    await act(async () => {
      checkboxes[1]!.click();
    });

    const confirmBtn = [...dom.container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Confirm & execute (1)"),
    )!;
    expect(confirmBtn).toBeDefined();
    expect(confirmBtn.disabled).toBe(false);

    await act(async () => {
      confirmBtn.click();
    });
    await dom.flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`/ui/api/assistant/proposals/${proposal.proposalId}/execute`);
    expect(calls[0]!.headers.get("X-Maobu-Settings")).toBe("1");
    expect(calls[0]!.body).toEqual({ planHash: proposal.planHash, selectedProfileIds: ["p1"] });
    expect(dom.container.textContent).toContain("Completed");
    expect(dom.container.textContent).toContain("Succeeded: 1");

    const locateBtn = [...dom.container.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Locate in profile list",
    )!;
    await act(async () => {
      locateBtn.click();
    });
    expect(located).toEqual([["p1"]]);
  });

  test("high-risk secondary confirmation gates execute, emergency stop calls /abort, and retry runs only failed/aborted items", async () => {
    const proposal = makeProposal({
      actionType: "batch_replace_failed_proxies",
      action: {
        type: "batch_replace_failed_proxies",
        profileIds: ["p1", "p2"],
        source: "proxy_vault_healthy",
        skipRunning: true,
      },
      risk: "high",
      requiresSecondaryConfirm: true,
      counts: { total: 2, actionable: 2, skipped: 0 },
      items: [
        {
          profileId: "p1",
          profileName: "Account One",
          group: "Inbox",
          running: false,
          executable: true,
          defaultSelected: true,
          beforeSummary: "Proxy error",
          afterSummary: "Vault: US-1",
          targetVaultId: "pxv_0123456789abcdef",
        },
        {
          profileId: "p2",
          profileName: "Account Two",
          group: "Inbox",
          running: false,
          executable: true,
          defaultSelected: true,
          beforeSummary: "Proxy error",
          afterSummary: "Vault: US-2",
          targetVaultId: "pxv_fedcba9876543210",
        },
      ],
    });

    const encoder = new TextEncoder();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    let execCount = 0;
    const requests: Array<{ url: string; body: any }> = [];

    const abortedSnapshot: ProposalExecutionSnapshot = {
      proposalId: proposal.proposalId,
      planHash: proposal.planHash,
      status: "aborted",
      startedAt: 1000,
      finishedAt: 1200,
      selectedProfileIds: ["p1", "p2"],
      total: 2,
      completed: 2,
      succeeded: 1,
      skipped: 0,
      failed: 0,
      aborted: 1,
      items: [
        { profileId: "p1", profileName: "Account One", status: "succeeded", detail: "Assigned US-1" },
        { profileId: "p2", profileName: "Account Two", status: "aborted", reason: "aborted_by_user" },
      ],
    };

    const fetchMock = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url === "/ui/api/shell-language") return Response.json({ ok: true, language: "en-US" });
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        requests.push({ url, body });

        if (url.endsWith("/abort")) {
          streamController.enqueue(
            encoder.encode(
              JSON.stringify({ type: "aborted", proposalId: proposal.proposalId, snapshot: abortedSnapshot }) + "\n",
            ),
          );
          streamController.close();
          return Response.json({ ok: true, proposalId: proposal.proposalId, aborted: true, status: "aborted", snapshot: abortedSnapshot });
        }

        execCount++;
        if (execCount === 1) {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
              controller.enqueue(
                encoder.encode(
                  JSON.stringify({
                    type: "start",
                    proposalId: proposal.proposalId,
                    actionType: "batch_replace_failed_proxies",
                    risk: "high",
                    total: 2,
                    selectedProfileIds: ["p1", "p2"],
                    startedAt: 1000,
                  }) + "\n",
                ),
              );
              controller.enqueue(
                encoder.encode(
                  JSON.stringify({
                    type: "item",
                    proposalId: proposal.proposalId,
                    index: 0,
                    total: 2,
                    completed: 1,
                    item: abortedSnapshot.items[0]!,
                  }) + "\n",
                ),
              );
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
          });
        }

        const retrySnapshot: ProposalExecutionSnapshot = {
          proposalId: proposal.proposalId,
          planHash: proposal.planHash,
          status: "completed",
          startedAt: 2000,
          finishedAt: 2100,
          selectedProfileIds: ["p2"],
          total: 1,
          completed: 1,
          succeeded: 1,
          skipped: 0,
          failed: 0,
          aborted: 0,
          items: [{ profileId: "p2", profileName: "Account Two", status: "succeeded", detail: "Assigned US-2" }],
        };
        return ndjsonResponse([
          {
            type: "start",
            proposalId: proposal.proposalId,
            actionType: "batch_replace_failed_proxies",
            risk: "high",
            total: 1,
            selectedProfileIds: ["p2"],
            startedAt: 2000,
          },
          { type: "item", proposalId: proposal.proposalId, index: 0, total: 1, completed: 1, item: retrySnapshot.items[0]! },
          { type: "summary", proposalId: proposal.proposalId, snapshot: retrySnapshot },
        ]);
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    const dom = await createWebDomHarness({ fetch: fetchMock });
    cleanups.push(() => dom.cleanup());

    await dom.render(
      <I18nProvider>
        <AssistantProposalCard proposal={proposal} />
      </I18nProvider>,
    );

    const findBtn = (label: string) =>
      [...dom.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);

    // High-risk execute button MUST be disabled before checking secondary confirmation!
    expect(findBtn("Confirm & execute (2)")!.disabled).toBe(true);

    const secondaryCheckbox = dom.container.querySelector<HTMLInputElement>(
      '.proposal-secondary-confirm input[type="checkbox"]',
    )!;
    await act(async () => {
      secondaryCheckbox.click();
    });
    expect(findBtn("Confirm & execute (2)")!.disabled).toBe(false);

    // Click execute -> stream stays open -> red Emergency stop button appears!
    await act(async () => {
      findBtn("Confirm & execute (2)")!.click();
    });
    await dom.flush();

    const stopBtn = findBtn("Emergency stop")!;
    expect(stopBtn).toBeDefined();
    expect(stopBtn.className).toContain("solid-danger");

    await act(async () => {
      stopBtn.click();
    });
    await dom.flush();

    expect(requests[0]!.body).toMatchObject({ confirmHighRisk: true, selectedProfileIds: ["p1", "p2"] });
    expect(requests[1]!.url).toBe(`/ui/api/assistant/proposals/${proposal.proposalId}/abort`);
    expect(dom.container.textContent).toContain("Emergency stopped");

    // Retry failed/aborted items button retries ONLY p2!
    const retryBtn = findBtn("Retry failed (1)")!;
    expect(retryBtn).toBeDefined();
    await act(async () => {
      retryBtn.click();
    });
    await dom.flush();

    expect(requests[2]!.body).toEqual({
      planHash: proposal.planHash,
      selectedProfileIds: ["p2"],
      confirmHighRisk: true,
    });
    expect(dom.container.textContent).toContain("Completed");
  });

  test("Discard collapses the card without making any network requests", async () => {
    const dom = await createWebDomHarness();
    cleanups.push(() => dom.cleanup());

    await dom.render(
      <I18nProvider>
        <AssistantProposalCard proposal={makeProposal()} />
      </I18nProvider>,
    );
    const discardBtn = [...dom.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Discard")!;
    await act(async () => {
      discardBtn.click();
    });
    expect(dom.container.textContent).toContain("Action proposal discarded.");
  });
});
