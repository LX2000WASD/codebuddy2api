import { Fragment, useState } from "react";
import type { ModelRule, RecordValue } from "./api";
import { t } from "./i18n";
import m from "./models.module.scss";
import { Badge, Cluster, Empty, Field, Panel, Select, Stack, type BadgeTone } from "./ui";
import { DataValue, profileLabel } from "./values";

type Facts = Pick<ModelRule, "capabilities" | "limits" | "metadata_by_profile">;
/** Routing scope shown next to the account count in the detail drawer. */
type RoutingFacts = Partial<Pick<ModelRule, "region" | "profile" | "credential_ids">> &
  Pick<ModelRule, "available_credentials">;
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
const names: Record<string, string> = {
  images: "图片",
  tools: "工具",
  reasoning: "思考",
  thinking_disable: "关闭思考",
};
const states: Record<string, string> = {
  supported: "支持",
  unsupported: "不支持",
  mixed: "因路由而异",
  unknown: "未知",
};
const labels: Record<string, string> = {
  id: "上游标识",
  name: "显示名称",
  vendor: "厂商标识",
  description: "说明",
  descriptionZh: "中文说明",
  descriptionEn: "英文说明",
  credits: "目录倍率（原值）",
  tags: "标签",
  isDefault: "上游默认模型",
  disabled: "上游停用",
  iconUrl: "图标地址（不自动加载）",
  supportsImages: "声明支持图片",
  disabledMultimodal: "禁用多模态",
  supportsToolCall: "声明支持工具",
  supportsReasoning: "声明支持思考",
  onlyReasoning: "仅思考模式",
  canDisableThinking: "允许关闭思考",
  supportsExtra: "上游扩展标记",
  maxInputTokens: "最大输入 Token",
  maxOutputTokens: "最大输出 Token",
  maxAllowedSize: "上游预算（原值）",
  contextWindow: "上下文窗口",
  defaultLength: "默认窗口",
  supportedLengths: "可选窗口",
  reasoning: "思考选项",
  defaultEffort: "默认强度",
  effort: "强度",
  supportedEfforts: "可选强度",
  summary: "摘要建议",
  relatedModels: "关联模型",
  lite: "普通模式",
  temperature: "温度建议",
  top_p: "Top P 建议",
  top_k: "Top K 建议",
  repetition_penalty: "重复惩罚建议",
};
const groups: [string, string[]][] = [
  [
    "基本信息",
    [
      "id",
      "name",
      "vendor",
      "description",
      "descriptionZh",
      "descriptionEn",
      "credits",
      "tags",
      "isDefault",
      "disabled",
      "iconUrl",
    ],
  ],
  [
    "能力与限制",
    [
      "supportsImages",
      "disabledMultimodal",
      "supportsToolCall",
      "supportsReasoning",
      "onlyReasoning",
      "canDisableThinking",
      "supportsExtra",
      "maxInputTokens",
      "maxOutputTokens",
      "maxAllowedSize",
      "contextWindow",
    ],
  ],
  [
    "思考与参数建议",
    [
      "reasoning",
      "relatedModels",
      "temperature",
      "top_p",
      "top_k",
      "repetition_penalty",
      "summary",
    ],
  ],
];

/** A declared capability as a badge: the tone is the state, the text says it too. */
const stateTone: Record<string, BadgeTone> = {
  supported: "good",
  mixed: "warn",
  unsupported: "neutral",
  unknown: "neutral",
};

/** Every declaration carries the shared-directory marker, so it is computed once. */
function inheritsShared(metadata: unknown): boolean {
  return variants(metadata).some(([, rows]) =>
    rows.some((entry) => record(entry.catalog_source).kind === "shared"),
  );
}

export function CapabilityBadges({ model, full = false }: { model: Facts; full?: boolean }) {
  const declared = record(model.capabilities);
  return (
    <Cluster gap="1">
      {(full ? Object.keys(names) : ["images", "tools", "reasoning"]).map((key) => {
        const raw = declared[key];
        const state = typeof raw === "string" && Object.hasOwn(states, raw) ? raw : "unknown";
        return (
          <Badge key={key} tone={stateTone[state]}>
            {names[key]}：{states[state]}
          </Badge>
        );
      })}
      {inheritsShared(model.metadata_by_profile) && <Badge tone="neutral">国际共享目录</Badge>}
    </Cluster>
  );
}

const chipNames: Record<string, string> = {
  images: "视觉",
  tools: "工具",
  reasoning: "推理",
};
const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];
export function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${Number.isInteger(millions) ? millions : Math.round(millions * 10) / 10}M`;
  }
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}
export function specRange(model: Facts, key: "maxInputTokens" | "maxOutputTokens"): number[] {
  const values = new Set<number>();
  for (const [, rows] of variants(model.metadata_by_profile))
    for (const row of rows) {
      const direct = row[key];
      if (typeof direct === "number" && Number.isFinite(direct) && direct > 0) {
        values.add(direct);
        continue;
      }
      if (key !== "maxInputTokens") continue;
      const window = record(row.contextWindow);
      const lengths = Array.isArray(window.supportedLengths)
        ? window.supportedLengths.filter(
            (length): length is number => typeof length === "number" && length > 0,
          )
        : [];
      const fallback =
        typeof window.defaultLength === "number" && window.defaultLength > 0
          ? window.defaultLength
          : lengths.length
            ? Math.max(...lengths)
            : null;
      if (fallback !== null) values.add(fallback);
    }
  return [...values].sort((a, b) => a - b);
}
export function effortSummary(model: Facts): {
  options: string[];
  defaults: string[];
  closable: boolean;
  only: boolean;
} {
  const options = new Set<string>();
  const defaults = new Set<string>();
  let closable = false;
  let only = false;
  for (const [, rows] of variants(model.metadata_by_profile))
    for (const row of rows) {
      const reasoning = record(row.reasoning);
      if (Array.isArray(reasoning.supportedEfforts))
        for (const value of reasoning.supportedEfforts)
          if (typeof value === "string" && value) options.add(value);
      if (typeof reasoning.defaultEffort === "string" && reasoning.defaultEffort)
        defaults.add(reasoning.defaultEffort);
      if (reasoning.canDisableThinking === true) closable = true;
      if (row.onlyReasoning === true) only = true;
    }
  const rank = (value: string) => {
    const index = EFFORT_ORDER.indexOf(value);
    return index === -1 ? EFFORT_ORDER.length : index;
  };
  return {
    options: [...options].sort((a, b) => rank(a) - rank(b)),
    defaults: [...defaults],
    closable,
    only,
  };
}
export function rateOf(credits: unknown): number | null {
  return typeof credits === "number" && Number.isFinite(credits) && credits >= 0 ? credits : null;
}
export function formatRate(value: number): string {
  return `${Math.round(value * 100) / 100}x`;
}
export function CapabilityChips({ model }: { model: Facts }) {
  const declared = record(model.capabilities);
  const notes: string[] = [];
  return (
    <span className={m.cellLine}>
      {(["images", "tools", "reasoning"] as const).map((key) => {
        const raw = declared[key];
        const state = typeof raw === "string" && Object.hasOwn(states, raw) ? raw : "unknown";
        if (state === "mixed") notes.push(`${names[key]}${states[state]}`);
        return (
          <Badge key={key} tone={stateTone[state]} title={`${names[key]}：${states[state]}`}>
            {chipNames[key]}
          </Badge>
        );
      })}
      {notes.map((note) => (
        <small className={m.muted} key={note}>
          {note}
        </small>
      ))}
      {inheritsShared(model.metadata_by_profile) && <small className={m.muted}>国际共享目录</small>}
    </span>
  );
}
export function EffortChips({ model }: { model: Facts }) {
  const { options, defaults, closable, only } = effortSummary(model);
  const state = record(model.capabilities).reasoning;
  if (state === "unsupported") return <span className={m.muted}>不支持思考</span>;
  if (!options.length && !closable && !only) {
    if (state === "supported")
      return (
        <span className={m.muted}>
          固定档{defaults.length === 1 ? ` · 默认 ${defaults[0]}` : ""}
        </span>
      );
    return <span className={m.muted}>—</span>;
  }
  return (
    <span className={m.cellLine}>
      {options.map((value) => (
        <Badge
          key={value}
          tone={defaults.includes(value) ? "good" : "neutral"}
          title={defaults.includes(value) ? "默认档" : undefined}
        >
          {value}
        </Badge>
      ))}
      {only && <Badge tone="neutral">仅思考</Badge>}
      {closable && <Badge tone="neutral">可关闭</Badge>}
    </span>
  );
}
export function SpecValue({ model, kind }: { model: Facts; kind: "input" | "output" }) {
  const values = specRange(model, kind === "input" ? "maxInputTokens" : "maxOutputTokens");
  if (!values.length) return <span className={m.muted}>—</span>;
  return (
    <span className={m.specNum}>
      {values.length === 1
        ? formatTokens(values[0])
        : `${formatTokens(values[0])}–${formatTokens(values[values.length - 1])}`}
    </span>
  );
}
export function modelSearchText(
  model: Pick<ModelRule, "id" | "public_id" | "upstream_id"> & Facts,
): string {
  const parts: unknown[] = [model.id, model.public_id, model.upstream_id, modelDisplayName(model)];
  for (const [, rows] of variants(model.metadata_by_profile))
    for (const row of rows) {
      parts.push(row.name, row.vendor, row.descriptionZh, row.descriptionEn, row.tags);
    }
  const text: string[] = [];
  for (const part of parts.flat()) if (typeof part === "string" && part) text.push(part);
  return text.join(" ").toLowerCase();
}

function MetaFields({ data, depth = 0 }: { data: RecordValue; depth?: number }) {
  return (
    <dl className={m.metadataFields}>
      {Object.entries(data).map(([key, value]) => (
        <Fragment key={key}>
          <dt title={key}>{Object.hasOwn(labels, key) ? labels[key] : key}</dt>
          <dd>
            {value !== null && typeof value === "object" && !Array.isArray(value) && depth < 3 ? (
              <MetaFields data={record(value)} depth={depth + 1} />
            ) : (
              <DataValue value={value} />
            )}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

function variants(value: unknown): [string, RecordValue[]][] {
  return Object.entries(record(value))
    .filter(([key]) => ["cn-cli", "cn-work", "intl-cli", "intl-work"].includes(key))
    .map(([profile, values]) => [profile, Array.isArray(values) ? values.map(record) : []]);
}

export function modelDisplayName(model: Facts): string {
  const values = [
    ...new Set(
      variants(model.metadata_by_profile)
        .flatMap(([, rows]) => rows.map((row) => row.name))
        .filter((name): name is string => typeof name === "string" && name.length > 0),
    ),
  ];
  return values.length === 1 ? values[0] : "";
}

function CatalogSource({ entry }: { entry: RecordValue }) {
  const source = record(entry.catalog_source);
  if (source.kind === "direct") return <p className={m.note}>目录来源：当前产品直接声明。</p>;
  if (source.kind !== "shared") return null;
  const profiles = Array.isArray(source.profiles)
    ? source.profiles.filter(
        (profile): profile is string =>
          typeof profile === "string" && ["intl-cli", "intl-work"].includes(profile),
      )
    : [];
  const originals = Array.isArray(entry.source_variants) ? entry.source_variants.map(record) : [];
  return (
    <Panel title="共享目录来源">
      <p className={m.note}>
        继承自{profiles.length ? profiles.map(profileLabel).join("、") : "未注明来源"}
        ；当前账号未直接声明此模型，权限与实际扣费以上游为准。
      </p>
      {originals.map((original, index) => (
        <details className={m.rawData} key={index}>
          <summary>
            {profileLabel(typeof original.profile === "string" ? original.profile : "")} · 来源版本{" "}
            {index + 1}
          </summary>
          <MetaFields data={record(original.metadata)} />
        </details>
      ))}
    </Panel>
  );
}

/**
 * Which accounts can actually route to this model right now. The count comes from the
 * backend's own routing preview (available_credentials); the scope line explains where
 * that number comes from, so "3 accounts" is never mistaken for "all accounts".
 */
function AvailableAccounts({ model, total }: { model: RoutingFacts; total: number | null }) {
  const available = model.available_credentials;
  const bindings = model.credential_ids ?? [];
  const tone: BadgeTone = available === undefined ? "neutral" : available > 0 ? "good" : "bad";
  const scope = bindings.length
    ? t("models.detail.strictBinding", { count: bindings.length })
    : model.region
      ? t("models.detail.regionRoute", { region: profileLabel(model.region) })
      : t("models.detail.autoRoute");
  return (
    <Panel title={t("models.detail.accounts")}>
      <Stack gap="1">
        <Cluster gap="2">
          <Badge tone={tone}>
            {available === undefined
              ? t("models.avail.unknown")
              : total === null
                ? t("models.avail.accountsOnly", { available })
                : t("models.avail.accounts", { available, total })}
          </Badge>
          <small className={m.muted}>{scope}</small>
        </Cluster>
        <small className={m.muted}>
          {available === undefined
            ? t("models.avail.reason.unknown")
            : available > 0
              ? t("models.detail.accountsHint")
              : t("models.detail.noAccounts")}
        </small>
      </Stack>
    </Panel>
  );
}

export function ModelMetadata({
  model,
  totalAccounts = null,
}: {
  model: Facts;
  totalAccounts?: number | null;
}) {
  const [selected, setSelected] = useState("");
  const sources = variants(model.metadata_by_profile);
  const active = sources.find(([profile]) => profile === selected) ?? sources[0];
  const limits = record(model.limits);
  return (
    <>
      <p className={m.note}>
        以下为上游声明，不代表模型原生模态或实测保证；目录参数不会自动覆盖客户端请求。
      </p>
      <AvailableAccounts model={model as Facts & RoutingFacts} total={totalAccounts} />
      <Panel title="能力概要">
        <CapabilityBadges model={model} full />
        <dl className={m.metadataFields}>
          {["maxInputTokens", "maxOutputTokens"].map((key) => {
            const limit = record(limits[key]);
            return (
              <Fragment key={key}>
                <dt>{labels[key]}</dt>
                <dd>
                  {limit.state === "mixed" ? (
                    "因路由而异"
                  ) : limit.state === "known" ? (
                    <DataValue value={limit.value} />
                  ) : (
                    "未知"
                  )}
                </dd>
              </Fragment>
            );
          })}
        </dl>
      </Panel>
      {!active ? (
        <Empty title="尚无模型元数据">未知不等于不支持；请等待账号目录同步。</Empty>
      ) : (
        <>
          <Field label="查看产品声明">
            <Select label="查看产品声明" value={active[0]} onChange={(value) => setSelected(value)}>
              {sources.map(([profile]) => (
                <option key={profile} value={profile}>
                  {profileLabel(profile)}
                </option>
              ))}
            </Select>
          </Field>
          {active[1].length > 1 && (
            <p className={m.note}>同一产品的账号声明存在差异；以下保留各版本，不公开账号身份。</p>
          )}
          {active[1].map((entry, index) => (
            <section
              key={`${active[0]}-${index}`}
              aria-label={`${profileLabel(active[0])} 声明 ${index + 1}`}
            >
              {active[1].length > 1 && <h3>声明 {index + 1}</h3>}
              {!Object.keys(entry).length && <Empty title="此来源未提供能力信息" />}
              <CatalogSource entry={entry} />
              {groups.map(([title, keys]) => {
                const data = Object.fromEntries(
                  keys.filter((key) => Object.hasOwn(entry, key)).map((key) => [key, entry[key]]),
                );
                return (
                  Object.keys(data).length > 0 && (
                    <Panel title={title} key={title}>
                      <MetaFields data={data} />
                    </Panel>
                  )
                );
              })}
              <details className={m.rawData}>
                <summary>查看安全元数据 JSON</summary>
                <pre>{JSON.stringify(entry, null, 2)}</pre>
              </details>
            </section>
          ))}
        </>
      )}
    </>
  );
}
