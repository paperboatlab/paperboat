// Paperboat's side of the shared Help window: a few guide pages, the manual, and a reference page
// for every block the backend offers, written from its template (what it does, ports, params).
import { matches, type BlockDef, type HelpItem, type HelpPage, type HelpProvider, type ParamDef, type PortDef } from "@paperboat/shared";

export const DOCS = "https://paperboatlab.github.io/paperboat/";

const GUIDES: (HelpItem & { text: string; link?: HelpPage["link"] })[] = [
  {
    id: "guide:start", title: "Getting started", kind: "guide", summary: "Station, Flow, Board and the view modes",
    text: `A project has three pages: the Station (the 3D scene), the Flow (the block diagram) and the Board (instruments and controls).

- Add a block with \`/\` or a double-click on the Flow; wire an output port to an input port.
- Run starts the simulation in the backend; the Board's scopes, displays and graphs show it live.
- Navigator shows one page at a time; Commander puts the Station and Flow over the Board; Lookout puts the Board in the middle.
- Toolkits (top bar) installs more blocks; the Console lists what the backend says.`,
    link: { label: "User manual", href: `${DOCS}user_manual.html` },
  },
  {
    id: "guide:manual", title: "User manual", kind: "guide", summary: "the whole manual, online",
    text: "The manual covers every page, the canvas, the Board, projects, runs and keyboard shortcuts in depth.",
    link: { label: "Open the user manual", href: `${DOCS}user_manual.html` },
  },
];

const BLOCK = "block:";

const port = (p: PortDef) =>
  `- \`${p.id}\`${p.type && p.type !== "signal" ? ` ${p.type}` : ""}${p.unit ? ` [${p.unit}]` : ""}${p.dimension ? ` × ${p.dimension}` : ""}${p.components?.length ? ` (${p.components.map((c) => c.id).join(", ")})` : ""}`;

const param = (p: ParamDef) => {
  const value = p.type === "text" || p.type === "key" || p.type === "file" || p.type === "variable" ? (p.default ? `"${p.default}"` : "empty") : String(p.default);
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

/** The Help provider: guides, then blocks matched by label, type, group or description. */
export function paperboatHelp(blocks: () => readonly BlockDef[]): HelpProvider {
  const item = (b: BlockDef): HelpItem => ({ id: BLOCK + b.type, title: b.label, kind: b.group ?? "block", summary: b.description ?? b.type });
  return {
    items(query) {
      const guides = GUIDES.filter((g) => matches(g, query));
      const found = blocks().filter((b) => !b.linked && (matches(item(b), query) || b.type.includes(query.toLowerCase())));
      return [...guides, ...found.map(item)];
    },
    page(id) {
      const guide = GUIDES.find((g) => g.id === id);
      if (guide) return { title: guide.title, kind: "guide", text: guide.text, link: guide.link };
      const b = blocks().find((one) => BLOCK + one.type === id);
      return b ? blockPage(b) : null;
    },
  };
}
