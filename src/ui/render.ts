import type { QueryRecord } from "../engine/database";
import { formatValue } from "../engine/format";
import { USERS, dbRoleFor, type Actor } from "../engine/personas";
import type { Step, Verdict } from "../engine/scenarios";
import { h, withCode } from "./dom";

const VERDICT_LABEL: Record<Verdict, string> = { bug: "Bug", safe: "Blocked", info: "Info" };

export function verdictBadge(verdict: Verdict, label = VERDICT_LABEL[verdict]): HTMLElement {
  return h("span", { class: `badge badge-${verdict}` }, label);
}

function senderLabel(sender: Step["sender"]): string {
  switch (sender) {
    case "anon":
      return "anon key, not signed in";
    case "alice":
    case "bob":
      return `${USERS[sender].name}, signed in`;
    case "service_role":
      return "service-role key (server only)";
    case "internet":
      return "anyone who can reach the URL";
    case "stripe":
      return "Stripe, signed with the endpoint secret";
  }
}

function roleComment(actor: Actor): string {
  const role = dbRoleFor(actor);
  if (actor === "alice" || actor === "bob") {
    return `-- as role ${role}, auth.uid() = '${USERS[actor].id}' (${USERS[actor].name})`;
  }
  return `-- as role ${role}, auth.uid() = null`;
}

function formatParam(value: unknown): string {
  return value === null ? "null" : `'${formatValue(value)}'`;
}

function resultView(record: QueryRecord): HTMLElement {
  const { outcome } = record;
  if (!outcome.ok) {
    const code = outcome.code ? ` ${outcome.code}` : "";
    return h("p", { class: "result result-error" }, `ERROR${code}: ${outcome.message}`);
  }
  if (outcome.rows.length === 0) {
    const isSelect = /^\s*select\b/i.test(record.sql);
    const affected = `${outcome.affectedRows} row${outcome.affectedRows === 1 ? "" : "s"} affected`;
    return h("p", { class: "result" }, isSelect ? "0 rows" : affected);
  }
  const columns = Object.keys(outcome.rows[0]);
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      { class: "result" },
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          columns.map((column) => h("th", { scope: "col" }, column)),
        ),
      ),
      h(
        "tbody",
        {},
        outcome.rows.map((row) =>
          h(
            "tr",
            {},
            columns.map((column) => h("td", {}, formatValue(row[column]))),
          ),
        ),
      ),
    ),
  );
}

function queryView(record: QueryRecord): HTMLElement {
  const params = record.params.map((value, i) => `-- $${i + 1} = ${formatParam(value)}`);
  return h(
    "div",
    { class: "query" },
    h("pre", { class: "code code-sql" }, h("code", {}, [roleComment(record.actor), ...params, record.sql].join("\n"))),
    resultView(record),
  );
}

/** Setup steps with several queries start folded so the step that matters stays in view. */
function queriesView(step: Step): HTMLElement | HTMLElement[] {
  const views = step.queries.map(queryView);
  if (step.verdict !== "info" || views.length <= 2) return views;
  return h("details", { class: "queries-folded" }, h("summary", {}, `Show the ${views.length} queries`), views);
}

export function stepView(step: Step, index: number): HTMLElement {
  const isHttp = step.sender === "internet" || step.sender === "stripe";
  let sqlLabel = "SQL that ran";
  if (step.queries.length === 0) sqlLabel = "SQL that ran: none";
  else if (step.queries.length > 1) sqlLabel = "SQL that ran, in order";

  return h(
    "li",
    { class: `step step-${step.verdict}` },
    h(
      "div",
      { class: "step-head" },
      h("span", { class: "step-number", "aria-hidden": "true" }, String(index + 1)),
      h("h4", {}, step.title),
      h("span", { class: "sender" }, senderLabel(step.sender)),
    ),
    h("p", { class: "label" }, isHttp ? "HTTP request" : "Client call"),
    h("pre", { class: "code" }, h("code", {}, step.request)),
    h("p", { class: "label" }, sqlLabel),
    queriesView(step),
    step.response &&
      h(
        "pre",
        { class: "code code-response" },
        h("code", {}, `HTTP ${step.response.status}\n${JSON.stringify(step.response.body)}`),
      ),
    h("p", { class: "finding" }, verdictBadge(step.verdict), " ", ...withCode(step.finding)),
  );
}
