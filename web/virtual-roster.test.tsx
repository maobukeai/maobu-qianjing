import { expect, test } from "bun:test";
import { act, useMemo, useRef, useState } from "react";
import type { HTMLButtonElement, HTMLInputElement, HTMLElement as DomElement } from "happy-dom";
import { createWebDomHarness } from "../test-fixtures/web-dom.ts";
import { profileGroupCollapsed, profileGroupSections, readGroupDisclosure, toggleProfileSelection, type GroupDisclosure } from "../profile-group-state.ts";
import type { RosterDensity } from "../roster-density-state.ts";
import type { UiProfile } from "./api.ts";
import type { ProfileRosterRowHandlers } from "./features/profile-roster-row.tsx";
import { ProfileRosterTable } from "./features/profile-roster-table.tsx";
import {
  buildFlatRosterItems,
  CHECKBOX_COLUMN_WIDTH,
  COLUMNS,
  computeRosterPipeline,
  DEFAULT_HIDDEN_COLUMNS,
  displayNo,
  type ColumnKey,
  type RosterSort,
} from "./hooks/use-roster-query.ts";
import { findOffsetIndex } from "./hooks/use-virtual-list.ts";
import { I18nProvider, translate } from "./i18n.tsx";
import { changeProfileRangeSelection, reconcileProfileSelectionAnchor, type ProfileSelectionAnchor } from "./profile-range-selection.ts";

const t = (source: string, values?: Record<string, string | number>) => translate({ "en-US": {} }, "en-US", source, values);

function createSyntheticProfiles(count: number, groupCount = 10): { profiles: UiProfile[]; groups: string[] } {
  const groups = Array.from({ length: groupCount }, (_, i) => `Group-${i}`);
  const groupSize = Math.max(1, Math.ceil(count / groupCount));
  const profiles: UiProfile[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const group = groups[Math.min(groupCount - 1, Math.floor(i / groupSize))]!;
    profiles[i] = {
      id: `p_${i}`,
      name: `Environment ${i}`,
      engine: i % 5 === 0 ? "firefox" : "chromium",
      chromiumRuntime: "aliasmode",
      group,
      platform: i % 3 === 0 ? "x.com" : "",
      tags: i % 4 === 0 ? ["warmup", "tier1"] : [],
      extensions: [],
      proxy: i % 2 === 0 ? `10.0.${(i >>> 8) & 255}.${i & 255}:8080` : null,
      timezone: "UTC",
      cookieCount: 0,
      seeded: true,
      screen: "1920x1080",
      has2fa: false,
      serial: i + 1,
      createdAt: 1,
      lastOpenAt: 0,
      customNo: "",
      running: false,
      mobilePersona: false,
    };
  }
  return { profiles, groups };
}

const noopHandlers: ProfileRosterRowHandlers = {
  openDetails() {},
  openEdit() {},
  async openPendingCookies() {},
  openCookie() {},
  async act() {},
  openInspection() {},
  async reuseProfileConfiguration() {},
  openProfileTags() {},
  async copy2fa() {},
  async toggleFavorite() {},
  changeProfileSelection() {},
  setLaunchFailure() {},
  openNetworkSettings() {},
  openLogs() {},
};

interface VirtualHarnessProps {
  profiles: UiProfile[];
  groups: string[];
  initialPageSize?: number;
  initialDensity?: RosterDensity;
  initialDisclosure?: GroupDisclosure;
  inlineRenameId?: string | null;
  inlineRenameDraft?: string;
  enableResourceChips?: boolean;
}

test("findOffsetIndex binary-searches Float64Array prefix-sum tables in O(log N)", () => {
  const count = 10_000;
  const offsets = new Float64Array(count + 1);
  for (let i = 0; i < count; i++) offsets[i + 1] = offsets[i]! + 50;
  expect(findOffsetIndex(offsets, count, -10)).toBe(0);
  expect(findOffsetIndex(offsets, count, 0)).toBe(0);
  expect(findOffsetIndex(offsets, count, 49.9)).toBe(0);
  expect(findOffsetIndex(offsets, count, 50)).toBe(1);
  expect(findOffsetIndex(offsets, count, 250_000)).toBe(5000);
  expect(findOffsetIndex(offsets, count, 499_999)).toBe(9999);
  expect(findOffsetIndex(offsets, count, 600_000)).toBe(9999);
});

test("lists with <= 60 items pass through directly with zero virtual spacers", async () => {
  const dom = await createWebDomHarness();
  try {
    const { profiles, groups } = createSyntheticProfiles(20, 2);
    const numbering = new Map(profiles.map((p, i) => [p.id, displayNo(p, i)]));
    const hiddenCols = new Set<ColumnKey>(DEFAULT_HIDDEN_COLUMNS);
    const shownColumns = COLUMNS.filter((c) => !hiddenCols.has(c.key));
    const visibleColumnCount = 1 + shownColumns.length;
    const tableMinWidth = CHECKBOX_COLUMN_WIDTH + shownColumns.reduce((sum, c) => sum + c.width, 0);
    const disclosure = new Map<string, boolean>(groups.map((g) => [g, false]));
    const sections = profileGroupSections(profiles, profiles, groups, false);
    const flatItems = buildFlatRosterItems(sections, disclosure, false, "all", null);
    const rangeKeyboardActivation = { current: null };

    await dom.render(
      <I18nProvider>
        <div className="profiles-workspace">
          <ProfileRosterTable
            loaded={true}
            profilesCount={profiles.length}
            filteredCount={profiles.length}
            flatItems={flatItems}
            selectableProfilesCount={profiles.length}
            numbering={numbering}
            rosterScope="all"
            rosterDensity="comfortable"
            missingRosterGroup={null}
            hasRosterRefinements={false}
            revealGroupMatches={false}
            sort={{ key: "no", dir: 1 }}
            hiddenCols={hiddenCols}
            shownColumns={shownColumns}
            visibleColumnCount={visibleColumnCount}
            tableMinWidth={tableMinWidth}
            tableScrolled={false}
            onTableScrolledChange={() => {}}
            selected={new Set()}
            allVisibleSelected={false}
            busy={{}}
            favoriteProfileIds={new Set()}
            reuseLoadingId={null}
            twoFaFlashId={null}
            viewPreferencesReady={true}
            viewPreferenceBusy={false}
            language="en-US"
            rangeKeyboardActivation={rangeKeyboardActivation}
            profilePageCount={1}
            visibleProfilePage={0}
            pageSize={20}
            onPageChange={() => {}}
            onPageSizeChange={() => {}}
            runningCount={0}
            diag={null}
            diagWhen={null}
            showDiag={false}
            onToggleDiag={() => {}}
            hasDetails={false}
            folderLabel={(name) => name}
            openLabel={() => "Start"}
            onToggleSort={() => {}}
            onToggleAll={() => {}}
            onToggleProfileGroup={() => {}}
            onToggleGroupSelection={() => {}}
            onCreateInGroup={() => {}}
            onManageGroup={() => {}}
            onNewSubfolder={() => {}}
            onOpenCreate={() => {}}
            onOpenBulk={() => {}}
            onSelectAllGroups={() => {}}
            onChooseRosterScope={() => {}}
            onClearRosterRefinements={() => {}}
            rowHandlers={noopHandlers}
            t={t}
          />
        </div>
      </I18nProvider>,
    );

    const tablewrap = dom.container.querySelector<DomElement>(".tablewrap")!;
    expect(tablewrap.dataset.virtualized).toBe("false");
    expect(dom.container.querySelectorAll("tr.virtual-spacer").length).toBe(0);
    expect(dom.container.querySelectorAll("tr[data-profile-id]").length).toBe(20);
  } finally {
    await dom.cleanup();
  }
});

test("10,000 synthetic profiles in virtual scroll mode keep mounted tr[data-profile-id] < 60 across scrolling, group collapse, Shift range selection, keyboard roving focus, pinnedKeys, and ResizeObserver compensation", async () => {
  const dom = await createWebDomHarness();
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  })) {
    previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }

  // Track ResizeObserver instances so we can trigger dynamic row height measurements and verify compensation.
  type ResizeCallback = (entries: Array<{ target: Element; borderBoxSize?: Array<{ blockSize: number; inlineSize: number }>; contentRect?: { height: number } }>) => void;
  const observers: Array<{ callback: ResizeCallback; targets: Set<Element> }> = [];
  const OriginalResizeObserver = (globalThis as any).ResizeObserver;
  class MockResizeObserver {
    record: { callback: ResizeCallback; targets: Set<Element> };
    constructor(callback: ResizeCallback) {
      this.record = { callback, targets: new Set() };
      observers.push(this.record);
    }
    observe(target: Element) { this.record.targets.add(target); }
    unobserve(target: Element) { this.record.targets.delete(target); }
    disconnect() { this.record.targets.clear(); }
  }
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: MockResizeObserver });

  try {
    const TOTAL = 10_000;
    const { profiles, groups } = createSyntheticProfiles(TOTAL, 10);
    const numbering = new Map(profiles.map((p, i) => [p.id, displayNo(p, i)]));
    const allExpanded = readGroupDisclosure(JSON.stringify(groups.map((name) => [name, false])));

    let latestSelected = new Set<string>();
    let setDensityExternal!: (d: RosterDensity) => void;
    let setInlineRenameExternal!: (id: string | null, draft?: string) => void;

    function Harness({
      initialPageSize = 0,
      initialDensity = "comfortable",
      initialDisclosure = allExpanded,
      enableResourceChips = true,
    }: VirtualHarnessProps) {
      const [pageSize, setPageSize] = useState(initialPageSize);
      const [profilePage, setProfilePage] = useState(0);
      const [rosterDensity, setRosterDensity] = useState<RosterDensity>(initialDensity);
      const [groupDisclosure, setGroupDisclosure] = useState<GroupDisclosure>(initialDisclosure);
      const [selected, setSelected] = useState<Set<string>>(new Set());
      const [sort, setSort] = useState<RosterSort>({ key: "no", dir: 1 });
      const [inlineRenameId, setInlineRenameId] = useState<string | null>(null);
      const [inlineRenameDraft, setInlineRenameDraft] = useState<string>("");
      setDensityExternal = setRosterDensity;
      setInlineRenameExternal = (id, draft = "") => {
        setInlineRenameId(id);
        setInlineRenameDraft(draft);
      };
      latestSelected = selected;

      const latestSelection = useRef(selected);
      latestSelection.current = selected;
      const rangeSelectionAnchor = useRef<ProfileSelectionAnchor | null>(null);
      const rangeKeyboardActivation = useRef<{ id: string; shiftKey: boolean } | null>(null);

      const hiddenCols = useMemo(() => new Set<ColumnKey>(DEFAULT_HIDDEN_COLUMNS), []);
      const shownColumns = useMemo(() => COLUMNS.filter((c) => !hiddenCols.has(c.key)), [hiddenCols]);
      const visibleColumnCount = 1 + shownColumns.length;
      const tableMinWidth = CHECKBOX_COLUMN_WIDTH + shownColumns.reduce((sum, c) => sum + c.width, 0);

      const pipeline = useMemo(
        () =>
          computeRosterPipeline({
            profiles,
            numbering,
            q: "",
            group: "all",
            selectedScope: new Set(["all", ...groups]),
            profileStatus: "all",
            sort,
            pageSize,
            profilePage,
            rosterScope: "all",
            favoriteProfileIds: new Set(),
          }),
        [sort, pageSize, profilePage],
      );

      const profileSections = useMemo(
        () => profileGroupSections(pipeline.visibleProfiles, pipeline.filtered, groups, false),
        [pipeline.visibleProfiles, pipeline.filtered],
      );

      const selectableProfiles = useMemo(
        () => profileSections.flatMap((section) => (profileGroupCollapsed(section, groupDisclosure, false) ? [] : section.profiles)),
        [profileSections, groupDisclosure],
      );

      const rangeVisibleIds = useMemo(() => selectableProfiles.map((p) => p.id), [selectableProfiles]);
      const rangeViewKey = JSON.stringify(["default", "profiles", "all", "", "all", "all", sort.key, sort.dir, pipeline.visibleProfilePage, pageSize]);
      rangeSelectionAnchor.current = reconcileProfileSelectionAnchor(rangeSelectionAnchor.current, rangeViewKey, rangeVisibleIds);

      const flatItems = useMemo(
        () => buildFlatRosterItems(profileSections, groupDisclosure, false, "all", null),
        [profileSections, groupDisclosure],
      );

      const handlers = useMemo<ProfileRosterRowHandlers>(
        () => ({
          ...noopHandlers,
          changeProfileSelection: (id, event) => {
            const keyboard = rangeKeyboardActivation.current;
            rangeKeyboardActivation.current = null;
            const result = changeProfileRangeSelection({
              selected: latestSelection.current,
              visibleIds: rangeVisibleIds,
              viewKey: rangeViewKey,
              anchor: rangeSelectionAnchor.current,
              id,
              checked: event.currentTarget.checked,
              shiftKey: !!(event.nativeEvent as MouseEvent).shiftKey || (keyboard?.id === id && keyboard.shiftKey),
            });
            rangeSelectionAnchor.current = result.anchor;
            latestSelection.current = result.selected;
            setSelected(result.selected);
          },
        }),
        [rangeVisibleIds, rangeViewKey],
      );

      const allVisibleSelected = selectableProfiles.length > 0 && selectableProfiles.every((p) => selected.has(p.id));

      return (
        <div className="app folded-workbench" data-roster-density={rosterDensity}>
          <div className="profiles-workspace">
            <ProfileRosterTable
              loaded={true}
              profilesCount={profiles.length}
              filteredCount={pipeline.filtered.length}
              flatItems={flatItems}
              selectableProfilesCount={selectableProfiles.length}
              numbering={numbering}
              rosterScope="all"
              rosterDensity={rosterDensity}
              missingRosterGroup={null}
              hasRosterRefinements={false}
              revealGroupMatches={false}
              sort={sort}
              hiddenCols={hiddenCols}
              shownColumns={shownColumns}
              visibleColumnCount={visibleColumnCount}
              tableMinWidth={tableMinWidth}
              tableScrolled={false}
              onTableScrolledChange={() => {}}
              selected={selected}
              allVisibleSelected={allVisibleSelected}
              busy={{}}
              favoriteProfileIds={new Set()}
              reuseLoadingId={null}
              twoFaFlashId={null}
              viewPreferencesReady={true}
              viewPreferenceBusy={false}
              language="en-US"
              rangeKeyboardActivation={rangeKeyboardActivation}
              profilePageCount={pipeline.profilePageCount}
              visibleProfilePage={pipeline.visibleProfilePage}
              pageSize={pageSize}
              onPageChange={setProfilePage}
              onPageSizeChange={setPageSize}
              runningCount={0}
              diag={null}
              diagWhen={null}
              showDiag={false}
              onToggleDiag={() => {}}
              hasDetails={false}
              folderLabel={(name) => name}
              openLabel={() => "Start"}
              onToggleSort={(key) => setSort((cur) => (cur.key === key ? { key, dir: cur.dir === 1 ? -1 : 1 } : { key, dir: 1 }))}
              onToggleAll={() => {
                rangeSelectionAnchor.current = null;
                setSelected((cur) => toggleProfileSelection(cur, selectableProfiles));
              }}
              onToggleProfileGroup={(name, collapsed) => {
                setGroupDisclosure((cur) => {
                  const next = new Map(cur);
                  next.delete(name);
                  next.set(name, !collapsed);
                  return next;
                });
              }}
              onToggleGroupSelection={(matches) => {
                rangeSelectionAnchor.current = null;
                setSelected((cur) => toggleProfileSelection(cur, matches));
              }}
              onCreateInGroup={() => {}}
              onManageGroup={() => {}}
              onNewSubfolder={() => {}}
              onOpenCreate={() => {}}
              onOpenBulk={() => {}}
              onSelectAllGroups={() => {}}
              onChooseRosterScope={() => {}}
              onClearRosterRefinements={() => {}}
              rowHandlers={handlers}
              t={t}
              renderResourceChips={enableResourceChips ? (p) => <span className="w3-resource-chip" data-chip-for={p.id}>128MB</span> : undefined}
              inlineRenameId={inlineRenameId}
              inlineRenameDraft={inlineRenameDraft}
              onStartInlineRename={(id) => {
                const found = profiles.find((item) => item.id === id);
                setInlineRenameId(id);
                setInlineRenameDraft(found?.name ?? "");
              }}
              onChangeInlineRename={setInlineRenameDraft}
              onCommitInlineRename={() => setInlineRenameId(null)}
              onCancelInlineRename={() => setInlineRenameId(null)}
            />
          </div>
        </div>
      );
    }

    await dom.render(
      <I18nProvider>
        <Harness profiles={profiles} groups={groups} />
      </I18nProvider>,
    );

    const tablewrap = () => dom.container.querySelector<DomElement>(".tablewrap")!;
    const table = () => dom.container.querySelector<DomElement>("table.profile-table")!;
    const mountedProfileRows = () => [...dom.container.querySelectorAll<DomElement>("tr[data-profile-id]")];
    const mountedIds = () => mountedProfileRows().map((r) => r.dataset.profileId!);
    const spacers = () => [...dom.container.querySelectorAll<DomElement>("tr.virtual-spacer")];
    const scrollTo = async (top: number) => {
      await act(async () => {
        const el = tablewrap();
        el.scrollTop = top;
        el.dispatchEvent(new dom.window.Event("scroll", { bubbles: false }));
      });
    };

    // 1. Initial mount at scrollTop = 0 with 10,000 profiles + 10 group headers = 10,010 items.
    expect(tablewrap().dataset.virtualized).toBe("true");
    expect(table().getAttribute("aria-rowcount")).toBe("10010");
    expect(dom.container.querySelector(".page-of")?.textContent).toContain("All 10,000");
    expect(mountedProfileRows().length).toBeGreaterThan(10);
    expect(mountedProfileRows().length).toBeLessThan(60);
    expect(mountedIds()).toContain("p_0");
    expect(mountedIds()).not.toContain("p_5000");
    expect(spacers().length).toBe(1); // Only bottom spacer at top of list
    // Verify Wave 3 resource chip slot renders
    expect(dom.container.querySelector('[data-chip-for="p_0"]')?.textContent).toBe("128MB");

    // 2. Scroll to middle of 10,000 profiles
    await scrollTo(250_000);
    expect(mountedProfileRows().length).toBeGreaterThan(10);
    expect(mountedProfileRows().length).toBeLessThan(60);
    expect(spacers().length).toBe(2); // Both top and bottom spacers active
    const midIds = mountedIds();
    expect(midIds).not.toContain("p_0");
    expect(midIds).not.toContain("p_9999");
    expect(midIds.some((id) => Number(id.slice(2)) > 3500 && Number(id.slice(2)) < 5500)).toBe(true);

    // 3. Scroll to bottom of 10,000 profiles
    await scrollTo(650_000);
    expect(mountedProfileRows().length).toBeGreaterThan(10);
    expect(mountedProfileRows().length).toBeLessThan(60);
    expect(mountedIds()).toContain("p_9999");
    expect(mountedIds()).not.toContain("p_0");

    // 4. Return to top and test group collapse / expand on Group-0 (1,000 profiles)
    await scrollTo(0);
    expect(mountedIds()).toContain("p_0");
    const group0Toggle = dom.container.querySelector<HTMLButtonElement>('button.profile-group-toggle[aria-label="Collapse Group-0"]')!;
    expect(group0Toggle).toBeTruthy();
    await act(async () => { group0Toggle.click(); });
    expect(table().getAttribute("aria-rowcount")).toBe("9010");
    expect(mountedProfileRows().length).toBeLessThan(60);
    expect(mountedIds()).not.toContain("p_0");
    expect(mountedIds()).toContain("p_1000"); // Group-1 immediately moves into the viewport

    const group0Expand = dom.container.querySelector<HTMLButtonElement>('button.profile-group-toggle[aria-label="Expand Group-0"]')!;
    expect(group0Expand).toBeTruthy();
    await act(async () => { group0Expand.click(); });
    expect(table().getAttribute("aria-rowcount")).toBe("10010");
    expect(mountedIds()).toContain("p_0");
    expect(mountedProfileRows().length).toBeLessThan(60);

    // 5. Shift cross-screen range selection across 10,000 profiles (anchor unmounted off-screen)
    const checkboxFor = (id: string) => {
      const row = mountedProfileRows().find((r) => r.dataset.profileId === id);
      const input = row?.querySelector<HTMLInputElement>('td.chk input[type="checkbox"]');
      expect(input).toBeTruthy();
      return input!;
    };
    await act(async () => {
      checkboxFor("p_2").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: false, detail: 1 }));
    });
    expect([...latestSelected]).toEqual(["p_2"]);

    // Scroll far away so p_2 is unmounted (~3,000 rows down)
    await scrollTo(160_000);
    expect(mountedIds()).not.toContain("p_2");
    expect(mountedProfileRows().length).toBeLessThan(60);
    const farTargetId = mountedIds()[5]!;
    const farTargetIndex = Number(farTargetId.slice(2));
    expect(farTargetIndex).toBeGreaterThan(2000);

    await act(async () => {
      checkboxFor(farTargetId).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true, detail: 1 }));
    });
    expect(latestSelected.size).toBe(farTargetIndex - 2 + 1);
    expect(latestSelected.has("p_0")).toBe(false);
    expect(latestSelected.has("p_1")).toBe(false);
    expect(latestSelected.has("p_2")).toBe(true);
    expect(latestSelected.has("p_1500")).toBe(true);
    expect(latestSelected.has(farTargetId)).toBe(true);
    expect(latestSelected.has(`p_${farTargetIndex + 1}`)).toBe(false);

    // 6. Keyboard Roving Focus navigation (ArrowDown / PageDown / End / ArrowUp / Home)
    await scrollTo(0);
    const firstCheck = checkboxFor("p_0");
    await act(async () => { firstCheck.focus(); });
    expect(dom.window.document.activeElement).toBe(firstCheck);

    const pressKey = async (key: string) => {
      const active = dom.window.document.activeElement as DomElement;
      await act(async () => {
        active.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
        await dom.flush();
      });
    };

    await pressKey("ArrowDown");
    expect(dom.window.document.activeElement).toBe(checkboxFor("p_1"));
    expect(mountedProfileRows().length).toBeLessThan(60);

    await pressKey("PageDown");
    const afterPageDownRow = (dom.window.document.activeElement as DomElement | null)?.closest("tr[data-profile-id]") as DomElement | null;
    expect(afterPageDownRow).toBeTruthy();
    expect(Number(afterPageDownRow!.dataset.profileId!.slice(2))).toBeGreaterThan(10);
    expect(mountedProfileRows().length).toBeLessThan(60);

    // Jump to the very last item (p_9999) via End key
    await pressKey("End");
    expect(mountedIds()).toContain("p_9999");
    expect(mountedProfileRows().length).toBeLessThan(60);
    expect(dom.window.document.activeElement).toBe(checkboxFor("p_9999"));

    // Step up to p_9998 via ArrowUp
    await pressKey("ArrowUp");
    expect(dom.window.document.activeElement).toBe(checkboxFor("p_9998"));

    // Jump back to top via Home key (Group-0 header is first navigable item)
    await pressKey("Home");
    expect(tablewrap().scrollTop).toBe(0);
    expect(mountedIds()).toContain("p_0");
    expect(mountedProfileRows().length).toBeLessThan(60);

    // 7. pinnedKeys keep-alive slot: Wave 4 inline rename row stays mounted even when scrolled far away
    await act(async () => {
      setInlineRenameExternal("p_0", "Pinned inline rename");
    });
    expect(dom.container.querySelector<HTMLInputElement>(".profile-inline-rename-input")?.value).toBe("Pinned inline rename");

    await scrollTo(300_000);
    expect(mountedProfileRows().length).toBeLessThan(60);
    expect(mountedIds()).toContain("p_0"); // Kept alive by pinnedKeys!
    expect(dom.container.querySelector<HTMLInputElement>(".profile-inline-rename-input")?.value).toBe("Pinned inline rename");

    await act(async () => {
      setInlineRenameExternal(null);
    });
    expect(mountedIds()).not.toContain("p_0"); // Released once inline rename ends

    // 8. Shared ResizeObserver dynamic measurement + upward scroll-jump compensation
    await scrollTo(0);
    const row0 = mountedProfileRows().find((r) => r.dataset.profileId === "p_0")!;
    expect(row0).toBeTruthy();
    await scrollTo(2000);
    const beforeScrollTop = tablewrap().scrollTop;
    expect(beforeScrollTop).toBe(2000);

    // Simulate ResizeObserver reporting row p_0 (above current scrollTop) expanded from 74px -> 114px (+40px delta)
    const rowObserver = observers.find((obs) => obs.targets.size > 1)!;
    expect(rowObserver).toBeTruthy();
    await act(async () => {
      rowObserver.callback([
        {
          target: row0 as unknown as Element,
          borderBoxSize: [{ blockSize: 114, inlineSize: 800 }],
        },
      ]);
    });
    expect(tablewrap().scrollTop).toBe(2040); // Upward scroll-jump compensated by exact +40px delta!

    // 9. Three-tier density switch (comfortable -> standard -> compact) preserves top anchor row
    const topAnchorBefore = mountedIds()[0]!;
    await act(async () => { setDensityExternal("standard"); });
    expect(dom.container.querySelector("[data-roster-density]")?.getAttribute("data-roster-density")).toBe("standard");
    expect(mountedIds()).toContain(topAnchorBefore);
    expect(mountedProfileRows().length).toBeLessThan(60);

    await act(async () => { setDensityExternal("compact"); });
    expect(dom.container.querySelector("[data-roster-density]")?.getAttribute("data-roster-density")).toBe("compact");
    expect(mountedIds()).toContain(topAnchorBefore);
    expect(mountedProfileRows().length).toBeLessThan(60);
  } finally {
    await dom.cleanup();
    if (OriginalResizeObserver !== undefined) {
      Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: OriginalResizeObserver });
    } else {
      Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
    for (const [name, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
