// Paperboat's side of the shared Help window: a reference page for every block the station offers,
// written from its template (what it does, ports, params) with its toolkit's prose under it, and
// the docs of the engine and every toolkit (paperboatlab.github.io), searched with them.
import { docsHelp, DOCS_URL, loadDocs, matches, type BlockDef, type HelpItem, type HelpPage, type HelpProvider, type ParamDef, type PortDef } from "@paperboat/shared";

/** The org's docs site; VITE_DOCS_URL points Help at another build (a local one, to try docs out). */
export const DOCS: string = import.meta.env?.VITE_DOCS_URL ?? DOCS_URL;

type Docs = ReturnType<typeof docsHelp>;
/** The engine's and the toolkits' docs, fetched on Help's first look and kept for the session. */
const engineDocs: Docs = docsHelp(() => loadDocs((s) => s.site === "paperboat" || s.site.startsWith("toolkits/"), DOCS), DOCS);

const BLOCK = "block:";

const port = (p: PortDef) =>
  `- \`${p.id}\`${p.type && p.type !== "signal" ? ` ${p.type}` : ""}${p.unit ? ` [${p.unit}]` : ""}${p.dimension ? ` × ${p.dimension}` : ""}${p.components?.length ? ` (${p.components.map((c) => c.id).join(", ")})` : ""}`;

const param = (p: ParamDef) => {
  const value = p.type === "text" || p.type === "key" || p.type === "file" || p.type === "variable" || p.type === "matrix" ? (p.default ? `"${p.default}"` : "empty") : String(p.default);
  const unit = p.type === "number" && p.unit ? ` ${p.unit}` : "";
  const options = p.type === "enum" ? `, one of ${p.options.join(", ")}` : "";
  return `- \`${p.id}\` ${p.type}, default ${value}${unit}${options}`;
};

/** A block's reference page, from its template. */
export function blockPage(b: BlockDef): HelpPage {
  const parts = [b.description ?? "No description.", `Type \`${b.type}\`${b.group ? ` · ${b.group}` : ""}${b.feedthrough === false ? " · no feedthrough: a feedback loop may pass through it" : ""}${b.elementwise ? " · element by element: vectors in, vectors out" : ""}.`];
  const ins = b.inputs_from ? `- one per free name in \`${b.inputs_from}\`` : b.ports_from ? `- one per sign or name in \`${b.ports_from}\`` : b.inputs.map(port).join("\n");
  if (ins) parts.push("## Inputs", ins);
  const outs = b.outputs_from ? `- one per name in \`${b.outputs_from}\`` : b.outputs.map(port).join("\n");
  if (outs) parts.push("## Outputs", outs);
  if (b.params.length) parts.push("## Parameters", b.params.map(param).join("\n"));
  return { title: b.label, kind: b.group ?? "block", text: parts.join("\n\n") };
}

/** The Help provider: blocks matched by label, type, group or description, and the docs. */
export function paperboatHelp(blocks: () => readonly BlockDef[], docs: Docs = engineDocs): HelpProvider {
  const item = (b: BlockDef): HelpItem => ({ id: BLOCK + b.type, title: b.label, kind: b.group ?? "block", summary: b.description ?? b.type });
  return {
    async items(query) {
      const found = blocks().filter((b) => !b.linked && (matches(item(b), query) || b.type.includes(query.toLowerCase()))).map(item);
      const pages = await docs.items(query);
      // No query: the docs' contents first; a query: the blocks it names first.
      return query.trim() ? [...found, ...pages] : [...pages, ...found];
    },
    async page(id) {
      const b = blocks().find((one) => BLOCK + one.type === id);
      if (!b) return docs.page(id);
      const prose = await docs.blockProse(b.type, b.group);
      return prose ? { ...blockPage(b), html: `<h3>Notes</h3>${prose}` } : blockPage(b);
    },
    link: (href) => docs.link?.(href) ?? null,
  };
}
