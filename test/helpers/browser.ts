import assert from "node:assert/strict";
import { request as httpRequest, type ClientRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { ask } from "./snapshot.ts";

/**
 * The UI as a browser has it: the served page, the served script, and a live
 * connection to the served event stream.
 *
 * Tap's UI is a page, so the thing worth asserting on is the page — not a
 * client-state object a test could build without ever fetching anything. This
 * loads what the server actually serves, runs it against a document small
 * enough to read, and lets the real transport drive it. A test that passes
 * here passes because the HTML, the script and the stream agree.
 *
 * The document is deliberately a subset: the elements, text, attributes and
 * listeners the UI uses, and nothing else. It is not a browser, and anything
 * the UI starts relying on that is missing here fails loudly rather than
 * silently doing nothing.
 */

/** Anything in the tree: an element or the text between elements. */
type Node = FakeElement | TextNode;

class TextNode {
  data: string;
  parent: FakeElement | null = null;

  constructor(data: string) {
    this.data = data;
  }

  get textContent(): string {
    return this.data;
  }
}

class FakeElement {
  readonly tagName: string;
  readonly children: Node[] = [];
  readonly dataset: { [name: string]: string } = {};
  readonly attributes: { [name: string]: string } = {};
  readonly listeners: { [type: string]: ((event: unknown) => void)[] } = {};
  parent: FakeElement | null = null;
  hidden = false;
  className = "";
  /** Only meaningful on a `select`, where it is the chosen option's value. */
  value = "";

  constructor(tagName: string) {
    this.tagName = tagName.toLowerCase();
  }

  get textContent(): string {
    return this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.children.length = 0;
    if (value !== "") this.append(new TextNode(value));
  }

  append(...nodes: (Node | string)[]): void {
    for (const node of nodes) this.adopt(node);
  }

  replaceChildren(...nodes: (Node | string)[]): void {
    this.children.length = 0;
    for (const node of nodes) this.adopt(node);
  }

  insertBefore(child: Node, before: Node | null): void {
    const at = before === null ? -1 : this.children.indexOf(before);
    if (at < 0) this.adopt(child);
    else {
      child.parent = this;
      this.children.splice(at, 0, child);
    }
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  addEventListener(type: string, listen: (event: unknown) => void): void {
    (this.listeners[type] ??= []).push(listen);
  }

  dispatch(type: string, event: unknown = {}): void {
    for (const listen of this.listeners[type] ?? []) listen(event);
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return descendants(this).filter((element) => matches(element, selector));
  }

  private adopt(node: Node | string): void {
    const child = typeof node === "string" ? new TextNode(node) : node;
    child.parent = this;
    this.children.push(child);
  }
}

function descendants(root: FakeElement): FakeElement[] {
  const found: FakeElement[] = [];
  for (const child of root.children) {
    if (child instanceof TextNode) continue;
    found.push(child, ...descendants(child));
  }
  return found;
}

/**
 * A selector as this document understands it: a chain of simple selectors
 * separated by whitespace, each a tag name, `#id`, `.class` or `[attr=value]`.
 * Anything else throws rather than matching nothing, so a test that outgrows
 * the subset says so.
 */
function matches(element: FakeElement, selector: string): boolean {
  const steps = selector.trim().split(/\s+/);
  const own = steps.pop();
  if (own === undefined) return false;
  if (!matchesSimple(element, own)) return false;
  let ancestor = element.parent;
  for (const step of steps.reverse()) {
    while (ancestor !== null && !matchesSimple(ancestor, step)) ancestor = ancestor.parent;
    if (ancestor === null) return false;
    ancestor = ancestor.parent;
  }
  return true;
}

function matchesSimple(element: FakeElement, simple: string): boolean {
  const parts = simple.match(/^[a-z0-9-]+|#[^.#[]+|\.[^.#[]+|\[[^\]]+\]/gi) ?? [];
  if (parts.join("") !== simple) throw new Error(`unsupported selector: ${simple}`);
  return parts.every((part) => {
    if (part.startsWith("#")) return element.attributes.id === part.slice(1);
    if (part.startsWith(".")) return element.className.split(/\s+/).includes(part.slice(1));
    if (part.startsWith("[")) {
      const [name, value] = part.slice(1, -1).split("=");
      const held = element.attributes[name!] ?? element.dataset[datasetName(name!)];
      if (value === undefined) return held !== undefined;
      return held === value.replace(/^["']|["']$/g, "");
    }
    return element.tagName === part.toLowerCase();
  });
}

function datasetName(attribute: string): string {
  return attribute.startsWith("data-")
    ? attribute.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
    : attribute;
}

/** Elements that never have children, so a parse never waits for their close. */
const VOID_TAGS = new Set(["meta", "link", "br", "img", "input", "hr"]);

/**
 * The served page as a tree.
 *
 * A small parser over Tap's own markup rather than a general one: the page is
 * a fixed, well-formed document this repository writes, so what this has to
 * survive is that document and not the web.
 */
function parse(html: string): FakeElement {
  const root = new FakeElement("html");
  let open: FakeElement = root;
  const pattern = /<!--[\s\S]*?-->|<!\[^>]*>|<\/([a-zA-Z0-9-]+)\s*>|<([a-zA-Z0-9-]+)([^>]*)>|([^<]+)/g;
  for (const [, closing, tag, attributes, text] of html.matchAll(pattern)) {
    if (text !== undefined) {
      if (text.trim() !== "") open.append(new TextNode(text));
      continue;
    }
    if (closing !== undefined) {
      if (open.tagName === closing.toLowerCase() && open.parent !== null) open = open.parent;
      continue;
    }
    if (tag === undefined) continue;
    const element = new FakeElement(tag);
    for (const [, name, quoted] of (attributes ?? "").matchAll(
      /([a-zA-Z0-9_:-]+)(?:="([^"]*)")?/g,
    )) {
      if (name === undefined) continue;
      const value = quoted ?? "";
      element.setAttribute(name, value);
      if (name.startsWith("data-")) element.dataset[datasetName(name)] = value;
      if (name === "class") element.className = value;
      if (name === "hidden") element.hidden = true;
      if (name === "value") element.value = value;
    }
    open.append(element);
    if (!VOID_TAGS.has(element.tagName)) open = element;
  }
  return root;
}

/** One framed event, as the page's `EventSource` hands it over. */
interface Framed {
  readonly event: string;
  readonly data: string;
}

/**
 * The live connection, opened by the page's own script against the running
 * server. Frames are parsed exactly as the browser would and delivered to the
 * listeners the script registered.
 */
class LiveConnection {
  readonly listeners: { [type: string]: ((message: Framed) => void)[] } = {};
  private readonly call: ClientRequest;

  constructor(target: string, base: string) {
    const url = new URL(target, base);
    this.call = httpRequest(
      { host: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, headers: { host: url.host, accept: "text/event-stream" } },
      (response) => {
        assert.equal(response.statusCode, 200);
        response.setEncoding("utf8");
        let buffered = "";
        this.fire("open", { event: "open", data: "" });
        response.on("data", (chunk: string) => {
          buffered += chunk;
          for (;;) {
            const boundary = buffered.indexOf("\n\n");
            if (boundary < 0) break;
            const frame = buffered.slice(0, boundary);
            buffered = buffered.slice(boundary + 2);
            const fields: { [name: string]: string } = {};
            for (const line of frame.split("\n")) {
              const colon = line.indexOf(":");
              fields[line.slice(0, colon)] = line.slice(colon + 1).trimStart();
            }
            this.fire(fields.event ?? "message", {
              event: fields.event ?? "message",
              data: fields.data ?? "",
            });
          }
        });
      },
    );
    this.call.on("error", () => this.fire("error", { event: "error", data: "" }));
    this.call.end();
  }

  addEventListener(type: string, listen: (message: Framed) => void): void {
    (this.listeners[type] ??= []).push(listen);
  }

  close(): void {
    this.call.destroy();
  }

  private fire(type: string, message: Framed): void {
    for (const listen of this.listeners[type] ?? []) listen(message);
  }
}

export interface Browser {
  /** The one element matching, or a failure naming the selector. */
  find(selector: string): FakeElement;
  all(selector: string): FakeElement[];
  /** The text of the one element matching, or "" when there is none. */
  text(selector: string): string;
  click(selector: string): void;
  /** Chooses a value on a `select` and fires the change the page listens for. */
  choose(selector: string, value: string): void;
  /** Waits for what the live stream is about to say, or fails saying what it saw. */
  until(described: string, holds: () => boolean): Promise<void>;
  close(): void;
}

/**
 * Loads the UI from a running server: the page, its script, and the live
 * connection the script opens for itself.
 */
export async function openUi(url: string): Promise<Browser> {
  const parsed = new URL(url);
  const fetched = async (route: string): Promise<string> => {
    const answer = await ask(Number(parsed.port), `${route}${parsed.search}`, {
      headers: { host: parsed.host },
    });
    assert.equal(answer.status, 200, `${route} answered ${answer.status}`);
    return answer.body;
  };

  const page = parse(await fetched("/"));
  const script = await fetched("/app.js");
  const connections: LiveConnection[] = [];

  runInNewContext(script, {
    URL,
    location: { href: url },
    EventSource: class {
      constructor(target: string) {
        const live = new LiveConnection(target, url);
        connections.push(live);
        return live as unknown as EventSource;
      }
    },
    document: {
      body: page.querySelector("body") ?? page,
      querySelector: (selector: string) => page.querySelector(selector),
      querySelectorAll: (selector: string) => page.querySelectorAll(selector),
      createElement: (tag: string) => new FakeElement(tag),
      createTextNode: (data: string) => new TextNode(data),
    },
  });

  const find = (selector: string): FakeElement => {
    const element = page.querySelector(selector);
    assert.ok(element !== null, `the page has no ${selector}`);
    return element;
  };

  return {
    find,
    all: (selector) => page.querySelectorAll(selector),
    text: (selector) => page.querySelector(selector)?.textContent ?? "",
    click: (selector) => find(selector).dispatch("click"),
    choose: (selector, value) => {
      const element = find(selector);
      element.value = value;
      element.dispatch("change");
    },
    until: async (described, holds) => {
      for (let waited = 0; waited < 5_000; waited += 5) {
        if (holds()) return;
        await delay(5);
      }
      throw new Error(`timed out waiting for ${described}`);
    },
    close: () => {
      for (const live of connections) live.close();
    },
  };
}
