// T-3346 stage 1: the schedule panel, centred like Community (notes/T-3346.md). A line's, opened
// from its panel's schedule heading: the schedule in Simple mode on the left (the line panel's own
// table, steppers and dots), its departures board and timetable chart on the right. A group's,
// opened from the group view: the group's chart, the longest line's stops down its side and the
// others drawn where they share its track. A bus or ferry line's (T-3703) is the left side without the board.
// docs/ui-panels.md "Schedule panel".

import { signal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { clock, lineSeconds } from "../../game/clock";
import { CUTS_DEFAULT, periodAt, rowHoursText, rowSpans, rowsOf } from "../../game/periods";
import { groupName, lineGroups } from "../../game/lineGroups";
import type { LineInput, LineStats } from "../../game/types";
import { ask, display, setDisplay } from "../../game/ui";
import { linesAt, linesById, listedLines, noteHeadwayLimits, rowCount, rowHeadwayShown, rowTrainsShown, setPeriods, stationNames, stationsById, world } from "../../game/world";
import { t, tList, tNumber } from "../../i18n";
import { queryClock } from "../../workers/clockClient";
import { GroupPill } from "../GroupPill";
import { useModalDialog } from "../Modal";
import { useClockQuery, useLatestAnswer } from "../useClockQuery";
import { Check, Chip, Icon, Segmented, Stepper } from "../widgets";
import { limitsFrom } from "./LineInspector";
import { useChartLinks } from "./MareyChart";
import { TrainTable, useRelated } from "./TrainTable";
import { NO_LIMITS, Schedule, rowLabel, useLinePeriods, vehicleOf, vehiclesText } from "./schedule";
import { drawnReversed } from "../../game/northUp";
import { hasUpgrade, UPGRADE } from "../../game/upgrades";

/** What the panel shows: a line's schedule, its detailed settings, or a group's chart; null closed. */
export type ScheduleShown = { kind: "line"; line: string } | { kind: "settings"; line: string } | { kind: "group"; group: number };
export const scheduleShown = signal<ScheduleShown | null>(null);

/** The chart's stops span under the timetable, px. */
const PLOT_H = 240;
/** The board's day starts at this local hour, as Japanese station timetables do. */
const DAY_START_H = 4;

const DAY = 86400, HOUR = 3600;

/** A line the panel opens for: running, with two stops (T-3703: a bus or ferry line too). */
const scheduled = (st: LineStats | undefined, l: LineInput | undefined): st is LineStats => !!st && !!l && st.status === "running" && l.stops.length >= 2;
/** A line the board and chart can show: a scheduled rail line (the sim keeps no bus or ferry timetable). */
const charted = (st: LineStats | undefined, l: LineInput | undefined): st is LineStats => scheduled(st, l) && !st.bus;

// ---------------------------------------------------------------- departures

/** One train leaving the board's station: its run, its stop index in that run, game seconds. */
export interface Departure { run: number; k: number; t: number }

/** T-3346: the one read of a station's departures (`TrackApi.station_departures`: each trip's
 * leaving time there from its own timetable, in the sim). Line `l` and, run on both pairs of quad
 * track (T-3333), its hidden twin at the stop in the same place in its list, merged in time order. */
export async function stationDepartures(l: LineInput, st: LineStats, station: string, t0: number, t1: number): Promise<Departure[] | null> {
  const w = world.value;
  if (!w) return null;
  const byId = stationsById(w);
  const asks: { line: number; node: number }[] = [];
  const node = byId.get(station)?.num;
  if (node !== undefined) asks.push({ line: l.num, node });
  const twin = st.twin ? linesById(w).get(st.twin) : undefined;
  if (twin) {
    const nodes = new Set(l.stops.flatMap((s, i) => (s === station && twin.stops[i] ? [byId.get(twin.stops[i])?.num] : [])));
    for (const n of nodes) if (n !== undefined) asks.push({ line: twin.num, node: n });
  }
  const answers = await Promise.all(asks.map((a) => queryClock({ what: "stationDeps", line: a.line, node: a.node, t0, t1 })));
  if (answers.some((d) => !d)) return null;
  const out: Departure[] = [];
  for (const d of answers) for (let i = 0; i + 2 < d!.length; i += 3) out.push({ run: d![i], k: d![i + 1], t: d![i + 2] });
  return out.sort((a, b) => a.t - b.t || a.run - b.run);
}

/** The board's hours from the day's start, local: [hour, minutes per run]. */
function boardRows(deps: Departure[], shift: number): { hour: number; mins: string[][] }[] {
  const rows = Array.from({ length: 24 }, (_, i) => ({ hour: (DAY_START_H + i) % 24, mins: [[], []] as string[][] }));
  for (const d of deps) {
    const local = (((d.t + shift) % DAY) + DAY) % DAY;
    const h = Math.floor(local / HOUR);
    rows[(h - DAY_START_H + 24) % 24].mins[d.run === 1 ? 1 : 0].push(String(Math.floor((local % HOUR) / 60)).padStart(2, "0"));
  }
  const used = rows.map((r) => r.mins[0].length + r.mins[1].length > 0);
  const a = used.indexOf(true), b = used.lastIndexOf(true);
  return a < 0 ? [] : rows.slice(a, b + 1);
}

/** The station's departures over the next 24 hours from the start of this hour, laid out as a day:
 * the line's current timetable for every hour. */
function Board({ l, st, selectedStation }: { l: LineInput; st: LineStats; selectedStation?: string }) {
  const w = world.value!;
  const names = stationNames(w);
  // the stations in the line's order, each once; a loop's first stop again at its end left out
  const stops = [...new Set(l.stops)];
  const [station, setStation] = useState(stops[0]);
  const chosen = selectedStation ?? station;
  const at = stops.includes(chosen) ? chosen : stops[0];
  const shift = st.shift ?? 0;
  const now = clock.minute.value * 60;
  const t0 = Math.floor((now + shift) / HOUR) * HOUR - shift;
  const deps = useLatestAnswer(() => stationDepartures(l, st, at, t0, t0 + DAY).then((d) => (d ? { at, d } : null)), [l.num, at, w.version, t0]);
  const shown = deps && deps.at === at ? deps.d : null;
  const n = l.stops.length;
  // a run's heading: where its trains go, or on a loop the next stop
  const label = (run: number, k: number) => {
    if (st.loop) {
      const next = run === 0 ? l.stops[k + 1] : l.stops[n - 2 - k];
      return t("schedulePanel.via", { station: names.get(next ?? "") ?? "" });
    }
    return t("schedulePanel.to", { station: names.get(run === 0 ? l.stops[n - 1] : l.stops[0]) ?? "" });
  };
  const runs = [0, 1].filter((r) => shown?.some((d) => d.run === r));
  const heads = runs.map((r) => label(r, shown!.find((d) => d.run === r)!.k));
  const rows = shown ? boardRows(shown, shift) : [];
  const hourNow = Math.floor((((now + shift) % DAY) + DAY) % DAY / HOUR);
  const body = useRef<HTMLDivElement>(null);
  // opened, or another station: the hour now at the top
  useLayoutEffect(() => {
    const el = body.current, row = el?.querySelector<HTMLElement>(".sp-row.now");
    if (el && row) el.scrollTop = row.offsetTop - el.offsetTop - (el.querySelector<HTMLElement>(".sp-heads")?.offsetHeight ?? 0);
  }, [at, !!shown]);
  return (
    <>
      <div class="sp-tools">
        <span class="h sp-board-h">{t("schedulePanel.departures")}{selectedStation !== undefined ? ` — ${names.get(at) ?? ""}` : ""}</span>
        {selectedStation === undefined && (
          <select aria-label={t("schedulePanel.station")} value={at} onChange={(e) => setStation(e.currentTarget.value)}>
            {stops.map((s) => <option value={s}>{names.get(s) ?? ""}</option>)}
          </select>
        )}
      </div>
      <div class="sp-board" ref={body} style={{ "--runs": Math.max(1, runs.length) }}>
        {shown && !rows.length && <p class="muted">{t("schedulePanel.noDepartures")}</p>}
        {rows.length > 0 && (
          <div class="sp-grid">
            <div class="sp-row sp-heads">
              <span class="sp-hour" />
              {heads.map((h) => <span class="sp-dir">{h}</span>)}
            </div>
            {rows.map((r) => (
              <div class={"sp-row" + (r.hour === hourNow ? " now" : "")}>
                <span class="sp-hour">{r.hour}</span>
                {runs.map((run) => <span class="sp-mins">{r.mins[run].map((m) => <span>{m}</span>)}</span>)}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- the panel

/** The toggle for other lines' trains on the chart, where any meet it. */
function OthersToggle({ any }: { any: boolean }) {
  if (!any) return null;
  const on = display.value.chartOtherLines;
  const tip = t(on ? "mareyChart.hideOthers" : "mareyChart.showOthers");
  return <button type="button" class={"btn icon mini sp-others" + (on ? " on" : "")} aria-pressed={on} data-tip={tip} aria-label={tip}
    onClick={() => setDisplay("chartOtherLines", !on)}><Icon.related /></button>;
}

// ---------------------------------------------------------------- periods (T-3542)

const PERIOD_CHOICES: [number, string][] = [[3, "3"], [4, "4"], [5, "5"]];

/** The rows of a line of `from` rows that a switch to `to` joins into one (none when `to` is not fewer):
 * five to three joins morning, midday and afternoon, five to four morning and afternoon, four to three
 * rush and midday. */
function joinedRows(from: number, to: number): number[] {
  if (to >= from) return [];
  const into = rowsOf(to), was = rowsOf(from);
  for (const r of into) {
    const olds = was.flatMap((o, i) => (o.periods.some((p) => r.periods.includes(p)) ? [i] : []));
    if (olds.length > 1) return olds;
  }
  return [];
}
/** "Morning, midday and afternoon" for a line of `n` rows' rows `rs`. */
function rowList(n: number, rs: number[]): string {
  const s = tList(rs.map((r) => t("schedulePanel.rowWord", { row: rowsOf(n)[r].code })));
  return s.charAt(0).toLocaleUpperCase() + s.slice(1);
}

/** Switch to `to` rows, after a question where rows are joined (Anita, 2026-11-17). `line`: this line's
 * own choice (0: the game's), else the game's. `from`: the rows the switch moves from, for the question. */
function switchPeriods(l: LineInput, to: number, line: boolean, from: number, after: number) {
  const send = () => setPeriods(to, line ? l.id : undefined);
  const join = joinedRows(from, after);
  if (!join.length) return send();
  const rows = rowList(from, join), count = join.length;
  let text: string;
  if (!line) text = t("schedulePanel.joinAskGame", { rows, count });
  else {
    const auto = rowHeadwayShown(l.id), trains = rowTrainsShown(l.id) ?? [];
    const h = auto ? Math.min(...join.map((r) => auto[r]).filter((x) => x > 0)) : 0;
    text = auto && Number.isFinite(h) && h > 0 ? t("schedulePanel.joinAskHeadway", { rows, count, headway: t("inspector.min", { n: tNumber(h / 60, { maximumFractionDigits: 2 }) }) })
      : t("schedulePanel.joinAskTrains", { rows, count, trains: vehiclesText(vehicleOf(world.value!.lineStats[l.id]), Math.max(0, ...join.map((r) => trains[r] ?? 0))) });
  }
  ask.value = { text, yes: t("schedulePanel.usePeriods", { n: after }), no: t("schedulePanel.keepPeriods", { n: from }), run: send };
}

/** The window's periods: the game's 3 / 4 / 5 (every line on the game's), "Set for this line" at its end; once the
 * line has its own, a "This line" 3 / 4 / 5 under it with "Same as game" at its end (Anita, 2026-11-19). */
function Periods({ l, st }: { l: LineInput; st: LineStats }) {
  const w = world.value!, game = w.periods, own = st.periodsOwn, n = rowCount(st);
  return (
    <div class="sp-periods">
      <span class="sp-periods-label">{t("schedulePanel.periods")}</span>
      <Segmented<number> options={PERIOD_CHOICES} value={game} onChange={(to) => switchPeriods(l, to, false, game, to)} />
      {own > 0 ? <span /> : (
        <button type="button" class="btn text mini sp-periods-own" data-tip={t("schedulePanel.setForLineTip")}
          onClick={() => setPeriods(n, l.id)}>{t("schedulePanel.setForLine")}</button>
      )}
      {own > 0 && (
        <>
          <span class="sp-periods-label">{t("schedulePanel.thisLine")}</span>
          <Segmented<number> options={PERIOD_CHOICES} value={own} onChange={(to) => switchPeriods(l, to, true, n, to)} />
          <button type="button" class="btn text mini sp-periods-own" onClick={() => switchPeriods(l, 0, true, n, game)}>{t("schedulePanel.useGame")}</button>
        </>
      )}
    </div>
  );
}

/** The line-wide train count, headway and demand-period settings. */
function LineScheduleEditor({ l, st, day, onDayChange }: { l: LineInput; st: LineStats; day: 0 | 1; onDayChange: (day: 0 | 1) => void }) {
  const w = world.value!;
  const rv = vehicleOf(st);
  const limits = useClockQuery({ what: "lineHeld", line: l.num, rows: true }, [l.num, w.version, rv], (d) => limitsFrom(d, rv)) ?? NO_LIMITS;
  if (limits !== NO_LIMITS) noteHeadwayLimits(l.id, limits.map((x) => x?.s ?? 0));
  const { periods } = useLinePeriods(l.id, l);

  return (
    <div class="sp-line-headway">
      <div class="sp-line-headway-days">
        <span class="h">{t("schedule.headway")}</span>
        <Segmented<0 | 1> options={[[0, t("schedule.weekdays")], [1, t("schedule.weekends")]]} value={day} onChange={onDayChange} />
      </div>
      <Schedule l={l} st={st} period={periodAt(lineSeconds(st))} limits={limits} crowd={periods}
        label={t("schedulePanel.setBy")} weekends hours dayView={day} above={<Periods l={l} st={st} />} />
    </div>
  );
}

function LineBody({ l, st }: { l: LineInput; st: LineStats }) {
  const { links, related } = useRelated(l, st, useChartLinks(l, st));
  const any = related.length > 0 || (!!links && (links.shared.size > 0 || links.passes.length > 0));

  return (
    <div class="sp-body sp-view-only">
      <div class="sp-right">
        <TrainTable axis={l} st={st} related={related} links={links} plotH={PLOT_H} tools={<OthersToggle any={any} />} />
      </div>
    </div>
  );
}

type PatternDay = "weekday" | "weekend";
type PatternTimes = Record<PatternDay, Record<string, string>>;

const emptyPatternTimes = (): PatternTimes => ({ weekday: {}, weekend: {} });

type ReferenceTimeRange = readonly [number, number];

/** Allowed minutes of the local day, [start, end), for one demand-period row. */
function referenceTimeRanges(st: LineStats, row: ReturnType<typeof rowsOf>[number]): ReferenceTimeRange[] {
  const ranges: ReferenceTimeRange[] = [];
  for (const [from, to] of rowSpans(st.hours ?? CUTS_DEFAULT, row)) {
    for (const day of [0, 1]) {
      const start = Math.max(from * 60, day * 1440);
      const end = Math.min(to * 60, (day + 1) * 1440);
      if (start < end) ranges.push([start - day * 1440, end - day * 1440]);
    }
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

function referenceTimeAllowed(ranges: readonly ReferenceTimeRange[], value: string): boolean {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!m) return false;
  const minute = Number(m[1]) * 60 + Number(m[2]);
  return ranges.some(([start, end]) => minute >= start && minute < end);
}

const referenceMinuteText = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

/** A reference time must belong to its demand period, including split or overnight periods. */
function ReferenceTimeInput({ st, row, value, disabled, label, onTime }: {
  st: LineStats; row: ReturnType<typeof rowsOf>[number]; value: string; disabled: boolean; label: string; onTime: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const ranges = referenceTimeRanges(st, row);
  const single = ranges.length === 1 ? ranges[0] : null;
  const invalid = draft !== "" && !referenceTimeAllowed(ranges, draft);
  const allowed = rowHoursText(st.hours ?? CUTS_DEFAULT, row);

  return (
    <div class="sp-reference-time-field">
      <input type="time" step={60} value={draft} disabled={disabled} aria-label={label} aria-invalid={invalid}
        min={single ? referenceMinuteText(single[0]) : undefined}
        max={single ? referenceMinuteText(single[1] - 1) : undefined}
        title={allowed}
        onInput={(e) => {
          const next = e.currentTarget.value;
          setDraft(next);
          if (!next || referenceTimeAllowed(ranges, next)) onTime(next);
        }}
        onBlur={() => { if (invalid) setDraft(value); }} />
      {invalid && <span class="sp-reference-invalid">{t("schedulePanel.referenceTimeOutOfRange")}</span>}
    </div>
  );
}

/** The selected station's pattern departure times, using the line's existing demand periods. */
function ReferenceTimes({ st, day, active, referenceName, onReference, times, onTime }: {
  st: LineStats; day: PatternDay; active: boolean; referenceName: string; onReference: () => void;
  times: PatternTimes; onTime: (day: PatternDay, row: string, value: string) => void;
}) {
  const n = rowCount(st), rows = rowsOf(n);
  return (
    <div class="sp-reference">
      <div class="sp-reference-station">
        <span class="muted">{t("schedulePanel.referenceStation")}: {referenceName || "—"}</span>
        <button type="button" class="btn text mini" onClick={onReference}>
          {t(active ? "schedulePanel.clearReference" : "schedulePanel.setReference")}
        </button>
      </div>
      <table class="sched sp-reference-table">
        <thead>
          <tr>
            <th>{t("schedule.period")}</th>
            <th>{t("schedulePanel.referenceTime")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.code}>
              <td>
                <span class="sp-reference-period">
                  <span>{rowLabel(n, i)}</span>
                  <small>{rowHoursText(st.hours ?? CUTS_DEFAULT, row)}</small>
                </span>
              </td>
              <td>
                <ReferenceTimeInput key={`${day}:${row.code}`} st={st} row={row}
                  value={times[day][row.code] ?? ""} disabled={!active}
                  label={`${t(day === "weekday" ? "schedule.weekdays" : "schedule.weekends")} ${rowLabel(n, i)} ${t("schedulePanel.referenceTime")}`}
                  onTime={(value) => onTime(day, row.code, value)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type ReferenceMethod = "time" | "departure" | "arrival" | "pass";

/** The detailed schedule settings window, with a full-height timetable and no chart. */
function SettingsBody({ l, st }: { l: LineInput; st: LineStats }) {
  const w = world.value!;
  const byId = stationsById(w), names = stationNames(w);
  const n = l.stops.length;
  const down = drawnReversed(byId.get(l.stops[0]), byId.get(l.stops[n - 1]), !!st.loop) ? 1 : 0;
  const [direction, setDirection] = useState(down);
  const [settingKind, setSettingKind] = useState<"departure" | "dwell">("departure");
  const [showStationSettings, setShowStationSettings] = useState(true);
  const [showDepartures, setShowDepartures] = useState(false);
  const [departureTimes, setDepartureTimes] = useState<Record<string, PatternTimes>>({});
  const [day, setDay] = useState<0 | 1>(0);
  const [passingStations, setPassingStations] = useState<Set<string>>(() => new Set());
  const [referenceMethods, setReferenceMethods] = useState<Record<string, ReferenceMethod>>({});
  const [referenceLineIds, setReferenceLineIds] = useState<Record<string, string>>({});
  const [referenceOffsets, setReferenceOffsets] = useState<Record<string, number>>({});
  const [specifiedReferenceLines, setSpecifiedReferenceLines] = useState<Set<string>>(() => new Set());
  const [dwellTimes, setDwellTimes] = useState<Record<string, number>>({});

  const [selectedStop, setSelectedStop] = useState<number | null>(null);
  const { links, related } = useRelated(l, st, useChartLinks(l, st));
  const any = related.length > 0 || (!!links && (links.shared.size > 0 || links.passes.length > 0));

  
  const passingStation = selectedStop === null ? undefined : stationsById(w).get(l.stops[selectedStop]);
  const passingPossible = !!passingStation && passingStation.built && !passingStation.port && !passingStation.one
    && hasUpgrade(passingStation.upgrades, UPGRADE.passing)
    && w.edges.some((e) => (e.a === passingStation.num || e.b === passingStation.num) && e.tracks === 2);
  const passingKey = passingStation ? `${l.id}:${direction}:${passingStation.id}:${day}` : null;
  const passingAssigned = (periods: readonly number[]) => passingKey !== null && periods.every((period) => passingStations.has(`${passingKey}:${period}`));
  const passingPartial = (periods: readonly number[]) => passingKey !== null && periods.some((period) => passingStations.has(`${passingKey}:${period}`)) && !passingAssigned(periods);

  // Until connections across station complexes are supported, only passing-capable station nodes allow them.
  const connectionPossible = passingPossible;

  const setPassingStation = (periods: readonly number[], checked: boolean) => {
    if (!passingPossible || passingKey === null) return;
    setPassingStations((old) => {
      const next = new Set(old);
      for (const period of periods) {
        const key = `${passingKey}:${period}`;
        if (checked) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  };

  const referenceKey = selectedStop === null ? null : `${direction}:${selectedStop}`;
  const referenceMethod = referenceKey === null || !connectionPossible ? "time" : referenceMethods[referenceKey] ?? "time";
  const referenceStation = selectedStop === null ? null : l.stops[selectedStop];
  const referenceLines = referenceMethod === "pass"
    ? passingStation ? listedLines(w).filter((other) => {
      if (other.id === l.id) return false;
      const otherStats = w.lineStats[other.id];
      return !!otherStats && [otherStats, otherStats.twin ? w.lineStats[otherStats.twin] : undefined]
        .some((stats) => stats?.passed.some((p) => p.node === passingStation.num));
    }) : []
    : referenceStation ? linesAt(referenceStation).filter((other) => other.id !== l.id) : [];
  const referenceLineKey = referenceKey === null ? null : `${referenceKey}:${referenceMethod}`;
  const specifyReferenceLine = referenceLineKey !== null && specifiedReferenceLines.has(referenceLineKey);
  const referenceLineId = referenceLineKey === null || !specifyReferenceLine ? null : referenceLineIds[referenceLineKey] ?? null;
  const selectedReferenceLine = referenceLines.find((other) => other.id === referenceLineId);
  const shownReferenceLines = selectedReferenceLine ? [selectedReferenceLine] : referenceLines;
  const referenceOffsetKey = referenceLineKey === null ? null : `${referenceLineKey}:${day}`;
  const referenceOffset = (periods: readonly number[]) => {
    if (referenceOffsetKey === null) return 0;
    const values = periods.map((period) => referenceOffsets[`${referenceOffsetKey}:${period}`] ?? 0);
    return values.every((value) => value === values[0]) ? values[0] : null;
  };

  const setReferenceMethod = (method: ReferenceMethod) => {
    if (referenceKey === null || (method !== "time" && !connectionPossible)) return;
    setReferenceMethods((old) => ({ ...old, [referenceKey]: method }));
  };

  const setReferenceLine = (id: string | null) => {
    if (referenceLineKey === null) return;
    setReferenceLineIds((old) => {
      const next = { ...old };
      if (id === null || old[referenceLineKey] === id) delete next[referenceLineKey];
      else next[referenceLineKey] = id;
      return next;
    });
  };

  const setSpecifyReferenceLine = (checked: boolean) => {
    if (referenceLineKey === null) return;
    setSpecifiedReferenceLines((old) => {
      const next = new Set(old);
      if (checked) next.add(referenceLineKey);
      else next.delete(referenceLineKey);
      return next;
    });
  };

  const stopDepartureTimes = referenceKey === null ? emptyPatternTimes() : departureTimes[referenceKey] ?? emptyPatternTimes();

  const setDepartureTime = (day: PatternDay, row: string, value: string) => {
    if (referenceKey === null) return;
    setDepartureTimes((old) => {
      const current = old[referenceKey] ?? emptyPatternTimes();
      return {
        ...old,
        [referenceKey]: { ...current, [day]: { ...current[day], [row]: value } },
      };
    });
  };

  const setReferenceOffset = (periods: readonly number[], value: number) => {
    if (referenceOffsetKey === null || !Number.isFinite(value)) return false;
    setReferenceOffsets((old) => {
      const next = { ...old };
      for (const period of periods) next[`${referenceOffsetKey}:${period}`] = Math.max(0, Math.round(value));
      return next;
    });
  };

  const dwellKey = selectedStop === null ? null : `${direction}:${selectedStop}:${day}`;
  const defaultDwell = Math.max(0, Math.round(st.dwellS / 60));

  const dwellTime = (periods: readonly number[]) => {
    if (dwellKey === null) return null;
    const values = periods.map((period) => dwellTimes[`${dwellKey}:${period}`] ?? defaultDwell);
    return values.every((value) => value === values[0]) ? values[0] : null;
  };

  const setDwellTime = (periods: readonly number[], value: number) => {
    if (dwellKey === null || !Number.isFinite(value)) return false;
    setDwellTimes((old) => {
      const next = { ...old };
      for (const period of periods) next[`${dwellKey}:${period}`] = Math.max(0, Math.round(value));
      return next;
    });
  };

  return (
    <div class="sp-body">
    <div class="sp-left sp-settings-detail">
      <LineScheduleEditor l={l} st={st} day={day} onDayChange={setDay} />
      {selectedStop !== null && (
        <div class="sp-settings-toggles">
          <Check checked={showStationSettings} onChange={setShowStationSettings}>詳細設定</Check>
          <Check checked={showDepartures} onChange={setShowDepartures}>発車案内</Check>
        </div>
      )}
      {selectedStop !== null && showStationSettings && (
        <div class="sp-station-settings">
          <div class="h sp-selected-station-heading">
              <span class="sp-selected-station-title">
                <span class="st-glyph" aria-hidden="true" />
                <span class="sp-selected-station-name">{names.get(l.stops[selectedStop]) ?? ""}</span>
              </span>
              <Segmented<"departure" | "dwell">
                options={[["departure", "発車条件"], ["dwell", "停車時間"]]}
                value={settingKind}
                onChange={setSettingKind}
              />
            </div>
            {settingKind === "departure" && (
              <>
                <div class="h set-by">
                    発車方法
                  <span class="right">
                    <Segmented<ReferenceMethod>
                      options={[
                        ["time", "発車基準時刻"],
                        ["departure", "出発待"],
                        ["arrival", "到着待"],
                        ["pass", "通過待"],
                      ]}
                      value={referenceMethod}
                      onChange={setReferenceMethod}
                      disabled={(method) => method !== "time" && !connectionPossible}
                    />
                  </span>
                </div>

                {referenceMethod === "time" ? (
                  <div class="sp-reference">
                    <table class="sched sp-reference-table">
                      <thead>
                        <tr>
                          <th>{t("schedule.period")}</th>
                          <th>基準時刻</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rowsOf(rowCount(st)).map((row, i) => (
                          <tr key={row.code}>
                            <td>
                              <span class="sp-reference-period">
                                <span>{rowLabel(rowCount(st), i)}</span>
                                <small>{rowHoursText(st.hours ?? CUTS_DEFAULT, row)}</small>
                              </span>
                            </td>
                            <td>
                              <ReferenceTimeInput key={`${direction}:${selectedStop}:${day}:${row.code}`}
                                st={st} row={row}
                                value={stopDepartureTimes[day === 0 ? "weekday" : "weekend"][row.code] ?? ""}
                                disabled={false}
                                label={`${names.get(l.stops[selectedStop!]) ?? ""} ${rowLabel(rowCount(st), i)} 基準時刻`}
                                onTime={(value) => setDepartureTime(day === 0 ? "weekday" : "weekend", row.code, value)} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (                  
                  <div class="sp-reference-lines">
                    <Check checked={specifyReferenceLine} onChange={setSpecifyReferenceLine}>
                      {referenceMethod === "arrival" ? "路線を指定して到着待ち"
                        : referenceMethod === "pass" ? "路線を指定して通過待ち"
                        : "路線を指定して発車待ち"}
                    </Check>

                    {specifyReferenceLine && (
                      referenceLines.length ? (
                        <ul class="rows pick">
                          {shownReferenceLines.map((other) => (
                            <li key={other.id} class={referenceLineId === other.id ? "on" : ""}
                              role="button" tabIndex={0} aria-pressed={referenceLineId === other.id}
                              onClick={() => setReferenceLine(other.id)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  setReferenceLine(other.id);
                                }
                              }}>
                              <Chip line={other} />
                              <span class="grow">{other.name}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p class="muted">
                          {referenceMethod === "pass"
                            ? "この駅を通過する他の路線はありません。"
                            : "この駅に停車する他の路線はありません。"}
                        </p>
                      )
                    )}

                    {!specifyReferenceLine && (
                      <p class="muted">参照路線：自動選択</p>
                    )}

                    <div class="sp-reference-offsets">
                      <span class="muted">
                        {referenceMethod === "arrival" ? "他路線の到着から"
                          : referenceMethod === "pass" ? "他路線の通過から"
                          : "他路線の発車から"}
                      </span>
                      <table class="sched sp-reference-table">
                        <thead>
                          <tr>
                            <th>{t("schedule.period")}</th>
                            <th>待ち時間</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rowsOf(rowCount(st)).map((row, i) => {
                            const offset = referenceOffset(row.periods);
                            return (
                              <tr key={row.code}>
                                <td>
                                  <span class="sp-reference-period">
                                    {referenceMethod === "pass" ? (
                                      <label class="check">
                                        <input type="checkbox" checked={passingAssigned(row.periods)}
                                          class={passingPartial(row.periods) ? "some" : undefined}
                                          aria-checked={passingPartial(row.periods) ? "mixed" : passingAssigned(row.periods)}
                                          onChange={(e) => setPassingStation(row.periods, e.currentTarget.checked)} />
                                        <span>{rowLabel(rowCount(st), i)}</span>
                                      </label>
                                    ) : (
                                      <span>{rowLabel(rowCount(st), i)}</span>
                                    )}
                                    <small>{rowHoursText(st.hours ?? CUTS_DEFAULT, row)}</small>
                                  </span>
                                </td>
                                <td>
                                  <Stepper wide jump jumpUnit={t("schedule.minUnit")}
                                    label={`${rowLabel(rowCount(st), i)}の待ち時間`}
                                    value={offset === null ? "—" : t("inspector.min", { n: offset })}
                                    onStep={(s) => setReferenceOffset(row.periods, (offset ?? 0) + s)}
                                    type={{ text: String(offset ?? 0), set: (value) => setReferenceOffset(row.periods, value) }} />
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      <span class="muted">後に発車</span>
                    </div>
                  </div>
                )}
              </>
            )}
            {settingKind === "dwell" && (
              <div class="sp-reference sp-dwell-times">
                <table class="sched sp-reference-table">
                  <thead>
                    <tr>
                      <th>{t("schedule.period")}</th>
                      <th>停車時間</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rowsOf(rowCount(st)).map((row, i) => {
                      const dwell = dwellTime(row.periods);
                      return (
                        <tr key={row.code}>
                          <td>
                            <span class="sp-reference-period">
                              <span>{rowLabel(rowCount(st), i)}</span>
                              <small>{rowHoursText(st.hours ?? CUTS_DEFAULT, row)}</small>
                            </span>
                          </td>
                          <td>
                            <Stepper wide jump jumpUnit={t("schedule.minUnit")}
                              label={`${rowLabel(rowCount(st), i)}の停車時間`}
                              value={dwell === null ? "—" : t("inspector.min", { n: dwell })}
                              onStep={(s) => setDwellTime(row.periods, (dwell ?? defaultDwell) + s)}
                              type={{ text: String(dwell ?? defaultDwell), set: (value) => setDwellTime(row.periods, value) }} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
        </div>
      )}
      {selectedStop !== null && showDepartures && (
        <div class="sp-settings-board">
          <Board key={l.num} l={l} st={st} selectedStation={l.stops[selectedStop]} />
        </div>
      )}
    </div>
    <div class="sp-right">
        <TrainTable axis={l} st={st} related={related} links={links} plotH={PLOT_H} tools={<OthersToggle any={any} />} timetableOnly
          selectedStop={selectedStop} onSelectStop={(i) => setSelectedStop((s) => s === i ? null : i)} onDirectionChange={setDirection} />
      </div>
    </div>
  );
}

/** T-3703: a bus or ferry line's: the left side alone, with no track limits (no track) and no board (no timetable).
 * T-3767: its periods and hours as a rail line's. */
function BusBody({ l, st }: { l: LineInput; st: LineStats }) {
  const { periods } = useLinePeriods(l.id, l);
  return (
    <div class="sp-body">
      <div class="sp-left">
        <Schedule l={l} st={st} period={periodAt(lineSeconds(st))} crowd={periods} label={t("schedulePanel.setBy")} weekends hours above={<Periods l={l} st={st} />} />
      </div>
    </div>
  );
}

function GroupBody({ axis, st, others }: { axis: LineInput; st: LineStats; others: LineInput[] }) {
  // kept while the group's lines are the same: the chart redraws its trains when it changes
  const key = others.map((o) => o.num).join(",");
  const group = useMemo<ReadonlySet<number>>(() => new Set(others.map((o) => o.num)), [key]);
  const { links, related } = useRelated(axis, st, useChartLinks(axis, st), group);
  const any = !!links && [...links.shared.keys(), ...links.passes.map((p) => p.o)].some((o) => !group.has(o));
  return (
    <div class="sp-group">
      <TrainTable axis={axis} st={st} others={others} related={related} links={links} group={group} plotH={PLOT_H} tools={<OthersToggle any={any} />} />
    </div>
  );
}

/** The panel's frame: a modal like the saved games panel's, its title the line's or group's bullet,
 * name and "schedule". */
/** The modes the heading offers; the choice is drawn only once there is more than Simple (Detailed and Exact, T-3346 stages 3 and 6). */
const scheduleModes = (): [string, string][] => [["simple", t("schedulePanel.simple")]];

function Frame({ label, title, mode, narrow = false, settings = false, children }: { label: string; title: ComponentChildren; mode?: ComponentChildren; narrow?: boolean; settings?: boolean; children: ComponentChildren }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useModalDialog(dialog, true);
  const close = () => (scheduleShown.value = null);
  // a click outside closes it, but not a drag of the timetable let go outside (its click lands on the dialog too)
  const pressedOutside = useRef(false);
  return (
    <dialog class={"saves-panel sched-panel" + (narrow ? " narrow" : "") + (settings ? " settings" : "")} ref={dialog} aria-label={label}
      onCancel={(e) => { e.preventDefault(); close(); }}
      onPointerDown={(e) => { pressedOutside.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && pressedOutside.current) close(); }}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); close(); } }}>
      <div class="saves-inner">
        <div class="saves-head sp-title">
          <h2>{title}<span class="sp-word">{t(settings ? "schedulePanel.settings" : "schedulePanel.schedule")}</span></h2>
          {mode}
          <button class="btn icon sp-close" autofocus aria-label={t("modal.close")} data-tip={t("modal.closeTip")} onClick={close}><Icon.cross /></button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

/** The schedule panel while `scheduleShown`; it closes when its line or group goes. */
export function SchedulePanel() {
  const s = scheduleShown.value;
  const w = world.value;
  let body: ComponentChildren = null;
  if (s && w && (s.kind === "line" || s.kind === "settings")) {
    const l = linesById(w).get(s.line), st = l ? w.lineStats[l.id] : undefined;
    if (l && scheduled(st, l)) {
      const settings = s.kind === "settings";
      body = (
        <Frame label={settings ? t("schedulePanel.settings") : t("schedulePanel.label", { line: l.name })}
          title={<><Chip line={l} plain /><span class="sp-name">{l.name}</span></>}
          narrow={!!st.bus && !settings} settings={settings}
          mode={!settings && scheduleModes().length > 1 ? <span class="sp-mode"><Segmented options={scheduleModes()} value="simple" onChange={() => {}} /></span> : undefined}>
          {settings ? <SettingsBody key={l.id} l={l} st={st} /> : st.bus ? <BusBody l={l} st={st} /> : <LineBody l={l} st={st} />}
        </Frame>
      );
    }
  } else if (s && w && s.kind === "group") {
    const ls = lineGroups(listedLines(w)).get(s.group) ?? [];
    const rail = ls.filter((l) => charted(w.lineStats[l.id], l));
    // the longest line's stops down the side
    const axis = rail.reduce<LineInput | undefined>((a, l) => (!a || w.lineStats[l.id].km > w.lineStats[a.id].km ? l : a), undefined);
    if (axis && rail.length >= 2) {
      const name = groupName(ls, s.group);
      body = (
        <Frame label={t("schedulePanel.label", { line: name })} title={<><GroupPill ls={ls} g={s.group} /><span class="sp-name">{name}</span></>}>
          <GroupBody axis={axis} st={w.lineStats[axis.id]} others={rail.filter((l) => l !== axis)} />
        </Frame>
      );
    }
  }
  // its line gone or stopped: closed, so it does not come back by itself
  useEffect(() => { if (s && w && !body) scheduleShown.value = null; }, [s, w, !body]);
  return <>{body}</>;
}

/** The line panel's icon beside its schedule: the schedule panel (T-3543: a size bigger than the others there). */
export function ScheduleButton({ l, st }: { l: LineInput; st: LineStats }) {
  if (!scheduled(st, l)) return null;
  const tip = t("schedulePanel.open");
  return <button class="btn icon mini sched-open" aria-label={tip} data-tip={tip} onClick={() => (scheduleShown.value = { kind: "line", line: l.id })}><Icon.timetable /></button>;
}

/** Open the detailed timetable settings for a running rail line. */
export function ScheduleSettingsButton({ l, st }: { l: LineInput; st: LineStats }) {
  if (!charted(st, l)) return null;
  const tip = t("schedulePanel.settings");
  return <button class="btn icon mini sched-settings" aria-label={tip} data-tip={tip} onClick={() => (scheduleShown.value = { kind: "settings", line: l.id })}><Icon.gear /></button>;
}

/** The group view's icon: the group's chart, for a group of two or more running rail lines. */
export function GroupChartButton({ ls }: { ls: readonly LineInput[] }) {
  const w = world.value;
  if (!w || ls.filter((l) => charted(w.lineStats[l.id], l)).length < 2 || !ls[0].group) return null;
  const tip = t("schedulePanel.groupChart");
  return <button class="btn icon mini related-toggle" aria-label={tip} data-tip={tip} onClick={() => (scheduleShown.value = { kind: "group", group: ls[0].group! })}><Icon.marey /></button>;
}
